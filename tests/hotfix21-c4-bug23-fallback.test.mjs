// Hotfix-21 c4 — Bug #23 e2e fallback (SIN env var PDF_CRUX_PRECIOS_T6).
//
// Decision Director "Hibrida C": cuando PDF_CRUX_PRECIOS_T6 NO esta
// configurado en el ambiente, el dispatcher NO debe escalar a Enmanuel
// con "lo coordino con Enmanuel". El commercial-layer instruye al modelo
// a dar los datos en texto y avanzar — la info de Torre 6 esta arriba
// en el prompt.
//
// Este archivo es hermano de hotfix21-c4-bug23-e2e.test.mjs. Razon de
// archivos separados: PROJECT_DOCS se construye al import time leyendo
// process.env.PDF_CRUX_PRECIOS_T6. Para testear AMBOS escenarios sin
// recargar modulos en runtime (vi.resetModules), usamos archivos
// independientes con env vars distintas.
//
// COBERTURA (1 test):
//   3. Bug #23 SIN env var T6 → bloqueo brochure/images + 0 envios T6 +
//      NO escalacion "lo coordino con Enmanuel" + commercial-layer
//      garantiza info en texto al cliente.

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

// ===== Env vars (CRITICO: PDF_CRUX_PRECIOS_T6 AUSENTE para este archivo) =====

process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
process.env.WHATSAPP_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "000000";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake";

process.env.PDF_CRUX_BROCHURE = "https://drive.google.com/fake/crux-brochure";
process.env.PDF_CRUX_PRECIOS = "https://drive.google.com/fake/crux-precios";
delete process.env.PDF_CRUX_PRECIOS_T6; // CRITICO: env var ausente.
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

function seedClientMeta(phone, sentDocs) {
  const meta = {
    name: "Cliente Bug 23",
    sentDocs,
    lastContact: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  };
  redisState.set("meta:" + phone, JSON.stringify(meta));
}

// ===== Tests =====

describe("Hotfix-21 c4 — Bug #23 fallback (SIN env var PDF_CRUX_PRECIOS_T6)", () => {
  beforeEach(() => {
    redisState.clear();
    fetchMock.mockClear();
    claudeMockResponse = null;
    consoleLogCalls.length = 0;
    vi.spyOn(console, "log").mockImplementation((...args) => {
      consoleLogCalls.push(args);
    });
  });

  it("Test 3: env var T6 ausente → bloqueo + 0 envios T6 + NO escalacion 'lo coordino con Enmanuel'", async () => {
    const PHONE = "18091112303";
    seedClientMeta(PHONE, {
      "crux.brochure": "2026-05-05T18:00:00Z",
      "crux.images": "2026-05-05T18:01:00Z",
    });

    // Mateo dice frase gatillo (forzar al dispatcher a evaluar la rama
    // PDF) + datos Torre 6 en texto. En produccion el commercial-layer
    // induciria al modelo a evitar frase gatillo cuando NO hay archivo,
    // pero aqui mockeamos un escenario worst-case: reply con frase
    // gatillo ANUNCIANDO envio T6, env var ausente. El dispatcher debe:
    //   - bloquear brochure/images (already-sent)
    //   - saltar "precios" del loop (cruxStage T6)
    //   - NO entrar al bloque T6 especial (docs.preciosT6 null)
    //   - NO emitir fallback "lo coordino con Enmanuel" porque
    //     missingDocTypes queda vacio (no se intento evaluar precios sin URL).
    claudeMockResponse = {
      content: [{
        type: "text",
        text: "Mira, Torre 6 desde US$99K, plan 10/30/60, entrega Jul 2027, 42 de 50 disponibles. Te mando el listado de precios Torre 6 ahorita.",
      }],
      stop_reason: "end_turn",
    };

    await processMessage(buildBody(PHONE, "en planos"));

    const docs = documentsSentTo(PHONE);
    const imgs = imagesSentTo(PHONE);
    const texts = textsSentTo(PHONE);

    // CORE ASSERT: NO se mando NINGUN documento (brochure bloqueado por
    // sentDocs, precios general saltado por skip cruxStage T6, preciosT6
    // ausente por env var).
    expect(docs.length).toBe(0);
    expect(imgs.length).toBe(0);

    // CORE ASSERT: NO se envio el mensaje fallback "lo coordino con Enmanuel"
    // — Hotfix-21 c3 elimina esa escalacion para Torre 6 (info esta en
    // commercial-layer + bot ya respondio en texto via Claude).
    const escalationFallback = texts.find((t) =>
      t.text && t.text.body && t.text.body.includes("lo coordino con Enmanuel")
    );
    expect(escalationFallback).toBeUndefined();

    // Logs: bloqueos confirmados.
    const findLog = (name) => consoleLogCalls.find((args) => args[0] === name);
    expect(findLog("pdf_skip_already_sent")).toBeDefined();
    expect(findLog("img_skip_already_sent")).toBeDefined();
  }, 20000);
});
