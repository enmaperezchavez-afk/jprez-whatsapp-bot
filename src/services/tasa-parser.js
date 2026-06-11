// src/services/tasa-parser.js — Tasa USD/DOP de referencia (BCRD), núcleo PURO.
//
// El Banco Central de la República Dominicana publica la "Tasa de Cambio
// del dólar de Referencia del Mercado Spot" como un XLSX en URL ESTABLE
// (sin slug aleatorio, a diferencia del PDF del ICDV):
//   https://cdn.bancentral.gov.do/documents/estadisticas/mercado-cambiario/
//     documents/TASA_DOLAR_REFERENCIA_MC.xlsx
// La hoja "Diaria" trae la serie COMPLETA desde 1991 (Año|Mes|Día|Compra|
// Venta), un dato por día laborable. No hace falta seed en disco ni
// acumular histórico: cada scrape trae todo.
//
// Este módulo es PURO (Buffer/string -> objeto), sin red. Usa SOLO
// builtins de Node (zlib para inflar el zip del XLSX) — cero dependencias
// nuevas, a diferencia del ICDV que necesitó pdf-parse porque parsear PDF
// a mano es inviable. Un XLSX es un zip de XMLs: el mini-lector de abajo
// (~60 líneas) lee el central directory e infla cada entrada.
//
// CONTRATO (espejo del patrón icdv-parser.js):
//   1. extractZipEntries(buffer) -> Map(path -> Buffer) del zip.
//   2. parseWorkbook(buffer, opts) -> { latest, serie } estructurado.
// La capa de red vive en tasa-scraper.js.

const zlib = require("zlib");

// Meses como los escribe el BCRD en la hoja Diaria (sharedStrings). El
// archivo real trae variantes sucias: "Jul " y "Ene " con espacio final,
// y un "Aug" en inglés. Normalizamos con trim + minúsculas + sin acentos.
const MESES_CORTOS = {
  ene: 1,
  feb: 2,
  mar: 3,
  abr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  ago: 8,
  aug: 8, // typo real del BCRD en la serie histórica
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dic: 12,
  dec: 12,
};

const BCRD_XLSX_URL =
  "https://cdn.bancentral.gov.do/documents/estadisticas/mercado-cambiario/documents/TASA_DOLAR_REFERENCIA_MC.xlsx";

// Días que conserva la serie servida. La hoja trae 35 años; al bot le
// sirven ~3 meses para "tasa de hoy" + tendencia, y el doc de Redis se
// mantiene chico.
const SERIE_DIAS_DEFAULT = 90;

function quitarAcentos(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function mesANumero(nombre) {
  const clave = quitarAcentos(nombre).toLowerCase().trim();
  return MESES_CORTOS[clave] || null;
}

// ============================================================
// MINI-LECTOR ZIP — extractZipEntries(buffer)
// ============================================================
// Camino canónico de lectura de un zip: EOCD (End of Central Directory)
// al final del archivo -> central directory -> cada entrada apunta a su
// local header. Soporta method 0 (stored) y 8 (deflate), que es todo lo
// que produce Excel. Sin zip64 (el XLSX del BCRD pesa ~350KB).
function extractZipEntries(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (buf.length < 22 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new Error("TASA parse: el buffer no es un zip/XLSX (magic PK ausente)");
  }

  // EOCD: firma 0x06054b50, buscada desde el final (el comment del zip
  // puede empujarla hasta 64KB hacia atrás).
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error("TASA parse: zip sin End of Central Directory (corrupto/truncado)");
  }

  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  const entries = new Map();
  let p = cdOffset;
  for (let n = 0; n < totalEntries; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error("TASA parse: entrada del central directory corrupta");
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    // El local header repite name/extra con longitudes PROPIAS (pueden
    // diferir de las del central directory) — los offsets de data salen
    // de ahí, no del CD.
    const lhNameLen = buf.readUInt16LE(localOffset + 26);
    const lhExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`TASA parse: método de compresión zip no soportado (${method})`);

    entries.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ============================================================
// XML helpers (regex sobre los XMLs del XLSX)
// ============================================================

// parseSharedStrings: <si><t>Año</t></si>... -> ["Año", ...]. Los <t>
// pueden traer xml:space="preserve" (los "Jul " sucios del BCRD).
function parseSharedStrings(xml) {
  const out = [];
  const re = /<si>\s*<t[^>]*>([\s\S]*?)<\/t>\s*<\/si>/g;
  let m;
  while ((m = re.exec(String(xml || ""))) !== null) {
    out.push(decodeXmlEntities(m[1]));
  }
  return out;
}

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// resolveDiariaSheetPath: workbook.xml nombra las hojas (name="Diaria"
// r:id="rId1") y workbook.xml.rels mapea rId -> worksheets/sheetN.xml.
// NUNCA asumimos que Diaria es sheet1.xml: si el BCRD reordena hojas, el
// scrape sigue apuntando a la correcta.
function resolveDiariaSheetPath(workbookXml, relsXml) {
  const wb = String(workbookXml || "");
  const mSheet = wb.match(/<sheet[^>]*name="Diaria"[^>]*r:id="([^"]+)"[^>]*\/>/i)
    || wb.match(/<sheet[^>]*r:id="([^"]+)"[^>]*name="Diaria"[^>]*\/>/i);
  if (!mSheet) {
    throw new Error('TASA parse: el workbook no tiene hoja "Diaria"');
  }
  const rid = mSheet[1];
  const re = new RegExp(`<Relationship[^>]*Id="${rid}"[^>]*Target="([^"]+)"`, "i");
  const reInv = new RegExp(`<Relationship[^>]*Target="([^"]+)"[^>]*Id="${rid}"`, "i");
  const mRel = String(relsXml || "").match(re) || String(relsXml || "").match(reInv);
  if (!mRel) {
    throw new Error(`TASA parse: rels sin target para ${rid}`);
  }
  const target = mRel[1].replace(/^\//, "");
  return target.startsWith("xl/") ? target : `xl/${target}`;
}

