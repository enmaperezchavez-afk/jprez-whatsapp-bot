// ============================================
// TOOL: consultar_tasa_dolar (skeleton drop-in)
// Tasa USD/DOP de referencia BCRD — Tool Use de Anthropic
// ============================================
//
// Mismo patrón que src/tools/icdv.js: schema + handler.
//
// DISCIPLINA (Sprint 1 PR-1, Fase 1): este skeleton queda listo como
// drop-in pero NO se cablea al array TOOLS de src/handlers/message.js
// hasta la Fase 2 (mismo camino que recorrió el ICDV: Bloque 3 lo dejó
// drop-in y Sprint0 PR-D lo activó). Cablear una tool toca el prompt
// budget y el comportamiento de Mateo — eso se decide y testea aparte.
//
// FUENTE DE DATOS: la serie viva vía loadDoc de api/tasa.js (cache Redis
// → store del cron → mock). NO hay seed en disco: el XLSX del BCRD trae
// la serie completa en cada scrape; si el cron nunca corrió, el handler
// degrada con ok:false y un mensaje accionable para Mateo.

const TOOL_CONSULTAR_TASA = {
  name: "consultar_tasa_dolar",
  description:
    "Consulta la tasa de cambio oficial USD/DOP de referencia del mercado spot que publica el Banco Central de la República Dominicana (BCRD). " +
    "Úsala cuando el cliente pregunte 'a cuánto está el dólar', 'cuál es la tasa de cambio', quiera convertir un precio en dólares a pesos " +
    "dominicanos (o al revés), o pregunte si el peso se ha devaluado. Devuelve compra, venta y promedio del día más reciente, la variación " +
    "vs el día anterior y vs ~30 días, y opcionalmente la serie de los últimos días para tendencia. " +
    "IMPORTANTE: son cifras oficiales del BCRD — preséntalas exactas, nunca inventes ni redondees la tasa. Los precios de JPREZ son en US$; " +
    "la conversión a DOP es referencial. Si el dato no está disponible, díselo al cliente y ofrece que Enmanuel se lo confirme.",
  input_schema: {
    type: "object",
    properties: {
      detalle: {
        type: "string",
        enum: ["resumen", "serie"],
        description:
          "'resumen' = solo la tasa más reciente con sus variaciones (default). " +
          "'serie' = incluye además la serie diaria de los últimos días para mostrar tendencia.",
      },
      dias: {
        type: "integer",
        minimum: 1,
        maximum: 90,
        description: "Cuántos días de serie incluir cuando detalle='serie' (default 10).",
      },
    },
    required: [],
  },
};

// resumenEntry: proyecta una entrada de la serie a lo que Mateo necesita
// para hablar en prosa con números exactos.
function resumenEntry(e) {
  if (!e) return null;
  return {
    fecha: e.fecha,
    compra: e.compra,
    venta: e.venta,
    promedio: e.promedio,
  };
}

// loadLiveDoc: doc vivo (Redis cache → store del cron → mock) vía
// api/tasa.js. Devuelve el doc solo si trae latest; null ante cualquier
// fallo. deps inyectables para tests.
async function loadLiveDoc(deps = {}) {
  try {
    const getRedis = deps.getRedis || require("../store/redis").getRedis;
    const loadDoc = deps.loadDoc || require("../../api/tasa.js").loadDoc;
    const doc = await loadDoc(await getRedis());
    if (doc && doc.latest) return doc;
    return null;
  } catch (e) {
    console.error("[tool:tasa] loadDoc falló:", e.message);
    return null;
  }
}

// consultarTasaDolar: handler de tool_use. input ya viene validado por el
// SDK contra el schema. Devuelve JSON estructurado que Mateo serializa
// en prosa.
async function consultarTasaDolar(input, deps = {}) {
  const detalle = (input && input.detalle) || "resumen";
  const dias = Math.max(1, Math.min(90, (input && input.dias) || 10));

  const data = await loadLiveDoc(deps);
  if (!data) {
    return {
      ok: false,
      warning:
        "Serie de tasa USD/DOP no disponible (el scraper del BCRD aún no ha corrido o Redis está vacío). " +
        "Dile al cliente que Enmanuel le confirma la tasa del día — NO inventes una cifra.",
      latest: null,
      serie: [],
      updated_at: null,
    };
  }

  const out = {
    ok: true,
    indicador: "TASA_USD_DOP",
    nombre: data.nombre || "Tasa de cambio del dólar de referencia del mercado spot (USD/DOP)",
    fuente: data.fuente || "BCRD - Banco Central de la República Dominicana",
    unidad: data.unidad || "DOP por USD",
    updated_at: data.updated_at || null,
    latest: {
      ...resumenEntry(data.latest),
      var_dia_pct: data.latest.var_dia_pct ?? null,
      var_30d_pct: data.latest.var_30d_pct ?? null,
    },
  };

  if (detalle === "serie") {
    const serie = Array.isArray(data.serie) ? data.serie : [];
    out.serie = serie.slice(0, dias).map(resumenEntry);
  }

  return out;
}

module.exports = {
  TOOL_CONSULTAR_TASA,
  consultarTasaDolar,
  // Helpers expuestos para testing.
  resumenEntry,
  loadLiveDoc,
};
