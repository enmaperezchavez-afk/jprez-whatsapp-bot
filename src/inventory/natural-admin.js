// src/inventory/natural-admin.js — Sprint1.8 PR-2: ADMIN NATURAL.
//
// El Director edita el inventario hablando normal (texto o nota de voz
// vía Whisper): "ponle 95 mil al 15-102 de puerto plata etapa 4",
// "reserva el 11A de prado 4", "libera el 8C de crux torre 6 en 176,500",
// "marca vendido el 12D de pr4".
//
// PRINCIPIOS DE SEGURIDAD (orden del Director):
//   1. Autorización SOLO por número verificado (ADMIN_PHONES) — conocer
//      la sintaxis jamás da poder de escritura.
//   2. CONFIRMACIÓN ANTES DE ESCRIBIR: el intent parseado queda PENDIENTE
//      en Redis (TTL 5 min) y solo un "sí/dale/confirmo" explícito lo
//      ejecuta — por el MISMO executor de admin-commands (cero bypass
//      del motor seguro). "no/cancela" aborta; cualquier otro mensaje
//      cancela el pendiente (nunca escribir sin sí explícito).
//   3. Confirmación POST con valor anterior + comando de reversión exacto.
//   4. Audit log a Axiom de toda escritura (quién, qué, antes/después)
//      — el sheets-writer ya emite inventory_update; este flujo agrega
//      admin_natural_write con el contexto del intent.
//
// PARSER DETERMINISTA (no LLM): un write de inventario no se le confía a
// una inferencia — regex con vocabulario cerrado. Lo que no parsea cae
// al flujo supervisor normal (el LLM responde, no escribe).

const { toNumber } = require("./parser");

const PENDING_PREFIX = "admin:pending-write:";
const PENDING_TTL_SECONDS = 300; // 5 min para confirmar

// ---- proyecto: alias en lenguaje natural -> key del executor ----
function resolveProjectAlias(texto) {
  const t = quitarAcentos(String(texto || "").toLowerCase());
  const esPP = /(puerto\s*plata|suites|pse)/.test(t);
  if (esPP && /(etapa\s*4|pse\s*-?\s*4|e4)/.test(t)) return "pse4";
  if (esPP && /(etapa\s*3|pse\s*-?\s*3|e3)/.test(t)) return "pse3";
  if (/(crux|torre)/.test(t) && /(torre\s*6|t6|construccion)/.test(t)) return "crux_t6";
  if (/crux/.test(t) && /(listos?|entrega\s*inmediata)/.test(t)) return "crux_listos";
  if (/(prado\s*(residences)?\s*(3|iii)|pr\s*-?\s*3|prado3)/.test(t)) return "pr3";
  if (/(prado\s*(residences)?\s*(4|iv)|pr\s*-?\s*4|prado4)/.test(t)) return "pr4";
  return null;
}

function quitarAcentos(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// ---- monto: "95 mil" / "95k" / "95,000" / "95000" -> 95000 ----
// Recoge TODOS los candidatos y devuelve el mayor >= 1000: así "torre 6"
// o el "4" de "pse4" jamás se leen como precio (ninguna unidad JPREZ
// cuesta menos de US$1,000 — y la reserva mínima es exactamente 1,000).
function parseMonto(texto) {
  const t = quitarAcentos(String(texto || "").toLowerCase());
  const candidatos = [];
  const re = /([\d][\d,\.]*)\s*(mil|k)?\b/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const base = toNumber(m[1]);
    if (base == null) continue;
    candidatos.push(m[2] ? Math.round(base * 1000) : base);
  }
  const validos = candidatos.filter((n) => Number.isFinite(n) && n >= 1000);
  return validos.length ? Math.max(...validos) : null;
}

// ---- unidad: "15-102", "11A", "8C", "4G" ----
// La letra suelta excluye k/K ("95k" es un monto, no la unidad 95K).
const UNIT_RE = /\b(\d{1,2}-\d{1,3}[a-z]?|\d{1,2}[a-jl-z])\b/i;

