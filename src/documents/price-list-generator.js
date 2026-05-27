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

const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const { loadInventory } = require("../inventory/loader");
const { botLog } = require("../log");

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

// Fix 3 (hotfix-51): inicio_construccion vive en PROJECT_META (fallback si el
// META tab del Sheet no lo trae). null = proyecto ya entregado/entrega
// inmediata → el header solo muestra "Entrega".
// Fix 4 (hotfix-51): logo = nombre del archivo en public/logos/<logo>.png.
// Si el archivo existe, se embebe; si no, fallback a texto estilizado.
const PROJECT_META = {
  pr3: { name: "Prado Residences III", currency: "USD", priceField: "precio_usd", title: "PRADO RESIDENCES III", location: "SANTO DOMINGO", inicio_construccion: null, logo: "prado3" },
  pr4: { name: "Prado Residences IV", currency: "USD", priceField: "precio_usd", title: "PRADO RESIDENCES IV", location: "SANTO DOMINGO", inicio_construccion: null, logo: "prado4" },
  pse3: { name: "Prado Suites Puerto Plata — Etapa 3", currency: "USD", priceField: "precio_usd", title: "PRADO SUITES PUERTO PLATA — ETAPA 3", location: "PUERTO - PLATA", inicio_construccion: "Enero 2028", logo: "pradosuites" },
  pse4: { name: "Prado Suites Puerto Plata — Etapa 4", currency: "USD", priceField: "precio_usd", title: "PRADO SUITES PUERTO PLATA — ETAPA 4", location: "PUERTO - PLATA", inicio_construccion: "En construcción", logo: "pradosuites" },
  crux_t6: { name: "Crux del Prado — Torre 6", currency: "USD", priceField: "precio_usd", title: "CRUX DEL PRADO — TORRE 6", location: "SANTIAGO", inicio_construccion: "En construcción", logo: "crux" },
  crux_listos: { name: "Crux del Prado — Listos para Entrega", currency: "DOP", priceField: "precio_dop", title: "CRUX DEL PRADO — LISTOS PARA ENTREGA", location: "SANTIAGO", inicio_construccion: null, logo: "crux" },
};

const VALID_PROJECTS = Object.keys(PROJECT_META);

// Fix 1 (hotfix-51): Crux T6 y Crux Listos tienen valores fijos para TODAS
// las unidades. El Sheet no trae estas columnas, así que las completamos en
// código cuando vienen vacías (no inventamos datos para otros proyectos).
const CRUX_DEFAULTS = { m2: 100, hab: "3", bano: 2, parqueos: "2" };

// Fix 4 (hotfix-51): carga del logo del proyecto desde public/logos/<logo>.png.
// Cacheado por logo. Devuelve Buffer o null (fallback a texto). El Director
// deja los PNG en public/logos/ y aparecen automáticamente — sin redeploy de
// código. Mientras no existan, el header usa el wordmark de texto.
const LOGOS_DIR = path.join(__dirname, "..", "..", "public", "logos");
const _logoCache = {};
function loadLogo(proyectoId) {
  const cfg = PROJECT_META[proyectoId];
  const key = cfg && cfg.logo;
  if (!key) return null;
  if (key in _logoCache) return _logoCache[key];
  let buf = null;
  for (const ext of ["png", "jpg", "jpeg"]) {
    const p = path.join(LOGOS_DIR, key + "." + ext);
    try {
      if (fs.existsSync(p)) { buf = fs.readFileSync(p); break; }
    } catch (e) { /* ignora, cae a fallback */ }
  }
  _logoCache[key] = buf;
  return buf;
}

