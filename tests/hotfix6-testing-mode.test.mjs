// Tests del modo testing para admin — hotfix-6 Día 3.
//
// Cubre:
//   - Comandos /test-on, /test-off, /test-status del admin
//   - Cliente normal que manda /test-on: ignorado, cae a pipeline normal
//   - Aislamiento de estado: admin real NO se toca durante testing
//   - TTL expira → siguiente mensaje admin usa flujo normal (sin phone swap)
//   - Rate limit de activaciones (6ta en 1h rechazada)
//
// Patron: require.cache patching (heredado de hotfix2-defense/hotfix4-docs,
// skill jprez-security-patterns §4.1) para @upstash/redis, @upstash/ratelimit
// y @anthropic-ai/sdk. Stateful Map compartido para Redis mock.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// ===== Estado compartido =====

const redisState = new Map();
const redisExpiry = new Map(); // key → epoch ms de expiracion
let claudeMockResponse = null;

function redisGet(key) {
  // Chequear expiracion lazy (mock simple de TTL para tests).
  const exp = redisExpiry.get(key);
  if (exp && Date.now() >= exp) {
    redisState.delete(key);
    redisExpiry.delete(key);
    return null;
  }
  return redisState.has(key) ? redisState.get(key) : null;
}

function redisSet(key, value, opts = {}) {
  if (opts?.nx && redisState.has(key)) return null;
  redisState.set(key, value);
  if (opts?.ex) {
    redisExpiry.set(key, Date.now() + opts.ex * 1000);
  } else {
    redisExpiry.delete(key);
  }
  return "OK";
}

function redisDel(key) {
  const had = redisState.has(key);
  redisState.delete(key);
  redisExpiry.delete(key);
  return had ? 1 : 0;
}

function redisIncr(key) {
  const current = Number(redisState.get(key) || 0);
  const next = current + 1;
  redisState.set(key, next);
  return next;
}

function redisExpire(key, seconds) {
  if (!redisState.has(key)) return 0;
  redisExpiry.set(key, Date.now() + seconds * 1000);
  return 1;
}

function redisTtl(key) {
  if (!redisState.has(key)) return -2;
  const exp = redisExpiry.get(key);
  if (!exp) return -1;
  const remaining = Math.ceil((exp - Date.now()) / 1000);
  return remaining <= 0 ? -2 : remaining;
}

// ===== require.cache patching =====

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
        async set(key, value, opts = {}) { return redisSet(key, value, opts); }
        async del(key) { return redisDel(key); }
        async incr(key) { return redisIncr(key); }
        async expire(key, seconds) { return redisExpire(key, seconds); }
        async ttl(key) { return redisTtl(key); }
        async lrange() { return []; }
        async rpush() { return 1; }
        async ltrim() { return "OK"; }
        async hget() { return null; }
        async hset() { return 1; }
        async hmget() { return []; }
      },
    },
  };
}

{
  const moduleId = require.resolve("@upstash/ratelimit");
  require.cache[moduleId] = {
    id: moduleId,
    filename: moduleId,
    loaded: true,
    exports: {
      Ratelimit: class {
        constructor(config) { this.config = config; }
        async limit() {
          return { success: true, limit: 9999, remaining: 9999, reset: Date.now() + 60000 };
        }
        static slidingWindow(max, window) { return { type: "sliding", max, window }; }
      },
    },
  };
}

{
  const moduleId = require.resolve("@anthropic-ai/sdk");
  class MockAnthropic {
    constructor(opts) {
      this.opts = opts;
      this.messages = {
        create: async (_params) => claudeMockResponse,
      };
    }
  }
  require.cache[moduleId] = {
    id: moduleId,
    filename: moduleId,
    loaded: true,
    exports: MockAnthropic,
  };
}

// ===== Mock fetch =====

const fetchMock = vi.fn(async () => ({
  ok: true,
  status: 200,
  async json() { return {}; },
  async text() { return ""; },
}));
vi.stubGlobal("fetch", fetchMock);

// ===== Env vars =====

process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
process.env.WHATSAPP_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "000000";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake";

// Import post-cache-patching.
const adminTesting = require("../src/admin-testing-mode");
const { parseTestingCommand, handleTestingCommand } = require("../api/webhook");
const { STAFF_PHONES } = require("../src/staff");

const ADMIN_PHONE = Object.keys(STAFF_PHONES)[0]; // ENMANUEL_PHONE
const CLIENT_PHONE = "18091234567";

// ===== Helpers =====

function lastWhatsappTextTo(phone) {
  const calls = fetchMock.mock.calls.filter(([url]) =>
    typeof url === "string" && url.includes("graph.facebook.com")
  );
  for (let i = calls.length - 1; i >= 0; i--) {
    const init = calls[i][1];
    if (!init?.body) continue;
    try {
      const body = JSON.parse(init.body);
      if (body.to === phone && body.type === "text") {
        return body.text.body;
      }
    } catch (_) {}
  }
  return null;
}

