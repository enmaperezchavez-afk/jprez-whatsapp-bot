// src/documents/price-list-generator.js — Bloque 2 Componente 1 (rediseño).
//
// Genera un PDF de listado de precios que REPLICA el diseño de los modelos
// del Director (carpeta Drive JPREZ_MODELO_PDF_PRECIOS). Lee la data EN VIVO
// del inventario (loader → Sheet) y muestra TODAS las unidades (disponibles,
// reservadas, vendidas, bloqueadas) con sus precios — el Director quiere ver
// el inventario completo, no solo lo disponible.
//
// Diseño replicado:
//   - Header: nombre proyecto + "LISTADO DE PRECIOS" + fecha de entrega.
//   - Cuadro RESUMEN: Disponibles | Reservados | Vendidos | Bloqueados |
//     Total | % Ventas, con colores por categoría.
//   - Tabla con columnas por proyecto (varía: PR3/PR4 vs PSE vs Crux T6).
//   - Filas coloreadas por estado (verde/amarillo/rojo/gris).
//   - Planes de pago (separación/completivo/saldo o inicial) calculados desde
//     el precio y el esquema del proyecto.
//   - Agrupado por piso/edificio con separador visual.
//   - Precios formato US$ 138,000.00 (comas + 2 decimales).
//   - Footer: "Actualizado al [fecha]" · paginación "N de M" · ubicación.
//
// CONTRATO:
//   generatePriceListPdf(proyectoId, { redis, forceRefresh }) → Promise<Buffer>
//     - Error("invalid_project") si el id no es válido.
//     - Error("inventory_unavailable") si el loader no trae data estructurada.
//
// PDFKit puro (sin binarios nativos, estable en Vercel serverless). Landscape
// A4 por la cantidad de columnas.

const PDFDocument = require("pdfkit");
const { loadInventory } = require("../inventory/loader");

// Branding
const NAVY = "#1a2b4a";
const GOLD = "#c9a227";
const GREY = "#666666";
const BORDER = "#cfd6e0";

// Colores de fila por estado
const STATUS_COLORS = {
  disponible: "#d8f3dc", // verde claro
  reservado: "#fff3bf",  // amarillo
  vendido: "#ffd6d6",    // rojo claro
  bloqueado: "#dee2e6",  // gris
};
const STATUS_LABEL = {
  disponible: "Disponible",
  reservado: "Reservado",
  vendido: "Vendido",
  bloqueado: "Bloqueado",
};

const VENTAS_WHATSAPP = "829-994-3102";

// Esquemas de pago por proyecto (fracciones del precio).
const SCHEMES = {
  pr3: null,
  pr4: { inicial: 0.40 },
  pse3: { sep: 0.10, comp: 0.30, saldo: 0.60 },
  pse4: { sep: 0.10, comp: 0.30, saldo: 0.60 },
  crux_t6: { sep: 0.10, comp: 0.20, saldo: 0.70 },
  crux_listos: null,
};

const PROJECT_META = {
  pr3: { name: "Prado Residences III", currency: "USD", priceField: "precio_usd", title: "PRADO RESIDENCES III", location: "SANTO DOMINGO" },
  pr4: { name: "Prado Residences IV", currency: "USD", priceField: "precio_usd", title: "PRADO RESIDENCES IV", location: "SANTO DOMINGO" },
  pse3: { name: "Prado Suites Puerto Plata — Etapa 3", currency: "USD", priceField: "precio_usd", title: "PRADO SUITES PUERTO PLATA — ETAPA 3", location: "PUERTO - PLATA" },
  pse4: { name: "Prado Suites Puerto Plata — Etapa 4", currency: "USD", priceField: "precio_usd", title: "PRADO SUITES PUERTO PLATA — ETAPA 4", location: "PUERTO - PLATA" },
  crux_t6: { name: "Crux del Prado — Torre 6", currency: "USD", priceField: "precio_usd", title: "CRUX DEL PRADO — TORRE 6", location: "SANTIAGO" },
  crux_listos: { name: "Crux del Prado — Listos para Entrega", currency: "DOP", priceField: "precio_dop", title: "CRUX DEL PRADO — LISTOS PARA ENTREGA", location: "SANTIAGO" },
};

const VALID_PROJECTS = Object.keys(PROJECT_META);

function fmtFechaEs(date) {
  return date.toLocaleDateString("es-DO", {
    day: "numeric", month: "long", year: "numeric",
    timeZone: "America/Santo_Domingo",
  });
}

function money(n, currency) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const symbol = currency === "DOP" ? "RD$" : "US$";
  return symbol + " " + Number(n).toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

