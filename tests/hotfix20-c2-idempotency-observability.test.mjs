// Hotfix-20 Commit 2 — Bug #9 idempotency observability.
//
// Smoke real del sabado: cliente "Ayudame" recibio 3 respuestas en mismo
// timestamp. Audit no pudo confirmar causa raiz (bypass / race / mensajes
// distintos). Antes de meter phone-lock ciego, agregamos logs granulares
// para diagnosticar con datos reales 1 semana antes de decidir fix final.
//
// Logs nuevos (alongside los existentes — preservados para dashboard.js
// y idempotency.test.mjs que dependen de los nombres legacy):
//   - inbound_message_received  (api/webhook.js)
//   - idempotency_decision       (src/security/idempotency.js)
//
// Estrategia de test: mirror del patron de tests/idempotency.test.mjs
// (require.cache patching de @upstash/redis + @upstash/ratelimit).

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
          return { success: true, limit: 9999, remaining: 9999, reset: Date.now() + 60000 };
        }
        static slidingWindow(max, window) { return { type: "sliding", max, window }; }
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

const SECRET = "test-secret-hotfix20-c2";
process.env.META_APP_SECRET = SECRET;
process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
process.env.WHATSAPP_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "000000";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake";

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

function findLog(consoleSpy, eventName) {
  return consoleSpy.mock.calls.find((args) => args[0] === eventName);
}

// ===== Tests =====

describe("Hotfix-20 c2 — Idempotency observability logs", () => {
  let consoleSpy;

  beforeEach(() => {
    redisState.clear();
    fetchMock.mockClear();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("Test 1: mensaje fresh → emite idempotency_decision con status='fresh'", async () => {
    const PHONE = "18091111111";
    const MSG_ID = "wamid.fresh.c2.1";
    await hit(buildMessageBody(PHONE, MSG_ID));

    const log = findLog(consoleSpy, "idempotency_decision");
    expect(log).toBeDefined();
    // Payload es JSON stringified como segundo argumento de console.log.
    expect(log[1]).toContain('"status":"fresh"');
    expect(log[1]).toContain(MSG_ID);
    expect(log[1]).toContain('"ttlSeconds":3600');
  });

  it("Test 2: mensaje duplicado → emite idempotency_decision con status='duplicate'", async () => {
    const PHONE = "18092222222";
    const MSG_ID = "wamid.dup.c2.1";
    redisState.set("processed:" + MSG_ID, "1");

    await hit(buildMessageBody(PHONE, MSG_ID));

    const log = findLog(consoleSpy, "idempotency_decision");
    expect(log).toBeDefined();
    expect(log[1]).toContain('"status":"duplicate"');
    expect(log[1]).toContain(MSG_ID);
    // Legacy log duplicate_message_ignored sigue emitiendose (dashboard-load-bearing).
    expect(findLog(consoleSpy, "duplicate_message_ignored")).toBeDefined();
  });

  it("Test 3: Redis caido → BOTH legacy bypass log Y nuevo idempotency_decision='bypassed'", async () => {
    const savedUrl = process.env.UPSTASH_REDIS_REST_URL;
    const savedToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    try {
      await hit(buildMessageBody("18093333333", "wamid.bypass.c2.1"));

      // Legacy log preservado para dashboard.js + idempotency.test.mjs.
      const legacyLog = findLog(consoleSpy, "idempotency_bypassed_redis_unavailable");
      expect(legacyLog).toBeDefined();

      // Nuevo log granular alongside.
      const newLog = findLog(consoleSpy, "idempotency_decision");
      expect(newLog).toBeDefined();
      expect(newLog[1]).toContain('"status":"bypassed"');
      expect(newLog[1]).toContain('"reason":"redis_unavailable"');
    } finally {
      process.env.UPSTASH_REDIS_REST_URL = savedUrl;
      process.env.UPSTASH_REDIS_REST_TOKEN = savedToken;
    }
  });

  it("Test 4: webhook emite inbound_message_received con messageId + phone + timestamp", async () => {
    const PHONE = "18094444444";
    const MSG_ID = "wamid.inbound.c2.1";
    await hit(buildMessageBody(PHONE, MSG_ID));

    const log = findLog(consoleSpy, "inbound_message_received");
    expect(log).toBeDefined();
    expect(log[1]).toContain(MSG_ID);
    expect(log[1]).toContain(PHONE);
    expect(log[1]).toContain('"timestamp":');
    // Verificar orden: inbound_message_received aparece ANTES de idempotency_decision
    // (precondicion: el inbound se loggea pre-check).
    const inboundIdx = consoleSpy.mock.calls.findIndex((args) => args[0] === "inbound_message_received");
    const decisionIdx = consoleSpy.mock.calls.findIndex((args) => args[0] === "idempotency_decision");
    expect(inboundIdx).toBeGreaterThanOrEqual(0);
    expect(decisionIdx).toBeGreaterThan(inboundIdx);
  });
});
