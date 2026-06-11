// ============================================
// TOOL: proyectar_reajuste (Sprint1 PR-3)
// Motor de reajuste ICDV — Tool Use de Anthropic
// ============================================
//
// Tool HERMANA de calcular_plan_pago (decisión de diseño PR-3): la
// calculadora es pura/sync con contrato estable; el reajuste necesita la
// serie ICDV viva (Redis) y produce un ESTIMADO, no un número de
// contrato. Separarlas evita que Mateo confunda el plan duro con la
// proyección honesta. calcularPlanPago se INYECTA desde message.js
// (patrón DI del repo — evita el ciclo de requires handler <-> tool).
//
// Fuente de la tasa: CAGR de la serie ICDV viva (loadLiveSerie de
// src/tools/icdv.js: Redis -> store del cron -> seed disco). Si la serie
// es corta, ancla doctrinal 0.3-0.5% mensual (v1.1 sección 6).
//
// DOCTRINA (v1.1 sección 6): SOLO proyectos en construcción activa; la
// cláusula CESA al entregar; en Crux Listos NO existe ni se menciona.
// El enum de proyecto solo admite proyectos en construcción — Crux
// Listos no es opción por construcción del schema.

const {
  tasaMensualDesdeSerie,
  proyectarReajuste,
  ANCLA_DOCTRINAL,
} = require("../services/reajuste");
const { loadLiveSerie } = require("./icdv");

const TOOL_PROYECTAR_REAJUSTE = {
  name: "proyectar_reajuste",
  description:
    "Proyecta el reajuste ESTIMADO por la cláusula ICDV del contrato JPREZ sobre el monto insoluto durante la construcción. " +
    "Úsala cuando el cliente pregunte '¿y si suben los costos de construcción?', '¿el precio puede cambiar?', '¿cuánto me puede subir?', " +
    "o al explicar la cláusula de reajuste con números concretos. Usa la serie oficial ICDV (ONE) viva para estimar la tasa mensual; " +
    "si la serie es corta usa el ancla histórica 0.3-0.5% mensual. SOLO aplica a proyectos en construcción activa — en Crux LISTOS " +
    "la cláusula NO existe y NO se menciona. IMPORTANTE: el resultado es un ESTIMADO honesto basado en datos históricos, NUNCA una " +
    "garantía ni un número de contrato — preséntalo siempre como estimación y di que el reajuste real depende del ICDV que publique " +
    "la ONE cada mes. La cláusula CESA al entregar.",
  input_schema: {
    type: "object",
    properties: {
      proyecto: {
        type: "string",
        enum: ["crux", "pr3", "pr4", "puertoPlata"],
        description:
          "Proyecto EN CONSTRUCCIÓN: crux=Crux del Prado Torre 6, pr3=Prado Residences III, pr4=Prado Residences IV, puertoPlata=Prado Suites Puerto Plata. Crux Listos NO tiene reajuste (no es opción).",
      },
      precio_usd: {
        type: "number",
        description: "Precio total de la unidad en USD (el mismo que usarías en calcular_plan_pago).",
      },
      etapa: {
        type: "string",
        enum: ["E3", "E4"],
        description:
          "SOLO para Puerto Plata: etapa (E3 entrega marzo 2029, E4 entrega diciembre 2027). Misma regla que calcular_plan_pago: si no sabes la etapa, pregunta al cliente antes de invocar.",
      },
      inicial_pct: {
        type: "number",
        description: "OPCIONAL. Mismo contrato que calcular_plan_pago: solo con esquema custom, junto a completivo_pct y entrega_pct sumando 100.",
      },
      completivo_pct: { type: "number", description: "OPCIONAL. Ver inicial_pct." },
      entrega_pct: { type: "number", description: "OPCIONAL. Ver inicial_pct." },
    },
    required: ["proyecto", "precio_usd"],
  },
};

// proyectarReajusteTool: handler de tool_use. deps.calcularPlanPago es
// OBLIGATORIA (la inyecta message.js); deps.loadLiveSerie inyectable
// para tests. Nunca lanza hacia el dispatcher — degrada con ok:false.
async function proyectarReajusteTool(input, deps = {}) {
  const calcular = deps.calcularPlanPago;
  if (typeof calcular !== "function") {
    console.error("[tool:reajuste] calcularPlanPago no inyectada");
    return { ok: false, warning: "Proyección no disponible. Explica la cláusula con el ancla histórica 0.3-0.5% mensual sobre insoluto y ofrece que Enmanuel confirme números." };
  }

  // 1. Plan de pago base (reusa la calculadora testeada — misma fuente
  //    de meses hasta entrega y cuotas que ve el cliente).
  const plan = calcular(
    input.proyecto,
    input.precio_usd,
    input.etapa,
    input.inicial_pct,
    input.completivo_pct,
    input.entrega_pct
  );
  if (plan && plan.needs_etapa) return plan; // señal soft passthrough (Hotfix-30)
  if (!plan || plan.error) {
    return { ok: false, warning: (plan && plan.error) || "No se pudo calcular el plan base." };
  }

  // 2. Tasa mensual: serie ICDV viva -> CAGR; serie corta -> ancla.
  const _loadLiveSerie = deps.loadLiveSerie || loadLiveSerie;
  let serie = [];
  let updatedAt = null;
  try {
    const doc = await _loadLiveSerie();
    if (doc && Array.isArray(doc.serie)) {
      serie = doc.serie;
      updatedAt = doc.updated_at || null;
    }
  } catch (e) {
    console.error("[tool:reajuste] serie ICDV no disponible:", e.message);
  }

  const tasaSerie = tasaMensualDesdeSerie(serie);
  const usaSerie = tasaSerie != null;
  const tasaMensualPct = usaSerie ? tasaSerie : ANCLA_DOCTRINAL.mid_pct;

  // 3. Proyección sobre el insoluto.
  const proyeccion = proyectarReajuste({ plan, tasaMensualPct });

  return {
    ok: true,
    estimado: true, // NUNCA garantía — Mateo lo presenta como estimación
    plan_base: {
      proyecto: plan.proyecto,
      precio_total_usd: plan.precio_total_usd,
      separacion_usd: plan.separacion_usd,
      cuota_mensual_usd: plan.cuota_mensual_usd,
      meses_hasta_entrega: plan.meses_hasta_entrega,
      contra_entrega_usd: plan.contra_entrega_usd,
      entrega_fecha: plan.entrega_fecha,
    },
    tasa: {
      mensual_pct: proyeccion.tasa_mensual_pct,
      fuente: usaSerie
        ? "CAGR de la serie ICDV oficial (ONE) acumulada"
        : `ancla histórica doctrinal (${ANCLA_DOCTRINAL.min_pct}-${ANCLA_DOCTRINAL.max_pct}% mensual; serie ICDV aún corta)`,
      serie_meses: serie.length,
      serie_updated_at: updatedAt,
      rango_doctrinal_pct: [ANCLA_DOCTRINAL.min_pct, ANCLA_DOCTRINAL.max_pct],
    },
    proyeccion,
    nota:
      "ESTIMADO sobre el insoluto que baja con cada cuota; la cláusula cesa al entregar. " +
      "El reajuste real depende del ICDV que publique la ONE cada mes — nunca lo presentes como garantía ni como precio final.",
  };
}

module.exports = {
  TOOL_PROYECTAR_REAJUSTE,
  proyectarReajusteTool,
};
