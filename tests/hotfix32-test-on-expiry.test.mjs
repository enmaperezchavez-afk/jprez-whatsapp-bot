// Hotfix-32 — "expiración anunciada" del modo testing.
//
// Bug Director 11 jun: el /test-on expiró en silencio a los 30 min y el
// flip a modo supervisor + historial testing aislado pareció "amnesia"
// del bot. Fix de 3 piezas:
//   1. consumeExpiredFlag: el PRÓXIMO mensaje del admin tras expirar el
//      TTL recibe PRIMERO el aviso ⏰ y LUEGO se procesa normal.
//   2. /test-on responde con la hora exacta de expiración (zona RD).
//   3. Renovación deslizante: cada mensaje en testing re-arma el TTL de
//      30 min, con tope DURO de 2h desde la activación.
//
// Patrón de mocks: require.cache patching de @upstash/redis con Map
// stateful + TTL lazy (heredado de hotfix6-testing-mode.test.mjs).

import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// ===== mock Redis stateful =====
const redisState = new Map();
const redisExpiry = new Map();

function redisGet(key) {
  const exp = redisExpiry.get(key);
  if (exp && Date.now() >= exp) {
    redisState.delete(key);
    redisExpiry.delete(key);
    return null;
  }
  return redisState.has(key) ? redisState.get(key) : null;
}

{
  const moduleId = require.resolve("@upstash/redis");
  require.cache[moduleId] = {
    id: moduleId,
    filename: moduleId,
    loaded: true,
    exports: {
      Redis: class {
        constructor() {}
        async get(key) { return redisGet(key); }
        async set(key, value, opts = {}) {
          redisState.set(key, value);
          if (opts?.ex) redisExpiry.set(key, Date.now() + opts.ex * 1000);
          else redisExpiry.delete(key);
          return "OK";
        }
        async del(key) {
          const had = redisState.has(key);
          redisState.delete(key);
          redisExpiry.delete(key);
          return had ? 1 : 0;
        }
        async incr(key) {
          const next = Number(redisState.get(key) || 0) + 1;
          redisState.set(key, next);
          return next;
        }
        async expire(key, seconds) {
          if (!redisState.has(key)) return 0;
          redisExpiry.set(key, Date.now() + seconds * 1000);
          return 1;
        }
        async ttl(key) {
          if (!redisState.has(key)) return -2;
          const exp = redisExpiry.get(key);
          if (!exp) return -1;
          const remaining = Math.ceil((exp - Date.now()) / 1000);
          return remaining <= 0 ? -2 : remaining;
        }
      },
    },
  };
}

process.env.UPSTASH_REDIS_REST_URL = "https://mock.upstash.test";
process.env.UPSTASH_REDIS_REST_TOKEN = "mock-token";

const adminTesting = require("../src/admin-testing-mode.js");
const {
  ADMIN_TESTING_MODE_PREFIX,
  ADMIN_TESTING_WAS_ACTIVE_PREFIX,
  ADMIN_TESTING_STARTED_PREFIX,
  TESTING_MODE_TTL_SECONDS,
  TESTING_MODE_HARD_CAP_SECONDS,
} = require("../src/redis-keys.js");
const { STAFF_PHONES } = require("../src/staff.js");

const ADMIN = Object.keys(STAFF_PHONES)[0]; // admin real del repo

function simularExpiracionTTL() {
  // El TTL del modo venció: Redis ya no tiene la key del modo, pero el
  // flag was-active (TTL largo) sigue vivo.
  redisState.delete(ADMIN_TESTING_MODE_PREFIX + ADMIN);
  redisExpiry.delete(ADMIN_TESTING_MODE_PREFIX + ADMIN);
}

beforeEach(() => {
  redisState.clear();
  redisExpiry.clear();
});

describe("Hotfix-32 — activate deja los flags de soporte", () => {
  it("activate setea was-active + started y devuelve expiresAtMs", async () => {
    const antes = Date.now();
    const r = await adminTesting.activate(ADMIN);
    expect(r.ok).toBe(true);
    expect(r.expiresAtMs).toBeGreaterThanOrEqual(antes + TESTING_MODE_TTL_SECONDS * 1000 - 50);
    expect(redisState.get(ADMIN_TESTING_WAS_ACTIVE_PREFIX + ADMIN)).toBe("1");
    expect(Number(redisState.get(ADMIN_TESTING_STARTED_PREFIX + ADMIN))).toBeGreaterThanOrEqual(antes);
  });
});

