// src/security/ratelimit.js — Rate limiter memoizado (Upstash sliding window).
//
// CONTRATO:
//   getRatelimit(): Promise<Ratelimit | null>
//     - Memoizada tras primer éxito con Redis.
//     - Retorna null si Redis está caído o si Ratelimit falla al construir
//       (fail-open: el handler procesa igual + loguea alarma).
//     - Si retorna null, NO memoiza — permite reintentar cuando Redis vuelva.
//
//   enforceRateLimit(phone): Promise<{ status }>
//     - "allowed"  — request puede proceder.
//     - "exceeded" — rate limit alcanzado, handler debe enviar mensaje amable + 200.
//     - "bypassed" — Redis null / Ratelimit error (fail-open, log ya emitido).
//     Logs internos en bypass + exceeded — handler solo decide UX.
//
// Parámetros: 10 mensajes por ventana de 60s por phone. Sliding window
// (más justo que fixed: evita burst al inicio de cada minuto).
//
// STAFF BYPASS NO ESTÁ ACÁ: el bypass vive en el handler, que ni siquiera
// llama a esta función si el sender es staff. Este módulo solo conoce
// "construir el limiter" y "aplicarlo al phone".
//
// NOTA CRÍTICA: require("@upstash/ratelimit") debe quedarse LAZY dentro
// de la función, NO al top del módulo. Los tests de ratelimit dependen
// de require.cache patching que solo funciona si el require no se ejecutó
// todavía. Ver .claude/skills/jprez-security-patterns §4.1.
//
// NO ES LEAF: depende de src/store/redis (getRedis) + src/log (botLog).

const { getRedis } = require("../store/redis");
const { botLog } = require("../log");

// ============================================
// RATE LIMITING (Upstash Ratelimit, sliding window)
// ============================================
// 10 mensajes por ventana de 60s por telefono. Staff bypass.
// Instancia memoizada al module scope tras primer exito con Redis;
// si Redis esta caido en el primer intento, NO se memoiza (para reintentar).
// Fail-open: si Redis cae, se saltea el check y se loguea el bypass.

const RATELIMIT_MAX = 10;
const RATELIMIT_WINDOW = "60 s";
const RATELIMIT_PREFIX = "ratelimit";

let _ratelimitInstance = null;
async function getRatelimit() {
  if (_ratelimitInstance) return _ratelimitInstance;
  const redis = await getRedis();
  if (!redis) return null; // no memoizamos null: permite reintentar cuando Redis vuelva
  try {
    const { Ratelimit } = require("@upstash/ratelimit");
    _ratelimitInstance = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(RATELIMIT_MAX, RATELIMIT_WINDOW),
      prefix: RATELIMIT_PREFIX,
      analytics: false,
    });
    return _ratelimitInstance;
  } catch (e) {
    console.log("[ratelimit] Error inicializando Ratelimit:", e.message);
    return null;
  }
}

// enforceRateLimit: aplica el limiter a un phone y emite status discriminado.
// Logs de bypass/exceeded internos. Handler solo decide UX (mensaje amable + 200)
// cuando recibe "exceeded".
async function enforceRateLimit(phone) {
  const ratelimit = await getRatelimit();
  if (!ratelimit) {
    botLog("warn", "rate_limit_bypassed_redis_unavailable", {
      event_type: "rate_limit_bypassed_redis_unavailable",
      phone,
      timestamp: new Date().toISOString(),
    });
    return { status: "bypassed" };
  }
  try {
    const { success, limit, remaining, reset } = await ratelimit.limit(phone);
    if (!success) {
      botLog("warn", "rate_limit_exceeded", {
        event_type: "rate_limit_exceeded",
        phone,
        limit,
        remaining,
        reset,
        usados: limit - remaining,
        timestamp: new Date().toISOString(),
      });
      return { status: "exceeded" };
    }
    return { status: "allowed" };
  } catch (e) {
    botLog("warn", "rate_limit_bypassed_error", {
      event_type: "rate_limit_bypassed_error",
      phone,
      error: e.message,
      timestamp: new Date().toISOString(),
    });
    return { status: "bypassed" };
  }
}

module.exports = { getRatelimit, enforceRateLimit };
