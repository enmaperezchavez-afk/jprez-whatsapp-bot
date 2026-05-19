// Hotfix-29 Bug 1 P1 (19 may 2026) — Tests detección dinámica de headers.
//
// EVIDENCIA: Director reportó "cero unidades disponibles" post-PR #46.
// ROOT CAUSE: rowsToObjects asumía tabRows[0] eran headers, pero el
// Sheet real tiene filas previas con título/notas/separadores. La fila
// real de headers (con "unidad_id") podía estar en row 3, 5, etc.
//
// FIX: findHeaderRowIndex() busca primera fila con celda "unidad_id"
// o "proyecto_id" (META). rowsToObjects arranca desde headerRowIdx+1.
//
// CONTRATO testeado:
//   findHeaderRowIndex(tabRows) → integer | -1
//   rowsToObjects(tabRows) → [{col: val, ...}]

import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { rowsToObjects, findHeaderRowIndex } = require("../src/inventory/sheets-client");

describe("Hotfix-29 Bug 1 P1 — findHeaderRowIndex", () => {
  it("retorna 0 si headers en fila 1 (caso clásico)", () => {
    const rows = [
      ["unidad_id", "precio_usd", "estado"],
      ["3B", "156000", "disponible"],
    ];
    expect(findHeaderRowIndex(rows)).toBe(0);
  });

  it("detecta fila de headers en row 2 (con título en row 0)", () => {
    const rows = [
      ["INVENTARIO PR3 - Edita aquí", "", ""],
      ["unidad_id", "precio_usd", "estado"],
      ["3B", "156000", "disponible"],
    ];
    expect(findHeaderRowIndex(rows)).toBe(1);
  });

  it("detecta fila de headers en row 3 (título + separador + nota)", () => {
    const rows = [
      ["INVENTARIO PR4", "", "", "", ""],
      ["", "", "", "", ""],
      ["Nota: estados válidos = disponible|reservado|vendido|bloqueado", "", "", "", ""],
      ["unidad_id", "tipo", "precio_usd", "m2", "estado"],
      ["4D", "D", "157500", "63", "disponible"],
    ];
    expect(findHeaderRowIndex(rows)).toBe(3);
  });

  it("case-insensitive: 'UNIDAD_ID' también detecta", () => {
    const rows = [
      ["Título"],
      ["UNIDAD_ID", "PRECIO_USD", "ESTADO"],
      ["3B", "156000", "disponible"],
    ];
    expect(findHeaderRowIndex(rows)).toBe(1);
  });

  it("META tab: detecta 'proyecto_id' como header signal", () => {
    const rows = [
      ["META - Configuración general"],
      ["proyecto_id", "nombre_display", "ubicacion"],
      ["pr3", "Prado Residences III", "Churchill"],
    ];
    expect(findHeaderRowIndex(rows)).toBe(1);
  });

  it("retorna -1 si no encuentra fila de headers", () => {
    const rows = [
      ["foo", "bar"],
      ["baz", "qux"],
    ];
    expect(findHeaderRowIndex(rows)).toBe(-1);
  });

  it("tolerante a celdas con espacios en blanco (trim)", () => {
    const rows = [
      ["título"],
      ["  unidad_id  ", "  precio_usd  ", "  estado  "],
      ["3B", "156000", "disponible"],
    ];
    expect(findHeaderRowIndex(rows)).toBe(1);
  });

  it("array vacío/null retorna -1", () => {
    expect(findHeaderRowIndex([])).toBe(-1);
    expect(findHeaderRowIndex(null)).toBe(-1);
    expect(findHeaderRowIndex(undefined)).toBe(-1);
  });
});

describe("Hotfix-29 Bug 1 P1 — rowsToObjects con detección dinámica", () => {
  it("Test 1: headers en row 0 → comportamiento clásico funciona", () => {
    const rows = [
      ["unidad_id", "precio_usd", "estado"],
      ["3B", "156000", "disponible"],
      ["3C", "162000", "reservado"],
    ];
    const objs = rowsToObjects(rows);
    expect(objs.length).toBe(2);
    expect(objs[0]).toEqual({ unidad_id: "3B", precio_usd: "156000", estado: "disponible" });
    expect(objs[1]).toEqual({ unidad_id: "3C", precio_usd: "162000", estado: "reservado" });
  });

  it("Test 2: headers en row 2 con título previo → skip las filas previas", () => {
    const rows = [
      ["INVENTARIO PR3", "", ""],
      ["", "", ""],
      ["unidad_id", "precio_usd", "estado"],
      ["3B", "156000", "disponible"],
      ["3C", "162000", "reservado"],
    ];
    const objs = rowsToObjects(rows);
    expect(objs.length).toBe(2);
    expect(objs[0]).toEqual({ unidad_id: "3B", precio_usd: "156000", estado: "disponible" });
    expect(objs[1]).toEqual({ unidad_id: "3C", precio_usd: "162000", estado: "reservado" });
  });

  it("Test 3: caso real del Director — Sheet con filas decorativas previas", () => {
    const rows = [
      ["PRADO RESIDENCES III - Churchill", "", "", "", "", "", ""],
      ["Edita estados aquí. Estados válidos: disponible|reservado|vendido|bloqueado.", "", "", "", "", "", ""],
      ["", "", "", "", "", "", ""],
      ["unidad_id", "tipo", "precio_usd", "m2", "hab", "bano", "estado"],
      ["3B", "B", "156000", "52", "2", "1", "disponible"],
      ["3C", "C", "162000", "55", "2", "1.5", "disponible"],
      ["3X", "X", "", "52", "2", "1", "disponible"], // skip (sin precio)
    ];
    const objs = rowsToObjects(rows);
    expect(objs.length).toBe(3);
    expect(objs[0].unidad_id).toBe("3B");
    expect(objs[2].unidad_id).toBe("3X");
    // Ninguna fila decorativa filtra como objeto:
    expect(objs.every((o) => !!o.unidad_id)).toBe(true);
  });

  it("Test 4: filas vacías intermedias (después de headers) se ignoran", () => {
    const rows = [
      ["Título"],
      ["unidad_id", "precio_usd", "estado"],
      ["3B", "156000", "disponible"],
      ["", "", ""], // vacía
      ["3C", "162000", "reservado"],
    ];
    const objs = rowsToObjects(rows);
    expect(objs.length).toBe(2);
    expect(objs[0].unidad_id).toBe("3B");
    expect(objs[1].unidad_id).toBe("3C");
  });

  it("Test 5: sin fila de headers → retorna [] (defensa)", () => {
    const rows = [
      ["foo", "bar"],
      ["baz", "qux"],
    ];
    expect(rowsToObjects(rows)).toEqual([]);
  });

  it("Test 6: META tab con proyecto_id como header signal", () => {
    const rows = [
      ["META - Datos por proyecto"],
      ["proyecto_id", "nombre_display", "total_unidades"],
      ["pr3", "Prado Residences III", "60"],
      ["pr4", "Prado Residences IV", "72"],
    ];
    const objs = rowsToObjects(rows);
    expect(objs.length).toBe(2);
    expect(objs[0]).toEqual({
      proyecto_id: "pr3",
      nombre_display: "Prado Residences III",
      total_unidades: "60",
    });
  });

  it("Test 7: empty/short input → [] sin crash", () => {
    expect(rowsToObjects([])).toEqual([]);
    expect(rowsToObjects(null)).toEqual([]);
    expect(rowsToObjects(undefined)).toEqual([]);
    expect(rowsToObjects([["unidad_id"]])).toEqual([]); // solo headers, sin datos
  });
});