describe("Hotfix-32 — expiración anunciada (consumeExpiredFlag)", () => {
  it("TTL expirado -> true UNA vez, luego false (flag consumido)", async () => {
    await adminTesting.activate(ADMIN);
    simularExpiracionTTL();
    expect(await adminTesting.consumeExpiredFlag(ADMIN)).toBe(true);
    // segundo mensaje: ya no anuncia
    expect(await adminTesting.consumeExpiredFlag(ADMIN)).toBe(false);
  });

  it("modo ACTIVO -> false (no hay nada que anunciar)", async () => {
    await adminTesting.activate(ADMIN);
    expect(await adminTesting.consumeExpiredFlag(ADMIN)).toBe(false);
    // y NO consumió el flag (sigue ahí para cuando expire de verdad)
    expect(redisState.get(ADMIN_TESTING_WAS_ACTIVE_PREFIX + ADMIN)).toBe("1");
  });

  it("salida explícita /test-off -> false (deactivate limpió los flags)", async () => {
    await adminTesting.activate(ADMIN);
    await adminTesting.deactivate(ADMIN);
    expect(await adminTesting.consumeExpiredFlag(ADMIN)).toBe(false);
  });

  it("no-admin -> siempre false", async () => {
    expect(await adminTesting.consumeExpiredFlag("18095550000")).toBe(false);
  });

  it("el texto del aviso es el doctrinal del Director", () => {
    expect(adminTesting.TESTING_EXPIRED_ANNOUNCEMENT).toMatch(/⏰/);
    expect(adminTesting.TESTING_EXPIRED_ANNOUNCEMENT).toMatch(/30 min/);
    expect(adminTesting.TESTING_EXPIRED_ANNOUNCEMENT).toMatch(/modo supervisor/);
    expect(adminTesting.TESTING_EXPIRED_ANNOUNCEMENT).toMatch(/\/test-on/);
  });
});

describe("Hotfix-32 — renovación deslizante con tope duro 2h", () => {
  it("mensaje en testing renueva el TTL a 30 min", async () => {
    await adminTesting.activate(ADMIN);
    // dejar el TTL "gastado": 5 min restantes
    redisExpiry.set(ADMIN_TESTING_MODE_PREFIX + ADMIN, Date.now() + 5 * 60 * 1000);
    const out = await adminTesting.renewIfActive(ADMIN);
    expect(out.renewed).toBe(true);
    const status = await adminTesting.getStatus(ADMIN);
    expect(status.secondsRemaining).toBeGreaterThan(TESTING_MODE_TTL_SECONDS - 60);
  });

  it("pasadas 2h desde la activación NO renueva (hardCapReached)", async () => {
    await adminTesting.activate(ADMIN);
    // simular que la activación fue hace 2h+
    redisState.set(
      ADMIN_TESTING_STARTED_PREFIX + ADMIN,
      String(Date.now() - (TESTING_MODE_HARD_CAP_SECONDS + 60) * 1000)
    );
    const out = await adminTesting.renewIfActive(ADMIN);
    expect(out.renewed).toBe(false);
    expect(out.hardCapReached).toBe(true);
  });

  it("cerca del tope renueva solo hasta el tope (TTL recortado)", async () => {
    await adminTesting.activate(ADMIN);
    // activación hace 1h55: quedan 5 min de cap -> TTL renovado ~300s, no 1800
    redisState.set(
      ADMIN_TESTING_STARTED_PREFIX + ADMIN,
      String(Date.now() - (TESTING_MODE_HARD_CAP_SECONDS - 300) * 1000)
    );
    const out = await adminTesting.renewIfActive(ADMIN);
    expect(out.renewed).toBe(true);
    expect(out.ttlSec).toBeLessThanOrEqual(301);
  });

  it("modo inactivo o sesión legacy sin ancla -> no renueva", async () => {
    expect((await adminTesting.renewIfActive(ADMIN)).renewed).toBe(false);
    // sesión activa pre-Hotfix-32 (sin started): muere a su TTL original
    redisState.set(ADMIN_TESTING_MODE_PREFIX + ADMIN, "active");
    const out = await adminTesting.renewIfActive(ADMIN);
    expect(out.renewed).toBe(false);
    expect(out.hardCapReached).toBe(false);
  });
});

describe("Hotfix-32 — hora exacta en zona RD", () => {
  it("formatHoraRD convierte a America/Santo_Domingo (UTC-4)", () => {
    // 2026-06-11 17:25 UTC = 1:25 PM en RD
    const hora = adminTesting.formatHoraRD(Date.UTC(2026, 5, 11, 17, 25));
    expect(hora).toMatch(/1:25/);
    expect(hora).toMatch(/p/i); // PM en es-DO ("p. m." o similar)
  });
});

describe("Hotfix-32 — wiring en handler y webhook", () => {
  it("message.js anuncia la expiración ANTES de procesar y renueva en testing", async () => {
    const { readFileSync } = await import("fs");
    const handler = readFileSync("src/handlers/message.js", "utf8");
    expect(handler).toMatch(/consumeExpiredFlag\(senderPhone\)/);
    expect(handler).toMatch(/TESTING_EXPIRED_ANNOUNCEMENT/);
    expect(handler).toMatch(/renewIfActive\(senderPhone\)/);
  });

  it("webhook /test-on responde con hora exacta + renovación + aviso de expiración", async () => {
    const { readFileSync } = await import("fs");
    const webhook = readFileSync("api/webhook.js", "utf8");
    expect(webhook).toMatch(/formatHoraRD\(result\.expiresAtMs\)/);
    expect(webhook).toMatch(/hasta la/);
    expect(webhook).toMatch(/tope 2h/);
    expect(webhook).toMatch(/Cuando expire te aviso/);
  });
});
