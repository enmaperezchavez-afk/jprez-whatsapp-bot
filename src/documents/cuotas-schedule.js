// src/documents/cuotas-schedule.js — Sprint1.7 PR-3 (Adendum v1.2 B2/B3).
//
// El corazón del Excel del plan de pago: la TABLA DE CUOTAS MES A MES
// con fechas reales (HOY → entrega) y saldo restante. PURO y testeable:
// `hoy` se inyecta (los tests no dependen del reloj).
//
// GARANTÍA DURA (B2): la fila TOTAL suma EXACTO al precio. Los redondeos
// de calcularPlanPago (separación/completivo/cuota redondeados por
// separado) se absorben así:
//   - la ÚLTIMA cuota ajusta el residuo del completivo (estándar de
//     amortización), y
//   - el contra entrega se calcula como residual (precio - separación -
//     completivo), no como % redondeado aparte.
// Si aún así no cuadra, se LANZA — un documento que no suma no sale.

// Reserva por proyecto (doctrina v1.1): se DESCUENTA del 10% inicial.
const RESERVAS = { crux: 1000, pr3: 2000, pr4: 2000, puertoPlata: 2000 };

const MESES_CORTOS_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function etiquetaMes(year, monthIdx0) {
  return MESES_CORTOS_ES[monthIdx0] + " " + year;
}

// buildCuotasSchedule({ plan, proyectoCalc, hoy }) -> {
//   filas: [{n, concepto, fecha, monto, saldo}], total, reserva, firma }
// plan = output de calcularPlanPago. hoy = Date (inyectable).
function buildCuotasSchedule({ plan, proyectoCalc, hoy = new Date() }) {
  if (!plan || !Number.isFinite(plan.precio_total_usd)) {
    throw new Error("cuotas-schedule: plan inválido");
  }
  const precio = plan.precio_total_usd;
  const separacion = plan.separacion_usd;
  const completivo = plan.completivo_total_usd;
  const meses = Math.max(1, Math.round(plan.meses_hasta_entrega));
  const cuotaBase = plan.cuota_mensual_usd;

  const reserva = Math.min(RESERVAS[proyectoCalc] || 2000, separacion);
  const firma = separacion - reserva;
  // Contra entrega RESIDUAL: absorbe los redondeos de los % para que el
  // total cuadre exacto (doctrina: el % pactado es fijo; el residuo de
  // redondeo es de centavos/dólares, no doctrina).
  const contraEntrega = precio - separacion - completivo;
  if (contraEntrega <= 0) {
    throw new Error("cuotas-schedule: contra entrega no positivo (plan corrupto)");
  }

  const filas = [];
  let saldo = precio;
  const push = (n, concepto, fecha, monto) => {
    saldo -= monto;
    filas.push({ n, concepto, fecha, monto, saldo });
  };

  const hoyLabel = etiquetaMes(hoy.getFullYear(), hoy.getMonth());
  push("—", "Reserva (se descuenta del 10% inicial)", hoyLabel, reserva);
  push("—", "Completivo de la firma", hoyLabel, firma);

  // Cuotas: arrancan el MES SIGUIENTE a hoy, una por mes. La última
  // ajusta el residuo del completivo para cuadrar exacto.
  const d = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  let acumCuotas = 0;
  for (let i = 1; i <= meses; i++) {
    d.setMonth(d.getMonth() + 1);
    const monto = i === meses ? completivo - acumCuotas : cuotaBase;
    acumCuotas += monto;
    push(i, "Cuota " + i + " de " + meses, etiquetaMes(d.getFullYear(), d.getMonth()), monto);
  }

  // Contra entrega en la fecha de entrega del plan (viene del Sheet vía
  // calcularPlanPago — nunca hardcode, B3).
  const ent = new Date(plan.entrega_fecha + "T00:00:00");
  push("—", "Contra entrega (" + plan.contra_entrega_pct + "% — banco o pago directo)",
    etiquetaMes(ent.getFullYear(), ent.getMonth()), contraEntrega);

  const total = filas.reduce((s, f) => s + f.monto, 0);
  if (total !== precio) {
    throw new Error(`cuotas-schedule: el total ${total} NO suma el precio ${precio} — documento bloqueado`);
  }
  if (saldo !== 0) {
    throw new Error("cuotas-schedule: saldo final distinto de 0");
  }

  return { filas, total, reserva, firma, contraEntrega, meses };
}

module.exports = { buildCuotasSchedule, RESERVAS, etiquetaMes };
