// src/security/doc-signing.js — Sprint1 PR-4.
//
// Firma HMAC para URLs de documentos generados al vuelo (plan de pago en
// Excel). El endpoint /api/plan-xlsx es público (WhatsApp descarga sin
// Authorization, igual que /api/price-list), pero a diferencia del
// listado de precios el plan lleva NÚMEROS PARAMETRIZADOS por cliente —
// sin firma, cualquiera podría generar Excels con cifras arbitrarias y
// branding JPREZ. La firma garantiza que solo URLs emitidas por el bot
// sirven documento, y `exp` les da vencimiento (7 días — el "TTL" del
// brief sin necesidad de storage: doctrina cero-storage del Bloque 2).
//
// Clave: derivada de META_APP_SECRET (siempre presente en prod, ya es la
// clave HMAC del webhook) con prefijo de dominio — no se reusa el secreto
// crudo en dos contextos. Fail-closed: sin secret no se firma ni verifica.

const crypto = require("crypto");
const { safeEqual } = require("./safe-compare");

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días

function deriveKey(secret) {
  return crypto.createHash("sha256").update("jprez:plan-xlsx:v1:" + secret).digest();
}

function hmacOf(payloadB64, secret) {
  return crypto.createHmac("sha256", deriveKey(secret)).update(payloadB64).digest("hex");
}

// signDocPayload(data, { secret, ttlMs, now }) -> { p, s } listos para
// query string. data debe ser JSON-serializable. Lanza sin secret
// (fail-closed: mejor no emitir URL que emitir URL sin firma).
function signDocPayload(data, { secret = process.env.META_APP_SECRET, ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  if (!secret) {
    throw new Error("doc-signing: META_APP_SECRET ausente, no se puede firmar");
  }
  const payload = { ...data, exp: now + ttlMs };
  const p = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const s = hmacOf(p, secret);
  return { p, s };
}

// verifyDocPayload(p, s, { secret, now }) -> { ok:true, data } |
// { ok:false, reason }. Timing-safe en la comparación de la firma.
function verifyDocPayload(p, s, { secret = process.env.META_APP_SECRET, now = Date.now() } = {}) {
  if (!secret) return { ok: false, reason: "no_secret" }; // fail-closed
  if (!p || !s) return { ok: false, reason: "missing_params" };
  if (!safeEqual(hmacOf(String(p), secret), String(s))) {
    return { ok: false, reason: "bad_signature" };
  }
  let data;
  try {
    data = JSON.parse(Buffer.from(String(p), "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "bad_payload" };
  }
  if (!Number.isFinite(data.exp) || data.exp < now) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, data };
}

module.exports = { signDocPayload, verifyDocPayload, DEFAULT_TTL_MS };
