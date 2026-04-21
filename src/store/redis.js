// ============================================
// CLIENTE REDIS (Upstash REST)
// ============================================
// Factory del cliente Redis. Extraido desde api/webhook.js en Dia 2 sin
// cambios de comportamiento: sigue siendo no-memoizada (cada llamada
// construye una instancia nueva) y soporta ambos formatos de env vars
// (Vercel Storage KV_REST_API_* y manual UPSTASH_REDIS_REST_*).

async function getRedis() {
  // Soporta ambos formatos: el de Vercel Storage (KV_REST_API) y el manual
  const redisUrl = process.env.UPSTASH_REDIS_REST_KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!redisUrl || !redisToken) {
    return null;
  }
  try {
    // NOTA CRITICA: require("@upstash/redis") debe quedarse dentro de la funcion,
    // NO al top del modulo. Los tests de ratelimit e idempotency dependen de
    // require.cache patching que solo funciona si el require no se ejecuto todavia.
    // Ver .claude/skills/jprez-security-patterns §4.1 (gotchas de testing).
    const { Redis } = require("@upstash/redis");
    return new Redis({
      url: redisUrl,
      token: redisToken,
    });
  } catch (e) {
    console.log("Redis no disponible, usando memoria RAM:", e.message);
    return null;
  }
}

module.exports = { getRedis };
