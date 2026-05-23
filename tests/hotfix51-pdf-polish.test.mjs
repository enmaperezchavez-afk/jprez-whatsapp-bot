// Hotfix-51 — Ajustes de diseño del PDF de precios (5 fixes).
//
// Fix 1: defaults fijos para Crux T6/Listos (100m², 3 hab, 2 baños, 2 parq).
// Fix 2: tabla resumen por edificio/piso (conteos por grupo + total + %).
// Fix 3: inicio_construccion en META + header.
// Fix 5: columna "No. Encargo" opcional (solo si el Sheet la trae).

import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

{
  const id = require.resolve("../src/log");
  require.cache[id] = { id, filename: id, loaded: true, exports: { botLog: () => {}, logToAxiom: async () => {} } };
}

let nextInventory;
{
  const id = require.resolve("../src/inventory/loader");
  require.cache[id] = {
    id, filename: id, loaded: true,
    exports: { loadInventory: async () => nextInventory, CACHE_KEY: "inventory:current", CACHE_TTL_SECONDS: 300 },
  };
}

const {
  generatePriceListPdf, applyDefaults, groupSummary, columnsFor,
  CRUX_DEFAULTS, CONSTRUCCION_DEFAULT,
} = require("../src/documents/price-list-generator");
const { parseInventory } = require("../src/inventory/parser");

describe("Hotfix-51 Fix 1 — defaults Crux", () => {
  it("crux_t6 sin m2/hab/bano/parqueos → usa defaults fijos", () => {
    const out = applyDefaults("crux_t6", [{ unidad_id: "T6-1A", estado: "disponible", precio_usd: 99000, piso: 1 }]);
    expect(out[0]).toMatchObject({ m2: 100, hab: "3", bano: 2, parqueos: "2" });
  });

  it("crux_listos también recibe defaults", () => {
    const out = applyDefaults("crux_listos", [{ unidad_id: "T3-2B", estado: "disponible", precio_dop: 5775000 }]);
    expect(out[0]).toMatchObject(CRUX_DEFAULTS);
  });

  it("NO sobrescribe valores existentes", () => {
    const out = applyDefaults("crux_t6", [{ unidad_id: "T6-1A", estado: "disponible", precio_usd: 99000, m2: 120, hab: "2" }]);
    expect(out[0].m2).toBe(120);
    expect(out[0].hab).toBe("2");
    expect(out[0].bano).toBe(2); // default rellena el faltante
  });

  it("NO toca otros proyectos (pse3/pr4)", () => {
    const input = [{ unidad_id: "15-102", estado: "disponible", precio_usd: 138000, edificio: 15 }];
    const out = applyDefaults("pse3", input);
    expect(out[0].m2).toBeUndefined();
    expect(out).toBe(input); // misma referencia, sin map
  });
});

describe("Hotfix-51 Fix 2 — groupSummary", () => {
  it("conteos por grupo + fila TOTAL con % ventas", () => {
    const rows = groupSummary("crux_t6", [
      { piso: 1, estado: "disponible", unidad_id: "a" },
      { piso: 1, estado: "vendido", unidad_id: "b" },
      { piso: 2, estado: "reservado", unidad_id: "c" },
    ]);
    expect(rows.length).toBe(3); // Piso 1, Piso 2, TOTAL
    expect(rows[0]).toMatchObject({ label: "Piso 1", disponible: 1, vendido: 1, total: 2, pct: 50 });
    expect(rows[1]).toMatchObject({ label: "Piso 2", reservado: 1, total: 1, pct: 100 });
    const totalRow = rows[rows.length - 1];
    expect(totalRow).toMatchObject({ label: "TOTAL", total: 3, disponible: 1, isTotal: true });
    expect(totalRow.pct).toBe(67); // (3-1)/3
  });

  it("pse agrupa por edificio", () => {
    const rows = groupSummary("pse3", [
      { edificio: 15, estado: "disponible", unidad_id: "15-1" },
      { edificio: 16, estado: "vendido", unidad_id: "16-1" },
    ]);
    expect(rows.map((r) => r.label)).toEqual(["Edificio 15", "Edificio 16", "TOTAL"]);
  });
});