// ===== Tests =====

describe("parseTestingCommand — dispatcher de comandos", () => {
  it("reconoce /test-on, /test-off, /test-status exactos", () => {
    expect(parseTestingCommand("/test-on")).toBe("on");
    expect(parseTestingCommand("/test-off")).toBe("off");
    expect(parseTestingCommand("/test-status")).toBe("status");
  });

  it("tolera trim y case-insensitive", () => {
    expect(parseTestingCommand("  /TEST-ON  ")).toBe("on");
    expect(parseTestingCommand("/Test-Off")).toBe("off");
  });

  it("NO matchea texto regular que contenga el comando", () => {
    expect(parseTestingCommand("quiero /test-on please")).toBe(null);
    expect(parseTestingCommand("hola")).toBe(null);
    expect(parseTestingCommand("")).toBe(null);
    expect(parseTestingCommand(null)).toBe(null);
  });
});

describe("/test-on desde admin → activa correctamente", () => {
  beforeEach(() => {
    redisState.clear();
    redisExpiry.clear();
    fetchMock.mockClear();
  });

  it("activate(adminPhone) setea flag en Redis con TTL 1800s", async () => {
    const result = await adminTesting.activate(ADMIN_PHONE);
    expect(result.ok).toBe(true);
    expect(result.ttlSec).toBe(1800);
    expect(redisState.get("admin:testing-mode:" + ADMIN_PHONE)).toBe("active");
  });

  it("handleTestingCommand('on', adminPhone) responde con mensaje de confirmacion", async () => {
    await handleTestingCommand("on", ADMIN_PHONE);
    const reply = lastWhatsappTextTo(ADMIN_PHONE);
    expect(reply).toContain("Modo testing activado");
    expect(reply).toContain("/test-off");
    expect(await adminTesting.isActive(ADMIN_PHONE)).toBe(true);
  });
});

describe("/test-on desde cliente normal → NO activa, activate retorna not_admin", () => {
  beforeEach(() => {
    redisState.clear();
    redisExpiry.clear();
    fetchMock.mockClear();
  });

  it("activate(clientPhone) retorna {ok:false, reason:not_admin}", async () => {
    const result = await adminTesting.activate(CLIENT_PHONE);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_admin");
    // No se creo ningun flag en Redis.
    expect(redisState.get("admin:testing-mode:" + CLIENT_PHONE)).toBeUndefined();
  });

  it("webhook NO dispara handleTestingCommand si phone NO es staff", () => {
    // El webhook chequea STAFF_PHONES[inboundPhone] antes de llamar
    // handleTestingCommand. Aca validamos la logica de guard directamente.
    const isStaff = !!STAFF_PHONES[CLIENT_PHONE];
    expect(isStaff).toBe(false);
    // Si el cliente manda "/test-on", el webhook NO entra al dispatcher —
    // el mensaje cae al pipeline normal (processMessage).
  });
});

describe("/test-off desde admin → desactiva + limpia caja testing", () => {
  beforeEach(() => {
    redisState.clear();
    redisExpiry.clear();
    fetchMock.mockClear();
  });

  it("deactivate borra el flag Y limpia chat/meta/profile bajo testing:<phone>", async () => {
    // Simular estado tras uso de testing
    await adminTesting.activate(ADMIN_PHONE);
    const storageKey = "testing:" + ADMIN_PHONE;
    redisState.set("chat:" + storageKey, "fake-history");
    redisState.set("meta:" + storageKey, "fake-meta");
    redisState.set("profile:" + storageKey, "fake-profile");
    // Estado admin real (NO debe tocarse)
    redisState.set("chat:" + ADMIN_PHONE, "admin-real-history");
    redisState.set("meta:" + ADMIN_PHONE, "admin-real-meta");

    const result = await adminTesting.deactivate(ADMIN_PHONE);
    expect(result.ok).toBe(true);

    // Flag borrado
    expect(redisState.get("admin:testing-mode:" + ADMIN_PHONE)).toBeUndefined();
    // Caja testing limpia
    expect(redisState.get("chat:" + storageKey)).toBeUndefined();
    expect(redisState.get("meta:" + storageKey)).toBeUndefined();
    expect(redisState.get("profile:" + storageKey)).toBeUndefined();
    // Estado admin real INTACTO
    expect(redisState.get("chat:" + ADMIN_PHONE)).toBe("admin-real-history");
    expect(redisState.get("meta:" + ADMIN_PHONE)).toBe("admin-real-meta");
  });

  it("handleTestingCommand('off') responde con mensaje de bienvenida de vuelta", async () => {
    await adminTesting.activate(ADMIN_PHONE);
    await handleTestingCommand("off", ADMIN_PHONE);
    const reply = lastWhatsappTextTo(ADMIN_PHONE);
    expect(reply).toContain("Modo testing desactivado");
    expect(reply).toContain("historial admin sigue intacto");
  });
});

