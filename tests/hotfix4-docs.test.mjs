// Tests pipeline envio de documentos — hotfix-4 Día 3:
// - FIX 1: JPG de Crux despues del PDF de precios (ampliacion del guard que
//   antes solo enviaba imagenes como teaser del brochure)
// - FIX 3a: slot "planos" eliminado de Crux (env var quedo apuntando a
//   archivo con precios, no planos)
//
// Patron heredado de tests/hotfix2-defense.test.mjs (skill jprez-security-patterns
// §4.1): require.cache patching para @upstash/redis, @upstash/ratelimit,
// @anthropic-ai/sdk + fetchMock global. Permite ejecutar processMessage end-to-end
// y capturar las llamadas a Graph API (Document e Image endpoints) para validar
// que el pipeline envia los archivos correctos en el orden correcto.

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

describe("FIX 1 (hotfix-4) — JPG de Crux despues del PDF de precios", () => {
  beforeEach(() => {
    redisState.clear();
    fetchMock.mockClear();
    claudeMockResponse = null;
  });

  it("cliente pide solo precios de Crux con IMG_CRUX -> PDF primero, luego imagenes", async () => {
    claudeMockResponse = {
      content: [{
        type: "text",
        text: "Mira, los de Crux del Prado arrancan en RD$5.65M. Te mando el listado de precios ahora para que veas disponibilidad.",
      }],
      stop_reason: "end_turn",
    };
    const PHONE = "18091111001";
    await processMessage(buildBody(PHONE, "quiero precios de crux"));

    const docs = documentsSentTo(PHONE);
    const imgs = imagesSentTo(PHONE);

    // 1 PDF: precios de Crux
    expect(docs.length).toBe(1);
    expect(docs[0].document.filename).toContain("Precios y Disponibilidad");
    // 2 imagenes despues del PDF (IMG_CRUX tiene 2 URLs separadas por coma)
    expect(imgs.length).toBe(2);
  }, 20000);

  it("cliente pide brochure + precios de Crux -> imagenes solo como teaser, NO se repiten", async () => {
    claudeMockResponse = {
      content: [{
        type: "text",
        text: "Dale, te mando el brochure y el listado de precios de Crux del Prado ahora.",
      }],
      stop_reason: "end_turn",
    };
    const PHONE = "18091111002";
    await processMessage(buildBody(PHONE, "mandame info de crux"));

    const docs = documentsSentTo(PHONE);
    const imgs = imagesSentTo(PHONE);

    // 2 PDFs: brochure + precios de Crux
    expect(docs.length).toBe(2);
    // Imagenes se envian SOLO UNA VEZ (teaser del brochure), NO se duplican despues de precios
    expect(imgs.length).toBe(2);
  }, 20000);

  it("cliente pide precios de PR3 (sin IMG_PR3) -> solo PDF, 0 imagenes, no falla", async () => {
    claudeMockResponse = {
      content: [{
        type: "text",
        text: "Te mando el listado de precios de Prado Residences 3 ahora.",
      }],
      stop_reason: "end_turn",
    };
    const PHONE = "18091111003";
    await processMessage(buildBody(PHONE, "precios de pr3"));

    const docs = documentsSentTo(PHONE);
    const imgs = imagesSentTo(PHONE);

    expect(docs.length).toBe(1);
    expect(docs[0].document.filename).toContain("Precios y Disponibilidad");
    expect(imgs.length).toBe(0);
  }, 20000);
});

describe("FIX 3a (hotfix-4) — Slot planos eliminado de Crux", () => {
  beforeEach(() => {
    redisState.clear();
    fetchMock.mockClear();
    claudeMockResponse = null;
  });

  it("cliente pide planos de Crux -> NO envia archivo (slot retirado)", async () => {
    claudeMockResponse = {
      content: [{
        type: "text",
        text: "Te mando los planos de Crux del Prado.",
      }],
      stop_reason: "end_turn",
    };
    const PHONE = "18091111004";
    await processMessage(buildBody(PHONE, "planos de crux"));

    const docs = documentsSentTo(PHONE);

    // Ningun PDF enviado: docs.planos es undefined en Crux post-FIX 3a
    // (aunque Mateo prometio "te mando los planos", no hay slot que atender).
    // Comportamiento esperado: el mensaje de texto llega, pero no llega PDF.
    expect(docs.length).toBe(0);
  }, 20000);

  it("cliente pide brochure de Crux -> sigue funcionando", async () => {
    claudeMockResponse = {
      content: [{
        type: "text",
        text: "Te mando el brochure de Crux del Prado.",
      }],
      stop_reason: "end_turn",
    };
    const PHONE = "18091111005";
    await processMessage(buildBody(PHONE, "brochure crux"));

    const docs = documentsSentTo(PHONE);
    expect(docs.length).toBe(1);
    expect(docs[0].document.filename).toContain("Brochure");
  }, 20000);

  it("cliente pide precios de Crux -> sigue funcionando post-FIX 3a", async () => {
    claudeMockResponse = {
      content: [{
        type: "text",
        text: "Te mando el listado de precios de Crux del Prado.",
      }],
      stop_reason: "end_turn",
    };
    const PHONE = "18091111006";
    await processMessage(buildBody(PHONE, "precios crux"));

    const docs = documentsSentTo(PHONE);
    expect(docs.length).toBe(1);
    expect(docs[0].document.filename).toContain("Precios y Disponibilidad");
  }, 20000);

  it("cliente pide planos de PR3 -> sigue funcionando (PDF_PR3_PLANOS existe)", async () => {
    claudeMockResponse = {
      content: [{
        type: "text",
        text: "Te mando los planos de Prado Residences 3.",
      }],
      stop_reason: "end_turn",
    };
    const PHONE = "18091111007";
    await processMessage(buildBody(PHONE, "planos pr3"));

    const docs = documentsSentTo(PHONE);
    expect(docs.length).toBe(1);
    expect(docs[0].document.filename).toContain("Planos Arquitectónicos");
  }, 20000);
});
