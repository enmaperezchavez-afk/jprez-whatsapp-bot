// tests/e2e-suite/helpers/real-llm-client.mjs — Hotfix-25 Día 2.
//
// Cliente que pega contra Anthropic API REAL con el prompt de Mateo en
// producción. Usa los mismos blocks que el handler real arma
// (buildSystemPromptBlocks) para que la suite mida COMPORTAMIENTO REAL
// del bot, no del prompt teórico.
//
// PATRÓN:
//   1. Importar buildSystemPromptBlocks vía CJS interop (createRequire).
//   2. Llamar Anthropic con system = staticBlock + dynamicHeader, user = input.
//   3. Si stop_reason === "tool_use", ejecutar tool localmente (cálculo
//      determinístico) y volver a llamar para obtener texto final.
//   4. Retornar el TEXTO COMBINADO de las respuestas (lo que el cliente
//      vería sin ningún post-processor — eso lo testea otra suite).
//
// NOTA: NO usa el handler completo (processMessage). El handler tiene
// state Redis, signature HMAC, idempotency, etc. La suite mide
// COMPORTAMIENTO DEL LLM con el prompt actual — no las defensas downstream.
// Las defensas (R4, R4-c5, format-postprocess) tienen sus propios tests.

import Anthropic from "@anthropic-ai/sdk";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { buildSystemPromptBlocks } = require("../../../src/prompts");

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 2048;

// Tool schema simplificado — solo lo necesario para que Mateo invoque
// calcular_plan_pago. Replica el shape del handler real.
const TOOLS = [
  {
    name: "calcular_plan_pago",
    description: "Calcula el plan de pago de una unidad JPREZ. Devuelve inicial 10%, cuota mensual y contra entrega 60% o 70% según el plan.",
    input_schema: {
      type: "object",
      properties: {
        proyecto: { type: "string", description: "uno de: pr3, pr4, puertoPlata, crux" },
        precio_usd: { type: "number", description: "precio total en USD" },
        etapa: { type: "string", description: "E3 o E4 para puertoPlata; omitir para otros" },
        plan: { type: "string", description: "10/30/60 (estándar) o 10/20/70 (Feria/extendido)" },
      },
      required: ["proyecto", "precio_usd"],
    },
  },
];

// Cálculo determinístico para mock tool result.
function mockCalcularPlan(input) {
  const precio = Number(input.precio_usd) || 0;
  const plan = input.plan || "10/30/60";
  const inicialPct = 0.10;
  const cuotasPct = plan === "10/20/70" ? 0.20 : 0.30;
  const contraEntregaPct = plan === "10/20/70" ? 0.70 : 0.60;

  // Fechas entrega aproximadas (matches inventario)
  const entregaMeses = {
    pr3: 3,    // ago 2026
    pr4: 15,   // ago 2027
    crux: 14,  // jul 2027
    "puertoPlata-E3": 36, // mar 2029
    "puertoPlata-E4": 16, // dic 2027
  };
  const key = input.etapa ? `${input.proyecto}-${input.etapa}` : input.proyecto;
  const meses = entregaMeses[key] || 24;

  const inicial = precio * inicialPct;
  const cuotasTotal = precio * cuotasPct;
  const cuotaMensual = cuotasTotal / meses;
  const contraEntrega = precio * contraEntregaPct;

  return {
    proyecto: input.proyecto,
    precio_total_usd: precio,
    inicial_usd: Math.round(inicial),
    cuota_mensual_usd: Math.round(cuotaMensual),
    contra_entrega_usd: Math.round(contraEntrega),
    meses_construccion: meses,
    plan_aplicado: plan,
  };
}

/**
 * Pregunta a Mateo (LLM real) con el prompt actual del bot.
 * Retorna el texto combinado de la conversación (todas las iteraciones).
 *
 * @param {string} input — mensaje del cliente
 * @returns {Promise<{ text: string, iterations: number, stop_reasons: string[], tool_calls: any[] }>}
 */
export async function askMateo(input) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY missing — set env var to run e2e-suite");
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const { staticBlock, dynamicHeader } = buildSystemPromptBlocks();
  const systemPrompt = `${dynamicHeader}\n\n${staticBlock}`;

  const messages = [{ role: "user", content: input }];
  const allText = [];
  const stopReasons = [];
  const toolCalls = [];
  let iteration = 0;
  const MAX_ITER = 3;

  while (iteration < MAX_ITER) {
    iteration++;
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages,
      tools: TOOLS,
    });

    stopReasons.push(response.stop_reason);

    // Capturar text blocks
    for (const block of response.content) {
      if (block.type === "text" && block.text) {
        allText.push(block.text);
      }
    }

    // Si stop_reason !== tool_use, terminamos
    if (response.stop_reason !== "tool_use") break;

    // Hay tool_use — ejecutar mock + continuar
    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
    messages.push({ role: "assistant", content: response.content });

    const toolResults = [];
    for (const tu of toolUseBlocks) {
      toolCalls.push({ name: tu.name, input: tu.input });
      const result = tu.name === "calcular_plan_pago"
        ? mockCalcularPlan(tu.input)
        : { error: `Unknown tool: ${tu.name}` };
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(result),
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return {
    text: allText.join("\n"),
    iterations: iteration,
    stop_reasons: stopReasons,
    tool_calls: toolCalls,
  };
}
