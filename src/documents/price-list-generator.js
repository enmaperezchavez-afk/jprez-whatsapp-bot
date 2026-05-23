// src/documents/price-list-generator.js — Bloque 2 Componente 1.
//
// Genera un PDF profesional con el listado de precios de un proyecto JPREZ,
// SIEMPRE actualizado porque lee la data en vivo del inventario (Sheet via
// loader, que internamente cachea 5 min en Redis). Solo muestra unidades
// DISPONIBLES con su precio actual.
//
// CONTRATO:
//   generatePriceListPdf(proyectoId, { redis, forceRefresh }) → Promise<Buffer>
//     - proyectoId: pr3 | pr4 | pse3 | pse4 | crux_t6 | crux_listos
//     - Lanza Error("invalid_project") si el id no es válido.
//     - Lanza Error("inventory_unavailable") si el loader no trae data
//       estructurada (p.ej. cayó al fallback hardcoded sin proyectos).
//
// DISEÑO: PDFKit puro (sin binarios nativos, estable en Vercel serverless).
// Tabla dibujada manualmente con salto de página automático.

const PDFDocument = require("pdfkit");
const { loadInventory } = require("../inventory/loader");
const { fmtUsd, fmtDop } = require("../inventory/markdown-formatter");

// Branding
const BRAND_NAVY = "#1a2b4a";
const BRAND_GOLD = "#c9a227";
const GREY = "#666666";
const LIGHT = "#eef1f6";
const VENTAS_WHATSAPP = "829-994-3102";

const PROJECT_META = {
  pr3: { name: "Prado Residences III", currency: "USD", priceField: "precio_usd" },
  pr4: { name: "Prado Residences IV", currency: "USD", priceField: "precio_usd" },
  pse3: { name: "Prado Suites Puerto Plata — Etapa 3", currency: "USD", priceField: "precio_usd" },
  pse4: { name: "Prado Suites Puerto Plata — Etapa 4", currency: "USD", priceField: "precio_usd" },
  crux_t6: { name: "Crux del Prado — Torre 6", currency: "USD", priceField: "precio_usd" },
  crux_listos: { name: "Crux del Prado — Listos para Entrega Inmediata", currency: "DOP", priceField: "precio_dop" },
};

const VALID_PROJECTS = Object.keys(PROJECT_META);

function fmtFechaEs(date) {
  return date.toLocaleDateString("es-DO", {
    day: "numeric", month: "long", year: "numeric",
    timeZone: "America/Santo_Domingo",
  });
}

// Compone el detalle por unidad a partir de los campos presentes (varían
// por proyecto: pr4 trae hab/baños, pse trae edificio/nivel, crux piso/torre).
function unitDetail(u) {
  const bits = [];
  if (u.tipo) bits.push(String(u.tipo));
  if (u.edificio != null) bits.push("Edif " + u.edificio);
  if (u.nivel) bits.push("Nivel " + u.nivel);
  if (u.piso != null) bits.push("Piso " + u.piso + (u.letra || ""));
  if (u.torre) bits.push("Torre " + u.torre);
  if (u.etapa != null) bits.push("Etapa " + u.etapa);
  if (u.hab != null) bits.push(u.hab + " hab");
  if (u.bano != null) bits.push(u.bano + " baños");
  if (u.parqueos != null) bits.push(u.parqueos + " parq");
  if (u.vista) bits.push("vista " + u.vista);
  if (u.orientacion) bits.push(String(u.orientacion));
  return bits.join(", ");
}

function fmtPrice(u, cfg) {
  const v = u[cfg.priceField];
  if (v == null) return "—";
  return cfg.currency === "DOP" ? fmtDop(v) : fmtUsd(v);
}

// generatePriceListPdf: entry point. Retorna Buffer del PDF.
async function generatePriceListPdf(proyectoId, options = {}) {
  const cfg = PROJECT_META[proyectoId];
  if (!cfg) {
    const err = new Error("invalid_project");
    err.code = "invalid_project";
    throw err;
  }

  const inv = await loadInventory({ redis: options.redis, forceRefresh: options.forceRefresh });
  const proyectos = inv && inv.proyectos;
  if (!proyectos || !Array.isArray(proyectos[proyectoId])) {
    // El loader cayó al fallback hardcoded (sin data estructurada) o Sheets
    // no está disponible. No inventamos precios — el caller decide qué decir.
    const err = new Error("inventory_unavailable");
    err.code = "inventory_unavailable";
    throw err;
  }

  const allUnits = proyectos[proyectoId];
  const disponibles = allUnits.filter((u) => u.estado === "disponible");
  const meta = (inv.meta || []).find((m) => m.proyecto_id === proyectoId) || null;
  const totalUnidades = meta && meta.total_unidades != null ? meta.total_unidades : allUnits.length;
  const displayName = (meta && meta.nombre_display) || cfg.name;

  return renderPdf({ cfg, displayName, meta, disponibles, totalUnidades });
}

