// src/security/idempotency.js — Dedupe de webhooks por message.id.
//
// POR QUÉ: Meta reintenta webhooks cuando no recibe 200 rápido (o por glitches
// de red). Cada retry trae el mismo message.id. Sin dedupe, procesamos N veces
// → N respuestas de Claude → cliente confundido + drain del rate limit.
//
// ORDEN EN EL HANDLER: idempotencia va ANTES del rate limit (intencional).
// Si Meta reintenta 5 veces por glitch, NO queremos gastar 5 hits del rate
// limit del cliente. Ver .claude/skills/jprez-security-patterns §3.1.
//
// CONTRATO:
//   checkIdempotency(messageId): Promise<{ status }>
//     - "fresh"     — primera vez vista (key creada con TTL 3600s). Proceder.
//     - "duplicate" — key ya existía. Handler debe responder 200 + early return.
//     - "bypassed"  — Redis null/error. Fail-open. Log ya emitido internamente.
//
// Aplica a TODOS (incluido staff): doble-tap accidental se deduplica igual.
//
// TTL: 3600s (1h) cubre todos los retries realistas de Meta (típicamente
// 10-15min). Si llega duplicado después de 1h, lo procesamos de nuevo —
// aceptable, extremadamente raro.
//
// NO ES LEAF: depende de src/store/redis (getRedis) + src/log (botLog).

const { getRedis } = require("../store/redis");
const { botLog } = require("../log");

// ============================================
// IDEMPOTENCIA (Dedupe via Redis SET NX)
// ============================================

const IDEMPOTENCY_TTL_SECONDS = 3600; // 1 hora

async function checkIdempotency(messageId) {
  const redis = await getRedis();
  if (!redis) {
    // Hotfix-20 c2: log legacy preservado (dashboard.js + idempotency.test.mjs
    // dependen del nombre exacto). Log nuevo idempotency_decision agregado
    // alongside para observabilidad granular del Bug #9 (3 respuestas en
    // mismo timestamp). Decision final post-1-semana de datos reales.
    botLog("warn", "idempotency_bypassed_redis_unavailable", {
      event_type: "idempotency_bypassed_redis_unavailable",
      messageId,
      timestamp: new Date().toISOString(),
    });
    botLog("warn", "idempotency_decision", {
      event_type: "idempotency_decision",
      messageId,
      status: "bypassed",
      reason: "redis_unavailable",
      ttlSeconds: IDEMPOTENCY_TTL_SECONDS,
      timestamp: new Date().toISOString(),
    });
    return { status: "bypassed" };
  }
  try {
    const result = await redis.set("processed:" + messageId, "1", {
      nx: true,
      ex: IDEMPOTENCY_TTL_SECONDS,
    });
    if (result !== "OK") {
      // Key ya existia -> mensaje duplicado (retry de Meta o similar).
      botLog("info", "idempotency_decision", {
        event_type: "idempotency_decision",
        messageId,
        status: "duplicate",
        ttlSeconds: IDEMPOTENCY_TTL_SECONDS,
        timestamp: new Date().toISOString(),
      });
      return { status: "duplicate" };
    }
    botLog("info", "idempotency_decision", {
      event_type: "idempotency_decision",
      messageId,
      status: "fresh",
      ttlSeconds: IDEMPOTENCY_TTL_SECONDS,
      timestamp: new Date().toISOString(),
    });
    return { status: "fresh" };
  } catch (e) {
    // Error durante el SET (timeout, red, etc.). Fail-open.
    botLog("warn", "idempotency_bypassed_redis_unavailable", {
      event_type: "idempotency_bypassed_redis_unavailable",
      messageId,
      error: e.message,
      timestamp: new Date().toISOString(),
    });
    botLog("warn", "idempotency_decision", {
      event_type: "idempotency_decision",
      messageId,
      status: "bypassed",
      reason: "redis_error",
      error: e.message,
      ttlSeconds: IDEMPOTENCY_TTL_SECONDS,
      timestamp: new Date().toISOString(),
    });
    return { status: "bypassed" };
  }
}

module.exports = { checkIdempotency };