describe("/test-status → reporta activo/inactivo con minutos", () => {
  beforeEach(() => {
    redisState.clear();
    redisExpiry.clear();
    fetchMock.mockClear();
  });

  it("status activo reporta minutos restantes", async () => {
    await adminTesting.activate(ADMIN_PHONE);
    const status = await adminTesting.getStatus(ADMIN_PHONE);
    expect(status.active).toBe(true);
    expect(status.admin).toBe(true);
    expect(status.minutesRemaining).toBeGreaterThan(0);
    expect(status.minutesRemaining).toBeLessThanOrEqual(30);

    await handleTestingCommand("status", ADMIN_PHONE);
    const reply = lastWhatsappTextTo(ADMIN_PHONE);
    expect(reply).toContain("ACTIVO");
    expect(reply).toMatch(/\d+ minutos/);
  });

  it("status inactivo reporta correctamente", async () => {
    const status = await adminTesting.getStatus(ADMIN_PHONE);
    expect(status.active).toBe(false);
    expect(status.admin).toBe(true);

    await handleTestingCommand("status", ADMIN_PHONE);
    const reply = lastWhatsappTextTo(ADMIN_PHONE);
    expect(reply).toContain("INACTIVO");
    expect(reply).toContain("/test-on");
  });
});

describe("Aislamiento de estado — admin real NO se modifica durante testing", () => {
  beforeEach(() => {
    redisState.clear();
    redisExpiry.clear();
    fetchMock.mockClear();
  });

  it("getStorageKey retorna 'testing:<phone>' si inTesting, sino el phone", () => {
    expect(adminTesting.getStorageKey(ADMIN_PHONE, true)).toBe("testing:" + ADMIN_PHONE);
    expect(adminTesting.getStorageKey(ADMIN_PHONE, false)).toBe(ADMIN_PHONE);
  });

  it("isActive false post-deactivate (flag borrado)", async () => {
    await adminTesting.activate(ADMIN_PHONE);
    expect(await adminTesting.isActive(ADMIN_PHONE)).toBe(true);
    await adminTesting.deactivate(ADMIN_PHONE);
    expect(await adminTesting.isActive(ADMIN_PHONE)).toBe(false);
  });
});

describe("TTL expira → isActive devuelve false, siguiente mensaje usa flujo normal", () => {
  beforeEach(() => {
    redisState.clear();
    redisExpiry.clear();
    fetchMock.mockClear();
  });

  it("flag expira despues de TTL (simulado con expiry en el pasado)", async () => {
    await adminTesting.activate(ADMIN_PHONE);
    expect(await adminTesting.isActive(ADMIN_PHONE)).toBe(true);
    // Forzar expiracion en el mock: expiry en el pasado.
    redisExpiry.set("admin:testing-mode:" + ADMIN_PHONE, Date.now() - 1000);
    expect(await adminTesting.isActive(ADMIN_PHONE)).toBe(false);
    // getStorageKey con inTesting=false retorna phone original
    expect(adminTesting.getStorageKey(ADMIN_PHONE, false)).toBe(ADMIN_PHONE);
  });
});

describe("Rate limit: 6ta activacion en 1h rechazada con reason='rate_limit'", () => {
  beforeEach(() => {
    redisState.clear();
    redisExpiry.clear();
    fetchMock.mockClear();
  });

  it("5 activaciones OK, 6ta rechazada con reason='rate_limit'", async () => {
    // Cada activate() incrementa el counter + deactivate() borra el flag
    // pero NO toca el counter. Simulamos 5 ciclos exitosos + 1 rechazado.
    for (let i = 1; i <= 5; i++) {
      const result = await adminTesting.activate(ADMIN_PHONE);
      expect(result.ok).toBe(true);
      await adminTesting.deactivate(ADMIN_PHONE);
    }
    const sixth = await adminTesting.activate(ADMIN_PHONE);
    expect(sixth.ok).toBe(false);
    expect(sixth.reason).toBe("rate_limit");
    expect(sixth.max).toBe(5);
  });

  it("handleTestingCommand('on') muestra mensaje de limite al admin en la 6ta", async () => {
    for (let i = 1; i <= 5; i++) {
      await adminTesting.activate(ADMIN_PHONE);
      await adminTesting.deactivate(ADMIN_PHONE);
    }
    fetchMock.mockClear();
    await handleTestingCommand("on", ADMIN_PHONE);
    const reply = lastWhatsappTextTo(ADMIN_PHONE);
    expect(reply).toContain("límite");
    expect(reply).toContain("5");
  });
});
