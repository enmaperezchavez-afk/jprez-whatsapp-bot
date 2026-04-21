// ============================================
// test-manual-claude.mjs (TEMPORAL, no commitear)
// ============================================
// Valida callClaudeWithTools (src/claude.js) contra la API real de Anthropic,
// disparando calcularPlanPago via tool use. Self-contained: duplica inline
// las constantes de dominio (PAYMENT_PLANS, DELIVERY_DATES, PROJECT_NAMES,
// TOOLS, calcularPlanPago) byte-exact desde api/webhook.js para no tener
// que exportarlas del webhook solo para este test.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ---------- [SETUP] cargar .env.local si existe ----------
const envPath = path.resolve(".env.local");
if (fs.existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
    console.log("[setup] .env.local cargado");
  } catch (e) {
    console.log("[setup] No pude cargar .env.local:", e.message);
  }
} else {
  console.log("[setup] .env.local NO existe — usando process.env directo");
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "[setup] ERROR: ANTHROPIC_API_KEY no está seteada.\n" +
      "        Opciones:\n" +
      "        (1) crea .env.local con ANTHROPIC_API_KEY=sk-ant-...\n" +
      "        (2) inline: ANTHROPIC_API_KEY=sk-ant-... node test-manual-claude.mjs"
  );
  process.exit(1);
}
console.log("[setup] ANTHROPIC_API_KEY presente (longitud=" + process.env.ANTHROPIC_API_KEY.length + ")");

// ---------- import del módulo bajo test ----------
const { callClaudeWithTools } = require("../src/claude");

// ---------- [DUPLICACIÓN byte-exact desde api/webhook.js] ----------
// Fuente: api/webhook.js L454-538 (PROJECT_NAMES, PAYMENT_PLANS, DELIVERY_DATES,
// calcularPlanPago, TOOLS). Copia literal. Si la lógica cambia en webhook,
// este script queda desactualizado — está OK, es temporal.

const PROJECT_NAMES = {
  crux: "Crux del Prado",
  pr3: "Prado Residences III",
  pr4: "Prado Residences IV",
  puertoPlata: "Prado Suites Puerto Plata",
};

const PAYMENT_PLANS = {
  crux: { separacion: 0.10, completivo: 0.20, entrega: 0.70 },
  pr3: { separacion: 0.10, completivo: 0.30, entrega: 0.60 },
  pr4: { separacion: 0.10, completivo: 0.30, entrega: 0.60 },
  puertoPlata: { separacion: 0.10, completivo: 0.30, entrega: 0.60 },
};

const DELIVERY_DATES = {
  crux: "2027-07-01",
  pr3: "2026-08-01",
  pr4: "2027-09-01",
  puertoPlata: "2027-12-01",
};

function calcularPlanPago(proyecto, precioUsd) {
  const plan = PAYMENT_PLANS[proyecto];
  const delivery = DELIVERY_DATES[proyecto];
  if (!plan || !delivery) {
    return { error: "Proyecto no reconocido: " + proyecto };
  }
  const now = new Date();
  const deliveryDate = new Date(delivery);
  const monthsRemaining = Math.max(1, Math.round((deliveryDate - now) / (30 * 86400 * 1000)));
  const separacion = Math.round(precioUsd * plan.separacion);
  const completivoTotal = Math.round(precioUsd * plan.completivo);
  const contraEntrega = Math.round(precioUsd * plan.entrega);
  const cuotaMensual = Math.round(completivoTotal / monthsRemaining);
  return {
    proyecto: PROJECT_NAMES[proyecto] || proyecto,
    precio_total_usd: precioUsd,
    separacion_usd: separacion,
    separacion_pct: Math.round(plan.separacion * 100),
    completivo_total_usd: completivoTotal,
    completivo_pct: Math.round(plan.completivo * 100),
    meses_hasta_entrega: monthsRemaining,
    cuota_mensual_usd: cuotaMensual,
    contra_entrega_usd: contraEntrega,
    contra_entrega_pct: Math.round(plan.entrega * 100),
    nota: "Cuota mensual = completivo total / meses hasta entrega. Contra entrega se cubre con banco o pago directo.",
  };
}

const TOOLS = [
  {
    name: "calcular_plan_pago",
    description:
      "Calcula el plan de pago desglosado de una unidad JPREZ: separacion, cuota mensual durante construccion, y monto contra entrega. " +
      "Usalo SIEMPRE que el cliente pregunte 'cuanto pago al mes', 'cuotas', 'financiamiento', 'inicial', 'mensualidad', o pida numeros concretos de pago. " +
      "Devuelve JSON con los montos exactos para que puedas mostrarlos al cliente.",
    input_schema: {
      type: "object",
      properties: {
        proyecto: {
          type: "string",
          enum: ["crux", "pr3", "pr4", "puertoPlata"],
          description: "Codigo del proyecto: crux=Crux del Prado Torre 6, pr3=Prado Residences III, pr4=Prado Residences IV, puertoPlata=Prado Suites Puerto Plata",
        },
        precio_usd: {
          type: "number",
          description: "Precio total de la unidad en USD. Usa el precio base del proyecto si no sabes uno especifico.",
        },
      },
      required: ["proyecto", "precio_usd"],
    },
  },
];

// ---------- [EJECUCIÓN] ----------
const systemPrompt =
  "Sos vendedor de Constructora JPREZ en República Dominicana. Podés usar la herramienta calcular_plan_pago cuando el cliente pida numeros de cuotas, inicial o plan de pago. Responde en español dominicano, breve.";

const messages = [
  {
    role: "user",
    content: "quiero saber el plan de pago de un apartamento de 138,000 en Prado Suites Etapa 4",
  },
];

async function main() {
  console.log("\n[STEP 1] Llamando callClaudeWithTools...");
  console.log("         system:", systemPrompt.slice(0, 80) + "...");
  console.log("         user message:", messages[0].content);

  const response = await callClaudeWithTools({
    system: systemPrompt,
    messages,
    tools: TOOLS,
    phone: "18299943102",
    toolHandlers: {
      calcular_plan_pago: (input) => {
        console.log("\n[STEP 3] Ejecutando tool 'calcular_plan_pago' con input:");
        console.log("         " + JSON.stringify(input));
        const result = calcularPlanPago(input.proyecto, input.precio_usd);
        console.log("[STEP 4] Tool retornó:");
        console.log("         " + JSON.stringify(result, null, 2).replace(/\n/g, "\n         "));
        return result;
      },
    },
  });

  console.log("\n[STEP 2] (agregado) Análisis del response final:");
  console.log("         stop_reason:", response.stop_reason);
  console.log("         content blocks:", response.content.map((b) => b.type).join(", "));
  console.log("         usage:", JSON.stringify(response.usage));

  const textBlocks = response.content.filter((b) => b.type === "text");
  const finalText = textBlocks.map((b) => b.text).join("\n").trim();

  console.log("\n[FINAL] Respuesta de texto completa:");
  console.log("========================================");
  console.log(finalText);
  console.log("========================================\n");
}

main().catch((e) => {
  console.error("\n[ERROR] main() falló:");
  console.error(e.stack || e.message || e);
  process.exit(1);
});
