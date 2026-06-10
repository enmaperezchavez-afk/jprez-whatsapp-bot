// ============================================
// Tests Hotfix-31 — sheets-writer headers dinámicos
// ============================================
// Bug: findUnitRow asumía headers en fila 1 y unidad_id en columna A.
// El Sheet real del Director tiene títulos/notas en filas previas
// (Hotfix-29 arregló el READER con findHeaderRowIndex pero el WRITER
// quedó con el supuesto viejo) — todos los comandos supervisor de
// escritura fallaban contra el Sheet real.

import { describe, it, expect } from "vitest";
import { findUnitRow, colIndexToLetter } from "../src/inventory/sheets-writer.js";

// Mock mínimo del cliente Sheets: batchGet devuelve las filas dadas.
function mockSheets(rows) {
  return {
    spreadsheets: {
      values: {
        batchGet: async () => ({ data: { valueRanges: [{ values: rows }] } }),
      },
    },
  };
}

describe("findUnitRow — detección dinámica de headers (Hotfix-31)", () => {
  it("Sheet legacy: headers en fila 1, unidad_id en columna A", async () => {
    const rows = [
      ["unidad_id", "estado", "precio_usd"],
      ["A-101", "disponible", "95000"],
      ["A-102", "reservado", "98000"],
    ];
    const found = await findUnitRow(mockSheets(rows), "sheet-id", "PR3", "A-102");
    expect(found).not.toBeNull();
    expect(found.rowNumber).toBe(3); // 1-indexed para Sheets
    expect(found.headers).toEqual(["unidad_id", "estado", "precio_usd"]);
    expect(found.rowValues[1]).toBe("reservado");
  });

  it("Sheet real: títulos y fila vacía antes de los headers", async () => {
    const rows = [
      ["INVENTARIO PR3 — Constructora JPREZ"],
      [],
      ["nota: precios en USD"],
      ["unidad_id", "estado", "precio_usd"],
      ["A-101", "disponible", "95000"],
      ["B-201", "vendido", "120000"],
    ];
    const found = await findUnitRow(mockSheets(rows), "sheet-id", "PR3", "B-201");
    expect(found).not.toBeNull();
    expect(found.rowNumber).toBe(6);
    expect(found.rowValues[2]).toBe("120000");
  });

  it("unidad_id NO en columna A (Director reordenó columnas)", async () => {
    const rows = [
      ["Título del tab"],
      ["estado", "unidad_id", "precio_usd"],
      ["disponible", "A-101", "95000"],
    ];
    const found = await findUnitRow(mockSheets(rows), "sheet-id", "PR3", "A-101");
    expect(found).not.toBeNull();
    expect(found.rowNumber).toBe(3);
    expect(found.rowValues[0]).toBe("disponible");
  });

  it("unidad no existente → null", async () => {
    const rows = [
      ["unidad_id", "estado"],
      ["A-101", "disponible"],
    ];
    const found = await findUnitRow(mockSheets(rows), "sheet-id", "PR3", "Z-999");
    expect(found).toBeNull();
  });

  it("tab sin fila de headers reconocible → null (defensa)", async () => {
    const rows = [["solo", "texto"], ["sin", "headers"]];
    const found = await findUnitRow(mockSheets(rows), "sheet-id", "PR3", "A-101");
    expect(found).toBeNull();
  });

  it("trim de unitId y de celdas (espacios accidentales del Sheet)", async () => {
    const rows = [
      ["unidad_id", "estado"],
      [" A-101 ", "disponible"],
    ];
    const found = await findUnitRow(mockSheets(rows), "sheet-id", "PR3", "A-101 ");
    expect(found).not.toBeNull();
    expect(found.rowNumber).toBe(2);
  });
});

describe("colIndexToLetter (sanity)", () => {
  it("convierte índices a letras de columna Sheets", () => {
    expect(colIndexToLetter(0)).toBe("A");
    expect(colIndexToLetter(1)).toBe("B");
    expect(colIndexToLetter(25)).toBe("Z");
    expect(colIndexToLetter(26)).toBe("AA");
  });
});
