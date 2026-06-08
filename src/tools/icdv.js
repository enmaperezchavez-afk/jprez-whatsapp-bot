// ============================================
// TOOL: consultar_icdv (skeleton drop-in)
// Scraper ICDV — Tool Use de Anthropic
// ============================================
//
// Mismo patrón que src/tools/market.js: schema + handler que lee de
// disco (data/icdv-history.json), escrito por el cron de api/icdv.js.
//
// IMPORTANTE — NO se importa desde message.js todavía. Sigue el precedente
// de market.js: el schema queda listo como drop-in, pero NO se agrega al
// array TOOLS de src/handlers/message.js hasta una activación deliberada
// (Fase 2). Cablearlo a Mateo es un PR de 3 líneas:
//   const { TOOL_CONSULTAR_ICDV } = require("../tools/icdv");
//   const TOOLS = [...existing, TOOL_CONSULTAR_ICDV];
//   case "consultar_icdv": return await consultarICDV(input);
//
// FUENTE DE DATOS:
//   data/icdv-history.json (seed committeado + refresh por cron). El ICDV
//   lo publica la ONE SOLO como PDF mensual; el scraper de
//   src/services/icdv-scraper.js lo extrae y acumula la serie histórica
//   que la ONE no ofrece en ningún formato leíble por máquina.

const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "..", "..", "data", "icdv-history.json");

const TOOL_CONSULTAR_ICDV = {
  name: "consultar_icdv",
  description:
    "Consulta el Índice de Costos Directos de la Construcción de Viviendas (ICDV) oficial de la ONE (Oficina Nacional de Estadística de RD). " +
    "Úsalo cuando el cliente pregunte sobre 'cómo van los costos de construcción', 'subió el cemento/los materiales', " +
    "'cuánto ha subido construir', 'el índice de la construcción', 'inflación de la construcción', o quiera justificar por qué " +
    "los precios de las viviendas se mueven. Devuelve el índice más reciente, su variación mensual, acumulada del año e interanual " +
    "(12 meses), sub-índices por tipo de vivienda y la serie histórica de los últimos meses. " +
    "IMPORTANTE: son cifras oficiales de la ONE — preséntalas exactas, nunca inventes números. Si el dato no está disponible, díselo " +
    "al cliente y ofrece que Enmanuel se lo confirme.",
  input_schema: {
    type: "object",
    properties: {
      detalle: {
        type: "string",
        enum: ["resumen", "serie"],
        description:
          "'resumen' = solo el último mes con sus variaciones (default). " +
          "'serie' = incluye además la serie histórica de los últimos meses para mostrar tendencia.",
      },
      meses: {
        type: "integer",
        minimum: 1,
        maximum: 24,
        description:
          "Cuántos meses de serie histórica incluir cuando detalle='serie' (default 6).",
      },
    },
    required: [],
  },
};

// readIcdvData: lee y parsea data/icdv-history.json. Devuelve null ante
// cualquier fallo (no existe, JSON inválido) — NO lanza, para que un
// dato corrupto no tumbe la conversación.
function readIcdvData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return null;
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("[tool:icdv] error leyendo data/icdv-history.json:", e.message);
    return null;
  }
}

// resumenEntry: proyecta una entrada de la serie a los campos que Mateo
// necesita para hablar en prosa con números exactos. Evita volcarle al
// LLM campos internos (region, base) en cada item de la serie.
function resumenEntry(e) {
  if (!e) return null;
  return {
    periodo: e.periodo,
    mes: e.mes,
    anio: e.anio,
    indice: e.indice,
    var_mensual_pct: e.var_mensual_pct,
    var_anio_corrido_pct: e.var_anio_corrido_pct,
    var_12m_pct: e.var_12m_pct,
    tendencia: e.tendencia,
  };
}

// consultarICDV: handler de tool_use. input ya viene validado por el SDK
// contra el schema. Devuelve JSON estructurado que Mateo serializa en
// prosa.
async function consultarICDV(input) {
  const detalle = (input && input.detalle) || "resumen";
  const meses = Math.max(1, Math.min(24, (input && input.meses) || 6));

  const data = readIcdvData();
  if (!data || !Array.isArray(data.serie) || data.serie.length === 0) {
    return {
      ok: false,
      warning:
        "data/icdv-history.json no disponible o vacío. Scraper aún no ha corrido. " +
        "Dile al cliente que Enmanuel le confirma el dato del índice de costos de construcción.",
      latest: null,
      serie: [],
      updated_at: null,
    };
  }

  const serieOrdenada = data.serie; // ya viene del más reciente al más viejo
  const latest = data.latest || serieOrdenada[0];

  const out = {
    ok: true,
    indicador: "ICDV",
    nombre: data.nombre || "Índice de Costos Directos de la Construcción de Viviendas",
    fuente: data.fuente || "ONE",
    base: data.base || "octubre 2009",
    updated_at: data.updated_at || null,
    latest: {
      ...resumenEntry(latest),
      indice_anterior: latest.indice_anterior,
      delta_puntos: latest.delta_puntos,
      sub_indices: latest.sub_indices || null,
      grupos: latest.grupos || null,
    },
  };

  if (detalle === "serie") {
    out.serie = serieOrdenada.slice(0, meses).map(resumenEntry);
  }

  return out;
}

module.exports = {
  TOOL_CONSULTAR_ICDV,
  consultarICDV,
  // Helper expuesto para testing — permite mockear el JSON sin tocar disco.
  readIcdvData,
  resumenEntry,
};
