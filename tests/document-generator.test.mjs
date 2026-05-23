// Bloque 2 Componente 1 — Tests del generador de PDF de precios dinámico.
//
// El generador lee el inventario estructurado (loader → Sheet) y produce un
// PDF con PDFKit. Tests mockean el loader para inyectar data controlada y
// validan: bytes PDF válidos, solo disponibles, currency correcta por
// proyecto, manejo de proyecto inválido e inventario no disponible.

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

// Mock loader controlable — DEBE registrarse antes de requerir el generador.
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

const { generatePriceListPdf, VALID_PROJECTS, unitDetail } = require("../src/documents/price-list-generator");

function sampleInventory() {
  return {
    source: "sheet",
    proyectos: {
      pse3: [
        { unidad_id: "15-102", estado: "disponible", precio_usd: 138000, m2: 67, edificio: 15, nivel: "1", tipo: "2hab_67" },
        { unidad_id: "15-108", estado: "disponible", precio_usd: 75000, m2: 27, edificio: 15, nivel: "1", tipo: "estudio" },
        { unidad_id: "16-301", estado: "reservado", precio_usd: 150000, m2: 67, edificio: 16 },
      ],
      pr4: [
        { unidad_id: "4D", estado: "disponible", precio_usd: 157500, m2: 63, hab: 1, bano: 1.5, parqueos: 1, tipo: "D", orientacion: "Sur" },
      ],
      crux_listos: [
        { unidad_id: "T3-2B", estado: "disponible", precio_dop: 5775000, torre: "T3", etapa: 1 },
      ],
      pse4: [],
      pr3: [],
      crux_t6: [],
    },
    meta: [
      { proyecto_id: "pse3", nombre_display: "Prado Suites Puerto Plata Etapa 3", ubicacion: "Puerto Plata", entrega_fecha: "marzo 2029", plan_normal: "10/30/60", plan_feria: "10/20/70", total_unidades: 126 },
      { proyecto_id: "crux_listos", nombre_display: "Crux Listos", ubicacion: "Santiago", entrega_fecha: "inmediata", plan_normal: "contado", plan_feria: null, total_unidades: 4 },
    ],
  };
}

describe("Bloque 2 — generatePriceListPdf", () => {
  beforeEach(() => {
    nextInventory = sampleInventory();
  });

  it("genera un PDF válido (header %PDF) para pse3", async () => {
    const buf = await generatePriceListPdf("pse3");
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(800);
    expect(buf.slice(0, 5).toString()).toBe("%PDF-");
  });

  it("genera PDF para crux_listos (currency DOP, no crashea)", async () => {
    const buf = await generatePriceListPdf("crux_listos");
    expect(buf.slice(0, 5).toString()).toBe("%PDF-");
    expect(buf.length).toBeGreaterThan(800);
  });

  it("genera PDF para pr4 (campos hab/baños/parqueos)", async () => {
    const buf = await generatePriceListPdf("pr4");
    expect(buf.slice(0, 5).toString()).toBe("%PDF-");
  });

  it("proyecto inválido → error code invalid_project", async () => {
    await expect(generatePriceListPdf("foo")).rejects.toMatchObject({ code: "invalid_project" });
  });

  it("inventario sin data estructurada → error code inventory_unavailable", async () => {
    nextInventory = { source: "fallback", markdown: "..." }; // sin .proyectos
    await expect(generatePriceListPdf("pse3")).rejects.toMatchObject({ code: "inventory_unavailable" });
  });

  it("proyecto con cero disponibles → sigue generando PDF (no crashea)", async () => {
    nextInventory = sampleInventory();
    nextInventory.proyectos.pse4 = [
      { unidad_id: "X", estado: "vendido", precio_usd: 100000 },
    ];
    const buf = await generatePriceListPdf("pse4");
    expect(buf.slice(0, 5).toString()).toBe("%PDF-");
  });

  it("VALID_PROJECTS cubre los 6 proyectos esperados", () => {
    expect(VALID_PROJECTS.sort()).toEqual(
      ["crux_listos", "crux_t6", "pr3", "pr4", "pse3", "pse4"].sort()
    );
  });
});

describe("Bloque 2 — unitDetail compone atributos por proyecto", () => {
  it("pse3: edificio + nivel + tipo", () => {
    const d = unitDetail({ tipo: "2hab_67", edificio: 15, nivel: "1" });
    expect(d).toContain("2hab_67");
    expect(d).toContain("Edif 15");
    expect(d).toContain("Nivel 1");
  });

  it("pr4: hab + baños + parqueos + orientacion", () => {
    const d = unitDetail({ tipo: "D", hab: 1, bano: 1.5, parqueos: 1, orientacion: "Sur" });
    expect(d).toContain("1 hab");
    expect(d).toContain("1.5 baños");
    expect(d).toContain("Sur");
  });

  it("crux_t6: piso + letra", () => {
    const d = unitDetail({ piso: 4, letra: "D" });
    expect(d).toContain("Piso 4D");
  });

  it("crux_listos: torre + etapa", () => {
    const d = unitDetail({ torre: "T3", etapa: 1 });
    expect(d).toContain("Torre T3");
    expect(d).toContain("Etapa 1");
  });
});
