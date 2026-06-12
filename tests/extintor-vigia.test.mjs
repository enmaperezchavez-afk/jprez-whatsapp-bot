// PROTOCOLO EXTINTOR + VIGÍA v2 [CORE] — override total + quién escribió
// durante el apagón. El extintor es el botón de emergencia rumbo a
// multitenant: tiene que ser INQUEBRANTABLE (fail-safe: jamás bloquea por
// error propio) y SUPERVISABLE (audit + /status).

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// ===== mock Redis stateful (patrón hotfix-6) =====
const state = new Map();
const sets = new Map();
{
  const moduleId = require.resolve("@upstash/redis");
  require.cache[moduleId] = {
    id: moduleId, filename: moduleId, loaded: true,
    exports: {
      Redis: class {
        async get(k) { return state.has(k) ? state.get(k) : null; }
        async set(k, v) { state.set(k, v); return "OK"; }
        async del(k) { state.delete(k); return 1; }
        async sadd(k, m) { if (!sets.has(k)) sets.set(k, new Set()); sets.get(k).add(m); return 1; }
        async srem(k, m) { sets.get(k)?.delete(m); return 1; }
        async smembers(k) { return [...(sets.get(k) || [])]; }
        async incr() { return 1; }
        async expire() { return 1; }
        async ttl() { return -1; }
      },
    },
  };
}
process.env.UPSTASH_REDIS_REST_URL = "https://mock.upstash.test";
process.env.UPSTASH_REDIS_REST_TOKEN = "mock";

const extintor = require("../src/extintor.js");
const vigia = require("../src/vigia.js");

beforeEach(() => { state.clear(); sets.clear(); });

describe("EXTINTOR — parser de comandos", () => {
  it("global on/off, status, pausa, despierta, relay", () => {
    expect(extintor.parseExtintorCommand("/extintor").command).toBe("global_on");
    expect(extintor.parseExtintorCommand("modo manual").command).toBe("global_on");
    expect(extintor.parseExtintorCommand("/extintor-off").command).toBe("global_off");
    expect(extintor.parseExtintorCommand("/status").command).toBe("status");
    expect(extintor.parseExtintorCommand("pausa al 18095551234")).toEqual({ command: "pause", phone: "18095551234" });
    expect(extintor.parseExtintorCommand("despierta al +1 809-555-1234")).toEqual({ command: "resume", phone: "18095551234" });
    const relay = extintor.parseExtintorCommand("dile al 18095551234: Hola, soy Enmanuel. Dame 10 minutos.");
    expect(relay).toEqual({ command: "relay", phone: "18095551234", texto: "Hola, soy Enmanuel. Dame 10 minutos." });
  });

  it("relay es VERBATIM (mayúsculas, acentos y saltos intactos) con sanitización mínima", () => {
    const r = extintor.parseExtintorCommand("dile al 18095551234: SÍ señor,\nel precio es US$163,400.");
    expect(r.texto).toBe("SÍ señor,\nel precio es US$163,400.");
    expect(extintor.sanitizeRelay("a" + String.fromCharCode(0) + "b")).toBe("ab");
    expect(extintor.sanitizeRelay("   ")).toBeNull();
    expect(extintor.sanitizeRelay("x".repeat(5000))).toHaveLength(4096);
  });

  it("mensajes normales del supervisor NO parsean (cero falsos positivos)", () => {
    expect(extintor.parseExtintorCommand("como va el inventario?")).toBeNull();
    expect(extintor.parseExtintorCommand("pausa un momento la negociación con ese cliente")).toBeNull();
    expect(extintor.parseExtintorCommand("dile a tu equipo que gracias")).toBeNull(); // sin número
  });
});

describe("EXTINTOR — estado y FAIL-SAFE", () => {
  it("global on/off + pausa por chat SIN TTL, persistente", async () => {
    await extintor.setGlobal(true, "admin");
    expect(await extintor.isGlobalOn()).toBe(true);
    await extintor.setGlobal(false, "admin");
    expect(await extintor.isGlobalOn()).toBe(false);

    await extintor.pauseChat("18095551234", "admin");
    expect(await extintor.isPaused("18095551234")).toBe(true);
    expect((await extintor.getStatus()).pausados).toContain("18095551234");
    await extintor.resumeChat("18095551234", "admin");
    expect(await extintor.isPaused("18095551234")).toBe(false);
  });

  it("FAIL-SAFE: si Redis revienta, el modo es NORMAL (el extintor nunca es el incendio)", async () => {
    state.set(extintor.GLOBAL_KEY, "on");
    const origGet = require("@upstash/redis").Redis.prototype.get;
    require("@upstash/redis").Redis.prototype.get = async () => { throw new Error("redis caído"); };
    expect(await extintor.isGlobalOn()).toBe(false); // degradación a normal
    expect(await extintor.isPaused("x")).toBe(false);
    expect((await extintor.getStatus()).modo).toBe("normal");
    require("@upstash/redis").Redis.prototype.get = origGet;
  });
});