function renderPdf({ cfg, displayName, meta, disponibles, totalUnidades }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 40 });
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const pageWidth = doc.page.width;
      const left = doc.page.margins.left;
      const right = pageWidth - doc.page.margins.right;
      const contentWidth = right - left;

      // ===== Header con branding =====
      doc.rect(0, 0, pageWidth, 90).fill(BRAND_NAVY);
      doc.fillColor(BRAND_GOLD).fontSize(26).font("Helvetica-Bold")
        .text("JPREZ", left, 26);
      doc.fillColor("#ffffff").fontSize(10).font("Helvetica")
        .text("Constructora JPREZ", left, 56);
      doc.fillColor("#ffffff").fontSize(15).font("Helvetica-Bold")
        .text("Listado de Precios", left, 26, { width: contentWidth, align: "right" });
      doc.fillColor("#dbe2ee").fontSize(11).font("Helvetica")
        .text(displayName, left, 50, { width: contentWidth, align: "right" });

      doc.y = 110;
      doc.fillColor(GREY).fontSize(9).font("Helvetica")
        .text("Actualizado al " + fmtFechaEs(new Date()), left, 104);

      // ===== Línea meta (entrega / ubicación) =====
      let cursorY = 124;
      if (meta) {
        const metaBits = [];
        if (meta.ubicacion) metaBits.push("Ubicación: " + meta.ubicacion);
        if (meta.entrega_fecha) metaBits.push("Entrega: " + meta.entrega_fecha);
        if (metaBits.length) {
          doc.fillColor(BRAND_NAVY).fontSize(10).font("Helvetica")
            .text(metaBits.join("    ·    "), left, cursorY, { width: contentWidth });
          cursorY = doc.y + 8;
        }
      }

      // ===== Tabla =====
      // Columnas: Unidad | Detalle | m² | Precio
      const cols = [
        { key: "unidad", label: "Unidad", w: 0.16 },
        { key: "detalle", label: "Detalle", w: 0.46 },
        { key: "m2", label: "m²", w: 0.12 },
        { key: "precio", label: "Precio (" + cfg.currency + ")", w: 0.26 },
      ];
      const colX = [];
      let acc = left;
      for (const c of cols) { colX.push(acc); acc += c.w * contentWidth; }

      const rowH = 22;
      const bottomLimit = doc.page.height - doc.page.margins.bottom - 60;

      function drawHeaderRow(y) {
        doc.rect(left, y, contentWidth, rowH).fill(BRAND_NAVY);
        doc.fillColor("#ffffff").fontSize(9.5).font("Helvetica-Bold");
        cols.forEach((c, i) => {
          doc.text(c.label, colX[i] + 4, y + 6, { width: c.w * contentWidth - 8, ellipsis: true });
        });
        return y + rowH;
      }

      cursorY = drawHeaderRow(cursorY);

      if (disponibles.length === 0) {
        doc.fillColor(GREY).fontSize(11).font("Helvetica")
          .text("No hay unidades disponibles en este momento. Escríbenos para opciones en otros proyectos.",
            left, cursorY + 10, { width: contentWidth });
        cursorY = doc.y + 10;
      } else {
        doc.font("Helvetica").fontSize(9.5);
        disponibles.forEach((u, idx) => {
          if (cursorY + rowH > bottomLimit) {
            doc.addPage();
            cursorY = doc.page.margins.top;
            cursorY = drawHeaderRow(cursorY);
            doc.font("Helvetica").fontSize(9.5);
          }
          if (idx % 2 === 0) {
            doc.rect(left, cursorY, contentWidth, rowH).fill(LIGHT);
          }
          const row = {
            unidad: u.unidad_id || "—",
            detalle: unitDetail(u) || "—",
            m2: u.m2 != null ? u.m2 + " m²" : "—",
            precio: fmtPrice(u, cfg),
          };
          doc.fillColor("#222222");
          cols.forEach((c, i) => {
            const bold = c.key === "precio";
            doc.font(bold ? "Helvetica-Bold" : "Helvetica");
            doc.text(String(row[c.key]), colX[i] + 4, cursorY + 6, {
              width: c.w * contentWidth - 8, ellipsis: true,
            });
          });
          cursorY += rowH;
        });
      }

      // ===== Resumen =====
      cursorY += 12;
      doc.fillColor(BRAND_GOLD).rect(left, cursorY, contentWidth, 1).fill(BRAND_GOLD);
      cursorY += 8;
      doc.fillColor(BRAND_NAVY).fontSize(11).font("Helvetica-Bold")
        .text(disponibles.length + " disponibles de " + totalUnidades + " unidades.", left, cursorY);
      cursorY = doc.y + 6;

      // ===== Plan de pago =====
      if (meta && (meta.plan_normal || meta.plan_feria)) {
        doc.fillColor("#333333").fontSize(10).font("Helvetica");
        if (meta.plan_normal) {
          doc.text("Plan de pago: " + meta.plan_normal, left, cursorY, { width: contentWidth });
          cursorY = doc.y + 2;
        }
        if (meta.plan_feria) {
          doc.fillColor(BRAND_GOLD).font("Helvetica-Bold")
            .text("Plan Feria de Mayo 2026: " + meta.plan_feria, left, cursorY, { width: contentWidth });
          cursorY = doc.y + 2;
        }
      }

      // ===== Footer =====
      const footerY = doc.page.height - doc.page.margins.bottom - 28;
      doc.fillColor(GREY).rect(left, footerY, contentWidth, 1).fill("#cccccc");
      doc.fillColor(BRAND_NAVY).fontSize(10).font("Helvetica-Bold")
        .text("WhatsApp ventas: " + VENTAS_WHATSAPP, left, footerY + 8, { width: contentWidth, align: "center" });
      doc.fillColor(GREY).fontSize(8).font("Helvetica")
        .text("Precios sujetos a cambio sin previo aviso · Documento generado automáticamente",
          left, footerY + 22, { width: contentWidth, align: "center" });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = {
  generatePriceListPdf,
  VALID_PROJECTS,
  PROJECT_META,
  // exportados para test granular
  unitDetail,
  fmtFechaEs,
};
