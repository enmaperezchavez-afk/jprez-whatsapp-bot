// src/documents/plan-xlsx-generator.js — Sprint1 PR-4.
//
// Genera EN VIVO un Excel (.xlsx) con el plan de pago calculado de una
// unidad, con la identidad visual por proyecto del Bloque 2
// (src/documents/project-themes.js — misma paleta que los PDFs de
// precios). Opcionalmente incluye la proyección ESTIMADA del reajuste
// ICDV del PR-3 como sección aparte, siempre etiquetada como estimado.
//
// ExcelJS (decisión del brief Sprint 1): generar XLSX con estilos a mano
// sería reescribir media spec OOXML; la lib es el estándar y pesa solo
// en la lambda que la usa (require perezoso en el endpoint).
//
// PURO en el sentido del repo: objeto plan -> Buffer. Sin red, sin Redis.
// El plan viene de calcularPlanPago (misma fuente que ve el cliente en
// el chat) — este módulo NO recalcula nada, solo presenta.

const { getTheme } = require("./project-themes");

// Mapeo proyecto de la calculadora -> proyectoId de themes/PROJECT_META
// (la calculadora usa crux/pr3/pr4/puertoPlata+etapa; los themes usan
// las keys del Bloque 2). Ticket conocido post-Sprint0: unificar keys.
function themeIdFor(proyectoCalc, etapa) {
  if (proyectoCalc === "crux") return "crux_t6";
  if (proyectoCalc === "puertoPlata") return etapa === "E3" ? "pse3" : "pse4";
  return proyectoCalc; // pr3 / pr4
}

const FMT_USD = '"US$"#,##0';
const COL_CONCEPTO = 42;
const COL_VALOR = 22;

// generatePlanXlsx: arma el workbook. Devuelve Buffer del .xlsx.
//   plan: output de calcularPlanPago (sin error/needs_etapa).
//   reajuste: opcional, output ok:true de proyectarReajusteTool.
//   proyectoCalc/etapa: keys de la calculadora para resolver el theme.
async function generatePlanXlsx({ plan, reajuste, proyectoCalc, etapa }) {
  if (!plan || plan.error || plan.needs_etapa || !Number.isFinite(plan.precio_total_usd)) {
    throw new Error("generatePlanXlsx: plan inválido");
  }
  const ExcelJS = require("exceljs"); // perezoso: solo paga quien genera
  const theme = getTheme(themeIdFor(proyectoCalc, etapa));
  const accent = theme.palette.accent.replace("#", "FF");
  const headerBg = theme.palette.headerBg.replace("#", "FF");
  const dark = "FF1F2937";

  const wb = new ExcelJS.Workbook();
  wb.creator = "JPREZ - Mateo";
  const ws = wb.addWorksheet("Plan de Pago", {
    properties: { defaultRowHeight: 18 },
    pageSetup: { paperSize: 9, orientation: "portrait" },
  });
  ws.columns = [{ width: COL_CONCEPTO }, { width: COL_VALOR }];

  // --- Header con identidad del proyecto ---
  ws.mergeCells("A1:B1");
  const title = ws.getCell("A1");
  title.value = "CONSTRUCTORA JPREZ";
  title.font = { name: "Calibri", size: 16, bold: true, color: { argb: dark } };
  title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: headerBg } };
  title.alignment = { vertical: "middle", horizontal: "center" };
  ws.getRow(1).height = 30;

  ws.mergeCells("A2:B2");
  const sub = ws.getCell("A2");
  sub.value = "Plan de pago — " + plan.proyecto;
  sub.font = { name: "Calibri", size: 12, bold: true, color: { argb: accent } };
  sub.fill = { type: "pattern", pattern: "solid", fgColor: { argb: headerBg } };
  sub.alignment = { vertical: "middle", horizontal: "center" };
  ws.getRow(2).height = 22;

  ws.mergeCells("A3:B3");
  const fecha = ws.getCell("A3");
  fecha.value = "Generado el " + new Date().toISOString().slice(0, 10) + " — precios en US$";
  fecha.font = { name: "Calibri", size: 9, italic: true, color: { argb: "FF6B7280" } };
  fecha.alignment = { horizontal: "center" };

  // --- Tabla del plan ---
  let r = 5;
  const addHeaderRow = (texto) => {
    ws.mergeCells(`A${r}:B${r}`);
    const c = ws.getCell(`A${r}`);
    c.value = texto;
    c.font = { bold: true, size: 11, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: dark } };
    c.alignment = { vertical: "middle" };
    r++;
  };
  const addRow = (concepto, valor, { money = true, bold = false, nota = false } = {}) => {
    const ca = ws.getCell(`A${r}`);
    const cb = ws.getCell(`B${r}`);
    ca.value = concepto;
    cb.value = valor;
    ca.font = { size: nota ? 9 : 11, italic: nota, bold, color: { argb: nota ? "FF6B7280" : dark } };
    cb.font = { size: nota ? 9 : 11, bold, color: { argb: bold ? accent.replace(/^FF/, "FF") : dark } };
    if (money && typeof valor === "number") cb.numFmt = FMT_USD;
    cb.alignment = { horizontal: "right" };
    r++;
  };

  addHeaderRow("PLAN DE PAGO");
  addRow("Precio de la unidad", plan.precio_total_usd, { bold: true });
  addRow(`Separación / inicial (${plan.separacion_pct}%)`, plan.separacion_usd);
  addRow(
    `Completivo en cuotas (${plan.completivo_pct}%) — ${plan.meses_hasta_entrega} meses`,
    plan.completivo_total_usd
  );
  addRow("Cuota mensual durante construcción", plan.cuota_mensual_usd, { bold: true });
  addRow(`Contra entrega (${plan.contra_entrega_pct}%)`, plan.contra_entrega_usd);
  addRow("Fecha estimada de entrega", plan.entrega_fecha, { money: false });
  addRow("La cuota mensual = completivo / meses hasta entrega.", "", { money: false, nota: true });

  // --- Sección opcional: reajuste ICDV ESTIMADO (PR-3) ---
  if (reajuste && reajuste.ok && reajuste.proyeccion) {
    r++;
    addHeaderRow("REAJUSTE ICDV — PROYECCIÓN ESTIMADA (NO ES GARANTÍA)");
    const p = reajuste.proyeccion;
    addRow(`Tasa mensual estimada (${reajuste.tasa.fuente})`, p.tasa_mensual_pct / 100, { money: false });
    ws.getCell(`B${r - 1}`).numFmt = "0.0000%";
    addRow(`Reajuste total estimado (${p.meses_proyectados} meses)`, p.reajuste_total_estimado_usd, { bold: true });
    addRow("Promedio mensual estimado", p.reajuste_promedio_mensual_usd);
    addRow("Precio ajustado estimado", p.precio_ajustado_estimado_usd);
    addRow(
      "Estimado sobre el insoluto, según el ICDV oficial (ONE). El reajuste real depende del índice publicado cada mes y CESA al entregar.",
      "",
      { money: false, nota: true }
    );
  }

  // --- Footer ---
  r++;
  ws.mergeCells(`A${r}:B${r}`);
  const foot = ws.getCell(`A${r}`);
  foot.value = "Constructora JPREZ — documento informativo; condiciones finales según contrato.";
  foot.font = { size: 8, italic: true, color: { argb: "FF9CA3AF" } };
  foot.alignment = { horizontal: "center" };

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

module.exports = { generatePlanXlsx, themeIdFor };
