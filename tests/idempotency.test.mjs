// ============================================
// Tests de idempotencia del webhook
// ============================================
// Estrategia:
// - require.cache patching para interceptar @upstash/redis y @upstash/ratelimit
//   (vi.mock no funciona con require() dentro de funciones CJS — ver el comment
//   equivalente en ratelimit.test.mjs).
// - Mock de Redis STATEFUL: un Map compartido simula keys persistentes para
//   que NX devuelva null cuando la key ya existe.
// - Mock de Ratelimit siempre-allow (estamos testeando idempotencia, no rate
//   limit).
// - Mock global de fetch para capturar outbound a WhatsApp y contar si
//   processMessage corrio o no.
// - spy en console.log para verificar que los logs (botLog) se emitieron con
//   el event_type esperado. botLog llama console.log sincronicamente antes
//   de waitUntil(logToAxiom), asi que el spy los captura confiablemente.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";
import { Readable } from "stream";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// ===== Estado de mocks compartido =====

const redisState = new Map();

// ===== Parchar require.cache =====

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
          if (opts && opts.nx && redisState.has(key)) {
            return null;
          }
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
          // Siempre permitir — aislamos idempotencia del rate limit.
          return {
            success: true,
            limit: 9999,
            remaining: 9999,
            reset: Date.now() + 60000,
          };
        }
        static slidingWindow(max, window) {
          return { type: "sliding", max, window };
        }
      },
    },
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

// ===== Env vars =====

const SECRET = "test-secret-idempotency-xyz";
process.env.META_APP_SECRET = SECRET;
process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
process.env.WHATSAPP_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "000000";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake";

// Import dinamico despues del cache patching
const handler = (await import("../api/webhook.js")).default;

// ===== Helpers =====

function signBody(body, secret) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

function buildMessageBody(phone, messageId) {
  return JSON.stringify({
    entry: [{
      changes: [{
        value: {
          messages: [{ from: phone, id: messageId, type: "unknown" }],
          contacts: [{ profile: { name: "Test" }, wa_id: phone }],
        },
      }],
    }],
  });
}

function buildStatusUpdateBody() {
  // Meta envia statuses[] en vez de messages[] para delivery/read/sent
  return JSON.stringify({
    entry: [{
      changes: [{
        value: {
          statuses: [{
            id: "wamid.status.1",
            recipient_id: "18091234567",
            status: "delivered",
            timestamp: "1700000000",
          }],
        },
      }],
    }],
  });
}

function makeReq(body) {
  const stream = Readable.from([Buffer.from(body, "utf8")]);
  return Object.assign(stream, {
    method: "POST",
    headers: { "x-hub-signature-256": signBody(body, SECRET) },
    query: {},
  });
}

function makeRes() {
  const res = { statusCode: null, _body: null, _json: null };
  res.status = vi.fn((c) => { res.statusCode = c; return res; });
  res.send = vi.fn((b) => { res._body = b; return res; });
  res.json = vi.fn((b) => { res._json = b; return res; });
  return res;
}

async function hit(body) {
  const req = makeReq(body);
  const res = makeRes();
  await handler(req, res);
  return res;
}

function fetchCallsToWhatsApp() {
  return fetchMock.mock.calls.filter(([url]) =>
    typeof url === "string" && url.includes("graph.facebook.com")
  );
}

// ===== Tests =====

describe("Idempotency (message.id dedup con SET NX EX 3600)", () => {
  let consoleSpy;

  beforeEach(() => {
    redisState.clear();
    fetchMock.mockClear();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("Test 1: primer mensaje (messageId nuevo) -> procesa + key SET en Redis", async () => {
    const body = buildMessageBody("18091111111", "wamid.first.1");
    const res = await hit(body);

    expect(res.statusCode).toBe(200);
    expect(res._body).toBe("EVENT_RECEIVED");
    // La key quedo guardada con SET NX
    expect(redisState.get("processed:wamid.first.1")).toBe("1");
    // processMessage corrio -> mando "solo texto" via fetch a WhatsApp
    expect(fetchCallsToWhatsApp().length).toBe(1);
  });

  it("Test 2: mensaje duplicado -> 200 + NO procesa + log duplicate_message_ignored", async () => {
    const PHONE = "18092222222";
    const MSG_ID = "wamid.dup.1";
    // Pre-popular la key como si el mensaje ya hubiera sido procesado
    redisState.set("processed:" + MSG_ID, "1");

    const body = buildMessageBody(PHONE, MSG_ID);
    const res = await hit(body);

    expect(res.statusCode).toBe(200);
    expect(res._body).toBe("EVENT_RECEIVED");

    // processMessage NO corrio -> cero fetches WhatsApp
    expect(fetchCallsToWhatsApp().length).toBe(0);

    // Se emitio el log de duplicate_message_ignored
    const dupLog = consoleSpy.mock.calls.find((args) => args[0] === "duplicate_message_ignored");
    expect(dupLog).toBeDefined();
    // El payload JSON incluye el messageId y el phone
    expect(dupLog[1]).toContain(MSG_ID);
    expect(dupLog[1]).toContain(PHONE);
  });

  it("Test 3: status update sin messageId -> no toca Redis, flujo normal", async () => {
    const res = await hit(buildStatusUpdateBody());

    expect(res.statusCode).toBe(200);
    expect(res._body).toBe("EVENT_RECEIVED");
    // Ninguna key processed:* se creo
    expect(redisState.size).toBe(0);
    // processMessage salio temprano (sin messages) -> cero fetches WhatsApp
    expect(fetchCallsToWhatsApp().length).toBe(0);
  });

  it("Test 4 (bonus): Redis caido -> fail-open + log idempotency_bypassed_redis_unavailable", async () => {
    // Simular Redis no disponible borrando env vars
    const savedUrl = process.env.UPSTASH_REDIS_REST_URL;
    const savedToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    try {
      const body = buildMessageBody("18093333333", "wamid.noredis.1");
      const res = await hit(body);

      expect(res.statusCode).toBe(200);
      expect(res._body).toBe("EVENT_RECEIVED");

      // Fail-open: processMessage corrio igual
      expect(fetchCallsToWhatsApp().length).toBeGreaterThanOrEqual(1);

      // Log de bypass se emitio
      const bypassLog = consoleSpy.mock.calls.find(
        (args) => args[0] === "idempotency_bypassed_redis_unavailable"
      );
      expect(bypassLog).toBeDefined();
      expect(bypassLog[1]).toContain("wamid.noredis.1");
    } finally {
      process.env.UPSTASH_REDIS_REST_URL = savedUrl;
      process.env.UPSTASH_REDIS_REST_TOKEN = savedToken;
    }
  });
});