describe("VIGÍA — huérfanos y reporte de recuperación", () => {
  it("esHuerfano: lag > 5 min = vivió un apagón", () => {
    const ahora = Date.now();
    expect(vigia.esHuerfano(Math.floor((ahora - 10 * 60 * 1000) / 1000), ahora)).toBe(true);
    expect(vigia.esHuerfano(Math.floor((ahora - 30 * 1000) / 1000), ahora)).toBe(false);
    expect(vigia.esHuerfano(undefined, ahora)).toBe(false); // sin timestamp = normal
  });

  it("registra ventana + huérfanos, reporta UNA vez con calientes/escalados, y reabre", async () => {
    const ts = Math.floor((Date.now() - 60 * 60 * 1000) / 1000);
    await vigia.registrarHuerfano({ phone: "18091112222", name: "Juan", tsSec: ts });
    await vigia.registrarHuerfano({ phone: "18091112222", name: "Juan", tsSec: ts + 300 });
    await vigia.registrarHuerfano({ phone: "18093334444", name: "Ana", tsSec: ts + 60 });

    const metas = {
      "18091112222": { temperature: "hot" },
      "18093334444": { escalated: true },
    };
    const reporte = await vigia.chequearRecuperacion({
      getMeta: async (p) => metas[p] || null,
      extintorStatus: "normal",
    });
    expect(reporte).toContain("[VIGÍA]");
    expect(reporte).toContain("recuperados): 2");
    expect(reporte).toContain("18091112222 (Juan) — 2 msj");
    expect(reporte).toMatch(/🔥/);
    expect(reporte).toMatch(/🆘/);
    expect(reporte).toMatch(/Meta entregó tarde/);

    // segunda vez: ya reportada → null
    expect(await vigia.chequearRecuperacion({ getMeta: async () => null })).toBeNull();

    // un huérfano nuevo tras el reporte ABRE ventana nueva
    await vigia.registrarHuerfano({ phone: "18095556666", name: "Luis", tsSec: Math.floor(Date.now() / 1000) - 600 });
    const v = await vigia.getVentana(await (require("../src/store/redis").getRedis()));
    expect(v.reported).toBe(false);
    expect(Object.keys(v.huerfanos)).toEqual(["18095556666"]);
  });
});

describe("EXTINTOR + VIGÍA — wiring en el handler", () => {
  const handler = readFileSync("src/handlers/message.js", "utf8");

  it("comandos del admin corren ANTES del eco/pending/natural y el global_on confirma", () => {
    const idxExt = handler.indexOf("parseExtintorCommand(userMessage)");
    const idxEco = handler.indexOf("esEcoConfirmacion(userMessage)");
    expect(idxExt).toBeGreaterThan(0);
    expect(idxExt).toBeLessThan(idxEco);
    expect(handler).toMatch(/extintor: true/); // pending especial del botón rojo
    expect(handler).toMatch(/EXTINTOR ACTIVADO/);
  });

  it("gate de clientes: held + reenvío al Director + return; vigía registra y disculpa", () => {
    expect(handler).toMatch(/extintor_message_held/);
    expect(handler).toMatch(/esHuerfano\(messageTsSec\)/);
    expect(handler).toMatch(/registrarHuerfano/);
    expect(handler).toMatch(/DISCULPA_HUERFANO/);
    expect(handler).toMatch(/chequearRecuperacion/);
    // el timestamp de Meta se captura del mensaje crudo
    expect(handler).toMatch(/Number\(message\.timestamp\)/);
  });

  it("relay: verbatim + historial del cliente + audit", () => {
    expect(handler).toMatch(/extintor_relay/);
    expect(handler).toMatch(/Enviado verbatim/);
  });

  it("/status incluye modo + pausados + ventana del vigía", () => {
    expect(handler).toMatch(/Chats pausados/);
    expect(handler).toMatch(/ventana de apagón ABIERTA/);
  });
});
