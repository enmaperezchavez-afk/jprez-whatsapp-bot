// tests/helpers/mini-xlsx.mjs — constructor de XLSX sintéticos para los
// tests del scraper de tasa USD/DOP (BCRD).
//
// Un XLSX es un zip de XMLs. Este helper escribe el zip a mano (local
// headers + central directory + EOCD) con builtins de Node, para que los
// tests ejerciten el mini-lector zip de tasa-parser.js en ambos métodos
// de compresión (0=stored y 8=deflate) sin dependencias ni archivos
// binarios committeados.
//
// CRC-32 se escribe en 0: el lector del repo no lo valida (lee por el
// central directory y descomprime; un CRC corrupto en origen igual
// produciría XML inválido que el parser rechaza). Excel real sí lo trae.

import zlib from "zlib";

// buildZip([{name, data, method}]) -> Buffer
// method: 0 stored | 8 deflate (default).
export function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const dataBuf = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, "utf8");
    const method = f.method ?? 8;
    const comp = method === 8 ? zlib.deflateRawSync(dataBuf) : dataBuf;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10); // time+date
    local.writeUInt32LE(0, 14); // crc (no validado por el lector)
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(dataBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12); // time+date
    central.writeUInt32LE(0, 16); // crc
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(dataBuf.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset

    locals.push(local, nameBuf, comp);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += local.length + nameBuf.length + comp.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8); // entries this disk
  eocd.writeUInt16LE(files.length, 10); // entries total
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16); // cd offset
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...locals, cd, eocd]);
}

// Shared strings reales del archivo del BCRD (incluye los sucios "Jul "
// y "Ene " con espacio final, y el "Aug" en inglés — índices 32-34).
export const SHARED_STRINGS_BCRD = [
  "Año", "Mes", "Día", "Compra", "Venta",
  "Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic",
  "Trimestre", "Enero-Marzo", "Abril-Junio", "Julio-Septiembre", "Octubre-Diciembre",
  "**Hasta el 23 de enero de 1985 existía la paridad RD$ 1.00 = US$ 1.00",
  "*Datos correspondientes al promedio simple diario en el referido período.",
  "Tasas de Cambio del dólar de Referencia del Mercado Spot",
  "Tasas de Cambio del dólar de Referencia del Mercado Spot, Promedio Mensual *",
  "Tasas de Cambio del dólar de Referencia del Mercado Spot, Promedio Trimestral*",
  "Tasas de Cambio del dólar de Referencia del Mercado Spot, Promedio Anual*",
  "Tasas de Cambio del dólar de Referencia del Mercado Spot, último día laborable del mes*",
  "*Datos correspondientes al último día laborable en el referido período.",
  "Tasas de Cambio del dólar de Referencia del Mercado Spot, último día laborable del trimestre*",
  "Tasas de Cambio del dólar de Referencia del Mercado Spot, último día laborable del año*",
  "Jul ", "Ene ", "Aug",
];

export function sharedStringsXml(strings = SHARED_STRINGS_BCRD) {
  const items = strings
    .map((s) => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${items}</sst>`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// rowXml(rowNum, anio, mesSharedIdx, dia, compra, venta) — fila con el
// shape EXACTO del sheet1.xml real del BCRD (estilos s="22" etc. variados
// en el archivo real; el parser no depende de ellos).
export function rowXml(r, anio, mesIdx, dia, compra, venta) {
  return (
    `<row r="${r}" spans="1:5">` +
    `<c r="A${r}" s="22"><v>${anio}</v></c>` +
    `<c r="B${r}" s="22" t="s"><v>${mesIdx}</v></c>` +
    `<c r="C${r}" s="30"><v>${dia}</v></c>` +
    `<c r="D${r}" s="29"><v>${compra}</v></c>` +
    `<c r="E${r}" s="43"><v>${venta}</v></c>` +
    `</row>`
  );
}

// Filas de cabecera reales (título mergeado + headers por shared string).
export const HEADER_ROWS =
  '<row r="1" spans="1:7"><c r="A1" s="50" t="s"><v>24</v></c><c r="B1" s="50"/><c r="C1" s="50"/><c r="D1" s="50"/><c r="E1" s="50"/></row>' +
  '<row r="2" spans="1:7"><c r="A2" s="51"/><c r="B2" s="51"/></row>' +
  '<row r="3" spans="1:7"><c r="A3" s="40" t="s"><v>0</v></c><c r="B3" s="40" t="s"><v>1</v></c><c r="C3" s="41" t="s"><v>2</v></c><c r="D3" s="41" t="s"><v>3</v></c><c r="E3" s="41" t="s"><v>4</v></c></row>';

export function sheetXml(rowsXml) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:K8897"/><sheetData>${rowsXml}</sheetData></worksheet>`;
}

export const WORKBOOK_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Diaria" sheetId="1" r:id="rId1"/><sheet name="PromMensual" sheetId="2" r:id="rId2"/></sheets></workbook>';

export const WORKBOOK_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>';

// buildXlsxFixture: XLSX sintético completo con filas dadas en la hoja
// Diaria. opts.method para forzar stored vs deflate.
export function buildXlsxFixture(rowsXml, { method = 8, workbook, rels, shared, extraFiles = [] } = {}) {
  return buildZip([
    { name: "xl/workbook.xml", data: workbook ?? WORKBOOK_XML, method },
    { name: "xl/_rels/workbook.xml.rels", data: rels ?? WORKBOOK_RELS_XML, method },
    { name: "xl/sharedStrings.xml", data: shared ?? sharedStringsXml(), method },
    { name: "xl/worksheets/sheet1.xml", data: sheetXml(rowsXml), method },
    { name: "xl/worksheets/sheet2.xml", data: sheetXml(""), method },
    ...extraFiles,
  ]);
}
