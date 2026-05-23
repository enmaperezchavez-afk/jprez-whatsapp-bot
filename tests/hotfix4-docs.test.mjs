// Tests pipeline envio de documentos — hotfix-4 Día 3 (ACTUALIZADO Bloque 2).
//
// BLOQUE 2 (cambio de arquitectura): el dispatcher regex post-LLM
// (detectDocumentRequest) que auto-enviaba brochure/precios/imágenes a partir
// del TEXTO del reply quedó DESACTIVADO (LEGACY_REGEX_DOC_DISPATCH=false).
// La vía única de envío de documentos es ahora el tool enviar_documento, que
// Mateo invoca explícitamente (cobertura en tests/enviar-documento-tool.test.mjs).
//
// Estos tests originalmente validaban el auto-envío regex (FIX 1 imágenes
// teaser, FIX 3a mapeo planos→brochure). Ahora se conservan como GUARDA DE
// REGRESIÓN: un reply de texto que "promete" documentos NO debe disparar
// ningún envío automático (eso evita el doble-envío con el tool). Si alguien
// reactiva el flag, estos tests fallan y obligan a revisar la decisión.
//
// Patron heredado de tests/hotfix2-defense.test.mjs: require.cache patching
// para @upstash/redis, @upstash/ratelimit, @anthropic-ai/sdk + fetchMock global.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// ===== Estado compartido =====

const redisState = new Map();
let claudeMockResponse = null;

// ===== require.cache patching ANTES de cargar handlers =====

{
  const moduleId = require.resolve("@upstash/redis");
  require.cache[moduleId] = {
    id: moduleId,
    filename: moduleId,
    loaded: true,
    exports: {
      Redis: class {
        constructor() {}
        async get(key) {
          return redisState.has(key) ? redisState.get(key) : null;
        }
        async set(key, value, opts = {}) {
          if (opts && opts.nx && redisState.has(key)) return null;
          redisState.set(key, value);
          return "OK";
        }
        async del(key) {
          const had = redisState.has(key);
          redisState.delete(key);
          return had ? 1 : 0;
        }
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

// ===== Mock global fetch =====

const fetchMock = vi.fn(async () => ({
  ok: true,
  status: 200,
  async json() { return {}; },
  async text() { return ""; },
}));
vi.stubGlobal("fetch", fetchMock);

// ===== Env vars ANTES del require de message.js =====
// CRITICO: PROJECT_DOCS se construye al import time leyendo process.env.*,
// por lo que estas vars deben existir antes de cargar el modulo.

process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
process.env.WHATSAPP_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "000000";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake";

// Crux: brochure + precios (slot planos eliminado por FIX 3a) + images (IMG_CRUX)
process.env.PDF_CRUX_BROCHURE = "https://drive.google.com/fake/crux-brochure";
process.env.PDF_CRUX_PRECIOS = "https://drive.google.com/fake/crux-precios";
process.env.IMG_CRUX = "https://drive.google.com/fake/crux-img1,https://drive.google.com/fake/crux-img2";

// PR3: brochure + precios + planos, SIN IMG_PR3 (test de no-imagenes)
process.env.PDF_PR3_BROCHURE = "https://drive.google.com/fake/pr3-brochure";
process.env.PDF_PR3_PRECIOS = "https://drive.google.com/fake/pr3-precios";
process.env.PDF_PR3_PLANOS = "https://drive.google.com/fake/pr3-planos";

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
          contacts: [{ profile: { name: "Test Cliente" }, wa_id: phone }],
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
    .map(([_url, init]) => {
      try { return JSON.parse(init.body); } catch { return null; }
    })
    .filter((b) => b && b.to === phone && b.type === type);
}

function documentsSentTo(phone) {
  return whatsappMessagesByType(phone, "document");
}

function imagesSentTo(phone) {
  return whatsappMessagesByType(phone, "image");
}

// ===== Tests =====

describe("Bloque 2 — dispatcher regex DESACTIVADO (auto-envío de docs OFF)", () => {
  beforeEach(() => {
    redisState.clear();
    fetchMock.mockClear();
    claudeMockResponse = null;
  });

  it("reply de texto que promete precios de Crux → 0 docs, 0 imágenes auto-enviadas", async () => {
    claudeMockResponse = {
      content: [{
        type: "text",
        text: "Mira, los de Crux del Prado arrancan en RD$5.65M. Te mando el listado de precios ahora para que veas disponibilidad.",
      }],
      stop_reason: "end_turn",
    };
    const PHONE = "18091111001";
    await processMessage(buildBody(PHONE, "quiero precios de crux listos"));

    // El auto-envío regex está OFF: la entrega ahora es vía tool enviar_documento.
    expect(documentsSentTo(PHONE).length).toBe(0);
    expect(imagesSentTo(PHONE).length).toBe(0);
  }, 20000);

  it("reply que promete brochure + precios → 0 docs auto-enviados (sin doble-envío)", async () => {
    claudeMockResponse = {
      content: [{
        type: "text",
        text: "Dale, te mando el brochure y el listado de precios de Crux del Prado ahora.",
      }],
      stop_reason: "end_turn",
    };
    const PHONE = "18091111002";
    await processMessage(buildBody(PHONE, "mandame info de crux listos"));

    expect(documentsSentTo(PHONE).length).toBe(0);
    expect(imagesSentTo(PHONE).length).toBe(0);
  }, 20000);

  it("reply que promete precios de PR3 → 0 docs auto-enviados", async () => {
    claudeMockResponse = {
      content: [{
        type: "text",
        text: "Te mando el listado de precios de Prado Residences 3 ahora.",
      }],
      stop_reason: "end_turn",
    };
    const PHONE = "18091111003";
    await processMessage(buildBody(PHONE, "precios de pr3"));

    expect(documentsSentTo(PHONE).length).toBe(0);
    expect(imagesSentTo(PHONE).length).toBe(0);
  }, 20000);

  it("reply que promete planos/brochure de Crux → 0 docs auto-enviados", async () => {
    claudeMockResponse = {
      content: [{
        type: "text",
        text: "Te mando los planos y el brochure de Crux del Prado.",
      }],
      stop_reason: "end_turn",
    };
    const PHONE = "18091111004";
    await processMessage(buildBody(PHONE, "planos de crux listos"));

    expect(documentsSentTo(PHONE).length).toBe(0);
  }, 20000);

  it("reply que promete planos de PR3 → 0 docs auto-enviados", async () => {
    claudeMockResponse = {
      content: [{
        type: "text",
        text: "Te mando los planos de Prado Residences 3.",
      }],
      stop_reason: "end_turn",
    };
    const PHONE = "18091111007";
    await processMessage(buildBody(PHONE, "planos pr3"));

    expect(documentsSentTo(PHONE).length).toBe(0);
  }, 20000);
});
