// Hotfix-22 V3 r4 — Tests del empty-reply guard de 4 niveles.
//
// COBERTURA (6 casos):
//   1. Bloque <perfil_update> cerrado normal → strip funciona como hoy.
//   2. JSON malformado dentro de bloque cerrado → strip aplica, json=null,
//      texto al cliente queda limpio (cubierto por extractor existente).
//   3. stop_reason="max_tokens" + bloque <perfil_update> truncated SIN
//      cierre + texto antes → recovery preserva texto antes, strip
//      manual del fragmento. Log claude_truncated_with_recovery.
//   4. stop_reason="max_tokens" + bloque truncated SIN cierre SIN texto
//      antes → fallback empty-reply caso 4. Log claude_truncated_with_recovery
//      + empty_reply_after_strip.
//   5. stop_reason="max_tokens" SIN bloque (texto parcial) → texto
//      parcial al cliente. Log claude_truncated_no_block.
//   6. Empty post-strip (Mateo emitio solo metadata) → fallback
//      generico hotfix-2. Log empty_reply_after_strip.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// ===== Estado compartido =====
const redisState = new Map();
const botLogCalls = [];
let claudeMockSequence = [];

// ===== Mocks (require.cache patching) =====

{
  const id = require.resolve("@upstash/redis");
  require.cache[id] = {
    id, filename: id, loaded: true,
    exports: {
      Redis: class {
        constructor() {}
        async get(key) { return redisState.has(key) ? redisState.get(key) : null; }
        async set(key, value) { redisState.set(key, value); return "OK"; }
        async del(key) { const had = redisState.has(key); redisState.delete(key); return had ? 1 : 0; }
        async lrange() { return []; }
        async rpush() { return 1; }
        async ltrim() { return "OK"; }
        async expire() { return 1; }
        async hget() { return null; }
        async hset() { return 1; }
        async hmget() { return []; }
        async incr() { return 1; }
      },
    },
  };
}

{
  const id = require.resolve("@upstash/ratelimit");
  require.cache[id] = {
    id, filename: id, loaded: true,
    exports: {
      Ratelimit: class {
        constructor(c) { this.config = c; }
        async limit() { return { success: true, limit: 9999, remaining: 9999, reset: Date.now() + 60000 }; }
        static slidingWindow(max, w) { return { type: "sliding", max, w }; }
      },
    },
  };
}

{
  const id = require.resolve("@anthropic-ai/sdk");
  class MockAnthropic {
    constructor(opts) {
      this.opts = opts;
      this.messages = {
        create: (_params) => {
          const promise = Promise.resolve().then(() => {
            if (claudeMockSequence.length === 0) throw new Error("MockAnthropic: out of mocked responses");
            return claudeMockSequence.shift();
          });
          // Hotfix-22 V3 r4: emular .withResponse() del SDK real, que
          // retorna { data, response } donde response.headers tiene
          // Headers HTTP estándar (.get()).
          promise.withResponse = () => promise.then((data) => ({
            data,
            response: { headers: new Map() },
          }));
          // Adapter para que .get() funcione como Headers HTTP.
          // Map.get devuelve undefined si no existe, Headers.get devuelve null.
          // En el código real verificamos != null, así que undefined o null
          // ambos saltan el log de ratelimit.
          return promise;
        },
      };
    }
  }
  require.cache[id] = { id, filename: id, loaded: true, exports: MockAnthropic };
}

// botLog mock
{
  const id = require.resolve("../src/log");
  require.cache[id] = {
    id, filename: id, loaded: true,
    exports: {
      botLog: (level, message, data) => botLogCalls.push({ level, message, data }),
      logToAxiom: async () => {},
    },
  };
}

// Mock src/whatsapp para capturar sendWhatsAppMessage.
let lastSentMessage = null;
{
  const id = require.resolve("../src/whatsapp");
  const real = require("../src/whatsapp");
  require.cache[id] = {
    id, filename: id, loaded: true,
    exports: {
      ...real,
      sendWhatsAppMessage: async (phone, text) => {
        lastSentMessage = { phone, text };
        return { success: true };
      },
      sendWhatsAppDocument: async () => ({ success: true }),
      sendWhatsAppImage: async () => ({ success: true }),
      transcribeWhatsAppAudio: async () => null,
    },
  };
}

