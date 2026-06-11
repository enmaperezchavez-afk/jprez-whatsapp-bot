// Sprint 1 PR-1 — tasa USD/DOP (BCRD): parser puro.
//
// Molde icdv-parser.test.mjs: el núcleo frágil (zip + XML + normalización
// de meses sucios) se blinda con fixtures que replican el shape EXACTO
// del TASA_DOLAR_REFERENCIA_MC.xlsx real, incluyendo sus datos sucios
// ("Jul "/"Ene " con espacio, "Aug" en inglés).

import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import {
  buildZip,
  buildXlsxFixture,
  rowXml,
  HEADER_ROWS,
  sharedStringsXml,
  WORKBOOK_XML,
} from "./helpers/mini-xlsx.mjs";

const require = createRequire(import.meta.url);
const parser = require("../src/services/tasa-parser.js");

// Índices en SHARED_STRINGS_BCRD: 5=Ene ... 16=Dic, 32="Jul ", 33="Ene ", 34="Aug"
const JUN = 10;
const MAY = 9;

function fixtureBasica() {
  // 5 días laborables de mayo-junio 2026 con cifras reales del BCRD.
  const rows =
    HEADER_ROWS +
    rowXml(4, 2026, MAY, 28, 58.1458, 58.59) +
    rowXml(5, 2026, MAY, 29, 57.8347, 58.7048) +
    rowXml(6, 2026, JUN, 8, 58.1102, 59.0332) +
    rowXml(7, 2026, JUN, 9, 58.4112, 58.9825) +
    rowXml(8, 2026, JUN, 10, 58.5264, 59.3263);
  return buildXlsxFixture(rows);
}

describe("TASA — mini-lector zip (extractZipEntries)", () => {
  it("lee entradas deflate (method 8) y stored (method 0)", () => {
    for (const method of [8, 0]) {
      const zip = buildZip([
        { name: "a.xml", data: "<a>hola</a>", method },
        { name: "dir/b.xml", data: "<b>año</b>", method },
      ]);
      const entries = parser.extractZipEntries(zip);
      expect(entries.get("a.xml").toString("utf8")).toBe("<a>hola</a>");
      expect(entries.get("dir/b.xml").toString("utf8")).toBe("<b>año</b>");
    }
  });

  it("rechaza buffers que no son zip (fail-closed)", () => {
    expect(() => parser.extractZipEntries(Buffer.from("<html>error</html>"))).toThrow(/PK/i);
    expect(() => parser.extractZipEntries(Buffer.alloc(0))).toThrow();
  });

  it("rechaza zip truncado sin EOCD", () => {
    const zip = buildZip([{ name: "a.xml", data: "<a/>" }]);
    expect(() => parser.extractZipEntries(zip.subarray(0, zip.length - 30))).toThrow(
      /central directory/i
    );
  });
});

