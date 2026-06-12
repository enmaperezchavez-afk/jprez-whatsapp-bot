// tests/qa-simulador/helpers/arnes-mateo.mjs — Sprint 1.5.
//
// Arnés del lado MATEO: ejecuta el pipeline REAL del bot offline —
// buildSystemPromptBlocks (mismo system que producción) + TOOLS[] real +
// loop de tool use + strip chain + post-processor de formato. Lo único
// stubbeado son los SIDE-EFFECTS (envío de WhatsApp, firma de URLs):
// las tools de cálculo y datos corren de verdad (calculadora, reajuste,
// ICDV con seed de disco). Cero red salvo la API de Anthropic, cero
// Redis, cero clientes reales.
//
// Guard de drift: buildToolHandlers cubre CADA tool de TOOLS[] — un test
// falla si se cablea una tool nueva al bot sin enseñarle al simulador
// qué hacer con ella.

import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { buildSystemPromptBlocks } = require("../../../src/prompts");
const {
  TOOLS,
  calcularPlanPago,
  inferEtapaFromContext,
} = require("../../../src/handlers/message");
const { proyectarReajusteTool } = require("../../../src/tools/reajuste");
const { consultarICDV } = require("../../../src/tools/icdv");
const { consultarTasaDolar } = require("../../../src/tools/tasa");
const { generarPlanXlsxTool } = require("../../../src/tools/plan-xlsx");
const {
  stripParameterBlocks,
  stripInternalBlocks,
} = require("../../../src/handlers/parameter-block-cleaner");
const { cleanFormat } = require("../../../src/handlers/format-postprocess");

export const MODEL = "claude-sonnet-4-6"; // mismo modelo que producción
export const MATEO_MAX_TOKENS = 1024; // control de costo (brief Sprint 1.5)
const MAX_TOOL_ITERATIONS = 6;

// Doc de tasa fixture: el simulador corre sin Redis, así que la tool de
// tasa degradaría a ok:false siempre. Para evaluar la doctrina de
// conversión (citar tasa + fecha) se inyecta este doc con cifras REALES
// del BCRD (10 jun 2026). Pasar { tasaDoc: null } fuerza el camino
// degradado (probar que Mateo NO inventa tasa).
export const TASA_DOC_FIXTURE = {
  indicador: "TASA_USD_DOP",
  nombre: "Tasa de cambio del dólar de referencia del mercado spot (USD/DOP)",
  fuente: "BCRD - Banco Central de la República Dominicana",
  unidad: "DOP por USD",
  updated_at: "2026-06-11T00:00:00Z",
  source: "qa-fixture",
  latest: {
    fecha: "2026-06-10",
    compra: 58.5264,
    venta: 59.3263,
    promedio: 58.9264,
    var_dia_pct: 0.5829,
    var_30d_pct: -0.417,
  },
  serie: [
    { fecha: "2026-06-10", compra: 58.5264, venta: 59.3263, promedio: 58.9264 },
    { fecha: "2026-06-09", compra: 58.4112, venta: 58.9825, promedio: 58.6969 },
  ],
};

// buildToolHandlers: handlers reales con side-effects stubbeados. Cada
// invocación queda registrada en `eventos` para el evaluador (qué tools
// usó Mateo y con qué inputs).
export function buildToolHandlers({ userMessage, eventos, tasaDoc = TASA_DOC_FIXTURE }) {
  const registrar = (tool, input, output) => {
    eventos.push({ tool, input, output });
    return output;
  };

  return {
    calcular_plan_pago: async (input) => {
      let etapa = input.etapa;
      if (input.proyecto === "puertoPlata" && !etapa) {
        etapa = inferEtapaFromContext(userMessage);
      }
      const out = calcularPlanPago(
        input.proyecto, input.precio_usd, etapa,
        input.inicial_pct, input.completivo_pct, input.entrega_pct
      );
      return registrar("calcular_plan_pago", input, out);
    },
    enviar_documento: async (input) =>
      registrar("enviar_documento", input, {
        sent: true,
        message: "Documento enviado al cliente.",
      }),
    consultar_icdv: async (input) =>
      registrar("consultar_icdv", input, await consultarICDV(input)),
    consultar_tasa_dolar: async (input) =>
      registrar(
        "consultar_tasa_dolar",
        input,
        await consultarTasaDolar(input, {
          getRedis: async () => null,
          loadDoc: async () => tasaDoc, // null -> degradación honesta
        })
      ),
    proyectar_reajuste: async (input) => {
      let etapa = input.etapa;
      if (input.proyecto === "puertoPlata" && !etapa) {
        etapa = inferEtapaFromContext(userMessage);
      }
      const out = await proyectarReajusteTool({ ...input, etapa }, { calcularPlanPago });
      return registrar("proyectar_reajuste", input, out);
    },
    generar_plan_pago_xlsx: async (input) => {
      let etapa = input.etapa;
      if (input.proyecto === "puertoPlata" && !etapa) {
        etapa = inferEtapaFromContext(userMessage);
      }
      const out = await generarPlanXlsxTool(
        { ...input, etapa },
        {
          calcularPlanPago,
          proyectarReajuste: (i) => proyectarReajusteTool(i, { calcularPlanPago }),
          sendDocument: async () => {}, // stub: no WhatsApp real
          phone: "18090000000",
          signPayload: () => ({ p: "qa-stub", s: "qa-stub" }), // sin META_APP_SECRET offline
        }
      );
      return registrar("generar_plan_pago_xlsx", input, out);
    },
  };
}

