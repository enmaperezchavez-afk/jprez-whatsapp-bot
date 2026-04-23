// src/profile/storage.js — Persistencia del perfil Mateo en Redis.
//
// NAMESPACE: profile:<phone>. INTACTO de meta:<phone> (decisión BC6-a del
// brief Día 3). La estructura meta existente sigue siendo usada por
// followups, escalation gating, sentDocs y contexto dinámico actual. Este
// profile corre en paralelo, es alimentado por el bloque <perfil_update>
// que emite Mateo, y se consulta antes de cada respuesta para inyectar
// PERFIL_CLIENTE al system prompt.
//
// CONTRATO:
//   getCustomerProfile(phone): Promise<object>
//     - Retorna el perfil almacenado o un shape "cliente nuevo" si no hay
//       entrada. Nunca retorna null — simplifica el caller.
//     - is_new: true si la clave no existe en Redis, false si sí.
//     - Fail-open: si Redis falla, devuelve "cliente nuevo" + logea warning.
//
//   updateCustomerProfile(phone, deltas): Promise<object>
//     - Merge inteligente sobre la entrada existente (o shape nuevo).
//     - Reglas de merge:
//         * Scalars: si delta[k] es null/undefined, NO pisa. Si es valor
//           concreto, pisa al campo existente.
//         * Arrays (tags, competencia_mencionada, documentos_solicitados,
//           objeciones_historicas): merge de union — agrega solo valores
//           nuevos, evita duplicados (case-sensitive).
//         * Objects anidados (info_interna): shallow merge (delta gana).
//         * Siempre bump ultimo_contacto al ISO actual.
//         * Si is_new, setea fecha_primer_contacto = ahora.
//         * Siempre bump conversaciones_count en +1.
//     - TTL sliding 90 días: cada escritura reseta expiración.
//     - Fail-open: si Redis falla, retorna el shape mergeado sin persistir.
//
// SHAPE DE PERFIL (documentado en brief Día 3):
//   { wa_id, nombre, telefono, fecha_primer_contacto, ultimo_contacto,
//     conversaciones_count, proyecto_interes, tipologia_interes,
//     presupuesto_mencionado, moneda_presupuesto, intencion_compra,
//     score_lead, tags, objeciones_historicas, documentos_enviados,
//     siguiente_accion_pendiente, ubicacion_cliente, fuente_financiamiento,
//     fecha_mudanza_objetivo, competencia_mencionada, info_interna }
//
// MAPEO BLOQUE → PERFIL:
//   El bloque <perfil_update> que emite Mateo tiene campos que NO son 1:1
//   con el shape. Mapeamos:
//     - objecion_detectada (bloque) → objeciones_historicas (perfil): push
//     - tags_nuevos (bloque)        → tags (perfil): union
//     - documentos_solicitados      → documentos_enviados: union
//     - siguiente_accion_sugerida   → siguiente_accion_pendiente
//     - resto pasa como scalar por nombre.
//
// DEPS: ../store/redis (getRedis). NO require-loopea con message.js.

const { getRedis } = require("../store/redis");

const TTL_SECONDS = 90 * 24 * 3600; // 90 días
const PROFILE_KEY_PREFIX = "profile:";

function emptyProfile(phone) {
  return {
    wa_id: phone,
    nombre: null,
    telefono: phone,
    fecha_primer_contacto: null,
    ultimo_contacto: null,
    conversaciones_count: 0,
    proyecto_interes: null,
    tipologia_interes: null,
    presupuesto_mencionado: null,
    moneda_presupuesto: null,
    intencion_compra: null,
    score_lead: null,
    tags: [],
    objeciones_historicas: [],
    documentos_enviados: [],
    siguiente_accion_pendiente: null,
    ubicacion_cliente: null,
    fuente_financiamiento: null,
    fecha_mudanza_objetivo: null,
    competencia_mencionada: [],
    info_interna: {},
    is_new: true,
  };
}

