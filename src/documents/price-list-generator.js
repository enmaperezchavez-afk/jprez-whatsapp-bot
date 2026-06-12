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
const { getTheme } = require("./project-themes");

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
  crux_t6: { sep: 0.05, comp: 0.25, saldo: 0.70 }, // Hotfix-33: base 5/25/70 (Doctrina v1.1)
  crux_listos: null,
};

// inicio_construccion sigue viviendo en PROJECT_META y en el parser del Sheet
// (META tab → inv.meta) por compatibilidad de data, pero F4 lo sacó del banner
// del header del PDF (decisión del Director: queda solo "ENTREGA").
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
    } catch (e) {
      // Hotfix-31: el archivo EXISTE pero no se pudo leer (permisos,
      // corrupto). Antes se silenciaba y el PDF salía con wordmark de
      // texto sin pista alguna en Axiom de por qué.
      botLog("warn", "price_list_logo_load_failed", { proyectoId, logo: key, path: p, error: e.message });
    }
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
      { label: "Separación " + Math.round(scheme.sep * 100) + "%", w: 1.2, align: "right", get: (u) => money(priceOf(u) != null ? priceOf(u) * scheme.sep : null, cur) },
      { label: "Completivo " + Math.round(scheme.comp * 100) + "%", w: 1.2, align: "right", get: (u) => money(priceOf(u) != null ? priceOf(u) * scheme.comp : null, cur) },
      { label: "Saldo " + Math.round(scheme.saldo * 100) + "%", w: 1.2, align: "right", get: (u) => money(priceOf(u) != null ? priceOf(u) * scheme.saldo : null, cur) },
      colArea, colHab, colBano, colEstatus,
    ];
  } else if (proyectoId === "crux_t6") {
    cols = [
      { label: "Apartamento", w: 0.8, align: "left", get: (u) => u.unidad_id || "—" },
      colPrecio,
      { label: "Separación " + Math.round(scheme.sep * 100) + "%", w: 1.1, align: "right", get: (u) => money(priceOf(u) != null ? priceOf(u) * scheme.sep : null, cur) },
      { label: "Completivo " + Math.round(scheme.comp * 100) + "%", w: 1.1, align: "right", get: (u) => money(priceOf(u) != null ? priceOf(u) * scheme.comp : null, cur) },
      { label: "Saldo " + Math.round(scheme.saldo * 100) + "%", w: 1.1, align: "right", get: (u) => money(priceOf(u) != null ? priceOf(u) * scheme.saldo : null, cur) },
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
      const theme = getTheme(proyectoId);
      const hasEncargos = units.some((u) => u.numero_encargos);
      const columns = columnsFor(proyectoId, { hasEncargos });
      const groups = groupUnits(proyectoId, units);
      const counts = statusCounts(units);
      const total = units.length;
      const pctVentas = total > 0 ? Math.round(((total - counts.disponible) / total) * 100) : 0;
      const entrega = (meta && meta.entrega_fecha) || "";
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

      // F4: register fonts custom (Montserrat) si el theme los requiere.
      // PDFKit acepta TTF embedded; el archivo viaja en el bundle Vercel
      // via includeFiles "src/documents/fonts/**".
      const FONTS_DIR = path.join(__dirname, "fonts");
      const TITLE_FONT_PATH = theme.fonts.title === "Montserrat-Bold"
        ? path.join(FONTS_DIR, "Montserrat-Bold.ttf") : null;
      if (TITLE_FONT_PATH && fs.existsSync(TITLE_FONT_PATH)) {
        try { doc.registerFont("Montserrat-Bold", TITLE_FONT_PATH); }
        catch (e) { botLog("warn", "price_list_font_register_failed", { error: e.message }); }
      }

      const M = doc.page.margins.left;
      const pageW = doc.page.width;
      const pageH = doc.page.height;
      const contentW = pageW - M * 2;
      const layout = theme.layout || {};

      // Alturas de layout — header crece si el theme lo pide (mapa, etc).
      const HEADER_H = layout.headerHeight || 60;
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

      // F4 helpers — primitivas reutilizables del nuevo layout (pin SVG,
      // donut de progreso, barra horizontal, imagen con clipping circular).
      // PDFKit soporta doc.path() con sintaxis SVG y doc.clip() para masks.
      function drawPin(cx, cy, h, color) {
        const r = h * 0.32;
        const headCy = cy - h + r;
        doc.save();
        doc.circle(cx, headCy, r).fillColor(color).fill();
        doc.moveTo(cx - r * 0.7, headCy + r * 0.55).lineTo(cx, cy).lineTo(cx + r * 0.7, headCy + r * 0.55).fillColor(color).fill();
        doc.circle(cx, headCy, r * 0.38).fillColor("#FFFFFF").fill();
        doc.restore();
      }
      function drawCircularImage(buf, cx, cy, r) {
        doc.save();
        doc.circle(cx, cy, r).clip();
        doc.image(buf, cx - r, cy - r, { width: r * 2, height: r * 2 });
        doc.restore();
      }
      function drawDonut(cx, cy, rOuter, rInner, pct, fgColor, trackColor) {
        doc.save();
        doc.circle(cx, cy, rOuter).fillColor(trackColor).fill();
        doc.restore();
        if (pct > 0 && pct < 100) {
          const a0 = -Math.PI / 2;
          const a1 = a0 + (pct / 100) * Math.PI * 2;
          const x0 = cx + rOuter * Math.cos(a0), y0 = cy + rOuter * Math.sin(a0);
          const x1 = cx + rOuter * Math.cos(a1), y1 = cy + rOuter * Math.sin(a1);
          const xi0 = cx + rInner * Math.cos(a0), yi0 = cy + rInner * Math.sin(a0);
          const xi1 = cx + rInner * Math.cos(a1), yi1 = cy + rInner * Math.sin(a1);
          const large = pct > 50 ? 1 : 0;
          const path = `M ${x0} ${y0} A ${rOuter} ${rOuter} 0 ${large} 1 ${x1} ${y1} L ${xi1} ${yi1} A ${rInner} ${rInner} 0 ${large} 0 ${xi0} ${yi0} Z`;
          doc.save();
          doc.path(path).fillColor(fgColor).fill();
          doc.restore();
        } else if (pct >= 100) {
          doc.save();
          doc.circle(cx, cy, rOuter).fillColor(fgColor).fill();
          doc.restore();
        }
        doc.save();
        doc.circle(cx, cy, rInner).fillColor("#FFFFFF").fill();
        doc.restore();
      }
      function drawProgressBar(x, y, w, h, pct, fgColor, trackColor) {
        doc.save();
        doc.rect(x, y, w, h).fillColor(trackColor).fill();
        if (pct > 0) {
          const fillW = Math.max(2, w * Math.min(pct, 100) / 100);
          doc.rect(x, y, fillW, h).fillColor(fgColor).fill();
        }
        doc.restore();
      }
      // F4: sombras manuales (PDFKit no tiene blur). Apilamos rects/circles
      // semi-transparentes con expansión progresiva para simular un drop
      // shadow estilo Material/CSS. El elemento real se dibuja DESPUÉS de
      // estos helpers; el centro queda cubierto y solo se ve la periferia.
      function drawRectShadow(x, y, w, h, opts) {
        opts = opts || {};
        const blur = opts.blur || 6;
        const offsetY = opts.offsetY || 3;
        const alpha = opts.alpha || 0.22;
        doc.save();
        for (let i = blur; i >= 0; i--) {
          doc.opacity(alpha / blur);
          doc.rect(x - i, y + offsetY, w + 2 * i, h + i).fillColor("#000000").fill();
        }
        doc.opacity(1);
        doc.restore();
      }
      function drawCircleShadow(cx, cy, r, opts) {
        opts = opts || {};
        const blur = opts.blur || 5;
        const offsetY = opts.offsetY || 2;
        const alpha = opts.alpha || 0.28;
        doc.save();
        for (let i = blur; i >= 0; i--) {
          doc.opacity(alpha / blur);
          doc.circle(cx, cy + offsetY, r + i).fillColor("#000000").fill();
        }
        doc.opacity(1);
        doc.restore();
      }
      function drawHorizontalShadowFade(x, y, w, opts) {
        opts = opts || {};
        const blur = opts.blur || 8;
        const alpha = opts.alpha || 0.22;
        doc.save();
        for (let i = 0; i < blur; i++) {
          doc.opacity(alpha * (1 - i / blur));
          doc.rect(x, y + i, w, 1).fillColor("#000000").fill();
        }
        doc.opacity(1);
        doc.restore();
      }

      function drawHeader() {
        if (layout.headerStyle === "white") {
          drawHeaderWhite();
        } else {
          drawHeaderClassic();
        }
        if (layout.bandTop) {
          drawBand(0, layout.bandHeight || 6);
        }
        // F4: sombra horizontal debajo del bloque del header — separa la
        // franja del header del cuerpo blanco del PDF. Solo headerStyle white.
        if (layout.headerStyle === "white") {
          drawHorizontalShadowFade(0, M + HEADER_H, pageW, { blur: 8, alpha: 0.22 });
        }
      }
      // F4: banda de marca (top o bottom). Si bandColor es un array, dibuja
      // un linearGradient horizontal con stops uniformemente espaciados.
      // PDFKit soporta linearGradient(x0,y0,x1,y1).stop(pct, color).
      function drawBand(yStart, h) {
        const c = layout.bandColor || theme.palette.accent;
        doc.save();
        if (Array.isArray(c) && c.length > 1) {
          const grad = doc.linearGradient(0, yStart, pageW, yStart);
          c.forEach((col, idx) => grad.stop(idx / (c.length - 1), col));
          doc.rect(0, yStart, pageW, h).fill(grad);
        } else {
          doc.rect(0, yStart, pageW, h).fillColor(Array.isArray(c) ? c[0] : c).fill();
        }
        doc.restore();
      }

      function drawHeaderClassic() {
        doc.rect(0, 0, pageW, M + HEADER_H).fill(theme.palette.headerBg);
        doc.fillColor(theme.palette.accent).font(theme.fonts.bodyBold).fontSize(9).text("JPREZ", M, M - 4);
        doc.fillColor(theme.palette.headerText).font(theme.fonts.title).fontSize(15)
          .text(displayTitle, M, M + 8, { width: contentW * 0.72 });
        const infoBits = ["LISTADO DE PRECIOS"];
        if (entrega) infoBits.push("ENTREGA: " + entrega);
        doc.fillColor(theme.palette.subText).font(theme.fonts.body).fontSize(8.5)
          .text(infoBits.join("   ·   "), M, M + 32, { width: contentW * 0.72 });
        if (logoBuf) {
          try {
            doc.image(logoBuf, pageW - M - 150, M - 4, { fit: [150, 46], align: "right", valign: "center" });
          } catch (e) {
            botLog("warn", "price_list_logo_render_failed", { proyectoId, error: e.message });
            doc.fillColor(theme.palette.accent).font(theme.fonts.bodyBold).fontSize(11)
              .text(ubicacion, M, M + 12, { width: contentW, align: "right" });
          }
        } else {
          doc.fillColor(theme.palette.accent).font(theme.fonts.bodyBold).fontSize(11)
            .text(ubicacion, M, M + 12, { width: contentW, align: "right" });
        }
      }

      function drawHeaderWhite() {
        // F4: fondo suave de la franja del header (color por proyecto).
        // Cubre desde y=0 hasta el final del header — las cards de abajo no
        // se tocan. La banda de marca (red/turquoise) se pinta DESPUÉS en
        // drawHeader() para quedar encima de este bg.
        doc.save();
        doc.rect(0, 0, pageW, M + HEADER_H).fillColor(theme.palette.headerBg || "#FFFFFF").fill();
        doc.restore();
        doc.fillColor(theme.palette.accent).font(theme.fonts.bodyBold).fontSize(9)
          .text("JPREZ", M, M + 6);
        // F4: soporte para resaltar la última palabra del título en el accent
        // (ej: "PRADO RESIDENCES IV" → "IV" en rojo). Si layout.titleHighlightWord
        // matchea el final del título, lo separamos en dos doc.text() con
        // continued:true (cursor mantiene posición horizontal).
        const hw = layout.titleHighlightWord;
        if (hw && displayTitle.endsWith(" " + hw)) {
          const mainPart = displayTitle.slice(0, displayTitle.length - hw.length);
          doc.fillColor(theme.palette.headerText).font(theme.fonts.title).fontSize(18)
            .text(mainPart, M, M + 16, { width: contentW * 0.60, continued: true })
            .fillColor(theme.palette.accent)
            .text(hw, { continued: false });
        } else {
          doc.fillColor(theme.palette.headerText).font(theme.fonts.title).fontSize(18)
            .text(displayTitle, M, M + 16, { width: contentW * 0.60 });
        }
        const infoBits = ["LISTADO DE PRECIOS"];
        if (entrega) infoBits.push("ENTREGA: " + entrega);
        doc.fillColor(theme.palette.subText).font(theme.fonts.body).fontSize(8.5)
          .text(infoBits.join("   ·   "), M, M + 42, { width: contentW * 0.60 });
        // Pin + dirección.
        if (layout.address) {
          const pinX = M + 5, pinY = M + 70;
          drawPin(pinX, pinY, 12, theme.palette.accent);
          doc.fillColor(theme.palette.headerText).font(theme.fonts.body).fontSize(8.5)
            .text(layout.address, M + 16, pinY - 9, { width: contentW * 0.60 });
        }
        // Mapa circular a la izquierda del logo.
        const mapD = layout.mapDiameter || 90;
        const mapR = mapD / 2;
        let mapBuf = null;
        if (layout.mapKey) {
          for (const ext of ["png", "jpg", "jpeg"]) {
            const p = path.join(LOGOS_DIR, layout.mapKey + "." + ext);
            try { if (fs.existsSync(p)) { mapBuf = fs.readFileSync(p); break; } } catch (e) { /* skip */ }
          }
        }
        const logoW = layout.logoWidth || 150;
        const logoH = layout.logoHeight || 46;
        const logoX = pageW - M - logoW;
        const logoY = M + (HEADER_H - logoH) / 2;
        const mapPad = 14;
        const mapCx = logoX - mapPad - mapR;
        const mapCy = M + HEADER_H / 2;
        if (mapBuf) {
          try {
            // F4: sombra circular debajo del mapa para efecto de relieve.
            drawCircleShadow(mapCx, mapCy, mapR, { blur: 6, offsetY: 2, alpha: 0.28 });
            drawCircularImage(mapBuf, mapCx, mapCy, mapR);
          } catch (e) { botLog("warn", "price_list_map_render_failed", { proyectoId, error: e.message }); }
        }
        if (logoBuf) {
          try {
            doc.image(logoBuf, logoX, logoY, { fit: [logoW, logoH], align: "right", valign: "center" });
          } catch (e) {
            botLog("warn", "price_list_logo_render_failed", { proyectoId, error: e.message });
            doc.fillColor(theme.palette.accent).font(theme.fonts.bodyBold).fontSize(11)
              .text(ubicacion, M, M + 12, { width: contentW, align: "right" });
          }
        }
      }

      function drawResumen(y) {
        const cells = [
          { label: "Disponibles", value: counts.disponible, accent: theme.statusColors.disponible, bgColor: theme.statusColors.disponible, kind: "stat" },
          { label: "Reservados",  value: counts.reservado,  accent: theme.statusColors.reservado,  bgColor: theme.statusColors.reservado,  kind: "stat" },
          { label: "Vendidos",    value: counts.vendido,    accent: theme.statusColors.vendido,    bgColor: theme.statusColors.vendido,    kind: "stat" },
          { label: "Bloqueados",  value: counts.bloqueado,  accent: theme.statusColors.bloqueado,  bgColor: theme.statusColors.bloqueado,  kind: "stat" },
          { label: "Total",       value: total,             accent: theme.palette.totalAccent || theme.palette.headerBg, bgColor: theme.palette.summaryTotalBg, kind: "stat" },
          {
            label:   "% Ventas",
            value:   pctVentas + "%",
            accent:  theme.palette.pctAccent || theme.palette.accent,
            bgColor: theme.palette.summaryPctBg,
            kind:    layout.donutPctVentas ? "donut" : "stat",
          },
        ];
        const cw = contentW / cells.length;
        const isElegant = layout.cardStyle === "elegant";
        cells.forEach((cell, i) => {
          const x = M + i * cw;
          const cw4 = cw - 4;
          if (isElegant) {
            drawCardElegant(x, y, cw4, cell);
          } else if (cell.kind === "donut") {
            drawCardDonutClassic(x, y, cw4, cell);
          } else {
            drawCardStatClassic(x, y, cw4, cell);
          }
        });
      }

      function drawCardElegant(x, y, w, cell) {
        // 0. Sombra de relieve (F4) — drop shadow debajo de la card.
        drawRectShadow(x, y, w, RESUMEN_H, { blur: 7, offsetY: 3, alpha: 0.24 });
        // 1. Fondo blanco.
        doc.save();
        doc.rect(x, y, w, RESUMEN_H).fillColor(theme.palette.cardBg || "#FFFFFF").fill();
        doc.restore();
        // 2. Borde 2.5px del color (stroke centrado en el path → inset 1.25).
        doc.save();
        doc.lineWidth(2.5).rect(x + 1.25, y + 1.25, w - 2.5, RESUMEN_H - 2.5).stroke(cell.accent);
        doc.restore();
        // 3. Barra lateral izquierda 6px (encima del borde).
        doc.save();
        doc.rect(x, y, 6, RESUMEN_H).fillColor(cell.accent).fill();
        doc.restore();
        const contentX = x + 6;
        const contentW2 = w - 6;
        if (cell.kind === "donut") {
          const cx = contentX + contentW2 / 2;
          const cy = y + 20;
          drawDonut(cx, cy, 16, 10, pctVentas, cell.accent, theme.palette.donutTrackBg || "#F3F4F6");
          doc.fillColor(cell.accent).font(theme.fonts.bodyBold).fontSize(9)
            .text(pctVentas + "%", contentX, cy - 4, { width: contentW2, align: "center" });
          doc.fillColor(theme.palette.cardLabel || "#4A4A4A").font(theme.fonts.body).fontSize(8)
            .text(cell.label, contentX, y + 38, { width: contentW2, align: "center" });
        } else {
          // Número grande en el color del accent + label gris debajo.
          doc.fillColor(cell.accent).font(theme.fonts.bodyBold).fontSize(18)
            .text(String(cell.value), contentX, y + 10, { width: contentW2, align: "center" });
          doc.fillColor(theme.palette.cardLabel || "#4A4A4A").font(theme.fonts.body).fontSize(8)
            .text(cell.label, contentX, y + 33, { width: contentW2, align: "center" });
        }
      }

      function drawCardDonutClassic(x, y, w, cell) {
        doc.rect(x, y, w, RESUMEN_H).fill("#FFFFFF");
        doc.rect(x, y, w, RESUMEN_H).lineWidth(0.5).stroke(theme.palette.border);
        const cx = x + w / 2, cy = y + 20;
        drawDonut(cx, cy, 16, 10, pctVentas, theme.palette.accent, theme.palette.donutTrackBg || "#F3F4F6");
        doc.fillColor(theme.palette.headerText || theme.palette.headerBg).font(theme.fonts.bodyBold).fontSize(9)
          .text(pctVentas + "%", x, cy - 4, { width: w, align: "center" });
        doc.fillColor(theme.palette.statLabelText || theme.palette.footerSideText).font(theme.fonts.body).fontSize(8)
          .text(cell.label, x, y + 38, { width: w, align: "center" });
      }

      function drawCardStatClassic(x, y, w, cell) {
        doc.rect(x, y, w, RESUMEN_H).fill(cell.bgColor);
        doc.rect(x, y, w, RESUMEN_H).lineWidth(0.5).stroke(theme.palette.border);
        doc.fillColor(theme.palette.headerBg).font(theme.fonts.bodyBold).fontSize(16)
          .text(String(cell.value), x, y + 12, { width: w, align: "center" });
        doc.fillColor(theme.palette.statLabelText || theme.palette.footerSideText).font(theme.fonts.body).fontSize(8)
          .text(cell.label, x, y + 33, { width: w, align: "center" });
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

        doc.fillColor(theme.palette.groupRowText || theme.palette.headerBg).font(theme.fonts.bodyBold).fontSize(8.5)
          .text("RESUMEN DE INVENTARIO POR " + grpLabel.toUpperCase(), M, y, { width: contentW });
        let ry = y + 12;
        // header
        doc.rect(M, ry, contentW, GS_ROW_H).fill(theme.palette.tableHeaderBg);
        doc.fillColor(theme.palette.tableHeaderText).font(theme.fonts.bodyBold).fontSize(7);
        gsCols.forEach((c, i) => doc.text(c.label, gsX[i] + 3, ry + 3, { width: gsW(i) - 6, align: c.align, ellipsis: true }));
        ry += GS_ROW_H;
        // rows
        gsRows.forEach((r) => {
          const bg = r.isTotal ? theme.palette.summaryTotalBg : "#ffffff";
          doc.rect(M, ry, contentW, GS_ROW_H).fill(bg);
          doc.rect(M, ry, contentW, GS_ROW_H).lineWidth(0.3).stroke(theme.palette.border);
          doc.fillColor(r.isTotal ? (theme.palette.groupRowText || theme.palette.headerBg) : theme.palette.cellTextDim).font(r.isTotal ? theme.fonts.bodyBold : theme.fonts.body).fontSize(7);
          gsCols.forEach((c, i) => {
            // Si el theme pide barras de progreso, la columna "pct" se renderiza
            // como progress bar horizontal en lugar de texto.
            if (c.key === "pct" && layout.progressBarsByGroup) {
              const barPad = 3, barH = GS_ROW_H - 6;
              const barX = gsX[i] + barPad, barY = ry + (GS_ROW_H - barH) / 2;
              const barW = gsW(i) - barPad * 2 - 22; // reserva 22px para texto a la derecha
              drawProgressBar(barX, barY, barW, barH, r.pct, theme.palette.accent, theme.palette.donutTrackBg || "#F3F4F6");
              doc.fillColor(r.isTotal ? theme.palette.headerBg : theme.palette.cellTextDim).font(r.isTotal ? theme.fonts.bodyBold : theme.fonts.body).fontSize(7)
                .text(r.pct + "%", barX + barW + 2, ry + 3, { width: 20, align: "left" });
              return;
            }
            let v = r[c.key];
            if (c.key === "pct") v = v + "%";
            if (c.key !== "label" && c.key !== "pct" && v === 0) v = "";
            doc.text(String(v), gsX[i] + 3, ry + 3, { width: gsW(i) - 6, align: c.align, ellipsis: true });
          });
          ry += GS_ROW_H;
        });
      }

      function drawColHeader(y) {
        doc.rect(M, y, contentW, COLHDR_H).fill(theme.palette.tableHeaderBg);
        doc.fillColor(theme.palette.tableHeaderText).font(theme.fonts.bodyBold).fontSize(7.5);
        columns.forEach((c, i) => {
          doc.text(c.label, colX[i] + 3, y + 6, { width: colWidth(i) - 6, align: c.align, ellipsis: true });
        });
      }

      function drawFooter(pageNum) {
        const y = pageH - M - FOOTER_H;
        if (layout.footerStyle === "dark") {
          // Fondo oscuro full-width (toca los bordes laterales para anclar
          // visualmente la banda roja del bottom).
          doc.save();
          doc.rect(0, y - 3, pageW, FOOTER_H + 3 + M).fillColor(theme.palette.footerBg).fill();
          doc.restore();
          doc.fillColor(theme.palette.footerSideText).font(theme.fonts.body).fontSize(8)
            .text("Actualizado al " + fmtFechaEs(new Date()), M, y + 5, { width: contentW * 0.4, align: "left" });
          // Línea central: ubicación + "WhatsApp ventas:" en blanco, número en
          // verde Brand Book. Layout manual via widthOfString para centrar el
          // bloque completo, después doc.text con coords explícitas por color.
          doc.font(theme.fonts.bodyBold).fontSize(8);
          const fLeft = ubicacion + "   ·   WhatsApp ventas: ";
          const fRight = VENTAS_WHATSAPP;
          const wLeft = doc.widthOfString(fLeft);
          const wRight = doc.widthOfString(fRight);
          const startX = M + (contentW - (wLeft + wRight)) / 2;
          doc.fillColor(theme.palette.footerCenter)
            .text(fLeft, startX, y + 5, { lineBreak: false });
          doc.fillColor(theme.palette.whatsappColor || "#25D366")
            .text(fRight, startX + wLeft, y + 5, { lineBreak: false });
          doc.fillColor(theme.palette.footerSideText).font(theme.fonts.body).fontSize(8)
            .text(pageNum + " de " + totalPages, M, y + 5, { width: contentW, align: "right" });
        } else {
          doc.rect(M, y, contentW, 0.5).fill(theme.palette.border);
          doc.fillColor(theme.palette.footerSideText).font(theme.fonts.body).fontSize(8)
            .text("Actualizado al " + fmtFechaEs(new Date()), M, y + 5, { width: contentW * 0.4, align: "left" });
          doc.fillColor(theme.palette.footerCenter).font(theme.fonts.bodyBold).fontSize(8)
            .text(ubicacion + "   ·   WhatsApp ventas: " + VENTAS_WHATSAPP, M, y + 5, { width: contentW, align: "center" });
          doc.fillColor(theme.palette.footerSideText).font(theme.fonts.body).fontSize(8)
            .text(pageNum + " de " + totalPages, M, y + 5, { width: contentW, align: "right" });
        }
        if (layout.bandBottom) {
          const bh = layout.bandHeight || 6;
          drawBand(pageH - bh, bh);
        }
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
          doc.rect(M, y, contentW, ROW_H).fill(theme.palette.groupRowBg);
          // Texto del separador: usa groupRowText (semántico). Fallback a
          // headerBg por retro-compat con _CORE (navy = #1a2b4a sobre bg
          // claro funciona OK).
          doc.fillColor(theme.palette.groupRowText || theme.palette.headerBg).font(theme.fonts.bodyBold).fontSize(9)
            .text(item.label, M + 6, y + 3, { width: contentW - 12 });
        } else {
          const u = item.unit;
          const stColor = theme.statusColors[u.estado];
          if (layout.rowStyle === "white-with-bar") {
            // Premium magazine look: bg blanco, barra lateral 3px en el color
            // de estado, texto rowText. La columna "Estatus" se pinta en el
            // color accent para identificar el estado de un vistazo.
            doc.rect(M, y, contentW, ROW_H).fillColor(theme.palette.rowBg || "#FFFFFF").fill();
            if (stColor) doc.rect(M, y, 3, ROW_H).fillColor(stColor).fill();
            doc.font(theme.fonts.body).fontSize(7);
            columns.forEach((c, i) => {
              const isStatusCol = (c.label === "Estatus");
              doc.fillColor(isStatusCol && stColor ? stColor : theme.palette.rowText);
              doc.text(String(c.get(u)), colX[i] + 3, y + 3.5, { width: colWidth(i) - 6, align: c.align, ellipsis: true });
            });
          } else {
            const bg = stColor || "#ffffff";
            doc.rect(M, y, contentW, ROW_H).fill(bg);
            doc.fillColor(theme.palette.rowText).font(theme.fonts.body).fontSize(7);
            columns.forEach((c, i) => {
              doc.text(String(c.get(u)), colX[i] + 3, y + 3.5, { width: colWidth(i) - 6, align: c.align, ellipsis: true });
            });
          }
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
        doc.fillColor(theme.palette.footerSideText).font(theme.fonts.body).fontSize(11)
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
