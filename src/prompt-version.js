// src/prompt-version.js — CORE Closer SD: detección de cambio de prompt
// y auto-invalidación de historial conversacional.
//
// CONTRATO:
//   computePromptHash(promptText): string
//     SHA-256 → primeros 12 chars hex. Determinístico. Cero I/O.
//
//   checkAndInvalidate(storageKey, currentHash): Promise<{
//     invalidated: boolean,
//     backupKey?: string,
//     messagesDropped?: number,
//   }>
//     Si el historial guardado tiene un promptHash distinto al actual,
//     hace backup (TTL 7 días) y borra el historial. Loguea métrica
//     en Axiom. Retorna info de qué pasó.
//
// MOTIVACIÓN: cuando el dev cambia MATEO_PROMPT_V5_2 o SUPERVISOR_PROMPT
// y deploya, el historial existente del cliente quedó "anclado" al prompt
// viejo. Si el prompt nuevo cambia reglas críticas (identidad, formato,
// flujo), el modelo recibe instrucciones contradictorias entre system
// prompt y messageHistory. Resultado: respuestas inconsistentes hasta
// que la ventana de 20 mensajes empuja al historial viejo afuera.
//
// Solución: hashear el activePrompt y guardarlo junto al historial. Al
// detectar mismatch, invalidar el historial completo (HARD mode). Backup
// preserva los datos por 7 días para rollback manual si hay problemas.
//
// MODO ACTUAL: HARD only. Soft mode (mantener historial pero anotar
// "prompt cambió") está fuera de scope (decidido en Pendiente-4).
//
// MULTI-TENANT: este módulo es agnóstico al cliente. Funciona para
// cualquier tenant que use src/store/history (chat:<phone>).
//
// MÓDULO NO-LEAF: depende de ./store/redis (getRedis), ./store/history
// (getHistoryWithMeta), ./log (botLog).

const crypto = require("node:crypto");
const { getRedis } = require("./store/redis");
const { getHistoryWithMeta } = require("./store/history");
const { botLog } = require("./log");

const BACKUP_TTL_SECONDS = 604800; // 7 días
const HASH_LENGTH = 12;

function computePromptHash(promptText) {
  if (!promptText || typeof promptText !== "string") {
    throw new Error("computePromptHash requires a non-empty string");
  }
  return crypto
    .createHash("sha256")
    .update(promptText)
    .digest("hex")
    .slice(0, HASH_LENGTH);
}

async function checkAndInvalidate(storageKey, currentHash) {
  if (!storageKey || !currentHash) {
    return { invalidated: false };
  }

  const historyData = await getHistoryWithMeta(storageKey);

  // Sin hash previo: historial v1 legacy O primer mensaje del cliente.
  // En ambos casos NO invalidar — el próximo addMessage marcará el hash
  // y futuras comparaciones serán válidas.
  if (!historyData.promptHash) {
    return { invalidated: false };
  }

  if (historyData.promptHash === currentHash) {
    return { invalidated: false };
  }

  // Mismatch detectado: backup + del + métrica.
  const redis = await getRedis();
  if (!redis) {
    // Sin Redis no podemos hacer backup ni borrar. Loguear y dejar pasar
    // (el flujo continúa con el historial viejo — degradado pero vivo).
    botLog("warn", "prompt_invalidation_skipped_no_redis", {
      phone: storageKey,
      oldHash: historyData.promptHash,
      newHash: currentHash,
    });
    return { invalidated: false };
  }

  const rand = Math.random().toString(36).slice(2, 6);
  const backupKey = "backup:chat:" + storageKey + ":" + Date.now() + "-" + rand;

  try {
    await redis.set(backupKey, JSON.stringify(historyData), {
      ex: BACKUP_TTL_SECONDS,
    });
    await redis.del("chat:" + storageKey);
  } catch (e) {
    botLog("warn", "prompt_invalidation_redis_error", {
      phone: storageKey,
      oldHash: historyData.promptHash,
      newHash: currentHash,
      error: e.message,
    });
    return { invalidated: false };
  }

  const messagesDropped = Array.isArray(historyData.messages)
    ? historyData.messages.length
    : 0;

  botLog("info", "prompt_invalidation", {
    phone: storageKey,
    oldHash: historyData.promptHash,
    newHash: currentHash,
    mode: "hard",
    backupKey,
    messagesDropped,
  });

  return { invalidated: true, backupKey, messagesDropped };
}

module.exports = {
  computePromptHash,
  checkAndInvalidate,
  BACKUP_TTL_SECONDS,
  HASH_LENGTH,
};
