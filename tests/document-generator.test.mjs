// Bloque 2 Componente 1 — Tests del generador de PDF de precios (rediseño
// que replica los modelos del Director).
//
// Cubre: PDF válido por proyecto, MUESTRA TODAS las unidades (no solo
// disponibles), formato de dinero US$/RD$ con 2 decimales, conteo por estado,
// columnas por proyecto (esquemas de pago), agrupación, y manejo de errores.

import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// Mock botLog
{
  const id = require.resolve("../src/log");
  require.cache[id] = {
    id, filename: id, loaded: true,
    exports: { botLog: () => {}, logToAxiom: async () => {} },
  };
}

// Mock loader controlable — registrar antes de requerir el generador.
let nextInventory;
{
  const id = require.resolve("../src/inventory/loader");
  require.cache[id] = {
    id, filename: id, loaded: true,
    exports: {
      loadInventory: async () => nextInventory,
      CACHE_KEY: "inventory:current",
      CACHE_TTL_SECONDS: 300,
    },
  };
}

const {
  generatePriceListPdf, VALID_PROJECTS, columnsFor, groupUnits,
  statusCounts, money, floorFromUnidad, SCHEMES,
} = require("../src/documents/price-list-generator");

function sampleInventory() {
  return {
    source: "sheet",
    proyectos: {
      pr4: [
        { unidad_id: "2A", estado: "reservado", precio_usd: 305000, m2: 130, vista: "Norte", hab: "3", bano: 3.5, parqueos: "2" },
        { unidad_id: "4D", estado: "disponible", precio_usd: 157500, m2: 63, vista: "Sur", hab: "1", bano: 1.5, parqueos: "1" },
        { unidad_id: "2F", estado: "vendido", precio_usd: 120120, m2: 52, vista: "Oeste", hab: "1", bano: 1, parqueos: "1" },
        { unidad_id: "3A", estado: "bloqueado", precio_usd: 281500, m2: 130, vista: "Norte", hab: "3", bano: 3.5, parqueos: "2" },
      ],
      pse3: [
        { unidad_id: "15-102", estado: "disponible", precio_usd: 138000, m2: 67, edificio: 15, nivel: "1", hab: "2", bano: 2 },
        { unidad_id: "15-111", estado: "bloqueado", precio_usd: 85000, m2: 31, edificio: 15, hab: "1", bano: 1 },
      ],
      crux_t6: [
        { unidad_id: "T6-1A", estado: "disponible", precio_usd: 99245.95, m2: 100, piso: 1, hab: "3", bano: 2, parqueos: "2", parqueo_tipo: "Lineal Nivel 2" },
        { unidad_id: "T6-1B", estado: "reservado", precio_usd: 99245.95, m2: 100, piso: 1, hab: "3", bano: 2, parqueos: "2", parqueo_tipo: "Paralelos Nivel 4" },
      ],
      crux_listos: [
        { unidad_id: "T3-2B", estado: "disponible", precio_dop: 5775000, torre: "T3", etapa: 1, m2: 90 },
      ],
      pse4: [], pr3: [],
    },
    meta: [
      { proyecto_id: "pr4", entrega_fecha: "30/08/2026", ubicacion: "Santo Domingo", total_unidades: 72 },
      { proyecto_id: "pse3", entrega_fecha: "Marzo 2029", ubicacion: "Puerto Plata", total_unidades: 126 },
      { proyecto_id: "crux_t6", entrega_fecha: "Jul 2027", ubicacion: "Santiago", total_unidades: 50 },
    ],
  };
}

describe("Bloque 2 — generatePriceListPdf (rediseño)", () => {
  beforeEach(() => { nextInventory = sampleInventory(); });

  it("genera PDF válido para pr4 (header %PDF)", async () => {
    const buf = await generatePriceListPdf("pr4");
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 5).toString()).toBe("%PDF-");
    expect(buf.length).toBeGreaterThan(800);
  });

  it("genera PDF para pse3, crux_t6 y crux_listos sin crashear", async () => {
    for (const p of ["pse3", "crux_t6", "crux_listos"]) {
      const buf = await generatePriceListPdf(p);
      expect(buf.slice(0, 5).toString()).toBe("%PDF-");
    }
  });

  it("proyecto inválido → invalid_project", async () => {
    await expect(generatePriceListPdf("foo")).rejects.toMatchObject({ code: "invalid_project" });
  });

  it("inventario sin estructura → inventory_unavailable", async () => {
    nextInventory = { source: "fallback", markdown: "..." };
    await expect(generatePriceListPdf("pse3")).rejects.toMatchObject({ code: "inventory_unavailable" });
  });

  it("VALID_PROJECTS cubre los 6 proyectos", () => {
    expect(VALID_PROJECTS.sort()).toEqual(
      ["crux_listos", "crux_t6", "pr3", "pr4", "pse3", "pse4"].sort()
    );
  });
});

