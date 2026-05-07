// ============================================
// TOOL: consultar_tasas_bancarias (skeleton)
// Hotfix-22 c3 — drop-in para Fase 2
// ============================================
//
// Schema completo + stub function para que en Fase 2 se agregue al
// array TOOLS de src/handlers/message.js (linea ~232) sin re-disenar.
//
// FUENTE DE DATOS:
//   Lee data/market-rates.json (mismo archivo que sirve api/market-data.js).
//   Si no existe, devuelve respuesta vacia con warning para que el LLM
//   sepa que tiene que escalar a Enmanuel y no inventar tasas.
//
// CONTRATO TOOL USE (Anthropic):
//   - name: snake_case unico, sin colisionar con calcular_plan_pago.
//   - description: dispara cuando el cliente pregunte tasas de banco.
//   - input_schema: JSON Schema valido. Enum de bancos limita las
//     opciones a las que sabemos scrappear.
//   - output: JSON estructurado que Mateo puede serializar en prosa
//     natural con numeros exactos (regla del C1).
//
// IMPORTANTE: este modulo NO se importa desde message.js todavia. Solo
// existe para que la integracion en Fase 2 sea un PR de 3 lineas:
//   const { TOOL_CONSULTAR_TASAS } = require("../tools/market");
//   const TOOLS = [...existing, TOOL_CONSULTAR_TASAS];
//   case "consultar_tasas_bancarias": return await consultarTasasBancarias(input);

const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "..", "..", "data", "market-rates.json");

const BANCOS_VALIDOS = [
  "all",
  "apap",
  "popular",
  "bhd",
  "scotiabank",
  "reservas",
  "cibao",
];

const TOOL_CONSULTAR_TASAS = {
  name: "consultar_tasas_bancarias",
  description:
    "Consulta tasas hipotecarias actualizadas de bancos RD (APAP, Banco Popular, BHD, Scotiabank, BanReservas, Asociacion Cibao). " +
    "Usalo cuando el cliente pregunte 'que tasa esta dando X banco', 'cuanto cobra el banco', 'comparar tasas', 'cual banco da mejor', " +
    "'que opciones de financiamiento hay'. Devuelve JSON con tasa nominal, TAE, plazo maximo y monto maximo por banco. " +
    "IMPORTANTE: si el banco que pregunta el cliente NO esta en el enum, escala a Enmanuel — no inventes tasas.",
  input_schema: {
    type: "object",
    properties: {
      banco: {
        type: "string",
        enum: BANCOS_VALIDOS,
        description:
          "Codigo del banco. Usa 'all' para devolver todos los bancos. " +
          "Codigos: apap=APAP, popular=Banco Popular Dominicano, bhd=Banco BHD, " +
          "scotiabank=Scotiabank, reservas=BanReservas, cibao=Asociacion Cibao de Ahorros y Prestamos.",
      },
    },
    required: ["banco"],
  },
};

// readMarketData: igual contrato que api/market-data.js#readMarketDataFromDisk.
// Duplicado deliberado para que este modulo no dependa de un archivo en
// /api (mejor separacion de capas: api/ es entrypoint, src/tools/ es
// logica reusable).
function readMarketData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return null;
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("[tool:market] error leyendo data/market-rates.json:", e.message);
    return null;
  }
}

// consultarTasasBancarias: stub function que el handler de tool_use
// invocara en Fase 2. Recibe el input parseado (ya validado por el SDK
// contra el schema) y devuelve JSON estructurado.
//
// Comportamiento:
//   - Si no hay JSON en disco -> warning + bancos vacios + nota de
//     escalar a Enmanuel.
//   - Si banco === 'all' -> devuelve el array completo.
//   - Si banco especifico -> filtra por banco.codigo === input.banco.
//     Si no encuentra match, devuelve warning explicito.
async function consultarTasasBancarias(input) {
  const banco = (input && input.banco) || "all";

  const data = readMarketData();
  if (!data) {
    return {
      ok: false,
      warning:
        "data/market-rates.json no disponible. Scraper pendiente (Fase 2). " +
        "Escala al cliente a Enmanuel para que confirme tasas vigentes.",
      bancos: [],
      updated_at: null,
    };
  }

  const todosBancos = Array.isArray(data.bancos) ? data.bancos : [];

  if (banco === "all") {
    return {
      ok: true,
      bancos: todosBancos,
      updated_at: data.updated_at || null,
      source: data.source || "disk",
    };
  }

  const match = todosBancos.find((b) => b && b.codigo === banco);
  if (!match) {
    return {
      ok: false,
      warning:
        "Banco '" + banco + "' no encontrado en data/market-rates.json. " +
        "Escala a Enmanuel o pregunta al cliente que confirme el nombre del banco.",
      bancos: [],
      updated_at: data.updated_at || null,
    };
  }

  return {
    ok: true,
    bancos: [match],
    updated_at: data.updated_at || null,
    source: data.source || "disk",
  };
}

module.exports = {
  TOOL_CONSULTAR_TASAS,
  consultarTasasBancarias,
  BANCOS_VALIDOS,
  // Helper expuesto para testing — permite mockear el JSON sin tocar disco.
  readMarketData,
};