function applyDefaults(proyectoId, units) {
  if (proyectoId !== "crux_t6" && proyectoId !== "crux_listos") return units;
  return units.map((u) => {
    const out = { ...u };
    for (const [k, v] of Object.entries(CRUX_DEFAULTS)) {
      if (out[k] == null || out[k] === "") out[k] = v;
    }
    return out;
  });
}

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
// opts.hasEncargos (Fix 5): si el Sheet trae "numero_encargos", se inserta la
// columna; si no, no se fuerza.
function columnsFor(proyectoId, opts = {}) {
  const cur = PROJECT_META[proyectoId].currency;
  const scheme = SCHEMES[proyectoId];
  const priceOf = (u) => u[PROJECT_META[proyectoId].priceField];

  const colPrecio = { label: "Precio " + (cur === "DOP" ? "RD$" : "US$"), w: 1.5, align: "right", get: (u) => money(priceOf(u), cur) };
  const colEstatus = { label: "Estatus", w: 0.9, align: "left", get: (u) => STATUS_LABEL[u.estado] || u.estado };
  const colArea = { label: "Área", w: 0.55, align: "right", get: (u) => val(u.m2, " m²") };
  const colHab = { label: "Hab.", w: 0.6, align: "center", get: (u) => val(u.hab) };
  const colBano = { label: "Baños", w: 0.6, align: "center", get: (u) => val(u.bano) };
  const colParq = { label: "Parq.", w: 0.55, align: "center", get: (u) => val(u.parqueos) };
  const colEncargo = { label: "No. Encargo", w: 1.1, align: "left", get: (u) => val(u.numero_encargos) };

  let cols;
  if (proyectoId === "pr3") {
    cols = [
      { label: "Unidad", w: 0.7, align: "left", get: (u) => u.unidad_id || "—" },
      colArea,
      { label: "Vista", w: 0.9, align: "left", get: (u) => val(u.vista || u.orientacion) },
      colPrecio,
      colHab, colBano, colParq, colEstatus,
    ];
  } else if (proyectoId === "pr4") {
    cols = [
      { label: "Unidad", w: 0.7, align: "left", get: (u) => u.unidad_id || "—" },
      colArea,
      { label: "Vista", w: 0.9, align: "left", get: (u) => val(u.vista || u.orientacion) },
      colPrecio,
      { label: "Inicial 40%", w: 1.3, align: "right", get: (u) => money(priceOf(u) != null ? priceOf(u) * scheme.inicial : null, cur) },
      colHab, colBano, colParq, colEstatus,
    ];
  } else if (proyectoId === "pse3" || proyectoId === "pse4") {
    cols = [
      { label: "Edificio", w: 0.7, align: "center", get: (u) => val(u.edificio) },
      { label: "Apartamento", w: 0.9, align: "left", get: (u) => u.unidad_id || "—" },
      colPrecio,
      { label: "Separación 10%", w: 1.2, align: "right", get: (u) => money(priceOf(u) != null ? priceOf(u) * scheme.sep : null, cur) },
      { label: "Completivo 30%", w: 1.2, align: "right", get: (u) => money(priceOf(u) != null ? priceOf(u) * scheme.comp : null, cur) },
      { label: "Saldo 60%", w: 1.2, align: "right", get: (u) => money(priceOf(u) != null ? priceOf(u) * scheme.saldo : null, cur) },
      colArea, colHab, colBano, colEstatus,
    ];
  } else if (proyectoId === "crux_t6") {
    cols = [
      { label: "Apartamento", w: 0.8, align: "left", get: (u) => u.unidad_id || "—" },
      colPrecio,
      { label: "Separación 10%", w: 1.1, align: "right", get: (u) => money(priceOf(u) != null ? priceOf(u) * scheme.sep : null, cur) },
      { label: "Completivo 20%", w: 1.1, align: "right", get: (u) => money(priceOf(u) != null ? priceOf(u) * scheme.comp : null, cur) },
      { label: "Saldo 70%", w: 1.1, align: "right", get: (u) => money(priceOf(u) != null ? priceOf(u) * scheme.saldo : null, cur) },
      colArea, colHab, colBano, colParq,
      { label: "Tipo Parqueo", w: 1.6, align: "left", get: (u) => val(u.parqueo_tipo) },
      colEstatus,
    ];
  } else {
    // crux_listos (entrega inmediata, RD$, sin esquema de cuotas)
    cols = [
      { label: "Apartamento", w: 0.9, align: "left", get: (u) => u.unidad_id || "—" },
      colPrecio,
      colArea, colHab, colBano,
      { label: "Torre", w: 0.6, align: "center", get: (u) => val(u.torre) },
      { label: "Etapa", w: 0.6, align: "center", get: (u) => val(u.etapa) },
      { label: "Tipo Parqueo", w: 1.4, align: "left", get: (u) => val(u.parqueo_tipo) },
      colEstatus,
    ];
  }

  // Fix 5: insertar "No. Encargo" tras la primera columna identificadora
  // (Apartamento/Unidad) cuando el Sheet trae el dato, en PSE y Crux T6.
  if (opts.hasEncargos && ["pse3", "pse4", "crux_t6"].includes(proyectoId)) {
    const insertAt = proyectoId === "pse3" || proyectoId === "pse4" ? 2 : 1;
    cols.splice(insertAt, 0, colEncargo);
  }
  return cols;
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

// Fix 2 (hotfix-51): conteos por grupo (edificio/piso) + fila TOTAL, para la
// tabla resumen que va entre el cuadro de colores y la tabla principal.
function groupSummary(proyectoId, units) {
  const groups = groupUnits(proyectoId, units);
  const rows = groups.map((g) => {
    const c = statusCounts(g.units);
    const t = g.units.length;
    return {
      label: g.label, vendido: c.vendido, bloqueado: c.bloqueado,
      reservado: c.reservado, disponible: c.disponible, total: t,
      pct: t > 0 ? Math.round(((t - c.disponible) / t) * 100) : 0,
    };
  });
  const tc = statusCounts(units);
  const tt = units.length;
  rows.push({
    label: "TOTAL", vendido: tc.vendido, bloqueado: tc.bloqueado,
    reservado: tc.reservado, disponible: tc.disponible, total: tt,
    pct: tt > 0 ? Math.round(((tt - tc.disponible) / tt) * 100) : 0,
    isTotal: true,
  });
  return rows;
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

  // Fix 1: completar defaults fijos de Crux antes de renderizar.
  const units = applyDefaults(proyectoId, proyectos[proyectoId]);
  const meta = (inv.meta || []).find((m) => m.proyecto_id === proyectoId) || null;
  return renderPdf({ proyectoId, units, meta });
}

function renderPdf({ proyectoId, units, meta }) {
  return new Promise((resolve, reject) => {
    try {
      const cfg = PROJECT_META[proyectoId];
      const hasEncargos = units.some((u) => u.numero_encargos);
      const columns = columnsFor(proyectoId, { hasEncargos });
      const groups = groupUnits(proyectoId, units);
      const counts = statusCounts(units);
      const total = units.length;
      const pctVentas = total > 0 ? Math.round(((total - counts.disponible) / total) * 100) : 0;
      const entrega = (meta && meta.entrega_fecha) || "";
      const inicio = (meta && meta.inicio_construccion) || cfg.inicio_construccion || "";
      const ubicacion = (meta && meta.ubicacion) || cfg.location;
      const displayTitle = cfg.title;
      const logoBuf = loadLogo(proyectoId);
      const gsRows = groupSummary(proyectoId, units);
      const showGroupSummary = gsRows.length > 1; // al menos 1 grupo + total

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
      const HEADER_H = 60;
      const RESUMEN_H = 46;
      const COLHDR_H = 20;
      const ROW_H = 15;
      const FOOTER_H = 22;
      const GS_ROW_H = 13;
      // Altura del bloque resumen-por-grupo (Fix 2): título + header + filas.
      const groupSummaryH = showGroupSummary ? (14 + (gsRows.length + 1) * GS_ROW_H) : 0;

      const baseFurnitureBottom = M + HEADER_H + 8 + RESUMEN_H + 8;
      const tableBottom = pageH - M - FOOTER_H;
      // Page 1 incluye el bloque resumen-por-grupo; las demás no.
      const colHdrY1 = baseFurnitureBottom + (showGroupSummary ? groupSummaryH + 8 : 0);
      const tableTop1 = colHdrY1 + COLHDR_H;
      const colHdrYN = baseFurnitureBottom;
      const tableTopN = colHdrYN + COLHDR_H;
      const rowsPerPage1 = Math.max(1, Math.floor((tableBottom - tableTop1) / ROW_H));
      const rowsPerPageN = Math.max(1, Math.floor((tableBottom - tableTopN) / ROW_H));
      let totalPages = 1;
      const remAfter1 = items.length - rowsPerPage1;
      if (remAfter1 > 0) totalPages += Math.ceil(remAfter1 / rowsPerPageN);

      // Posiciones de columna
      const totalW = columns.reduce((s, c) => s + c.w, 0);
      const colX = [];
      let acc = M;
      for (const c of columns) { colX.push(acc); acc += (c.w / totalW) * contentW; }
      const colWidth = (i) => (columns[i].w / totalW) * contentW;

      function drawHeader() {
        doc.rect(0, 0, pageW, M + HEADER_H).fill(NAVY);
        doc.fillColor(GOLD).font("Helvetica-Bold").fontSize(9).text("JPREZ", M, M - 4);
        doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(15)
          .text(displayTitle, M, M + 8, { width: contentW * 0.72 });
        // Fix 3: línea de inicio de construcción + entrega.
        const infoBits = ["LISTADO DE PRECIOS"];
        if (inicio) infoBits.push("INICIO DE CONSTRUCCIÓN: " + inicio);
        if (entrega) infoBits.push("ENTREGA: " + entrega);
        doc.fillColor("#dbe2ee").font("Helvetica").fontSize(8.5)
          .text(infoBits.join("   ·   "), M, M + 32, { width: contentW * 0.72 });
        // Fix 4: logo del proyecto arriba a la derecha si existe el PNG; si no,
        // wordmark de texto (ubicación en dorado) como fallback.
        if (logoBuf) {
          try {
            doc.image(logoBuf, pageW - M - 150, M - 4, { fit: [150, 46], align: "right", valign: "center" });
          } catch (e) {
            botLog("warn", "price_list_logo_render_failed", { proyectoId, error: e.message });
            doc.fillColor(GOLD).font("Helvetica-Bold").fontSize(11)
              .text(ubicacion, M, M + 12, { width: contentW, align: "right" });
          }
        } else {
          doc.fillColor(GOLD).font("Helvetica-Bold").fontSize(11)
            .text(ubicacion, M, M + 12, { width: contentW, align: "right" });
        }
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

      // Fix 2: tabla resumen por edificio/piso (solo página 1).
      function drawGroupSummary(y) {
        const grpLabel = (proyectoId === "pse3" || proyectoId === "pse4") ? "Edificio"
          : proyectoId === "crux_listos" ? "Etapa" : "Piso";
        const gsCols = [
          { label: grpLabel, w: 1.6, align: "left", key: "label" },
          { label: "Vendido", w: 1, align: "center", key: "vendido" },
          { label: "Bloqueado", w: 1, align: "center", key: "bloqueado" },
          { label: "Reservado", w: 1, align: "center", key: "reservado" },
          { label: "Disponible", w: 1, align: "center", key: "disponible" },
          { label: "Total", w: 1, align: "center", key: "total" },
          { label: "% Ventas", w: 1, align: "center", key: "pct" },
        ];
        const gsTotalW = gsCols.reduce((s, c) => s + c.w, 0);
        const gsX = []; let ax = M;
        for (const c of gsCols) { gsX.push(ax); ax += (c.w / gsTotalW) * contentW; }
        const gsW = (i) => (gsCols[i].w / gsTotalW) * contentW;

        doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(8.5)
          .text("RESUMEN DE INVENTARIO POR " + grpLabel.toUpperCase(), M, y, { width: contentW });
        let ry = y + 12;
        // header
        doc.rect(M, ry, contentW, GS_ROW_H).fill(NAVY);
        doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(7);
        gsCols.forEach((c, i) => doc.text(c.label, gsX[i] + 3, ry + 3, { width: gsW(i) - 6, align: c.align, ellipsis: true }));
        ry += GS_ROW_H;
        // rows
        gsRows.forEach((r) => {
          const bg = r.isTotal ? "#e9edf3" : "#ffffff";
          doc.rect(M, ry, contentW, GS_ROW_H).fill(bg);
          doc.rect(M, ry, contentW, GS_ROW_H).lineWidth(0.3).stroke(BORDER);
          doc.fillColor(r.isTotal ? NAVY : "#333333").font(r.isTotal ? "Helvetica-Bold" : "Helvetica").fontSize(7);
          gsCols.forEach((c, i) => {
            let v = r[c.key];
            if (c.key === "pct") v = v + "%";
            if (c.key !== "label" && c.key !== "pct" && v === 0) v = "";
            doc.text(String(v), gsX[i] + 3, ry + 3, { width: gsW(i) - 6, align: c.align, ellipsis: true });
          });
          ry += GS_ROW_H;
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
          .text(ubicacion + "   ·   WhatsApp ventas: " + VENTAS_WHATSAPP, M, y + 5, { width: contentW, align: "center" });
        doc.fillColor(GREY).font("Helvetica").fontSize(8)
          .text(pageNum + " de " + totalPages, M, y + 5, { width: contentW, align: "right" });
      }

      // Dibuja la decoración de página y devuelve la Y donde empiezan las filas.
      function drawPageFurniture(pageNum) {
        drawHeader();
        drawResumen(M + HEADER_H + 8);
        if (pageNum === 1 && showGroupSummary) {
          drawGroupSummary(baseFurnitureBottom);
          drawColHeader(colHdrY1);
          drawFooter(pageNum);
          return tableTop1;
        }
        drawColHeader(colHdrYN);
        drawFooter(pageNum);
        return tableTopN;
      }

      // Render paginado
      let pageNum = 1;
      let y = drawPageFurniture(pageNum);
      let placed = 0;
      let cap = rowsPerPage1;

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
        if (placed >= cap) {
          doc.addPage();
          pageNum += 1;
          y = drawPageFurniture(pageNum);
          placed = 0;
          cap = rowsPerPageN;
        }
        drawRow(item);
        placed += 1;
      }

      if (items.length === 0) {
        doc.fillColor(GREY).font("Helvetica").fontSize(11)
          .text("Sin unidades cargadas para este proyecto.", M, y + 10, { width: contentW });
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
  groupSummary,
  applyDefaults,
  money,
  floorFromUnidad,
  loadLogo,
  SCHEMES,
  CRUX_DEFAULTS,
};
