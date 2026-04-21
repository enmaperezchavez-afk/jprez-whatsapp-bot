// src/store/history.js — Historial conversacional (Redis + fallback RAM).
//
// CONTRATO:
//   getHistory(phone): Promise<Array<{role, content}>>
//     Retorna el historial del cliente (lista de mensajes). Vacío si primer
//     contacto. Fallback a RAM si Redis cae — se pierde en cold start pero
//     el bot sigue respondiendo.
//
//   addMessage(phone, role, content): Promise<void>
//     Append + trim ventana a MAX_MESSAGES (20) + set TTL 30 días.
//     Sin retorno — fire and forget desde el handler.
//
// NAMESPACE: chat:<phone>. TTL: 30 días (2592000s). Ventana: 20 últimos
// mensajes (splice FIFO cuando excede). Ver skill §2.
//
// FORMATO: array de { role: "user" | "assistant", content: string }.
// Serializado con JSON.stringify. Upstash puede devolver string o objeto
// ya parseado — parseo defensivo.
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

async function getHistory(phone) {
  // Intentar Redis primero
  const redis = await getRedis();
  if (redis) {
    try {
      const history = await redis.get("chat:" + phone);
      if (history) {
        // Redis puede devolver string o objeto ya parseado
        const parsed = typeof history === "string" ? JSON.parse(history) : history;
        return parsed;
      }
      return [];
    } catch (e) {
      console.log("Error leyendo Redis, usando RAM:", e.message);
    }
  }
  // Fallback a RAM
  if (!conversationHistory[phone]) {
    conversationHistory[phone] = [];
  }
  return conversationHistory[phone];
}

async function addMessage(phone, role, content) {
  const redis = await getRedis();
  if (redis) {
    try {
      let history = await redis.get("chat:" + phone);
      history = history ? (typeof history === "string" ? JSON.parse(history) : history) : [];
      history.push({ role, content });
      if (history.length > MAX_MESSAGES) {
        history.splice(0, history.length - MAX_MESSAGES);
      }
      // Guardar con expiracion de 30 dias (2592000 segundos)
      await redis.set("chat:" + phone, JSON.stringify(history), { ex: 2592000 });
      return;
    } catch (e) {
      console.log("Error escribiendo Redis, usando RAM:", e.message);
    }
  }
  // Fallback a RAM
  if (!conversationHistory[phone]) {
    conversationHistory[phone] = [];
  }
  conversationHistory[phone].push({ role, content });
  if (conversationHistory[phone].length > MAX_MESSAGES) {
    conversationHistory[phone].splice(0, conversationHistory[phone].length - MAX_MESSAGES);
  }
}

module.exports = { getHistory, addMessage };
