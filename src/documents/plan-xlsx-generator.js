// src/documents/plan-xlsx-generator.js — Sprint1.7 PR-3: EXCEL DIGNO.
//
// Reescritura total bajo el Adendum v1.2 sección B. El v1 (Sprint1 PR-4)
// era un resumen de 7 filas sin logo, sin tabla de cuotas, sin fechas y
// sin totales validados — auditado y condenado el 11 jun.
//
// B1 — identidad: logo del proyecto (public/logos, mismos assets del
//      Bloque 2) + wordmark JPREZ, colores del theme por proyecto,
//      Montserrat, pie oscuro. SIN logo el documento NO sale.
// B2 — contenido: bloque info (cliente, proyecto/unidad real, emisión,
//      validez 7 días) + resumen + TABLA DE CUOTAS MES A MES (de
//      cuotas-schedule.js, con cuadre EXACTO garantizado) + fila TOTAL
//      + reajuste opcional marcado ESTIMADO + pie legal.
// B3 — fechas reales HOY → entrega_fecha (nunca hardcode).
// B4 — precio de LISTA siempre (el descuento se conversa, no se imprime
//      hasta que la condición esté ACEPTADA — responsabilidad del tool/
//      doctrina; este módulo imprime lo que el plan trae).

const fs = require("fs");
const path = require("path");
const { getTheme } = require("./project-themes");
const { buildCuotasSchedule } = require("./cuotas-schedule");

const LOGOS_DIR = path.join(__dirname, "..", "..", "public", "logos");

// Mapeo proyecto calculadora -> proyectoId de themes/logos del Bloque 2.
function themeIdFor(proyectoCalc, etapa) {
  if (proyectoCalc === "crux") return "crux_t6";
  if (proyectoCalc === "puertoPlata") return etapa === "E3" ? "pse3" : "pse4";
  return proyectoCalc; // pr3 / pr4
}

const LOGO_KEYS = { crux_t6: "FINAL_crux", pse3: "FINAL_pradosuites", pse4: "FINAL_pradosuites", pr3: "def2_prado3", pr4: "def2_prado4" };

function loadLogoBuffer(themeId) {
  const key = LOGO_KEYS[themeId];
  if (!key) return null;
  for (const ext of ["png", "jpg", "jpeg"]) {
    const p = path.join(LOGOS_DIR, key + "." + ext);
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p);
    } catch (e) {
      console.error("[plan-xlsx] logo ilegible:", p, e.message);
    }
  }
  return null;
}

const FMT_USD = '"US$"#,##0';
const FONT = "Montserrat";

