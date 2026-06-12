// ============================================
// TOOL: generar_plan_pago_xlsx (Sprint1 PR-4)
// Excel del plan de pago por WhatsApp
// ============================================
//
// Mateo calcula el plan (calcular_plan_pago), y con esta tool se lo
// manda al cliente como documento Excel con branding del proyecto.
// Opcionalmente incluye la proyección ESTIMADA del reajuste ICDV (PR-3)
// como sección aparte del Excel, siempre etiquetada como estimado.
//
// Mecánica (patrón enviar_documento del Bloque 2): el handler calcula el
// plan con la MISMA calculadora del chat, firma el payload (HMAC, exp
// 7 días) y manda a WhatsApp la URL de /api/plan-xlsx, que genera el
// Excel al vuelo al descargarlo. Cero storage. Las deps pesadas
// (calculadora, reajuste, sendDocument, phone) se INYECTAN desde
// message.js — mismo DI que proyectar_reajuste.

const { signDocPayload } = require("../security/doc-signing");
const { VERCEL_DOMAIN } = require("../proxy");

const TOOL_GENERAR_PLAN_XLSX = {
  name: "generar_plan_pago_xlsx",
  description:
    "Genera un Excel (.xlsx) con el plan de pago COMPLETO de una unidad (resumen + calendario de cuotas mes a mes con fechas reales y saldos) y se lo envía al cliente por WhatsApp, " +
    "con la identidad visual del proyecto. Úsala cuando el cliente pida 'mándame el plan', 'me lo pasas en Excel', 'un documento con los números', " +
    "o después de negociar un plan para formalizarlo en archivo. Di al cliente 'te lo mando ahora mismo' y USA esta herramienta — NO prometas " +
    "enviar algo sin invocarla. Pasa la unidad concreta si el cliente eligió una (Adendum: documentos con unidad REAL). " +
    "IMPORTANTE precio_usd = SIEMPRE el precio de LISTA del inventario: un precio con descuento solo entra al documento cuando el cliente YA ACEPTÓ la condición " +
    "(reserva/adelanto confirmado) — mientras esté condicionado, el documento dice precio de lista y el descuento se conversa, no se imprime. " +
    "Con incluir_reajuste=true agrega la proyección ESTIMADA del reajuste ICDV (solo construcción; nunca garantía). El link vence en 7 días.",
  input_schema: {
    type: "object",
    properties: {
      proyecto: {
        type: "string",
        enum: ["crux", "pr3", "pr4", "puertoPlata"],
        description:
          "Proyecto: crux=Crux del Prado Torre 6, pr3=Prado Residences III, pr4=Prado Residences IV, puertoPlata=Prado Suites Puerto Plata.",
      },
      precio_usd: {
        type: "number",
        description: "Precio total de la unidad en USD (el mismo que usaste en calcular_plan_pago).",
      },
      etapa: {
        type: "string",
        enum: ["E3", "E4"],
        description: "SOLO Puerto Plata. Misma regla que calcular_plan_pago: sin etapa conocida, pregunta antes de invocar.",
      },
      inicial_pct: {
        type: "number",
        description: "OPCIONAL. Esquema custom igual que calcular_plan_pago (los 3 pct juntos sumando 100).",
      },
      completivo_pct: { type: "number", description: "OPCIONAL. Ver inicial_pct." },
      entrega_pct: { type: "number", description: "OPCIONAL. Ver inicial_pct." },
      incluir_reajuste: {
        type: "boolean",
        description:
          "true = agrega al Excel la proyección ESTIMADA del reajuste ICDV (solo construcción activa). Default false.",
      },
      unidad: {
        type: "string",
        description:
          "OPCIONAL pero recomendado: la unidad REAL del inventario que el cliente eligió (ej: '15-102', '11A'). Sale impresa en el documento.",
      },
    },
    required: ["proyecto", "precio_usd"],
  },
};

// generarPlanXlsxTool: handler de tool_use. deps OBLIGATORIAS desde
// message.js: calcularPlanPago, sendDocument, phone. Opcionales:
// proyectarReajuste (async input->out de proyectarReajusteTool),
// baseUrl, signPayload (tests). NUNCA lanza — degrada { sent:false }
// para que Mateo sea honesto (patrón enviarDocumento).
async function generarPlanXlsxTool(input, deps = {}) {
  const { calcularPlanPago, sendDocument, phone } = deps;
  if (typeof calcularPlanPago !== "function" || typeof sendDocument !== "function" || !phone) {
    console.error("[tool:plan-xlsx] deps incompletas");
    return { sent: false, error: "deps_incompletas", message: "No puedo generar el Excel ahora mismo. Ofrece coordinar el envío con Enmanuel." };
  }

  // 1. Plan con la MISMA calculadora del chat (números idénticos).
  const plan = calcularPlanPago(
    input.proyecto,
    input.precio_usd,
    input.etapa,
    input.inicial_pct,
    input.completivo_pct,
    input.entrega_pct
  );
  if (plan && plan.needs_etapa) return plan; // señal soft (Hotfix-30)
  if (!plan || plan.error) {
    return { sent: false, error: "plan_invalido", message: (plan && plan.error) || "No se pudo calcular el plan." };
  }

  // 2. Reajuste opcional (PR-3). Si falla, el Excel sale SIN la sección
  //    (mejor documento sin estimado que sin documento).
  let reajuste = null;
  if (input.incluir_reajuste && typeof deps.proyectarReajuste === "function") {
    try {
      const out = await deps.proyectarReajuste(input);
      if (out && out.ok) reajuste = out;
    } catch (e) {
      console.error("[tool:plan-xlsx] reajuste no disponible:", e.message);
    }
  }

  // 3. URL firmada (exp 7d) + envío por WhatsApp.
  try {
    const sign = deps.signPayload || signDocPayload;
    const { p, s } = sign({
      plan,
      reajuste,
      proyectoCalc: input.proyecto,
      etapa: input.etapa,
      unidad: input.unidad,
      clienteNombre: deps.clienteNombre,
    });
    const baseUrl = deps.baseUrl || VERCEL_DOMAIN;
    const url = baseUrl + "/api/plan-xlsx?p=" + encodeURIComponent(p) + "&s=" + encodeURIComponent(s);
    const filename = "JPREZ - Plan de Pago - " + plan.proyecto + ".xlsx";
    const caption = "Plan de pago de " + plan.proyecto + (reajuste ? " (incluye proyección estimada de reajuste ICDV)." : ".");

    await sendDocument(phone, url, filename, caption);
    return {
      sent: true,
      message: "Excel del plan de pago enviado al cliente." + (input.incluir_reajuste && !reajuste ? " (La sección de reajuste no estuvo disponible y se omitió.)" : ""),
      con_reajuste: Boolean(reajuste),
      link_vence: "7 días",
    };
  } catch (e) {
    console.error("[tool:plan-xlsx] envío falló:", e.message);
    return { sent: false, error: "envio_fallo", message: "No se pudo enviar el Excel ahora mismo. Sé honesto con el cliente y ofrece reintentarlo." };
  }
}

module.exports = { TOOL_GENERAR_PLAN_XLSX, generarPlanXlsxTool };
