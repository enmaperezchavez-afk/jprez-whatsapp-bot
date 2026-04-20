// ============================================
// Tests de rate limiting del webhook
// ============================================
// Estrategia:
// - vi.mock NO intercepta require() dentro de funciones en módulos CJS
//   (webhook.js es CJS y llama require("@upstash/ratelimit") lazily dentro
//   de getRatelimit()). Solución robusta: poblar require.cache con nuestros
//   mocks ANTES del import dinámico de webhook.js.
// - Mock de @upstash/ratelimit: contador Map en memoria, sliding window
//   determinista.
// - Mock de @upstash/redis: constructor + métodos no-op para que saveClientMeta
//   no rompa.
// - Mock global de fetch para capturar outbound a WhatsApp.
// - Body con messageType "unknown" → processMessage sale temprano vía rama
//   "solo texto", sin tocar Anthropic.

import { describe, it, expect, beforeEach, vi } from "vitest";
import crypto from "crypto";
import { Readable } from "stream";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// Estado de mocks compartido (referenciado desde dentro de las clases mock)
const mockState = {
  counters: new Map(),
  limit: 10,
};

// Parchar require.cache para @upstash/ratelimit
{
  const moduleId = require.resolve("@upstash/ratelimit");
  require.cache[moduleId] = {
    id: moduleId,
    filename: moduleId,
    loaded: true,
    exports: {
      Ratelimit: class {
        constructor(config) {
          this.config = config;
        }
        async limit(key) {
          const count = (mockState.counters.get(key) || 0) + 1;
          mockState.counters.set(key, count);
          const success = count <= mockState.limit;
          return {
            success,
            limit: mockState.limit,
            remaining: Math.max(0, mockState.limit - count),
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

// Parchar require.cache para @upstash/redis
{
  const moduleId = require.resolve("@upstash/redis");
  require.cache[moduleId] = {
    id: moduleId,
    filename: moduleId,
    loaded: true,
    exports: {
      Redis: class {
        constructor() {}
        async get() { return null; }
        async set() { return "OK"; }
        async del() { return 1; }
      },
    },
  };
}

// Mock global de fetch
const fetchMock = vi.fn(async () => ({
  ok: true,
  status: 200,
  async json() { return {}; },
  async text() { return ""; },
}));
vi.stubGlobal("fetch", fetchMock);

// Env vars (leídas en runtime por webhook.js)
const SECRET = "test-secret-ratelimit-xyz";
process.env.META_APP_SECRET = SECRET;
process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
process.env.WHATSAPP_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "000000";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake";

// Import dinámico DESPUÉS de configurar el cache: los require() internos de
// webhook.js harán hit en nuestras entradas parcheadas.
const handler = (await import("../api/webhook.js")).default;

// ===== Helpers =====

function signBody(body, secret) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

function buildWebhookBody(phone, messageId = "wamid.test.1") {
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

function makeReq({ body, signature }) {
  const stream = Readable.from([Buffer.from(body, "utf8")]);
  return Object.assign(stream, {
    method: "POST",
    headers: { "x-hub-signature-256": signature },
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

async function hit(phone, messageId) {
  const body = buildWebhookBody(phone, messageId);
  const req = makeReq({ body, signature: signBody(body, SECRET) });
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

describe("Rate limiting (sliding window 10/60s por phone)", () => {
  beforeEach(() => {
    mockState.counters.clear();
    mockState.limit = 10;
    fetchMock.mockClear();
  });

  it("Test 1: dentro del limite (1 mensaje) -> 200 + procesa", async () => {
    const PHONE = "18091111111";
    const res = await hit(PHONE);
    expect(res.statusCode).toBe(200);
    expect(res._body).toBe("EVENT_RECEIVED");
    expect(mockState.counters.get(PHONE)).toBe(1);
  });

  it("Test 2: exactamente 10 mensajes del mismo phone pasan todos", async () => {
    const PHONE = "18092222222";
    for (let i = 0; i < 10; i++) {
      const res = await hit(PHONE, `wamid.${i}`);
      expect(res.statusCode).toBe(200);
      expect(res._body).toBe("EVENT_RECEIVED");
    }
    expect(mockState.counters.get(PHONE)).toBe(10);
  });

  it("Test 3: mensaje 11 -> 200 a Meta pero bloquea procesamiento + manda amable", async () => {
    const PHONE = "18093333333";
    for (let i = 0; i < 10; i++) {
      await hit(PHONE, `wamid.${i}`);
    }
    fetchMock.mockClear();

    const res = await hit(PHONE, "wamid.overflow");

    expect(res.statusCode).toBe(200);
    expect(res._body).toBe("EVENT_RECEIVED");

    // Si hubiera procesado saldrían 2 outbound (amable + "solo texto").
    // Rate-limit bloquea processMessage → sólo queda el amable.
    const waCalls = fetchCallsToWhatsApp();
    expect(waCalls.length).toBe(1);

    const [, opts] = waCalls[0];
    const payload = JSON.parse(opts.body);
    expect(payload.to).toBe(PHONE);
    expect(payload.type).toBe("text");
    expect(payload.text.body).toContain("procesando tus mensajes con calma");
  });

  it("Test 4: phones distintos tienen contadores independientes", async () => {
    const PHONE_A = "18094444444";
    const PHONE_B = "18095555555";

    for (let i = 0; i < 10; i++) {
      await hit(PHONE_A, `wamid.a.${i}`);
    }
    expect(mockState.counters.get(PHONE_A)).toBe(10);

    const resB = await hit(PHONE_B, "wamid.b.1");
    expect(resB.statusCode).toBe(200);
    expect(resB._body).toBe("EVENT_RECEIVED");
    expect(mockState.counters.get(PHONE_B)).toBe(1);
    expect(mockState.counters.get(PHONE_A)).toBe(10);
  });
});
