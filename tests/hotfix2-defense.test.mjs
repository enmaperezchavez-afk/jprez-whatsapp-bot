// Tests defensa en profundidad — hotfix-2 Día 3.
//
// Cubre los 3 fixes:
//   - Fix A: empty-reply guard cuando Mateo emite solo el bloque <perfil_update>
//   - Fix B: safety net en catch top-level cuando Claude tira excepcion
//   - Fix C: refuerzo del prompt v5.2 con instruccion de colocacion
//
// Patron heredado de tests/idempotency.test.mjs (skill jprez-security-patterns):
// require.cache patching para @upstash/redis, @upstash/ratelimit y
// @anthropic-ai/sdk. Permite ejecutar processMessage en isolation con flujo
// real pero sin dependencias externas. Ver §4.1 del skill.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// ===== Estado de mocks compartido =====

const redisState = new Map();

// Respuesta mockeable de Claude. Cada test reasigna `claudeMockResponse` o
// `claudeMockShouldThrow` antes de disparar processMessage.
let claudeMockResponse = null;
let claudeMockShouldThrow = null;

// ===== require.cache patching ANTES de cualquier import del codigo =====

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

// Mock @anthropic-ai/sdk: Anthropic se exporta como default en src/claude.js
// (`const Anthropic = require("@anthropic-ai/sdk")`). Reflejamos esa forma
// y exponemos messages.create configurable por test.
{
  const moduleId = require.resolve("@anthropic-ai/sdk");
  class MockAnthropic {
    constructor(opts) {
      this.opts = opts;
      this.messages = {
        create: async (_params) => {
          if (claudeMockShouldThrow) {
            throw claudeMockShouldThrow;
          }
          return claudeMockResponse;
        },
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

// ===== Mock global fetch (captura outbound a WhatsApp y Axiom) =====

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

// Import dinamico despues del cache patching
const { processMessage } = require("../src/handlers/message");
const { buildSystemPrompt } = require("../src/prompts");

// ===== Helpers =====

function buildBody(phone, text) {
  return {
    entry: [{
      changes: [{
        value: {
          messages: [{ from: phone, type: "text", text: { body: text }, id: "wamid." + Date.now() }],
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

function lastWhatsappBody() {
  const calls = whatsappCalls();
  if (calls.length === 0) return null;
  const lastCall = calls[calls.length - 1];
  const init = lastCall[1];
  if (!init?.body) return null;
  try { return JSON.parse(init.body); } catch { return null; }
}

function whatsappMessagesSentTo(phone) {
  return whatsappCalls()
    .map(([_url, init]) => {
      try { return JSON.parse(init.body); } catch { return null; }
    })
    .filter((b) => b && b.to === phone && b.type === "text")
    .map((b) => b.text.body);
}

// ===== Tests =====

describe("Fix A — Empty-reply guard", () => {
  beforeEach(() => {
    redisState.clear();
    fetchMock.mockClear();
    claudeMockResponse = null;
    claudeMockShouldThrow = null;
  });

  it("Mateo emite SOLO el bloque <perfil_update> sin texto -> handler envia fallback", async () => {
    // Claude retorna text block que contiene solo el bloque perfil_update.
    // Es el caso de borde que dejaba al cliente en visto antes del hotfix-2.
    claudeMockResponse = {
      content: [{
        type: "text",
        text: '<perfil_update>\n{"nombre": "Marinelly", "score_lead": "frio"}\n</perfil_update>',
      }],
      stop_reason: "end_turn",
    };

    const PHONE = "18091112222";
    await processMessage(buildBody(PHONE, "Cuanto cuesta el de 3 hab en Crux del Prado?"));

    const messages = whatsappMessagesSentTo(PHONE);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    // El cliente recibio el fallback Mateo-natural, NO el bloque crudo
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg).toContain("Dame un segundo");
    expect(lastMsg).toContain("se me complicó algo");
    // El bloque NUNCA se filtra al cliente
    expect(lastMsg).not.toContain("<perfil_update>");
    expect(lastMsg).not.toContain("Marinelly");
  });

  it("Mateo emite texto VACIO (despues de strip de tags) -> handler envia fallback", async () => {
    // Texto solo con tags sin contenido. Tras strip queda "".
    claudeMockResponse = {
      content: [{ type: "text", text: "[LEAD_CALIENTE]" }],
      stop_reason: "end_turn",
    };

    const PHONE = "18093334444";
    await processMessage(buildBody(PHONE, "Hola"));

    const messages = whatsappMessagesSentTo(PHONE);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg).toContain("Dame un segundo");
    expect(lastMsg).not.toBe("");
    expect(lastMsg).not.toContain("[LEAD_CALIENTE]");
  });

  it("Mateo emite texto + bloque -> cliente recibe SOLO el texto (no falla guard)", async () => {
    claudeMockResponse = {
      content: [{
        type: "text",
        text: 'Mira, arranca desde US$98K. Te lo mando ahora.\n\n<perfil_update>\n{"nombre": "Juan"}\n</perfil_update>',
      }],
      stop_reason: "end_turn",
    };

    const PHONE = "18095556666";
    await processMessage(buildBody(PHONE, "Cuanto cuesta el 3 hab?"));

    const messages = whatsappMessagesSentTo(PHONE);
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg).toContain("US$98K");
    expect(lastMsg).toContain("Te lo mando ahora");
    // El bloque NO viaja al cliente
    expect(lastMsg).not.toContain("<perfil_update>");
    expect(lastMsg).not.toContain("Juan");
    // Fallback NO se dispara cuando hay texto valido
    expect(lastMsg).not.toContain("Dame un segundo");
  });
});

describe("Fix B — Safety net en catch top-level", () => {
  beforeEach(() => {
    redisState.clear();
    fetchMock.mockClear();
    claudeMockResponse = null;
    claudeMockShouldThrow = null;
  });

  it("Claude tira excepcion -> safety net envia fallback al cliente", async () => {
    claudeMockShouldThrow = new Error("Anthropic 500: internal server error");

    const PHONE = "18097778888";
    await processMessage(buildBody(PHONE, "Hola"));

    const messages = whatsappMessagesSentTo(PHONE);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg).toContain("Dame un segundo");
    expect(lastMsg).toContain("se me complicó algo");
  });

  it("Body invalido (sin senderPhone) -> NO crashea, no envia mensaje", async () => {
    // Body sin messages -> processMessage retorna temprano sin ejecutar nada
    // (no hay senderPhone, el catch no envia fallback porque no hay a quien)
    await processMessage({ entry: [{ changes: [{ value: {} }] }] });
    const messages = whatsappCalls();
    expect(messages.length).toBe(0);
  });

  it("Caso normal (Claude responde texto valido) -> NO se dispara safety net", async () => {
    claudeMockResponse = {
      content: [{ type: "text", text: "Hola, soy Mateo. ¿En que te ayudo?" }],
      stop_reason: "end_turn",
    };

    const PHONE = "18099990000";
    await processMessage(buildBody(PHONE, "Hola"));

    const messages = whatsappMessagesSentTo(PHONE);
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg).toContain("Mateo");
    // Fallback NO se dispara cuando todo va bien
    expect(lastMsg).not.toContain("se me complicó algo");
  });
});

describe("Fix C — Refuerzo del prompt v5.2", () => {
  it("buildSystemPrompt incluye REGLA CRÍTICA DE COLOCACIÓN", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("REGLA CRÍTICA DE COLOCACIÓN");
  });

  it("buildSystemPrompt explicita que el bloque va AL FINAL del mensaje", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("AL FINAL");
  });

  it("buildSystemPrompt advierte que si solo emites el bloque el cliente queda en visto", () => {
    const prompt = buildSystemPrompt();
    expect(prompt.toLowerCase()).toContain("queda en visto");
  });

  it("buildSystemPrompt incluye patron correcto + anti-patron", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Patrón correcto");
    expect(prompt).toContain("Patrón INCORRECTO");
  });
});
