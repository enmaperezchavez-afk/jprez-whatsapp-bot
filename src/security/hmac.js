// src/security/hmac.js — Validación HMAC de webhooks de Meta.
//
// CONTRATO:
//   readRawBody(req): Promise<string>
//     Lee bytes crudos del stream ANTES de cualquier parseo.
//     Retorna string UTF-8. Requiere bodyParser desactivado en handler.
//
//   verifyWebhookSignature(rawBody, signatureHeader): { status, reason }
//     status ∈ { valid, invalid, missing_secret, missing_signature }
//     Solo emite veredicto. El handler decide qué hacer con cada status
//     (fail-open en missing_secret, 401 en invalid, 200 en valid).
//
// CRÍTICO: rawBody DEBE ser exactamente lo que Meta firmó. Serializar y
// re-firmar un objeto JSON parseado rompe la firma byte-exact.
// Ver .claude/skills/jprez-security-patterns §1.1 + §1.2 (timingSafeEqual).
//
// MÓDULO HOJA: solo depende de Node crypto/Buffer/process.env. Sin imports
// locales. Sin ciclos posibles.

const crypto = require("crypto");

// ============================================
// VERIFICACION HMAC (Seguridad)
// ============================================

// Lee el body HTTP crudo (raw) como string UTF-8 directo del stream,
// ANTES de cualquier parseo. Requiere bodyParser desactivado via export config.
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Verifica la firma HMAC SHA256 sobre el body crudo exacto que envio Meta.
// Retorna { status, reason } donde status = "valid" | "invalid" | "missing_secret" | "missing_signature"
// Importante: la comparacion usa timingSafeEqual para evitar timing attacks.
function verifyWebhookSignature(rawBody, signatureHeader) {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    return { status: "missing_secret", reason: "META_APP_SECRET no configurado" };
  }
  if (!signatureHeader) {
    return { status: "missing_signature", reason: "Request sin header x-hub-signature-256" };
  }
  const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  // timingSafeEqual requiere que ambos buffers sean del mismo largo; si difieren
  // retornamos invalid sin comparar (evita throw).
  const sigBuf = Buffer.from(signatureHeader);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) {
    return { status: "invalid", reason: "Firma de largo inesperado" };
  }
  const isValid = crypto.timingSafeEqual(sigBuf, expBuf);
  return isValid
    ? { status: "valid" }
    : { status: "invalid", reason: "Firma HMAC no coincide con body crudo" };
}

module.exports = { readRawBody, verifyWebhookSignature };
