// Bloque 1 Fase 2 — Tests endpoint /api/inventory.
//
// Cobertura:
//   1. Handler es async function
//   2. 503 cuando HEALTH_DASHBOARD_TOKEN no configurado
//   3. 401 sin auth header
//   4. 401 con token inválido
//   5. 200 con TOKEN current → llama loader → JSON con markdown/source/totals
//   6. 200 con TOKEN_PREV durante rotación activa
//   7. POST con token válido → forceRefresh=true al loader
//   8. ?refresh=1 query → forceRefresh=true

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// Mock botLog para que no rompa por waitUntil sin Vercel context
const botLogCalls = [];
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

// Mock getRedis para devolver objeto fake (los tests no usan Redis real)
const redisGetCalls = [];
const fakeRedis = {
  get: async (key) => { redisGetCalls.push({ op: "get", key }); return null; },
  set: async (key, val, opts) => { redisGetCalls.push({ op: "set", key, val, opts }); return "OK"; },
};
{
  const id = require.resolve("../src/store/redis");
  require.cache[id] = {
    id, filename: id, loaded: true,
    exports: { getRedis: async () => fakeRedis },
  };
}

// Mock inventory loader
const loaderCalls = [];
let nextLoaderResult = null;
{
  const id = require.resolve("../src/inventory/loader");
  require.cache[id] = {
    id, filename: id, loaded: true,
    exports: {
      loadInventory: async (opts) => {
        loaderCalls.push(opts);
        return nextLoaderResult;
      },
      CACHE_KEY: "inventory:current",
    },
  };
}

function makeReq(opts = {}) {
  return {
    method: opts.method || "GET",
    headers: {
      authorization: opts.auth || "",
      "user-agent": opts.userAgent || "test-agent/1.0",
      "x-forwarded-for": opts.ip || "1.2.3.4",
    },
    query: opts.query || {},
    socket: { remoteAddress: opts.ip || "1.2.3.4" },
  };
}

function makeRes() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = String(v); },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

describe("Bloque 1 — /api/inventory endpoint", () => {
  let originalEnv;
  beforeEach(() => {
    originalEnv = { ...process.env };
    botLogCalls.length = 0;
    redisGetCalls.length = 0;
    loaderCalls.length = 0;
    nextLoaderResult = {
      markdown: "# inventario fake",
      source: "sheet",
      updated_at: "2026-05-19T10:00:00Z",
      totals: { pr3: { disponibles: 6, total: 60 } },
      skipped_count: 0,
    };
    delete require.cache[require.resolve("../api/inventory.js")];
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k];
    }
    Object.assign(process.env, originalEnv);
    vi.restoreAllMocks();
  });

  it("Test 1: handler es async function", () => {
    const handler = require("../api/inventory.js");
    expect(typeof handler).toBe("function");
    expect(handler.constructor.name).toBe("AsyncFunction");
  });

  it("Test 2: 503 cuando HEALTH_DASHBOARD_TOKEN no configurado", async () => {
    delete process.env.HEALTH_DASHBOARD_TOKEN;
    delete process.env.HEALTH_DASHBOARD_TOKEN_PREV;
    const handler = require("../api/inventory.js");
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/HEALTH_DASHBOARD_TOKEN/);
  });

  it("Test 3: 401 sin auth header", async () => {
    process.env.HEALTH_DASHBOARD_TOKEN = "tok-current";
    const handler = require("../api/inventory.js");
    const res = makeRes();
    await handler(makeReq({ auth: "" }), res);
    expect(res.statusCode).toBe(401);
  });

  it("Test 4: 401 con token inválido", async () => {
    process.env.HEALTH_DASHBOARD_TOKEN = "tok-current";
    const handler = require("../api/inventory.js");
    const res = makeRes();
    await handler(makeReq({ auth: "Bearer wrong" }), res);
    expect(res.statusCode).toBe(401);
  });

  it("Test 5: 200 con TOKEN current → JSON con markdown/source/totals", async () => {
    process.env.HEALTH_DASHBOARD_TOKEN = "tok-current";
    const handler = require("../api/inventory.js");
    const res = makeRes();
    await handler(makeReq({ auth: "Bearer tok-current" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.markdown).toBe("# inventario fake");
    expect(res.body.source).toBe("sheet");
    expect(res.body.totals).toEqual({ pr3: { disponibles: 6, total: 60 } });
    // El loader recibió { redis, forceRefresh: false }
    expect(loaderCalls.length).toBe(1);
    expect(loaderCalls[0].forceRefresh).toBe(false);
    expect(loaderCalls[0].redis).toBeDefined();
  });

  it("Test 6: 200 con TOKEN_PREV durante rotación activa", async () => {
    process.env.HEALTH_DASHBOARD_TOKEN = "new-token";
    process.env.HEALTH_DASHBOARD_TOKEN_PREV = "old-token";
    const handler = require("../api/inventory.js");
    const res = makeRes();
    await handler(makeReq({ auth: "Bearer old-token" }), res);
    expect(res.statusCode).toBe(200);
  });

  it("Test 7: POST force refresh → loader recibe forceRefresh=true", async () => {
    process.env.HEALTH_DASHBOARD_TOKEN = "tok-current";
    const handler = require("../api/inventory.js");
    const res = makeRes();
    await handler(makeReq({ auth: "Bearer tok-current", method: "POST" }), res);
    expect(res.statusCode).toBe(200);
    expect(loaderCalls[0].forceRefresh).toBe(true);
  });

  it("Test 8: ?refresh=1 query → forceRefresh=true", async () => {
    process.env.HEALTH_DASHBOARD_TOKEN = "tok-current";
    const handler = require("../api/inventory.js");
    const res = makeRes();
    await handler(makeReq({ auth: "Bearer tok-current", query: { refresh: "1" } }), res);
    expect(res.statusCode).toBe(200);
    expect(loaderCalls[0].forceRefresh).toBe(true);
  });

  it("Test 9: 500 si loader lanza error", async () => {
    process.env.HEALTH_DASHBOARD_TOKEN = "tok-current";
    // Sobreescribir mock para hacer throw
    const loaderId = require.resolve("../src/inventory/loader");
    require.cache[loaderId].exports.loadInventory = async () => {
      throw new Error("sheets unreachable");
    };
    delete require.cache[require.resolve("../api/inventory.js")];
    const handler = require("../api/inventory.js");
    const res = makeRes();
    await handler(makeReq({ auth: "Bearer tok-current" }), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe("Internal server error");
  });
});
