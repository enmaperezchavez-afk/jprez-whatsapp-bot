// src/services/reajuste.js — Motor de reajuste ICDV, núcleo PURO.
//
// La cláusula de reajuste del contrato JPREZ (doctrina v1.1 sección 6)
// ajusta el monto INSOLUTO durante la construcción según el ICDV de la
// ONE. Este módulo proyecta ese reajuste como ESTIMADO honesto:
//
//   1. tasaMensualDesdeSerie(serie) — CAGR mensual de la serie ICDV viva
//      (la que acumula el cron de api/icdv.js). Si la serie es corta
//      (< MIN_MESES_SERIE de span), devuelve null y el caller usa el
//      ANCLA_DOCTRINAL (0.3-0.5% mensual, punto medio 0.4%).
//   2. proyectarReajuste({ plan, tasaMensualPct }) — proyección mes a mes
//      sobre el insoluto que BAJA con cada cuota del completivo. El
//      reajuste CESA al entregar (la proyección termina en
//      meses_hasta_entrega del plan).
//
// 100% puro (objeto -> objeto), sin red ni Redis: la serie viva la trae
// el caller (src/tools/reajuste.js). Mismo molde que tasa-parser/
// icdv-parser: la lógica frágil se blinda acá con tests deterministas.

// Ancla doctrinal v1.1: "históricamente ronda 0.3-0.5% mensual sobre el
// monto insoluto". Se usa cuando la serie viva no da señal suficiente.
const ANCLA_DOCTRINAL = { min_pct: 0.3, max_pct: 0.5, mid_pct: 0.4 };

// Span mínimo (en meses) entre el dato más viejo y el más reciente de la
// serie para confiar en el CAGR. Con menos de 3 meses de historia un solo
// boletín atípico domina la tasa — mejor el ancla doctrinal.
const MIN_MESES_SERIE = 3;

// mesesEntrePeriodos: "2025-12" -> "2026-04" = 4.
function mesesEntrePeriodos(periodoViejo, periodoReciente) {
  const [y1, m1] = String(periodoViejo).split("-").map(Number);
  const [y2, m2] = String(periodoReciente).split("-").map(Number);
  if (!y1 || !m1 || !y2 || !m2) return null;
  return (y2 - y1) * 12 + (m2 - m1);
}

// tasaMensualDesdeSerie: CAGR mensual (%) de la serie ICDV. La serie
// viene del más reciente al más viejo (orden canónico del store), cada
// entrada con { periodo: "YYYY-MM", indice }. Devuelve por ejemplo
// 0.42 (= 0.42% mensual), o null si no hay señal suficiente (caller
// decide el fallback al ancla).
function tasaMensualDesdeSerie(serie, { minMeses = MIN_MESES_SERIE } = {}) {
  if (!Array.isArray(serie)) return null;
  const validas = serie.filter(
    (e) => e && /^\d{4}-\d{2}$/.test(String(e.periodo)) && Number.isFinite(e.indice) && e.indice > 0
  );
  if (validas.length < 2) return null;

  const reciente = validas[0];
  const vieja = validas[validas.length - 1];
  const span = mesesEntrePeriodos(vieja.periodo, reciente.periodo);
  if (!span || span < minMeses) return null;

  const cagr = (Math.pow(reciente.indice / vieja.indice, 1 / span) - 1) * 100;
  return round4(cagr);
}

// proyectarReajuste: proyección mes a mes del reajuste estimado.
//
//   plan: output de calcularPlanPago (precio_total_usd, separacion_usd,
//         cuota_mensual_usd, meses_hasta_entrega, contra_entrega_usd).
//   tasaMensualPct: % mensual a aplicar (de la serie o del ancla).
//
// Modelo: insoluto al inicio del mes m = precio - separación - cuotas ya
// pagadas (m-1). El reajuste del mes = insoluto * tasa. El insoluto baja
// linealmente con las cuotas del completivo; el contra entrega sigue
// insoluto hasta la entrega (ahí la cláusula CESA — no se proyecta más
// allá). Redondeos solo al final para no acumular error.
function proyectarReajuste({ plan, tasaMensualPct }) {
  if (!plan || !Number.isFinite(plan.precio_total_usd) || !Number.isFinite(plan.meses_hasta_entrega)) {
    throw new Error("proyectarReajuste: plan inválido (falta precio o meses)");
  }
  if (!Number.isFinite(tasaMensualPct)) {
    throw new Error("proyectarReajuste: tasaMensualPct inválida");
  }

  const meses = Math.max(1, Math.round(plan.meses_hasta_entrega));
  const precio = plan.precio_total_usd;
  const separacion = plan.separacion_usd || 0;
  const cuota = plan.cuota_mensual_usd || 0;
  const tasa = tasaMensualPct / 100;

  const insolutoInicial = precio - separacion;
  let totalReajuste = 0;
  let insoluto = insolutoInicial;
  for (let m = 1; m <= meses; m++) {
    totalReajuste += Math.max(0, insoluto) * tasa;
    insoluto -= cuota;
  }
  const insolutoFinal = Math.max(0, insolutoInicial - cuota * meses);

  return {
    tasa_mensual_pct: round4(tasaMensualPct),
    meses_proyectados: meses,
    insoluto_inicial_usd: Math.round(insolutoInicial),
    insoluto_final_usd: Math.round(insolutoFinal), // = contra entrega, donde cesa
    reajuste_total_estimado_usd: Math.round(totalReajuste),
    reajuste_promedio_mensual_usd: Math.round(totalReajuste / meses),
    precio_ajustado_estimado_usd: Math.round(precio + totalReajuste),
  };
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

module.exports = {
  tasaMensualDesdeSerie,
  proyectarReajuste,
  mesesEntrePeriodos,
  ANCLA_DOCTRINAL,
  MIN_MESES_SERIE,
};
