// src/store/history.js — Historial conversacional (Redis + fallback RAM).
//
// CONTRATO:
//   getHistory(phone): Promise<Array<{role, content}>>
//     Retorna SOLO los mensajes (lista plana). Vacío si primer contacto.
//     Compatibilidad con callers existentes — no rompen.
//
//   getHistoryWithMeta(phone): Promise<{
//     v: 1 | 2,
//     promptHash: string | null,
//     messages: Array<{role, content}>
//   }>
//     Retorna el historial + metadata. Hace migración transparente
//     desde v1 (array plano) a v2 ({v, promptHash, messages}). Usado por
//     src/prompt-version.js para detección de cambio de prompt.
//
//   addMessage(phone, role, content, promptHash?): Promise<void>
//     Append + trim ventana a MAX_MESSAGES (20) + set TTL 30 días.
//     Si recibe promptHash, escribe en formato v2; si no, v1 (compat).
//     Sin retorno — fire and forget desde el handler.
//
// NAMESPACE: chat:<phone>. TTL: 30 días (2592000s). Ventana: 20 últimos
// mensajes (splice FIFO cuando excede). Ver skill §2.
//
// FORMATO V1 (legacy): array de { role: "user" | "assistant", content }.
// FORMATO V2 (Pendiente-4): { v: 2, promptHash: "abc...", messages: [...] }.
// Migración: getHistoryWithMeta detecta v1 (Array.isArray) y lo envuelve
// con v:1 + promptHash:null sin tocar Redis. La próxima escritura con
// hash convertirá a v2.
//
// LOGS: usa console.log directo (NO botLog) — preservado byte-exact desde
// el extract original. Convertir a botLog en commit separado si hay ganas.
//
// NO ES LEAF: depende de src/store/redis (getRedis).

const { getRedis } = require("./redis");

// ============================================
// MEMORIA CONVERSACIONAL (chat:<phone>)
// ============================================

// Fallback a memoria en RAM si Redis no esta configurado
const conversationHistory = {};
const MAX_MESSAGES = 20;
const TTL_SECONDS = 2592000; // 30 días

// Parseo defensivo: Upstash puede devolver string o objeto ya parseado.
function parseValue(raw) {
  if (raw === null || raw === undefined) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

// Normaliza cualquier valor leído a la estructura v2 con migración v1→v2.
// v1 (array plano)            → { v: 1, promptHash: null, messages: [...] }
// v2 ({v, promptHash, messages}) → tal cual
// null/inválido               → { v: 2, promptHash: null, messages: [] }
function normalize(raw) {
  if (raw === null) {
    return { v: 2, promptHash: null, messages: [] };
  }
  if (Array.isArray(raw)) {
    // V1 legacy: array plano de {role, content}.
    return { v: 1, promptHash: null, messages: raw };
  }
  if (raw && typeof raw === "object" && Array.isArray(raw.messages)) {
    return {
      v: raw.v || 2,
      promptHash: raw.promptHash || null,
      messages: raw.messages,
    };
  }
  // Forma desconocida: empezar limpio para no propagar corrupción.
  return { v: 2, promptHash: null, messages: [] };
}

async function getHistory(phone) {
  const data = await getHistoryWithMeta(phone);
  return data.messages;
}

async function getHistoryWithMeta(phone) {
  const redis = await getRedis();
  if (redis) {
    try {
      const raw = await redis.get("chat:" + phone);
      return normalize(parseValue(raw));
    } catch (e) {
      console.log("Error leyendo Redis, usando RAM:", e.message);
    }
  }
  // Fallback RAM
  if (!conversationHistory[phone]) {
    conversationHistory[phone] = { v: 2, promptHash: null, messages: [] };
  }
  return conversationHistory[phone];
}

async function addMessage(phone, role, content, promptHash = null) {
  const redis = await getRedis();
  if (redis) {
    try {
      const raw = await redis.get("chat:" + phone);
      const current = normalize(parseValue(raw));
      const messages = current.messages.slice();
      messages.push({ role, content });
      if (messages.length > MAX_MESSAGES) {
        messages.splice(0, messages.length - MAX_MESSAGES);
      }
      // Si recibimos hash o el historial actual ya es v2, escribimos v2.
      // Si hash es null y el historial es v1, preservamos v1 (compat).
      const useV2 = promptHash !== null || current.v === 2;
      const payload = useV2
        ? {
            v: 2,
            promptHash: promptHash || current.promptHash || null,
            messages,
          }
        : messages;
      await redis.set("chat:" + phone, JSON.stringify(payload), {
        ex: TTL_SECONDS,
      });
      return;
    } catch (e) {
      console.log("Error escribiendo Redis, usando RAM:", e.message);
    }
  }
  // Fallback RAM (estructura v2 internamente para consistencia)
  if (!conversationHistory[phone]) {
    conversationHistory[phone] = { v: 2, promptHash: null, messages: [] };
  }
  const ramEntry = conversationHistory[phone];
  ramEntry.messages.push({ role, content });
  if (ramEntry.messages.length > MAX_MESSAGES) {
    ramEntry.messages.splice(0, ramEntry.messages.length - MAX_MESSAGES);
  }
  if (promptHash) {
    ramEntry.promptHash = promptHash;
  }
}

module.exports = { getHistory, getHistoryWithMeta, addMessage };