describe("Hotfix-51 Fix 3 — inicio_construccion", () => {
  it("parser mapea inicio_construccion del META tab", () => {
    const inv = parseInventory({
      META: [{ proyecto_id: "pse3", nombre_display: "PSE3", inicio_construccion: "Enero 2028", entrega_fecha: "Marzo 2029" }],
    });
    expect(inv.meta[0].inicio_construccion).toBe("Enero 2028");
  });

  it("parser deja null si no viene", () => {
    const inv = parseInventory({ META: [{ proyecto_id: "pr3", nombre_display: "PR3" }] });
    expect(inv.meta[0].inicio_construccion).toBe(null);
  });

  it("defaults de construcción definidos para pse3/pse4/crux_t6", () => {
    expect(CONSTRUCCION_DEFAULT.pse3).toBe("Enero 2028");
    expect(CONSTRUCCION_DEFAULT.crux_t6).toBe("En construcción");
    expect(CONSTRUCCION_DEFAULT.pr3).toBeUndefined();
  });
});

describe("Hotfix-51 Fix 5 — columna No. Encargo opcional", () => {
  it("pse3 incluye No. Encargo solo cuando hasEncargos", () => {
    expect(columnsFor("pse3", { hasEncargos: true }).map((c) => c.label)).toContain("No. Encargo");
    expect(columnsFor("pse3", { hasEncargos: false }).map((c) => c.label)).not.toContain("No. Encargo");
  });

  it("crux_t6 incluye No. Encargo cuando hasEncargos", () => {
    expect(columnsFor("crux_t6", { hasEncargos: true }).map((c) => c.label)).toContain("No. Encargo");
  });

  it("pr3 NO agrega No. Encargo (no aplica)", () => {
    expect(columnsFor("pr3", { hasEncargos: true }).map((c) => c.label)).not.toContain("No. Encargo");
  });

  it("parser pse3/crux_t6 leen numero_encargos", () => {
    const inv = parseInventory({
      PSE3: [{ unidad_id: "15-102", precio_usd: "138000", edificio: "15", numero_encargos: "237000100335", estado: "disponible" }],
      CRUX_TORRE6: [{ unidad_id: "T6-1A", precio_usd: "99000", piso: "1", numero_encargos: "X1", estado: "disponible" }],
    });
    expect(inv.proyectos.pse3[0].numero_encargos).toBe("237000100335");
    expect(inv.proyectos.crux_t6[0].numero_encargos).toBe("X1");
  });
});

describe("Hotfix-51 — integración: PDF se genera con todos los fixes", () => {
  beforeEach(() => {
    nextInventory = {
      source: "sheet",
      proyectos: {
        crux_t6: [
          { unidad_id: "T6-1A", estado: "disponible", precio_usd: 99245.95, piso: 1 },
          { unidad_id: "T6-1B", estado: "bloqueado", precio_usd: 99245.95, piso: 1 },
          { unidad_id: "T6-2A", estado: "reservado", precio_usd: 100677, piso: 2 },
        ],
        pse3: [
          { unidad_id: "15-102", estado: "disponible", precio_usd: 138000, edificio: 15, m2: 67, hab: "2", bano: 2, numero_encargos: "237000100335" },
          { unidad_id: "16-101", estado: "vendido", precio_usd: 150000, edificio: 16, m2: 67, hab: "2", bano: 2, numero_encargos: "237000100400" },
        ],
        pr4: [], pr3: [], pse4: [], crux_listos: [],
      },
      meta: [
        { proyecto_id: "pse3", entrega_fecha: "Marzo 2029", inicio_construccion: "Enero 2028", ubicacion: "Puerto Plata", total_unidades: 126 },
        { proyecto_id: "crux_t6", entrega_fecha: "Jul 2027", ubicacion: "Santiago", total_unidades: 50 },
      ],
    };
  });

  it("crux_t6 genera PDF válido (con defaults + resumen por piso)", async () => {
    const buf = await generatePriceListPdf("crux_t6");
    expect(buf.slice(0, 5).toString()).toBe("%PDF-");
    expect(buf.length).toBeGreaterThan(1000);
  });

  it("pse3 genera PDF válido (con encargos + resumen por edificio + inicio)", async () => {
    const buf = await generatePriceListPdf("pse3");
    expect(buf.slice(0, 5).toString()).toBe("%PDF-");
  });
});