// parseDiariaSheet: filas <row> -> [{fecha, anio, mes, dia, compra,
// venta}] ascendente por fecha. Columnas: A=Año, B=Mes (shared string),
// C=Día, D=Compra, E=Venta. Filas de título/header/notas no tienen el
// shape completo y se saltan solas. Dedupe por fecha: la ÚLTIMA aparición
// en el archivo gana (rectificaciones del BCRD).
function parseDiariaSheet(sheetXml, sharedStrings) {
  const src = String(sheetXml || "");
  const porFecha = new Map();
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  // Celdas con valor: <c r="A4" s="22" [t="s"]><v>2026</v></c>. Los
  // atributos se parsean por separado — un grupo opcional lazy en medio
  // del regex de la celda nunca capturaría t="s" (el engine prefiere
  // saltárselo). Las celdas self-closing (<c r="B1" s="50"/>) no traen
  // valor y no matchean: correcto, se ignoran.
  const cellRe = /<c\s+([^>]*?)>(?:\s*<v>([^<]*)<\/v>\s*)?<\/c>/g;
  let rm;
  while ((rm = rowRe.exec(src)) !== null) {
    const cells = {};
    let cm;
    cellRe.lastIndex = 0;
    while ((cm = cellRe.exec(rm[1])) !== null) {
      const attrs = cm[1];
      const v = cm[2];
      if (v == null) continue;
      const mCol = attrs.match(/r="([A-Z]+)\d+"/);
      if (!mCol) continue;
      const esSharedString = /t="s"/.test(attrs);
      cells[mCol[1]] = esSharedString ? sharedStrings[parseInt(v, 10)] : v;
    }

    const anio = parseInt(cells.A, 10);
    const mes = mesANumero(cells.B);
    const dia = parseInt(cells.C, 10);
    const compra = Number(cells.D);
    const venta = Number(cells.E);
    if (
      !Number.isInteger(anio) || anio < 1980 || anio > 2200 ||
      !mes || !Number.isInteger(dia) || dia < 1 || dia > 31 ||
      !Number.isFinite(compra) || compra <= 0 ||
      !Number.isFinite(venta) || venta <= 0
    ) {
      continue; // título, header, nota al pie o fila incompleta
    }

    const fecha = `${anio}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
    porFecha.set(fecha, {
      fecha,
      anio,
      mes,
      dia,
      compra: round4(compra),
      venta: round4(venta),
      promedio: round4((compra + venta) / 2),
    });
  }
  return Array.from(porFecha.values()).sort((a, b) => a.fecha.localeCompare(b.fecha));
}

// ============================================================
// PIPELINE — parseWorkbook(buffer, { dias })
// ============================================================
// Buffer del XLSX -> { latest, serie } listo para servir. Política
// fail-closed: si falta la hoja Diaria, los XMLs no parsean o la serie
// queda vacía -> error (nunca servimos un doc vacío como si fuera dato).
function parseWorkbook(buffer, { dias = SERIE_DIAS_DEFAULT } = {}) {
  const entries = extractZipEntries(buffer);

  const workbookXml = leerEntrada(entries, "xl/workbook.xml");
  const relsXml = leerEntrada(entries, "xl/_rels/workbook.xml.rels");
  const sharedXml = entries.has("xl/sharedStrings.xml")
    ? entries.get("xl/sharedStrings.xml").toString("utf8")
    : "";

  const sheetPath = resolveDiariaSheetPath(workbookXml, relsXml);
  const sheetXml = leerEntrada(entries, sheetPath);
  const sharedStrings = parseSharedStrings(sharedXml);

  const todas = parseDiariaSheet(sheetXml, sharedStrings);
  if (!todas.length) {
    throw new Error("TASA parse: la hoja Diaria no produjo ninguna fila válida");
  }

  const serie = todas.slice(-Math.max(1, dias)).reverse(); // más reciente primero
  const latest = enrichLatest(serie);
  return { latest, serie, total_filas_archivo: todas.length };
}

function leerEntrada(entries, path) {
  if (!entries.has(path)) {
    throw new Error(`TASA parse: el XLSX no contiene ${path}`);
  }
  return entries.get(path).toString("utf8");
}

// enrichLatest: último dato + variaciones (vs día anterior y vs ~30 días
// atrás, primer dato con fecha <= latest-30d — la serie solo tiene días
// laborables, no se puede indexar por posición).
function enrichLatest(serieDesc) {
  const latest = { ...serieDesc[0] };
  const prev = serieDesc[1];
  latest.var_dia_pct = prev ? round4((latest.venta / prev.venta - 1) * 100) : null;

  const corte = restarDias(latest.fecha, 30);
  const hace30 = serieDesc.find((e) => e.fecha <= corte);
  latest.var_30d_pct = hace30 ? round4((latest.venta / hace30.venta - 1) * 100) : null;
  return latest;
}

function restarDias(fechaISO, dias) {
  const d = new Date(fechaISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

module.exports = {
  parseWorkbook,
  // etapas expuestas para test
  extractZipEntries,
  parseSharedStrings,
  resolveDiariaSheetPath,
  parseDiariaSheet,
  enrichLatest,
  // helpers
  mesANumero,
  quitarAcentos,
  round4,
  MESES_CORTOS,
  BCRD_XLSX_URL,
  SERIE_DIAS_DEFAULT,
};