// Mock global fetch
const fetchMock = vi.fn(async () => ({
  ok: true, status: 200,
  async json() { return {}; },
  async text() { return ""; },
}));
vi.stubGlobal("fetch", fetchMock);

// Env vars críticas
process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
process.env.WHATSAPP_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "000000";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake";

const { processMessage } = require("../src/handlers/message");

function buildBody(phone, text) {
  return {
    entry: [{
      changes: [{
        value: {
          messages: [{
            from: phone,
            type: "text",
            id: "wamid." + Date.now() + "." + Math.random().toString(36).slice(2, 8),
            text: { body: text },
          }],
          contacts: [{ profile: { name: "Cliente Test" }, wa_id: phone }],
        },
      }],
    }],
  };
}

function mockResponse(text, stop_reason = "end_turn") {
  return {
    content: [{ type: "text", text }],
    stop_reason,
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

describe("Hotfix-22 V3 r4 — empty-reply guard 4 niveles", () => {
  beforeEach(() => {
    redisState.clear();
    fetchMock.mockClear();
    claudeMockSequence = [];
    botLogCalls.length = 0;
    lastSentMessage = null;
  });

  it("Caso 1: bloque <perfil_update> cerrado normal → strip preserva texto", async () => {
    const reply = "Mira, los precios de PR4 arrancan en US$140,000.\n\n<perfil_update>\n{\"score_lead\": \"caliente\"}\n</perfil_update>";
    claudeMockSequence = [mockResponse(reply)];
    await processMessage(buildBody("18091111111", "info pr4"));
    expect(lastSentMessage).toBeTruthy();
    expect(lastSentMessage.text).toContain("PR4");
    expect(lastSentMessage.text).not.toContain("<perfil_update>");
    expect(lastSentMessage.text).not.toContain("score_lead");
  });

  it("Caso 2: JSON malformado en bloque cerrado → strip funciona, no leak", async () => {
    const reply = "Te tengo info.\n\n<perfil_update>\n{score_lead: caliente}\n</perfil_update>";
    claudeMockSequence = [mockResponse(reply)];
    await processMessage(buildBody("18092222222", "info"));
    expect(lastSentMessage.text).toBe("Te tengo info.");
    expect(lastSentMessage.text).not.toContain("score_lead");
    // Bloque malformado loguea warn.
    const malformedLog = botLogCalls.find((c) => c.message === "Bloque <perfil_update> invalido");
    // Nota: extractor retorna json=null para malformados → no loguea "invalido"
    // (solo loguea cuando json existe pero validateProfileUpdate falla).
    // Para JSON que falla parse, json=null → skip log. Es OK — el strip sí aplica.
    void malformedLog;
  });

  it("Caso 3: max_tokens + bloque truncated SIN cierre + texto antes → recovery preserva texto", async () => {
    const reply = "Mira, los precios de PR4 arrancan en US$140,000.\n\n<perfil_update>\n{\"score_lead\":";
    claudeMockSequence = [mockResponse(reply, "max_tokens")];
    await processMessage(buildBody("18093333333", "info pr4"));
    expect(lastSentMessage).toBeTruthy();
    expect(lastSentMessage.text).toContain("PR4");
    expect(lastSentMessage.text).not.toContain("<perfil_update>");
    expect(lastSentMessage.text).not.toContain("score_lead");
    // Log claude_truncated_with_recovery.
    const recoveryLog = botLogCalls.find((c) => c.message === "claude_truncated_with_recovery");
    expect(recoveryLog).toBeDefined();
    expect(recoveryLog.level).toBe("warn");
    expect(recoveryLog.data.beforeBlockChars).toBeGreaterThan(0);
    expect(recoveryLog.data.stop_reason).toBe("max_tokens");
  });

  it("Caso 4: max_tokens + bloque truncated SIN cierre SIN texto antes → fallback genérico", async () => {
    const reply = "<perfil_update>\n{\"score_lead\":";
    claudeMockSequence = [mockResponse(reply, "max_tokens")];
    await processMessage(buildBody("18094444444", "hi"));
    expect(lastSentMessage).toBeTruthy();
    expect(lastSentMessage.text).toContain("se me complic");
    expect(lastSentMessage.text).not.toContain("<perfil_update>");
    // Ambos logs: recovery (con beforeBlockChars=0) + empty_reply_after_strip.
    const recoveryLog = botLogCalls.find((c) => c.message === "claude_truncated_with_recovery");
    expect(recoveryLog).toBeDefined();
    expect(recoveryLog.data.beforeBlockChars).toBe(0);
    const emptyLog = botLogCalls.find((c) => c.message === "empty_reply_after_strip");
    expect(emptyLog).toBeDefined();
    expect(emptyLog.data.truncated_recovery_applied).toBe(true);
  });

  it("Caso 5: max_tokens SIN bloque (texto puro truncado) → texto parcial al cliente", async () => {
    const reply = "Mira, los precios de PR4 arrancan en US$140,000 y van hasta US$310,000 dependiendo del tipo. La en";
    claudeMockSequence = [mockResponse(reply, "max_tokens")];
    await processMessage(buildBody("18095555555", "info"));
    expect(lastSentMessage.text).toContain("PR4");
    expect(lastSentMessage.text).not.toContain("se me complic");
    // Log claude_truncated_no_block.
    const noBlockLog = botLogCalls.find((c) => c.message === "claude_truncated_no_block");
    expect(noBlockLog).toBeDefined();
    expect(noBlockLog.level).toBe("warn");
    expect(noBlockLog.data.stop_reason).toBe("max_tokens");
  });

  it("Caso 6: empty post-strip (solo metadata) → fallback genérico (hotfix-2 caso original)", async () => {
    const reply = "<perfil_update>\n{\"score_lead\": \"frio\"}\n</perfil_update>";
    claudeMockSequence = [mockResponse(reply)];
    await processMessage(buildBody("18096666666", "hi"));
    expect(lastSentMessage.text).toContain("se me complic");
    expect(lastSentMessage.text).not.toContain("<perfil_update>");
    const emptyLog = botLogCalls.find((c) => c.message === "empty_reply_after_strip");
    expect(emptyLog).toBeDefined();
    expect(emptyLog.level).toBe("warn");
    expect(emptyLog.data.truncated_recovery_applied).toBe(false);
  });

  it("Caso 7 (Hotfix-24 R4 c5): max_tokens + reply válido + <parameter> truncado → strip + pass", async () => {
    // Evidencia 11 mayo 2026 14:33:04, Caso A formal PR4 — Director vio
    // <parameter name="..."> crudo en el reply. El R4 caso 2 solo cubre
    // <perfil_update>; el caso 5 (este test) cubre tool-use XML truncado
    // emitido como texto en content[].text.
    const reply = "Buenas tardes. Con gusto le doy información de PR4. Los precios van desde US$140,000.\n\n<parameter name=\"proyecto\">prado";
    claudeMockSequence = [mockResponse(reply, "max_tokens")];
    await processMessage(buildBody("18097777777", "buenas tardes, info PR4"));
    expect(lastSentMessage).toBeTruthy();
    // El texto válido antes del <parameter> truncado queda preservado.
    expect(lastSentMessage.text).toContain("Buenas tardes");
    expect(lastSentMessage.text).toContain("PR4");
    // El bloque <parameter> truncado fue stripeado.
    expect(lastSentMessage.text).not.toContain("<parameter");
    expect(lastSentMessage.text).not.toContain("prado");
    // No cae al fallback porque hay texto válido antes del bloque.
    expect(lastSentMessage.text).not.toContain("se me complic");
    // Log del strip emitido.
    const stripLog = botLogCalls.find((c) => c.message === "perfil_update_truncated_stripped");
    expect(stripLog).toBeDefined();
    expect(stripLog.level).toBe("warn");
    expect(stripLog.data.strippedChars).toBeGreaterThan(0);
  });
});
