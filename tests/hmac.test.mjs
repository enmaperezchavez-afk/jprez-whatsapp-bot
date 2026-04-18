// ============================================
// Tests de validación HMAC del webhook
// ============================================
// Estrategia:
// - Se importa el handler (CJS default export) una sola vez.
// - El estado de HMAC se controla via process.env.META_APP_SECRET, que el
//   código lee en runtime (no al module load), así que cambiar env entre
//   tests funciona sin resetear módulos.
// - Tests 200: body `{}` hace que processMessage salga temprano (no hay
//   messages), evitando llamadas reales a Anthropic / WhatsApp / Redis.
// - Tests 401: el handler rechaza ANTES de processMessage, cero side effects.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";
import { Readable } from "stream";
import handler from "../api/webhook.js";

const SECRET = "test-secret-hmac-abc123-xyz";

function makeReq({ method = "POST", body = "{}", signature, extraHeaders = {} } = {}) {
  const headers = { ...extraHeaders };
  if (signature !== undefined) {
    headers["x-hub-signature-256"] = signature;
  }
  const stream = Readable.from([Buffer.from(body, "utf8")]);
  return Object.assign(stream, {
    method,
    headers,
    query: {},
  });
}

function makeRes() {
  const res = {
    statusCode: null,
    _body: null,
    _json: null,
  };
  res.status = vi.fn(function (code) {
    res.statusCode = code;
    return res;
  });
  res.send = vi.fn(function (payload) {
    res._body = payload;
    return res;
  });
  res.json = vi.fn(function (payload) {
    res._json = payload;
    return res;
  });
  return res;
}

function signBody(body, secret) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

describe("HMAC validation (webhook POST)", () => {
  beforeEach(() => {
    process.env.META_APP_SECRET = SECRET;
  });

  afterEach(() => {
    delete process.env.META_APP_SECRET;
  });

  it("Test 1: firma VÁLIDA → 200 EVENT_RECEIVED", async () => {
    const body = "{}";
    const req = makeReq({ body, signature: signBody(body, SECRET) });
    const res = makeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._body).toBe("EVENT_RECEIVED");
    expect(res._json).toBeNull();
  });

  it("Test 2: firma INVÁLIDA → 401 Unauthorized + NO procesa", async () => {
    const body = "{}";
    const req = makeReq({ body, signature: signBody(body, "wrong-secret") });
    const res = makeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res._json).toEqual({ error: "Unauthorized: invalid webhook signature" });
    expect(res._body).toBeNull();
  });

  it("Test 3: firma AUSENTE (sin header x-hub-signature-256) → 401 + NO procesa", async () => {
    const body = "{}";
    const req = makeReq({ body, signature: undefined });
    const res = makeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res._json).toEqual({ error: "Unauthorized: invalid webhook signature" });
    expect(res._body).toBeNull();
  });

  it("Test 4: META_APP_SECRET AUSENTE (modo dev) → warning + procesa 200", async () => {
    delete process.env.META_APP_SECRET;
    const body = "{}";
    const req = makeReq({ body, signature: undefined });
    const res = makeRes();

    await handler(req, res);

    // En modo dev (sin secret) el código loguea warning y sigue procesando
    expect(res.statusCode).toBe(200);
    expect(res._body).toBe("EVENT_RECEIVED");
  });
});
