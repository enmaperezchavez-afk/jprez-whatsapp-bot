// Hotfix-27 Día 4-5 — Hardening /api/health (B1+B2+B3).
//
// Tests enfocados en B3 token rotation (lo más sensible operacionalmente):
// el endpoint ya está en producción y un bug de auth bloquearía el dashboard.
//
// B1 (rate limit) se valida via skip-graceful cuando Upstash ausente.
// B2 (access logs) se valida indirectamente — no romper handler.
//
// Cobertura:
//   1. Handler es async function exportada con module.exports.
//   2. 503 cuando HEALTH_DASHBOARD_TOKEN no configurado.
//   3. 401 sin auth header.
//   4. 401 con token inválido.
//   5. 200 con HEALTH_DASHBOARD_TOKEN current (rotación inactiva).
//   6. 200 con HEALTH_DASHBOARD_TOKEN_PREV durante rotación activa.
//   7. 401 con TOKEN_PREV cuando PREV no está definido (no leak path).
//   8. Sin headers X-RateLimit cuando Upstash ausente (graceful degradation).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

function makeReq(opts = {}) {
  return {
    headers: {
      authorization: opts.auth || "",
      "user-agent": opts.userAgent || "test-agent/1.0",
      "x-forwarded-for": opts.ip || "1.2.3.4",
      ...(opts.headers || {}),
    },
    query: opts.query || {},
    socket: { remoteAddress: opts.ip || "1.2.3.4" },
  };
}

function makeRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = String(v);
    },
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
  return res;
}

describe("Hotfix-27 Día 4-5 — /api/health hardening (B1+B2+B3)", () => {
  let originalFetch;
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalFetch = globalThis.fetch;
    // Stub Axiom para que las queries devuelvan vacío (no rompen handler).
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({
        tables: [{ fields: [{ name: "v" }], columns: [[0]] }],
      }),
    });
    // Asegurar graceful skip de rate limit en tests (sin Upstash real).
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.AXIOM_QUERY_TOKEN = "fake-query-token";
    // Reset module cache para que el lazy init de ratelimit se re-evalúe.
    delete require.cache[require.resolve("../api/health.js")];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k];
    }
    Object.assign(process.env, originalEnv);
    vi.restoreAllMocks();
  });

  it("Test 1: handler exportado como async function", () => {
    const handler = require("../api/health.js");
    expect(typeof handler).toBe("function");
    expect(handler.constructor.name).toBe("AsyncFunction");
  });

  it("Test 2: 503 cuando HEALTH_DASHBOARD_TOKEN no configurado", async () => {
    delete process.env.HEALTH_DASHBOARD_TOKEN;
    delete process.env.HEALTH_DASHBOARD_TOKEN_PREV;
    const handler = require("../api/health.js");
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/HEALTH_DASHBOARD_TOKEN/);
  });

  it("Test 3: 401 sin auth header", async () => {
    process.env.HEALTH_DASHBOARD_TOKEN = "real-current-token-abc123";
    const handler = require("../api/health.js");
    const res = makeRes();
    await handler(makeReq({ auth: "" }), res);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("Test 4: 401 con token inválido", async () => {
    process.env.HEALTH_DASHBOARD_TOKEN = "real-current-token-abc123";
    const handler = require("../api/health.js");
    const res = makeRes();
    await handler(makeReq({ auth: "Bearer wrong-token" }), res);
    expect(res.statusCode).toBe(401);
  });

  it("Test 5: 200 con TOKEN current válido (rotación inactiva)", async () => {
    process.env.HEALTH_DASHBOARD_TOKEN = "real-current-token-abc123";
    delete process.env.HEALTH_DASHBOARD_TOKEN_PREV;
    const handler = require("../api/health.js");
    const res = makeRes();
    await handler(makeReq({ auth: "Bearer real-current-token-abc123" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty("prompt");
    expect(res.body).toHaveProperty("cache");
    expect(res.body).toHaveProperty("cost");
  });

  it("Test 6: 200 con TOKEN_PREV durante rotación activa", async () => {
    process.env.HEALTH_DASHBOARD_TOKEN = "new-token-xyz789";
    process.env.HEALTH_DASHBOARD_TOKEN_PREV = "old-token-abc123";
    const handler = require("../api/health.js");
    const res = makeRes();
    await handler(makeReq({ auth: "Bearer old-token-abc123" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty("prompt");
  });

  it("Test 7: 401 con token que sería PREV cuando PREV no está definido", async () => {
    process.env.HEALTH_DASHBOARD_TOKEN = "current-only-token-xyz";
    delete process.env.HEALTH_DASHBOARD_TOKEN_PREV;
    const handler = require("../api/health.js");
    const res = makeRes();
    await handler(makeReq({ auth: "Bearer old-token-abc123" }), res);
    expect(res.statusCode).toBe(401);
  });

  it("Test 8: sin headers X-RateLimit cuando Upstash ausente (graceful skip)", async () => {
    process.env.HEALTH_DASHBOARD_TOKEN = "tok-graceful";
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const handler = require("../api/health.js");
    const res = makeRes();
    await handler(makeReq({ auth: "Bearer tok-graceful" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
    expect(res.headers["x-ratelimit-remaining"]).toBeUndefined();
  });
});