// parseNaturalAdminIntent(text) -> parsed compatible con
// executeAdminCommand ({command, project, unit, price?, error?}) | null.
// null = no es intent de escritura (mensaje supervisor normal).
function parseNaturalAdminIntent(text) {
  if (typeof text !== "string") return null;
  // El audio llega con el marker del transcriptor — se ignora al parsear.
  const limpio = text.replace(/^\[audio transcrito\]\s*/i, "").trim();
  const t = quitarAcentos(limpio.toLowerCase());
  if (t.startsWith("/")) return null; // slash commands: vía clásica intacta

  // El verbo debe ser IMPERATIVO y abrir la orden (con muletillas
  // opcionales). "la reserva del cliente va bien" NO es una orden — el
  // sustantivo en medio de una frase jamás dispara escritura.
  const inicio = t.replace(/^(mateo[,:]?\s*|oye[,:]?\s*|por\s+favor[,:]?\s*|porfa[,:]?\s*)+/, "");
  let command = null;
  if (/^(ponle|pon\b|cambia(le)?\s+(el\s+)?precio|ajusta(le)?\s+(el\s+)?precio|actualiza(le)?\s+(el\s+)?precio|sube(le)?\s+(el\s+)?precio|baja(le)?\s+(el\s+)?precio)/.test(inicio)) {
    command = "precio";
  } else if (/^(reserva(me|r|lo|la)?\b|aparta(me|r|lo|la)?\b)/.test(inicio)) {
    command = "reservar";
  } else if (/^(libera(me|r|lo|la)?\b)/.test(inicio)) {
    command = "liberar";
  } else if (/^(vende(lo|la|r)?\b|marca(lo|la)?\s+(como\s+)?vendid[oa]\b|ponlo\s+vendido\b|ponla\s+vendida\b)/.test(inicio)) {
    command = "vender";
  }
  if (!command) return null;

  const unitMatch = limpio.match(UNIT_RE);
  const project = resolveProjectAlias(t);

  // monto: el primer número que NO sea la unidad. Quitamos la unidad del
  // texto antes de buscar monto para no confundir "15-102" con un precio.
  const sinUnidad = unitMatch ? limpio.replace(unitMatch[0], " ") : limpio;
  const price = parseMonto(sinUnidad);

  const parsed = { command, natural: true };
  if (project) parsed.project = project;
  if (unitMatch) parsed.unit = unitMatch[1].toUpperCase();
  if (price != null && (command === "precio" || command === "liberar")) parsed.price = price;

  // Señales de falta (mismos códigos que el parser slash: el executor ya
  // tiene los mensajes guía).
  if (!parsed.project) parsed.error = "missing_project";
  else if (!parsed.unit) parsed.error = "missing_unit";
  else if ((command === "precio" || command === "liberar") && parsed.price == null) {
    parsed.error = "missing_price";
  } else if (parsed.price != null && (!Number.isFinite(parsed.price) || parsed.price <= 0)) {
    parsed.error = "invalid_price";
  }

  return parsed;
}

// ---- formato de montos en confirmaciones: "US$95,000", no "95000" ----
function formatMonto(n, moneda = "US$") {
  if (n == null || !Number.isFinite(Number(n))) return String(n);
  return moneda + Number(n).toLocaleString("en-US");
}

// ---- preview de confirmación: "¿Confirmo? PSE4 15-102: ... → ..." ----
function buildConfirmPrompt(parsed, snapshot) {
  const moneda = (snapshot && snapshot.moneda) || "US$";
  const antesEstado = (snapshot && snapshot.estado) || "?";
  const antesPrecio = snapshot && snapshot.precio ? formatMonto(toNumber(snapshot.precio), moneda) : "?";
  const lugar = String(parsed.project).toUpperCase() + " " + parsed.unit;

  let cambio;
  if (parsed.command === "precio") {
    cambio = antesPrecio + " → " + formatMonto(parsed.price, moneda);
  } else if (parsed.command === "reservar") {
    cambio = antesEstado + " → reservado";
  } else if (parsed.command === "vender") {
    cambio = antesEstado + " → vendido";
  } else if (parsed.command === "liberar") {
    cambio = antesEstado + " (" + antesPrecio + ") → disponible en " + formatMonto(parsed.price, moneda);
  }
  return "¿Confirmo? " + lugar + ": " + cambio + "\n(responde sí para ejecutar, no para cancelar)";
}

