// Hotfix-21 c4 — Bug #23 e2e regression (con env var PDF_CRUX_PRECIOS_T6).
//
// Reproduce el bug literal observado en produccion el 5 mayo 2026:
//
//   1) Cliente recibio crux.brochure + crux.images en mensaje 1
//   2) Cliente dice "en planos" en mensaje 2
//   3) PRE-FIX: dispatcher reenvio MISMO brochure + MISMA imagen
//      → cliente recibio archivos duplicados → bot dijo "te envio la
//      informacion" sin agregar valor.
//
// POST-FIX (Hotfix-21 c1+c2+c3):
//   - Policy guard bloquea brochure y images (already-sent)
//   - detectCruxStage("...", "en planos") = "T6"
//   - Dispatcher entra al bloque especial Crux T6 y manda preciosT6
//     (Drive ID separado, archivo NUEVO que el cliente no tiene)
//   - Bot AVANZA con info Torre 6 (precios, plan, entrega)
//
// COBERTURA (2 tests):
//   1. Bug #23 con env var T6 → bloqueo + envio preciosT6 + logs correctos
//   2. Override explicit-retransmit ("manda otra vez") → reenvia brochure
//
// El archivo hermano hotfix21-c4-bug23-fallback.test.mjs cubre el
// escenario SIN env var T6 (fallback texto, 0 envios, NO escalacion).
//
// Patron heredado de tests/hotfix4-docs.test.mjs.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// ===== Estado compartido =====

const redisState = new Map();
const consoleLogCalls = [];
let claudeMockResponse = null;

// ===== require.cache patching ANTES de cargar handlers =====

{
  const moduleId = require.resolve("@upstash/redis");
  require.cache[moduleId] = {
    id: moduleId, filename: moduleId, loaded: true,
    exports: {
      Redis: class {
        constructor() {}
        async get(key) { return redisState.has(key) ? redisState.get(key) : null; }
        async set(key, value, opts = {}) {
          if (opts && opts.nx && redisState.has(key)) return null;
          redisState.set(key, value); return "OK";
        }
        async del(key) { const had = redisState.has(key); redisState.delete(key); return had ? 1 : 0; }
        async lrange() { return []; }
        async rpush() { return 1; }
        async ltrim() { return "OK"; }
        async expire() { return 1; }
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
    id: moduleId, filename: moduleId, loaded: true,
    exports: {
      Ratelimit: class {
        constructor(config) { this.config = config; }
        async limit() { return { success: true, limit: 9999, remaining: 9999, reset: Date.now() + 60000 }; }
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
      this.messages = { create: async (_params) => claudeMockResponse };
    }
  }
  require.cache[moduleId] = {
    id: moduleId, filename: moduleId, loaded: true,
    exports: MockAnthropic,
  };
}

// ===== Mock global fetch =====

const fetchMock = vi.fn(async () => ({
  ok: true, status: 200,
  async json() { return {}; },
  async text() { return ""; },
}));
vi.stubGlobal("fetch", fetchMock);

// ===== Env vars (CRITICO: ANTES del require de message.js) =====

process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
process.env.WHATSAPP_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "000000";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake";

process.env.PDF_CRUX_BROCHURE = "https://drive.google.com/fake/crux-brochure";
process.env.PDF_CRUX_PRECIOS = "https://drive.google.com/fake/crux-precios";
// CRITICO para este archivo: PDF_CRUX_PRECIOS_T6 SETEADO.
process.env.PDF_CRUX_PRECIOS_T6 = "https://drive.google.com/fake/crux-precios-t6";
process.env.IMG_CRUX = "https://drive.google.com/fake/crux-img1,https://drive.google.com/fake/crux-img2";

const { processMessage } = require("../src/handlers/message");

// ===== Helpers =====

function buildBody(phone, text) {
  return {
    entry: [{
      changes: [{
        value: {
          messages: [{
            from: phone,
            type: "text",
            text: { body: text },
            id: "wamid." + Date.now() + "." + Math.random().toString(36).slice(2, 8),
          }],
          contacts: [{ profile: { name: "Cliente Test" }, wa_id: phone }],
        },
      }],
    }],
  };
}

function whatsappCalls() {
  return fetchMock.mock.calls.filter(([url]) =>
    typeof url === "string" && url.includes("graph.facebook.com")
  );
}

function whatsappMessagesByType(phone, type) {
  return whatsappCalls()
    .map(([_url, init]) => { try { return JSON.parse(init.body); } catch { return null; } })
    .filter((b) => b && b.to === phone && b.type === type);
}

function documentsSentTo(phone) { return whatsappMessagesByType(phone, "document"); }
function imagesSentTo(phone) { return whatsappMessagesByType(phone, "image"); }
function textsSentTo(phone) { return whatsappMessagesByType(phone, "text"); }

// Pre-popular meta:<phone> con sentDocs poblado para reproducir Bug #23.
function seedClientMeta(phone, sentDocs) {
  const meta = {
    name: "Cliente Bug 23",
    sentDocs,
    lastContact: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // hace 5 min
  };
  redisState.set("meta:" + phone, JSON.stringify(meta));
}

// ===== Tests =====

// BLOQUE 2: el dispatcher regex que enviaba brochure/precios/T6/imágenes a
// partir del texto del reply quedó DESACTIVADO. La entrega es ahora vía el
// tool enviar_documento. Estos tests, antes guardas de Bug #23 (dedup +
// routing T6), ahora garantizan que NINGÚN documento se auto-envía desde el
// texto del reply — eliminando de raíz el doble-envío que el tool podría
// causar si el regex siguiera activo.
describe("Bloque 2 — Bug #23 obsoleto: regex dispatch OFF → 0 auto-envíos", () => {
  let consoleSpy;
  beforeEach(() => {
    redisState.clear();
    fetchMock.mockClear();
    claudeMockResponse = null;
    consoleLogCalls.length = 0;
    consoleSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      consoleLogCalls.push(args);
    });
  });

  it("Test 1: 'en planos' con sentDocs poblado → 0 docs y 0 imágenes auto-enviadas", async () => {
    const PHONE = "18091112301";
    seedClientMeta(PHONE, {
      "crux.brochure": "2026-05-05T18:00:00Z",
      "crux.images": "2026-05-05T18:01:00Z",
    });

    claudeMockResponse = {
      content: [{
        type: "text",
        text: "Mira, para Torre 6 los precios arrancan en US$99K con plan 10/30/60. Te mando el listado de precios Torre 6 ahorita para que veas pisos y disponibilidad.",
      }],
      stop_reason: "end_turn",
    };

    await processMessage(buildBody(PHONE, "en planos"));

    // Regex dispatch OFF → nada se auto-envía (ni duplicados ni T6).
    expect(documentsSentTo(PHONE).length).toBe(0);
    expect(imagesSentTo(PHONE).length).toBe(0);
  }, 20000);

  it("Test 2: 'manda otra vez' → tampoco auto-envía (retransmit ahora vía tool)", async () => {
    const PHONE = "18091112302";
    seedClientMeta(PHONE, {
      "crux.brochure": "2026-05-05T18:00:00Z",
    });

    claudeMockResponse = {
      content: [{
        type: "text",
        text: "Dale, te mando el brochure de Crux Torre 6 otra vez.",
      }],
      stop_reason: "end_turn",
    };

    await processMessage(buildBody(PHONE, "no me llego el brochure de torre 6, mandalo otra vez"));

    // Sin auto-envío regex: el reenvío explícito lo maneja Mateo invocando
    // de nuevo el tool enviar_documento (no este camino).
    expect(documentsSentTo(PHONE).length).toBe(0);
  }, 20000);
});