describe("TASA — parseWorkbook (pipeline completo)", () => {
  it("extrae la serie de la hoja Diaria, más reciente primero", () => {
    const { latest, serie, total_filas_archivo } = parser.parseWorkbook(fixtureBasica());
    expect(total_filas_archivo).toBe(5);
    expect(serie).toHaveLength(5);
    expect(serie[0].fecha).toBe("2026-06-10");
    expect(serie[4].fecha).toBe("2026-05-28");
    expect(latest.fecha).toBe("2026-06-10");
    expect(latest.compra).toBe(58.5264);
    expect(latest.venta).toBe(59.3263);
    expect(latest.promedio).toBe(58.9264); // (58.5264+59.3263)/2 redondeado a 4
  });

  it("salta título/headers/filas incompletas sin romper", () => {
    const { serie } = parser.parseWorkbook(fixtureBasica());
    // Las 3 filas de cabecera del fixture no aparecen como datos.
    expect(serie.every((e) => e.anio === 2026)).toBe(true);
  });

  it("latest trae var_dia_pct vs día anterior", () => {
    const { latest } = parser.parseWorkbook(fixtureBasica());
    // 59.3263 / 58.9825 - 1 = 0.5829%
    expect(latest.var_dia_pct).toBeCloseTo(0.5829, 3);
  });

  it("respeta el cap de días de la serie (dias)", () => {
    const { serie, total_filas_archivo } = parser.parseWorkbook(fixtureBasica(), { dias: 2 });
    expect(total_filas_archivo).toBe(5);
    expect(serie).toHaveLength(2);
    expect(serie[0].fecha).toBe("2026-06-10");
    expect(serie[1].fecha).toBe("2026-06-09");
  });

  it("meses sucios del BCRD: 'Jul ' (idx 32), 'Ene ' (33) y 'Aug' (34) parsean", () => {
    const rows =
      rowXml(4, 2025, 32, 15, 60.1, 61.2) + // "Jul "
      rowXml(5, 2026, 33, 20, 62.3, 63.4) + // "Ene "
      rowXml(6, 2025, 34, 5, 59.5, 60.6); // "Aug" -> agosto
    const { serie } = parser.parseWorkbook(buildXlsxFixture(rows));
    const fechas = serie.map((e) => e.fecha);
    expect(fechas).toContain("2025-07-15");
    expect(fechas).toContain("2026-01-20");
    expect(fechas).toContain("2025-08-05");
  });

  it("dedupe por fecha: la última aparición gana (rectificación BCRD)", () => {
    const rows =
      rowXml(4, 2026, JUN, 10, 58.0, 59.0) +
      rowXml(5, 2026, JUN, 10, 58.5264, 59.3263);
    const { serie } = parser.parseWorkbook(buildXlsxFixture(rows));
    expect(serie).toHaveLength(1);
    expect(serie[0].venta).toBe(59.3263);
  });

  it("encuentra la hoja Diaria por nombre aunque no sea sheet1 (workbook reordenado)", () => {
    const workbook = WORKBOOK_XML.replace('Target="worksheets/sheet1.xml"', "X"); // no usado
    const wb =
      '<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="PromMensual" sheetId="2" r:id="rId1"/><sheet name="Diaria" sheetId="1" r:id="rId2"/></sheets></workbook>';
    const rels =
      '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet2.xml"/><Relationship Id="rId2" Target="worksheets/sheet1.xml"/></Relationships>';
    const rows = HEADER_ROWS + rowXml(4, 2026, JUN, 10, 58.5264, 59.3263);
    const buf = buildXlsxFixture(rows, { workbook: wb, rels });
    const { latest } = parser.parseWorkbook(buf);
    expect(latest.fecha).toBe("2026-06-10");
    void workbook;
  });

  it("fail-closed: sin hoja Diaria -> throw", () => {
    const wb =
      '<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Otra" sheetId="1" r:id="rId1"/></sheets></workbook>';
    const buf = buildXlsxFixture(rowXml(4, 2026, JUN, 10, 58.5, 59.3), { workbook: wb });
    expect(() => parser.parseWorkbook(buf)).toThrow(/Diaria/);
  });

  it("fail-closed: hoja Diaria sin filas válidas -> throw (no servimos doc vacío)", () => {
    const buf = buildXlsxFixture(HEADER_ROWS); // solo cabeceras
    expect(() => parser.parseWorkbook(buf)).toThrow(/ninguna fila/i);
  });
});

describe("TASA — helpers", () => {
  it("mesANumero normaliza variantes del BCRD", () => {
    expect(parser.mesANumero("Ene")).toBe(1);
    expect(parser.mesANumero("Jul ")).toBe(7);
    expect(parser.mesANumero("Aug")).toBe(8);
    expect(parser.mesANumero("Dic")).toBe(12);
    expect(parser.mesANumero("???")).toBeNull();
    expect(parser.mesANumero("")).toBeNull();
  });

  it("parseSharedStrings preserva los strings con espacio final", () => {
    const xml = sharedStringsXml(["Año", "Jul ", "x & y"]);
    const out = parser.parseSharedStrings(xml);
    expect(out).toEqual(["Año", "Jul ", "x & y"]);
  });

  it("BCRD_XLSX_URL apunta al CDN estable del Banco Central", () => {
    expect(parser.BCRD_XLSX_URL).toMatch(
      /^https:\/\/cdn\.bancentral\.gov\.do\/.*TASA_DOLAR_REFERENCIA_MC\.xlsx$/
    );
  });

  it("enrichLatest: var_30d_pct usa el primer dato con fecha <= latest-30d", () => {
    const serie = [
      { fecha: "2026-06-10", venta: 59.0, compra: 58.0, promedio: 58.5 },
      { fecha: "2026-06-09", venta: 58.9, compra: 58.0, promedio: 58.45 },
      { fecha: "2026-05-08", venta: 57.0, compra: 56.5, promedio: 56.75 },
      { fecha: "2026-04-01", venta: 56.0, compra: 55.5, promedio: 55.75 },
    ];
    const latest = parser.enrichLatest(serie);
    // corte = 2026-05-11 -> primer dato <= corte es 2026-05-08 (57.0)
    expect(latest.var_30d_pct).toBeCloseTo((59.0 / 57.0 - 1) * 100, 3);
  });

  it("enrichLatest: serie de un solo día -> variaciones null (no inventa)", () => {
    const latest = parser.enrichLatest([
      { fecha: "2026-06-10", venta: 59.0, compra: 58.0, promedio: 58.5 },
    ]);
    expect(latest.var_dia_pct).toBeNull();
    expect(latest.var_30d_pct).toBeNull();
  });
});