async function generatePlanXlsx({ plan, reajuste, proyectoCalc, etapa, clienteNombre, unidad, hoy }) {
  if (!plan || plan.error || plan.needs_etapa || !Number.isFinite(plan.precio_total_usd)) {
    throw new Error("generatePlanXlsx: plan inválido");
  }
  const ExcelJS = require("exceljs");
  const themeId = themeIdFor(proyectoCalc, etapa);
  const theme = getTheme(themeId);
  const accent = "FF" + theme.palette.accent.replace("#", "");
  const headerBg = "FF" + theme.palette.headerBg.replace("#", "");
  const footerBg = "FF" + (theme.palette.footerBg || "#1F2937").replace("#", "");
  const dark = "FF1F2937";
  const gris = "FF6B7280";

  // B1: sin logo el documento NO sale al cliente.
  const logoBuf = loadLogoBuffer(themeId);
  if (!logoBuf) {
    throw new Error("generatePlanXlsx: logo del proyecto no disponible (" + themeId + ") — documento bloqueado (Adendum B1)");
  }

  const fechaEmision = hoy || new Date();
  const schedule = buildCuotasSchedule({ plan, proyectoCalc, hoy: fechaEmision });

  const wb = new ExcelJS.Workbook();
  wb.creator = "Constructora JPREZ — Mateo";
  const ws = wb.addWorksheet("Plan de Pago", {
    properties: { defaultRowHeight: 18 },
    pageSetup: { paperSize: 9, orientation: "portrait" },
  });
  ws.columns = [{ width: 8 }, { width: 40 }, { width: 14 }, { width: 16 }, { width: 16 }];

  const F = (opts) => ({ name: FONT, ...opts });

  // ---- Header con identidad (logo + wordmark + tema) ----
  // Fondo pintado celda a celda (un merge A1:E4 chocaría con los merges
  // del wordmark — ExcelJS no permite merges solapados).
  for (let row = 1; row <= 4; row++) {
    for (let col = 1; col <= 5; col++) {
      ws.getCell(row, col).fill = { type: "pattern", pattern: "solid", fgColor: { argb: headerBg } };
    }
  }
  const imgId = wb.addImage({ buffer: logoBuf, extension: "png" });
  ws.addImage(imgId, { tl: { col: 0.2, row: 0.3 }, ext: { width: 150, height: 60 } });
  ws.mergeCells("C2:E2");
  const wm = ws.getCell("C2");
  wm.value = "CONSTRUCTORA JPREZ";
  wm.font = F({ size: 15, bold: true, color: { argb: dark } });
  wm.alignment = { horizontal: "right", vertical: "middle" };
  ws.mergeCells("C3:E3");
  const sub = ws.getCell("C3");
  sub.value = "Plan de pago — " + plan.proyecto + (unidad ? " · Unidad " + unidad : "");
  sub.font = F({ size: 11, bold: true, color: { argb: accent } });
  sub.alignment = { horizontal: "right", vertical: "middle" };

  // ---- Bloque info (B2) ----
  let r = 6;
  const info = (label, valor) => {
    ws.getCell(`B${r}`).value = label;
    ws.getCell(`B${r}`).font = F({ size: 9, color: { argb: gris } });
    ws.mergeCells(`C${r}:E${r}`);
    ws.getCell(`C${r}`).value = valor;
    ws.getCell(`C${r}`).font = F({ size: 10, bold: true, color: { argb: dark } });
    r++;
  };
  if (clienteNombre) info("Cliente", clienteNombre);
  info("Proyecto", plan.proyecto + (unidad ? " — Unidad " + unidad : ""));
  info("Fecha de emisión", fechaEmision.toISOString().slice(0, 10));
  info("Validez", "7 días (igual que el enlace de este documento)");

  // ---- Resumen (B2) ----
  r++;
  const resumenHeader = ws.getCell(`B${r}`);
  ws.mergeCells(`B${r}:E${r}`);
  resumenHeader.value = "RESUMEN DEL PLAN";
  resumenHeader.font = F({ size: 11, bold: true, color: { argb: "FFFFFFFF" } });
  resumenHeader.fill = { type: "pattern", pattern: "solid", fgColor: { argb: dark } };
  r++;
  const res = (label, valor, money = true) => {
    ws.getCell(`B${r}`).value = label;
    ws.getCell(`B${r}`).font = F({ size: 10, color: { argb: dark } });
    const c = ws.getCell(`E${r}`);
    c.value = valor;
    c.font = F({ size: 10, bold: true, color: { argb: dark } });
    if (money && typeof valor === "number") c.numFmt = FMT_USD;
    c.alignment = { horizontal: "right" };
    r++;
  };
  res("Precio de lista", plan.precio_total_usd);
  res(`Reserva (se descuenta del ${plan.separacion_pct}% inicial)`, schedule.reserva);
  res(`Estructura del plan`, `${plan.separacion_pct}/${plan.completivo_pct}/${plan.contra_entrega_pct}`, false);
  res(`Contra entrega (${plan.contra_entrega_pct}% FIJO según plan pactado)`, schedule.contraEntrega);
  res("Fecha de entrega", plan.entrega_fecha, false);

  // ---- TABLA DE CUOTAS MES A MES (el corazón, B2/B3) ----
  r++;
  ws.mergeCells(`A${r}:E${r}`);
  const th = ws.getCell(`A${r}`);
  th.value = "CALENDARIO DE PAGOS";
  th.font = F({ size: 11, bold: true, color: { argb: "FFFFFFFF" } });
  th.fill = { type: "pattern", pattern: "solid", fgColor: { argb: accent } };
  r++;
  const cols = ["#", "Concepto", "Mes", "Monto", "Saldo restante"];
  cols.forEach((label, i) => {
    const c = ws.getCell(r, i + 1);
    c.value = label;
    c.font = F({ size: 9, bold: true, color: { argb: "FFFFFFFF" } });
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: dark } };
    c.alignment = { horizontal: i >= 3 ? "right" : "left" };
  });
  r++;
  for (const fila of schedule.filas) {
    ws.getCell(r, 1).value = fila.n;
    ws.getCell(r, 2).value = fila.concepto;
    ws.getCell(r, 3).value = fila.fecha;
    const monto = ws.getCell(r, 4);
    monto.value = fila.monto;
    monto.numFmt = FMT_USD;
    const saldo = ws.getCell(r, 5);
    saldo.value = fila.saldo;
    saldo.numFmt = FMT_USD;
    for (let c = 1; c <= 5; c++) {
      ws.getCell(r, c).font = F({ size: 9, color: { argb: dark } });
      if (c >= 4) ws.getCell(r, c).alignment = { horizontal: "right" };
    }
    r++;
  }
  // Fila TOTAL — suma EXACTA garantizada por cuotas-schedule (throw si no).
  ws.getCell(r, 2).value = "TOTAL";
  ws.getCell(r, 2).font = F({ size: 10, bold: true, color: { argb: dark } });
  const totalCell = ws.getCell(r, 4);
  totalCell.value = schedule.total;
  totalCell.numFmt = FMT_USD;
  totalCell.font = F({ size: 10, bold: true, color: { argb: accent } });
  totalCell.alignment = { horizontal: "right" };
  for (let c = 1; c <= 5; c++) {
    ws.getCell(r, c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: headerBg } };
  }
  r++;

  // ---- Reajuste ICDV opcional, claramente ESTIMADO ----
  if (reajuste && reajuste.ok && reajuste.proyeccion) {
    r++;
    ws.mergeCells(`A${r}:E${r}`);
    const rh = ws.getCell(`A${r}`);
    rh.value = "REAJUSTE ICDV — ESTIMADO, NO GARANTIZADO";
    rh.font = F({ size: 10, bold: true, color: { argb: "FFFFFFFF" } });
    rh.fill = { type: "pattern", pattern: "solid", fgColor: { argb: gris } };
    r++;
    ws.mergeCells(`A${r}:E${r}`);
    const rt = ws.getCell(`A${r}`);
    rt.value =
      "Proyección estimada sobre el insoluto según el ICDV oficial (ONE): " +
      "US$" + reajuste.proyeccion.reajuste_total_estimado_usd.toLocaleString("en-US") +
      " en " + reajuste.proyeccion.meses_proyectados + " meses (" +
      reajuste.proyeccion.tasa_mensual_pct + "% mensual). El reajuste real depende del índice publicado cada mes y cesa al entregar.";
    rt.font = F({ size: 8, italic: true, color: { argb: gris } });
    rt.alignment = { wrapText: true };
    ws.getRow(r).height = 30;
    r++;
  }

  // ---- Pie oscuro (B1/B2) ----
  r++;
  ws.mergeCells(`A${r}:E${r + 1}`);
  const foot = ws.getCell(`A${r}`);
  foot.value =
    "Documento informativo — no constituye contrato. Constructora JPREZ · WhatsApp oficial · constructorajprez.com";
  foot.font = F({ size: 8, color: { argb: "FFFFFFFF" } });
  foot.fill = { type: "pattern", pattern: "solid", fgColor: { argb: footerBg } };
  foot.alignment = { horizontal: "center", vertical: "middle", wrapText: true };

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

module.exports = { generatePlanXlsx, themeIdFor, loadLogoBuffer, LOGO_KEYS };