export function toolNamesSinHandler() {
  const handlers = buildToolHandlers({ userMessage: "", eventos: [] });
  return TOOLS.map((t) => t.name).filter((name) => typeof handlers[name] !== "function");
}

// crearMateo: devuelve { responder(messages) } que corre UN turno del
// bot real: LLM + tool loop + strip chain + post-processor. `anthropic`
// es el cliente del SDK (inyectable: los tests unitarios pasan un mock,
// el simulador real pasa el SDK con ANTHROPIC_API_KEY).
export function crearMateo({ anthropic, tasaDoc, model = MODEL, maxTokens = MATEO_MAX_TOKENS, promptVariant = "v5", usage } = {}) {
  if (!anthropic) throw new Error("arnes-mateo: falta el cliente anthropic");
  // V6 F2: el A/B del certificador corre el MISMO careo y el MISMO juez
  // sobre ambos prompts — la única variable es el system.
  const { staticBlock, dynamicHeader } = buildSystemPromptBlocks({ v6: promptVariant === "v6" });
  const system = [
    { type: "text", text: staticBlock, cache_control: { type: "ephemeral" } },
    { type: "text", text: dynamicHeader },
  ];

  return {
    // messages: historial estilo Anthropic [{role, content}] donde el
    // último es el mensaje del cliente. Devuelve { texto, eventos }.
    async responder(messages) {
      const eventos = [];
      const userMessage =
        typeof messages[messages.length - 1]?.content === "string"
          ? messages[messages.length - 1].content
          : "";
      const handlers = buildToolHandlers({ userMessage, eventos, tasaDoc });

      const convo = messages.slice();
      const textos = [];
      for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
        const resp = await anthropic.messages.create({
          model,
          max_tokens: maxTokens,
          system,
          messages: convo,
          tools: TOOLS,
        });
        if (usage) usage.add("mateo", model, resp.usage);
        for (const b of resp.content) {
          if (b.type === "text" && b.text.trim()) textos.push(b.text);
        }
        if (resp.stop_reason !== "tool_use") break;

        const toolUses = resp.content.filter((b) => b.type === "tool_use");
        convo.push({ role: "assistant", content: resp.content });
        const results = [];
        for (const tu of toolUses) {
          let out;
          try {
            const handler = handlers[tu.name];
            out = handler
              ? await handler(tu.input)
              : { error: "tool sin handler en el simulador: " + tu.name };
          } catch (e) {
            out = { error: e.message };
          }
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify(out),
          });
        }
        convo.push({ role: "user", content: results });
      }

      // Mismo strip chain + post-processor que ve el cliente real. Se
      // conserva el texto CRUDO y los counts del post-processor: el
      // evaluador distingue "el LLM emitió bullets pero producción los
      // limpia" (warning) de "el cliente los vio" (fail).
      let crudo = textos.join("\n").trim();
      crudo = stripParameterBlocks(crudo).text;
      crudo = stripInternalBlocks(crudo).text;
      crudo = crudo.replace(/<perfil_update>[\s\S]*?<\/perfil_update>/g, "").trim();
      const { text: texto, counts } = cleanFormat(crudo);

      return { texto, textoCrudo: crudo, formatoCounts: counts, eventos };
    },
  };
}
