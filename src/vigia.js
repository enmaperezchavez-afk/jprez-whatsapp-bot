// src/vigia.js — VIGÍA v2: "quién me escribió durante el apagón".
//
// Meta a veces entrega tarde los mensajes retenidos durante un incidente
// (como el del 12 jun: integración muerta por horas). El Vigía:
//
//   1. Detecta mensajes HUÉRFANOS por lag de entrega: el timestamp que
//      Meta pone en el mensaje vs la hora de llegada real. Lag > 5 min =
//      el mensaje vivió un apagón.
//   2. Registra la ventana del incidente [inicio, fin] en Redis y acumula
//      los huérfanos (número, nombre, hora).
//   3. El handler antepone una disculpa breve al cliente huérfano y
//      loggea "huerfano_recuperado".
//   4. Al volver la entrega en tiempo real (primer mensaje NO huérfano
//      con ventana abierta), compila el REPORTE para el Director: total,
//      lista número/nombre, a quiénes ya respondió Mateo, cuáles están
//      calientes o escalados (leído de meta:<phone> al momento).
//
// Limitación honesta: el Vigía solo ve lo que Meta ENTREGA. Mensajes que
// Meta descartó (reintentos agotados) no existen para nadie — por eso el
// reporte dice "huérfanos recuperados", no "todos los que escribieron".
//
// Fail-safe: cualquier error de Redis degrada a "no es huérfano" — el
// Vigía jamás bloquea una respuesta.

const { getRedis } = require("./store/redis");
const { botLog } = require("./log");

const WINDOW_KEY = "vigia:window";
const LAG_HUERFANO_MS = 5 * 60 * 1000; // 5 min de lag = vivió un apagón
const WINDOW_TTL_SECONDS = 7 * 24 * 3600; // forense 7 días

const DISCULPA_HUERFANO =
  "Disculpa la demora en responderte — tuvimos un inconveniente técnico y tu mensaje me llegó tarde. Ya estoy contigo:";

// esHuerfano(timestampSegundos, ahoraMs) — puro.
function esHuerfano(messageTsSec, ahoraMs = Date.now()) {
  const ts = Number(messageTsSec) * 1000;
  if (!Number.isFinite(ts) || ts <= 0) return false;
  return ahoraMs - ts > LAG_HUERFANO_MS;
}

async function getVentana(redis) {
  try {
    const raw = await redis.get(WINDOW_KEY);
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    console.log("[vigia] getVentana error:", e.message);
    return null;
  }
}

// registrarHuerfano: upsert de la ventana + el huérfano. Devuelve true si
// registró. (get/set no atómico: dos lambdas concurrentes pueden pisarse
// un huérfano — pérdida aceptable v1, el grueso del reporte sobrevive.)
async function registrarHuerfano({ phone, name, tsSec }) {
  try {
    const redis = await getRedis();
    if (!redis) return false;
    const tsIso = new Date(Number(tsSec) * 1000).toISOString();
    let w = (await getVentana(redis)) || { inicio: tsIso, fin: tsIso, reported: false, huerfanos: {} };
    if (w.reported) {
      // ventana anterior ya reportada: este huérfano abre una nueva
      w = { inicio: tsIso, fin: tsIso, reported: false, huerfanos: {} };
    }
    if (tsIso < w.inicio) w.inicio = tsIso;
    if (tsIso > w.fin) w.fin = tsIso;
    const previo = w.huerfanos[phone];
    w.huerfanos[phone] = {
      name: name || (previo && previo.name) || "Desconocido",
      primerTs: (previo && previo.primerTs) || tsIso,
      mensajes: ((previo && previo.mensajes) || 0) + 1,
      respondido: true, // el handler sigue al flujo normal tras registrar
    };
    await redis.set(WINDOW_KEY, JSON.stringify(w), { ex: WINDOW_TTL_SECONDS });
    botLog("warn", "huerfano_recuperado", { phone, lagDesde: tsIso });
    return true;
  } catch (e) {
    console.log("[vigia] registrarHuerfano error:", e.message);
    return false;
  }
}

// chequearRecuperacion: con ventana abierta sin reportar y entrega ya en
// tiempo real → compila el reporte (leyendo meta de cada huérfano) y
// marca reported. Devuelve el texto del reporte o null. getMeta
// inyectable: (phone) -> meta | null.
async function chequearRecuperacion({ getMeta, extintorStatus }) {
  try {
    const redis = await getRedis();
    if (!redis) return null;
    const w = await getVentana(redis);
    if (!w || w.reported || !Object.keys(w.huerfanos || {}).length) return null;

    const lineas = [];
    let calientes = 0;
    let escalados = 0;
    for (const [phone, h] of Object.entries(w.huerfanos)) {
      let marca = "";
      try {
        const meta = getMeta ? await getMeta(phone) : null;
        if (meta && meta.escalated === true) {
          marca = " 🆘 requiere humano";
          escalados++;
        } else if (meta && meta.temperature === "hot") {
          marca = " 🔥 caliente";
          calientes++;
        }
      } catch (e) {
        console.log("[vigia] meta error:", e.message);
      }
      lineas.push(
        "• " + phone + " (" + h.name + ") — " + h.mensajes + " msj desde " +
          h.primerTs.slice(11, 16) + " UTC" + (h.respondido ? ", ya respondido" : ", SIN responder") + marca
      );
    }

    w.reported = true;
    w.reportedAt = new Date().toISOString();
    await redis.set(WINDOW_KEY, JSON.stringify(w), { ex: WINDOW_TTL_SECONDS });

    const total = Object.keys(w.huerfanos).length;
    const modo = extintorStatus ? "\nModo actual del bot: " + extintorStatus : "";
    const reporte =
      "🛰️ [VIGÍA] Entrega de Meta RECUPERADA.\n" +
      "Ventana del apagón: " + w.inicio.slice(0, 16).replace("T", " ") + " → " + w.fin.slice(0, 16).replace("T", " ") + " UTC\n" +
      "Clientes que escribieron en la ventana (recuperados): " + total +
      (calientes ? " · 🔥 " + calientes : "") + (escalados ? " · 🆘 " + escalados : "") + "\n" +
      lineas.join("\n") + modo +
      "\n(Solo veo lo que Meta entregó tarde — mensajes descartados por Meta no aparecen.)";

    botLog("warn", "vigia_reporte_recuperacion", { total, calientes, escalados, inicio: w.inicio, fin: w.fin });
    return reporte;
  } catch (e) {
    console.log("[vigia] chequearRecuperacion error:", e.message);
    return null;
  }
}

module.exports = {
  esHuerfano,
  registrarHuerfano,
  chequearRecuperacion,
  getVentana,
  DISCULPA_HUERFANO,
  LAG_HUERFANO_MS,
  WINDOW_KEY,
};