// ---- comando de reversión exacto para la confirmación POST ----
function buildRevertCommand(parsed, snapshot) {
  const p = parsed.project;
  const u = parsed.unit;
  const precioAntes = snapshot && snapshot.precio ? toNumber(snapshot.precio) : null;
  if (parsed.command === "precio" && precioAntes != null) {
    return "/precio " + p + " " + u + " " + precioAntes;
  }
  if (parsed.command === "reservar" || parsed.command === "vender") {
    return precioAntes != null
      ? "/liberar " + p + " " + u + " " + precioAntes
      : "/liberar " + p + " " + u + " [precio]";
  }
  if (parsed.command === "liberar") {
    const estadoAntes = (snapshot && snapshot.estado) || "";
    if (/reservad/i.test(estadoAntes)) return "/reservar " + p + " " + u;
    if (/vendid/i.test(estadoAntes)) return "/vender " + p + " " + u;
    return "/precio " + p + " " + u + " " + (precioAntes != null ? precioAntes : "[precio]");
  }
  return null;
}

// ---- eco de confirmación (Sprint1.8 PR-3) ----
// El supervisor a veces reenvía/copia una confirmación del propio bot
// ("✅ PSE4 15-102 marcada como reservada."). Sin guard, el LLM
// supervisor tiende a re-confirmar una acción que NO ejecutó. Detecta
// el shape de las confirmaciones del executor y del flujo natural.
function esEcoConfirmacion(text) {
  const t = String(text || "").trim();
  if (!t.startsWith("✅")) return false;
  return /(marcada?\s+como\s+(reservad|vendid)|liberad[ao]\s+en|precio\s+de\s+.+\s+actualizado)/i.test(t);
}

const ECO_CONFIRMACION_REPLY =
  "Eso parece el eco de una confirmación mía — NO ejecuté ningún cambio nuevo. " +
  "Si quieres repetir la operación, dímela como orden (natural o /comando).";

// ---- respuesta de confirmación: sí / no / null ----
function esRespuestaConfirmacion(text) {
  const t = quitarAcentos(String(text || "").toLowerCase()).replace(/[¡!.,;:]+/g, "").trim();
  if (/^(si|sii+|dale|confirmo|confirmado|hazlo|ok|okey|okay|correcto|ejecuta|adelante|si senor)$/.test(t)) return "si";
  if (/^(no|cancela|cancelar|cancelalo|aborta|abortar|dejalo|olvidalo|nope)$/.test(t)) return "no";
  return null;
}

// ---- estado pendiente en Redis ----
async function savePendingWrite(redis, phone, payload) {
  if (!redis) return false;
  await redis.set(PENDING_PREFIX + phone, JSON.stringify(payload), { ex: PENDING_TTL_SECONDS });
  return true;
}

async function getPendingWrite(redis, phone) {
  if (!redis) return null;
  const raw = await redis.get(PENDING_PREFIX + phone);
  if (!raw) return null;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

async function clearPendingWrite(redis, phone) {
  if (!redis) return;
  await redis.del(PENDING_PREFIX + phone);
}

module.exports = {
  parseNaturalAdminIntent,
  resolveProjectAlias,
  parseMonto,
  formatMonto,
  esEcoConfirmacion,
  ECO_CONFIRMACION_REPLY,
  buildConfirmPrompt,
  buildRevertCommand,
  esRespuestaConfirmacion,
  savePendingWrite,
  getPendingWrite,
  clearPendingWrite,
  PENDING_PREFIX,
  PENDING_TTL_SECONDS,
};