function val(x, suffix) {
  if (x == null || x === "") return "—";
  return suffix ? String(x) + suffix : String(x);
}

// Número de piso a partir del unidad_id tipo "4D", "11G" (PR3/PR4).
function floorFromUnidad(unidadId) {
  const m = String(unidadId || "").match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

// ===== Definición de columnas por proyecto =====
// Cada columna: { label, w (peso relativo), align, get(u, ctx) }
function columnsFor(proyectoId) {
  const cur = PROJECT_META[proyectoId].currency;
  const scheme = SCHEMES[proyectoId];
  const priceOf = (u) => u[PROJECT_META[proyectoId].priceField];

  const colPrecio = { label: "Precio " + (cur === "DOP" ? "RD$" : "US$"), w: 1.5, align: "right", get: (u) => money(priceOf(u), cur) };
  const colEstatus = { label: "Estatus", w: 0.9, align: "left", get: (u) => STATUS_LABEL[u.estado] || u.estado };
  const colArea = { label: "Área", w: 0.55, align: "right", get: (u) => val(u.m2, " m²") };
  const colHab = { label: "Hab.", w: 0.6, align: "center", get: (u) => val(u.hab) };
  const colBano = { label: "Baños", w: 0.6, align: "center", get: (u) => val(u.bano) };
  const colParq = { label: "Parq.", w: 0.55, align: "center", get: (u) => val(u.parqueos) };

  if (proyectoId === "pr3") {
    return [
      { label: "Unidad", w: 0.7, align: "left", get: (u) => u.unidad_id || "—" },
      colArea,
      { label: "Vista", w: 0.9, align: "left", get: (u) => val(u.vista || u.orientacion) },
      colPrecio,
      colHab, colBano, colParq, colEstatus,
    ];
  }
  if (proyectoId === "pr4") {
    return [
      { label: "Unidad", w: 0.7, align: "left", get: (u) => u.unidad_id || "—" },
      colArea,
      { label: "Vista", w: 0.9, align: "left", get: (u) => val(u.vista || u.orientacion) },
      colPrecio,
      { label: "Inicial 40%", w: 1.3, align: "right", get: (u) => money(priceOf(u) != null ? priceOf(u) * scheme.inicial : null, cur) },
      colHab, colBano, colParq, colEstatus,
    ];
  }
  if (proyectoId === "pse3" || proyectoId === "pse4") {
    return [
      { label: "Edificio", w: 0.7, align: "center", get: (u) => val(u.edificio) },
      { label: "Apartamento", w: 0.9, align: "left", get: (u) => u.unidad_id || "—" },
      colPrecio,
      { label: "Separación 10%", w: 1.2, align: "right", get: (u) => money(priceOf(u) != null ? priceOf(u) * scheme.sep : null, cur) },
      { label: "Completivo 30%", w: 1.2, align: "right", get: (u) => money(priceOf(u) != null ? priceOf(u) * scheme.comp : null, cur) },
      { label: "Saldo 60%", w: 1.2, align: "right", get: (u) => money(priceOf(u) != null ? priceOf(u) * scheme.saldo : null, cur) },
      colArea, colHab, colBano, colEstatus,
    ];
  }
  if (proyectoId === "crux_t6") {
    return [
      { label: "Apartamento", w: 0.8, align: "left", get: (u) => u.unidad_id || "—" },
      colPrecio,
      { label: "Separación 10%", w: 1.1, align: "right", get: (u) => money(priceOf(u) != null ? priceOf(u) * scheme.sep : null, cur) },
      { label: "Completivo 20%", w: 1.1, align: "right", get: (u) => money(priceOf(u) != null ? priceOf(u) * scheme.comp : null, cur) },
      { label: "Saldo 70%", w: 1.1, align: "right", get: (u) => money(priceOf(u) != null ? priceOf(u) * scheme.saldo : null, cur) },
      colArea, colHab, colBano, colParq,
      { label: "Tipo Parqueo", w: 1.6, align: "left", get: (u) => val(u.parqueo_tipo) },
      colEstatus,
    ];
  }
  // crux_listos (entrega inmediata, RD$, sin esquema de cuotas)
  return [
    { label: "Apartamento", w: 0.9, align: "left", get: (u) => u.unidad_id || "—" },
    colPrecio,
    colArea, colHab, colBano,
    { label: "Torre", w: 0.6, align: "center", get: (u) => val(u.torre) },
    { label: "Etapa", w: 0.6, align: "center", get: (u) => val(u.etapa) },
    { label: "Tipo Parqueo", w: 1.4, align: "left", get: (u) => val(u.parqueo_tipo) },
    colEstatus,
  ];
}

// Agrupa unidades en secciones (piso/edificio) y devuelve [{label, units}].
function groupUnits(proyectoId, units) {
  const groups = new Map();
  const keyFn = (u) => {
    if (proyectoId === "pse3" || proyectoId === "pse4") return u.edificio != null ? "Edificio " + u.edificio : "Edificio —";
    if (proyectoId === "crux_t6") return u.piso != null ? "Piso " + u.piso : "Piso —";
    if (proyectoId === "crux_listos") return u.etapa != null ? "Etapa " + u.etapa : "Etapa —";
    return "Piso " + floorFromUnidad(u.unidad_id); // pr3/pr4
  };
  const ordFn = (u) => {
    if (proyectoId === "pse3" || proyectoId === "pse4") return u.edificio || 0;
    if (proyectoId === "crux_t6") return u.piso || 0;
    if (proyectoId === "crux_listos") return u.etapa || 0;
    return floorFromUnidad(u.unidad_id);
  };
  for (const u of units) {
    const k = keyFn(u);
    if (!groups.has(k)) groups.set(k, { label: k, ord: ordFn(u), units: [] });
    groups.get(k).units.push(u);
  }
  const arr = [...groups.values()].sort((a, b) => a.ord - b.ord);
  for (const g of arr) g.units.sort((a, b) => String(a.unidad_id).localeCompare(String(b.unidad_id), "en", { numeric: true }));
  return arr;
}

function statusCounts(units) {
  const c = { disponible: 0, reservado: 0, vendido: 0, bloqueado: 0 };
  for (const u of units) if (c[u.estado] != null) c[u.estado]++;
  return c;
}

// ===== Entry point =====
async function generatePriceListPdf(proyectoId, options = {}) {
  if (!PROJECT_META[proyectoId]) {
    const err = new Error("invalid_project");
    err.code = "invalid_project";
    throw err;
  }
  const inv = await loadInventory({ redis: options.redis, forceRefresh: options.forceRefresh });
  const proyectos = inv && inv.proyectos;
  if (!proyectos || !Array.isArray(proyectos[proyectoId])) {
    const err = new Error("inventory_unavailable");
    err.code = "inventory_unavailable";
    throw err;
  }

  const units = proyectos[proyectoId];
  const meta = (inv.meta || []).find((m) => m.proyecto_id === proyectoId) || null;
  return renderPdf({ proyectoId, units, meta });
}

function renderPdf({ proyectoId, units, meta }) {
  return new Promise((resolve, reject) => {
    try {
      const cfg = PROJECT_META[proyectoId];
      const columns = columnsFor(proyectoId);
      const groups = groupUnits(proyectoId, units);
      const counts = statusCounts(units);
      const total = units.length;
      const pctVentas = total > 0 ? Math.round(((total - counts.disponible) / total) * 100) : 0;
      const entrega = (meta && meta.entrega_fecha) || "";
      const ubicacion = (meta && meta.ubicacion) || cfg.location;
      const displayTitle = cfg.title;

      // Construir lista plana de items (group-header + filas) para paginar.
      const items = [];
      for (const g of groups) {
        items.push({ type: "group", label: g.label });
        for (const u of g.units) items.push({ type: "row", unit: u });
      }

      const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 30 });
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const M = doc.page.margins.left;
      const pageW = doc.page.width;
      const pageH = doc.page.height;
      const contentW = pageW - M * 2;

      // Alturas de layout
      const HEADER_H = 56;
      const RESUMEN_H = 46;
      const COLHDR_H = 20;
      const ROW_H = 15;
      const FOOTER_H = 22;
      const tableTop = M + HEADER_H + 8 + RESUMEN_H + 8 + COLHDR_H;
      const tableBottom = pageH - M - FOOTER_H;
      const rowsPerPage = Math.max(1, Math.floor((tableBottom - tableTop) / ROW_H));
      const totalPages = Math.max(1, Math.ceil(items.length / rowsPerPage));

      // Posiciones de columna
      const totalW = columns.reduce((s, c) => s + c.w, 0);
      const colX = [];
      let acc = M;
      for (const c of columns) { colX.push(acc); acc += (c.w / totalW) * contentW; }
      const colWidth = (i) => (columns[i].w / totalW) * contentW;

      function drawHeader() {
        doc.rect(0, 0, pageW, M + HEADER_H).fill(NAVY);
        doc.fillColor(GOLD).font("Helvetica-Bold").fontSize(9).text("JPREZ", M, M - 2);
        doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(15)
          .text(displayTitle, M, M + 10, { width: contentW * 0.7 });
        doc.fillColor("#dbe2ee").font("Helvetica").fontSize(9)
          .text("LISTADO DE PRECIOS" + (entrega ? "   ·   Entrega: " + entrega : ""), M, M + 32, { width: contentW * 0.7 });
        doc.fillColor(GOLD).font("Helvetica-Bold").fontSize(11)
          .text(ubicacion, M, M + 14, { width: contentW, align: "right" });
      }

      function drawResumen(y) {
        const cells = [
          { label: "Disponibles", value: counts.disponible, color: STATUS_COLORS.disponible },
          { label: "Reservados", value: counts.reservado, color: STATUS_COLORS.reservado },
          { label: "Vendidos", value: counts.vendido, color: STATUS_COLORS.vendido },
          { label: "Bloqueados", value: counts.bloqueado, color: STATUS_COLORS.bloqueado },
          { label: "Total", value: total, color: "#e9edf3" },
          { label: "% Ventas", value: pctVentas + "%", color: "#f3e9c9" },
        ];
        const cw = contentW / cells.length;
        cells.forEach((cell, i) => {
          const x = M + i * cw;
          doc.rect(x, y, cw - 4, RESUMEN_H).fill(cell.color);
          doc.rect(x, y, cw - 4, RESUMEN_H).lineWidth(0.5).stroke(BORDER);
          doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(16)
            .text(String(cell.value), x, y + 8, { width: cw - 4, align: "center" });
          doc.fillColor(GREY).font("Helvetica").fontSize(8)
            .text(cell.label, x, y + 30, { width: cw - 4, align: "center" });
        });
      }

      function drawColHeader(y) {
        doc.rect(M, y, contentW, COLHDR_H).fill(NAVY);
        doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(7.5);
        columns.forEach((c, i) => {
          doc.text(c.label, colX[i] + 3, y + 6, { width: colWidth(i) - 6, align: c.align, ellipsis: true });
        });
      }

      function drawFooter(pageNum) {
        const y = pageH - M - FOOTER_H;
        doc.rect(M, y, contentW, 0.5).fill(BORDER);
        doc.fillColor(GREY).font("Helvetica").fontSize(8)
          .text("Actualizado al " + fmtFechaEs(new Date()), M, y + 5, { width: contentW * 0.4, align: "left" });
        doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(8)
          .text(ubicacion + "   ·   WhatsApp ventas: " + VENTAS_WHATSAPP, M, y + 5, { width: contentW * 0.3, align: "center" });
        doc.fillColor(GREY).font("Helvetica").fontSize(8)
          .text(pageNum + " de " + totalPages, M, y + 5, { width: contentW, align: "right" });
      }

      function drawPageFurniture(pageNum) {
        drawHeader();
        drawResumen(M + HEADER_H + 8);
        drawColHeader(M + HEADER_H + 8 + RESUMEN_H + 8);
        drawFooter(pageNum);
      }

      // Render paginado
      let pageNum = 1;
      drawPageFurniture(pageNum);
      let y = tableTop;
      let placed = 0;

      const drawRow = (item) => {
        if (item.type === "group") {
          doc.rect(M, y, contentW, ROW_H).fill("#eef1f6");
          doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(8)
            .text(item.label, M + 4, y + 3.5, { width: contentW - 8 });
        } else {
          const u = item.unit;
          const bg = STATUS_COLORS[u.estado] || "#ffffff";
          doc.rect(M, y, contentW, ROW_H).fill(bg);
          doc.fillColor("#222222").font("Helvetica").fontSize(7);
          columns.forEach((c, i) => {
            doc.text(String(c.get(u)), colX[i] + 3, y + 3.5, { width: colWidth(i) - 6, align: c.align, ellipsis: true });
          });
        }
        y += ROW_H;
      };

      for (const item of items) {
        if (placed >= rowsPerPage) {
          doc.addPage();
          pageNum += 1;
          drawPageFurniture(pageNum);
          y = tableTop;
          placed = 0;
        }
        drawRow(item);
        placed += 1;
      }

      if (items.length === 0) {
        doc.fillColor(GREY).font("Helvetica").fontSize(11)
          .text("Sin unidades cargadas para este proyecto.", M, tableTop + 10, { width: contentW });
      }

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
  // exportados para test
  columnsFor,
  groupUnits,
  statusCounts,
  money,
  floorFromUnidad,
  SCHEMES,
};