async function getCustomerProfile(phone) {
  const redis = await getRedis();
  if (!redis) {
    return emptyProfile(phone);
  }
  try {
    const raw = await redis.get(PROFILE_KEY_PREFIX + phone);
    if (!raw) return emptyProfile(phone);
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return { ...parsed, is_new: false };
  } catch (e) {
    console.log("[profile] Error leyendo perfil:", e.message);
    return emptyProfile(phone);
  }
}

// Union de arrays sin duplicados. Orden preservado: existentes primero,
// luego nuevos en el orden en que llegaron. Compara por igualdad simple
// (case-sensitive). Si se llenan demasiado, la ventana se trunca en el
// caller — acá no imponemos tope.
function mergeArray(existing, incoming) {
  const base = Array.isArray(existing) ? existing.slice() : [];
  if (!Array.isArray(incoming)) return base;
  for (const item of incoming) {
    if (item == null) continue;
    if (!base.includes(item)) base.push(item);
  }
  return base;
}

async function updateCustomerProfile(phone, deltas) {
  const current = await getCustomerProfile(phone);
  const isFirstInteraction = current.is_new === true;

  // Copia base sin el flag is_new (no se persiste — se deriva al leer).
  const merged = { ...current };
  delete merged.is_new;

  const d = deltas || {};

  // ---- Scalars: solo pisan si delta trae valor concreto ----
  const scalarFields = [
    "nombre",
    "proyecto_interes",
    "tipologia_interes",
    "presupuesto_mencionado",
    "moneda_presupuesto",
    "intencion_compra",
    "score_lead",
    "ubicacion_cliente",
    "fuente_financiamiento",
    "fecha_mudanza_objetivo",
  ];
  for (const f of scalarFields) {
    if (d[f] != null && d[f] !== "") {
      merged[f] = d[f];
    }
  }

  // ---- Arrays: union ----
  if (d.tags_nuevos) merged.tags = mergeArray(merged.tags, d.tags_nuevos);
  if (d.competencia_mencionada) merged.competencia_mencionada = mergeArray(merged.competencia_mencionada, d.competencia_mencionada);
  if (d.documentos_solicitados) merged.documentos_enviados = mergeArray(merged.documentos_enviados, d.documentos_solicitados);

  // ---- Objeción detectada: push a historial (si es nueva) ----
  if (d.objecion_detectada) {
    merged.objeciones_historicas = mergeArray(merged.objeciones_historicas, [d.objecion_detectada]);
  }
  if (d.objecion_nueva === true && d.objecion_nueva_texto) {
    merged.objeciones_historicas = mergeArray(merged.objeciones_historicas, [d.objecion_nueva_texto]);
  }

  // ---- Siguiente acción: scalar pero mapeamos de bloque → perfil ----
  if (d.siguiente_accion_sugerida != null && d.siguiente_accion_sugerida !== "none") {
    merged.siguiente_accion_pendiente = d.siguiente_accion_sugerida;
  }

  // ---- info_interna: shallow merge (delta gana por key) ----
  if (d.info_interna && typeof d.info_interna === "object" && !Array.isArray(d.info_interna)) {
    merged.info_interna = { ...(merged.info_interna || {}), ...d.info_interna };
  }

  // ---- Timestamps + contador ----
  const nowIso = new Date().toISOString();
  if (isFirstInteraction && !merged.fecha_primer_contacto) {
    merged.fecha_primer_contacto = nowIso;
  }
  merged.ultimo_contacto = nowIso;
  merged.conversaciones_count = (merged.conversaciones_count || 0) + 1;

  // Forzar siempre wa_id + telefono
  merged.wa_id = phone;
  merged.telefono = phone;

  // ---- Persistir con TTL sliding ----
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.set(PROFILE_KEY_PREFIX + phone, JSON.stringify(merged), { ex: TTL_SECONDS });
    } catch (e) {
      console.log("[profile] Error persistiendo perfil:", e.message);
    }
  }

  return merged;
}

module.exports = {
  getCustomerProfile,
  updateCustomerProfile,
  PROFILE_KEY_PREFIX,
  TTL_SECONDS,
  _internal: { emptyProfile, mergeArray }, // Solo para tests.
};