describe("Bloque 2 — money (formato US$/RD$ con 2 decimales)", () => {
  it("USD con comas y 2 decimales", () => {
    expect(money(138000, "USD")).toBe("US$ 138,000.00");
    expect(money(99245.95, "USD")).toBe("US$ 99,245.95");
  });
  it("DOP usa RD$", () => {
    expect(money(5775000, "DOP")).toBe("RD$ 5,775,000.00");
  });
  it("null/NaN → guion", () => {
    expect(money(null, "USD")).toBe("—");
    expect(money(undefined, "USD")).toBe("—");
  });
});

describe("Bloque 2 — statusCounts (todas las categorías)", () => {
  it("cuenta disponible/reservado/vendido/bloqueado", () => {
    const c = statusCounts([
      { estado: "disponible" }, { estado: "disponible" },
      { estado: "reservado" }, { estado: "vendido" }, { estado: "bloqueado" },
    ]);
    expect(c).toEqual({ disponible: 2, reservado: 1, vendido: 1, bloqueado: 1 });
  });
});

describe("Bloque 2 — esquemas de pago por proyecto", () => {
  it("pr4 = inicial 40%, pse3 = 10/30/60, crux_t6 = 5/25/70 (Hotfix-33, Doctrina v1.1)", () => {
    expect(SCHEMES.pr4).toEqual({ inicial: 0.40 });
    expect(SCHEMES.pse3).toEqual({ sep: 0.10, comp: 0.30, saldo: 0.60 });
    expect(SCHEMES.crux_t6).toEqual({ sep: 0.05, comp: 0.25, saldo: 0.70 });
    expect(SCHEMES.pr3).toBe(null);
  });
});

describe("Bloque 2 — columnas por proyecto (modelo del Director)", () => {
  function labels(p) { return columnsFor(p).map((c) => c.label); }

  it("pr4 incluye Inicial 40% + Vista + Parq.", () => {
    const l = labels("pr4");
    expect(l).toContain("Inicial 40%");
    expect(l).toContain("Vista");
    expect(l).toContain("Estatus");
  });

  it("pse3 incluye Separación/Completivo/Saldo + Edificio", () => {
    const l = labels("pse3");
    expect(l).toContain("Edificio");
    expect(l).toContain("Separación 10%");
    expect(l).toContain("Completivo 30%");
    expect(l).toContain("Saldo 60%");
  });

  it("crux_t6 incluye Saldo 70% + Tipo Parqueo", () => {
    const l = labels("crux_t6");
    expect(l).toContain("Completivo 25%"); // Hotfix-33: 5/25/70
    expect(l).toContain("Saldo 70%");
    expect(l).toContain("Tipo Parqueo");
  });

  it("getters de pago calculan desde el precio", () => {
    const cols = columnsFor("pse3");
    const sep = cols.find((c) => c.label === "Separación 10%");
    const u = { precio_usd: 138000 };
    expect(sep.get(u)).toBe("US$ 13,800.00");
  });
});

describe("Bloque 2 — groupUnits agrupa por piso/edificio", () => {
  it("pr4 agrupa por piso (dígitos del unidad_id)", () => {
    const groups = groupUnits("pr4", [
      { unidad_id: "2A", estado: "disponible" },
      { unidad_id: "3A", estado: "vendido" },
      { unidad_id: "2B", estado: "reservado" },
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Piso 2", "Piso 3"]);
    expect(groups[0].units.length).toBe(2);
  });

  it("pse3 agrupa por edificio", () => {
    const groups = groupUnits("pse3", [
      { unidad_id: "15-102", edificio: 15, estado: "disponible" },
      { unidad_id: "16-101", edificio: 16, estado: "disponible" },
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Edificio 15", "Edificio 16"]);
  });

  it("crux_t6 agrupa por piso", () => {
    const groups = groupUnits("crux_t6", [
      { unidad_id: "T6-1A", piso: 1, estado: "disponible" },
      { unidad_id: "T6-2A", piso: 2, estado: "vendido" },
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Piso 1", "Piso 2"]);
  });

  it("floorFromUnidad extrae el piso de IDs tipo 11G", () => {
    expect(floorFromUnidad("11G")).toBe(11);
    expect(floorFromUnidad("2A")).toBe(2);
    expect(floorFromUnidad("X")).toBe(0);
  });
});
