// src/extintor.js — PROTOCOLO EXTINTOR [🌐 CORE]: override total de chats.
//
// Dos niveles de freno manual para el Director (Admin Natural: misma
// lista blanca ADMIN_PHONES, autorización SOLO por número):
//
//   NIVEL 1 — pausa por chat: "pausa al <numero>" → Mateo callado en ese
//     chat (flag SIN TTL, solo lo quita "despierta al <numero>") y cada
//     mensaje entrante de ese número se reenvía al Director.
//   NIVEL 2 — modo manual global: "/extintor" (con confirmación: es el
//     botón rojo) → Mateo deja de responder a TODOS los clientes; cada
//     entrante se reenvía al Director. RELAY: "dile al <numero>: <texto>"
//     → sale VERBATIM por la línea oficial (cero LLM, sanitización
//     básica), SIN confirmación (la velocidad es el punto).
//     "/extintor-off" → retoma normal (apagar el freno tampoco confirma).
//
// FAIL-SAFE (regla del Director): si Redis no se puede leer, Mateo
// responde NORMAL — el extintor jamás puede convertirse él mismo en el
// incendio. Por eso TODAS las lecturas degradan a "modo normal".
//
// Persistencia: Redis (sobrevive deploys). Audit completo a Axiom:
// quién activó/desactivó/pausó, qué relays salieron.

const { getRedis } = require("./store/redis");
const { botLog } = require("./log");

const GLOBAL_KEY = "extintor:global";
const PAUSED_PREFIX = "extintor:paused:";
const PAUSED_SET = "extintor:paused-set";
const RELAY_MAX_CHARS = 4096; // límite duro de WhatsApp text

// ---------- estado (todas las lecturas fail-safe → normal) ----------

async function isGlobalOn() {
  try {
    const r = await getRedis();
    if (!r) return false;
    return (await r.get(GLOBAL_KEY)) === "on";
  } catch (e) {
    console.log("[extintor] isGlobalOn error (fail-safe normal):", e.message);
    return false;
  }
}

async function isPaused(phone) {
  try {
    const r = await getRedis();
    if (!r) return false;
    return (await r.get(PAUSED_PREFIX + phone)) === "on";
  } catch (e) {
    console.log("[extintor] isPaused error (fail-safe normal):", e.message);
    return false;
  }
}

async function getStatus() {
  try {
    const r = await getRedis();
    if (!r) return { modo: "normal", pausados: [], error: "redis_unavailable" };
    const global = (await r.get(GLOBAL_KEY)) === "on";
    let pausados = [];
    try {
      pausados = (await r.smembers(PAUSED_SET)) || [];
    } catch (e) {
      console.log("[extintor] smembers error:", e.message);
    }
    return { modo: global ? "extintor" : "normal", pausados };
  } catch (e) {
    return { modo: "normal", pausados: [], error: e.message };
  }
}

// ---------- mutaciones (con audit a Axiom) ----------

async function setGlobal(on, adminPhone) {
  const r = await getRedis();
  if (!r) return { ok: false, reason: "redis_unavailable" };
  if (on) await r.set(GLOBAL_KEY, "on"); // SIN TTL: solo /extintor-off lo quita
  else await r.del(GLOBAL_KEY);
  botLog("warn", on ? "extintor_global_on" : "extintor_global_off", {
    admin: adminPhone,
    timestamp: new Date().toISOString(),
  });
  return { ok: true };
}

async function pauseChat(phone, adminPhone) {
  const r = await getRedis();
  if (!r) return { ok: false, reason: "redis_unavailable" };
  await r.set(PAUSED_PREFIX + phone, "on"); // SIN TTL (a diferencia del holding 4h)
  try {
    await r.sadd(PAUSED_SET, phone);
  } catch (e) {
    console.log("[extintor] sadd error:", e.message);
  }
  botLog("warn", "extintor_chat_paused", { admin: adminPhone, chat: phone });
  return { ok: true };
}

async function resumeChat(phone, adminPhone) {
  const r = await getRedis();
  if (!r) return { ok: false, reason: "redis_unavailable" };
  await r.del(PAUSED_PREFIX + phone);
  try {
    await r.srem(PAUSED_SET, phone);
  } catch (e) {
    console.log("[extintor] srem error:", e.message);
  }
  botLog("warn", "extintor_chat_resumed", { admin: adminPhone, chat: phone });
  return { ok: true };
}

// ---------- parser de comandos (determinista, estilo Admin Natural) ----------

// normaliza "+1 829-994-3102" / "1829..." → dígitos. Exige 10-15 dígitos.
function parsePhone(s) {
  const d = String(s || "").replace(/[^\d]/g, "");
  return d.length >= 10 && d.length <= 15 ? d : null;
}

// parseExtintorCommand(text) -> { command, phone?, texto? } | null
//   pause | resume | global_on | global_off | relay | status
function parseExtintorCommand(text) {
  if (typeof text !== "string") return null;
  const limpio = text.replace(/^\[audio transcrito\]\s*/i, "").trim();
  const t = limpio
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

  if (/^\/status$/.test(t) || /^estado del bot$/.test(t)) return { command: "status" };
  if (/^\/extintor-?off$/.test(t) || /^modo normal$/.test(t)) return { command: "global_off" };
  if (/^\/extintor$/.test(t) || /^modo manual$/.test(t)) return { command: "global_on" };

  let m = t.match(/^pausa(?:r)?\s+(?:a|al|el\s+chat(?:\s+de)?l?)?\s*([+\d][\d\s\-+().]{8,})$/);
  if (m) {
    const phone = parsePhone(m[1]);
    return phone ? { command: "pause", phone } : { command: "pause", error: "bad_phone" };
  }
  m = t.match(/^(?:despierta|reactiva|reanuda)(?:r)?\s+(?:a|al|el\s+chat(?:\s+de)?l?)?\s*([+\d][\d\s\-+().]{8,})$/);
  if (m) {
    const phone = parsePhone(m[1]);
    return phone ? { command: "resume", phone } : { command: "resume", error: "bad_phone" };
  }

  // RELAY verbatim: "dile al <numero>: <texto>". El texto sale del mensaje
  // ORIGINAL (limpio), no del normalizado — verbatim significa verbatim.
  m = limpio.match(/^dile\s+(?:a|al)\s*([+\d][\d\s\-+().]{8,}?)\s*[:,]\s*([\s\S]+)$/i);
  if (m) {
    const phone = parsePhone(m[1]);
    if (!phone) return { command: "relay", error: "bad_phone" };
    const texto = sanitizeRelay(m[2]);
    return texto ? { command: "relay", phone, texto } : { command: "relay", error: "empty_text" };
  }

  return null;
}

// sanitizeRelay: VERBATIM salvo lo minimo — trim, control chars fuera
// (preserva saltos de linea), tope 4096 (limite WhatsApp). Cero edicion
// de contenido.
function sanitizeRelay(texto) {
  let s = "";
  for (const ch of String(texto || "")) {
    const c = ch.charCodeAt(0);
    // control chars fuera (preserva salto de linea y tab)
    if ((c < 32 && ch !== "\n" && ch !== "\t") || c === 127) continue;
    s += ch;
  }
  s = s.trim();
  return s ? s.slice(0, RELAY_MAX_CHARS) : null;
}

module.exports = {
  isGlobalOn,
  isPaused,
  getStatus,
  setGlobal,
  pauseChat,
  resumeChat,
  parseExtintorCommand,
  parsePhone,
  sanitizeRelay,
  GLOBAL_KEY,
  PAUSED_PREFIX,
  PAUSED_SET,
  RELAY_MAX_CHARS,
};
