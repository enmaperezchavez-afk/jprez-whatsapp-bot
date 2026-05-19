// Bloque 1 Fase 2 — Tests markdown formatter.
//
// Golden snapshot + checks comportamentales clave:
//   - Crux Torre 6 muestra reservados/vendidos/bloqueados INLINE con flag
//   - PR3/PR4/PSE3/PSE4 solo listan disponibles, no-disponibles solo
//     suman al conteo "X de Y"
//   - Total usa META.total_unidades, no count de unidades
//   - Pluralización correcta (1 disponible vs 5 disponibles)

import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { parseInventory } = require("../src/inventory/parser");
const {
  formatInventoryMarkdown,
  sectionCruxTorre6,
  sectionPR3,
} = require("../src/inventory/markdown-formatter");

describe("Bloque 1 — markdown formatter", () => {
  it("Crux T6: muestra reservados inline con flag (RESERVADO)", () => {
    const inv = parseInventory({
      META: [{ proyecto_id: "crux_t6", total_unidades: "50" }],
      CRUX_TORRE6: [
        { unidad_id: "P1-A", piso: "1", letra: "A", precio_usd: "99246", estado: "disponible" },
        { unidad_id: "P1-B", piso: "1", letra: "B", precio_usd: "99246", estado: "reservado" },
        { unidad_id: "P1-C", piso: "1", letra: "C", precio_usd: "98292", estado: "bloqueado" },
        { unidad_id: "P1-D", piso: "1", letra: "D", precio_usd: "100009", estado: "vendido" },
      ],
    });
    const md = sectionCruxTorre6(inv);
    expect(md).toContain("PISO 1:");
    expect(md).toContain("A=US$99,246");
    expect(md).toContain("B=US$99,246 (RESERVADO)");
    expect(md).toContain("C=US$98,292 (BLOQUEADO)");
    expect(md).toContain("D=US$100,009 (VENDIDO)");
    expect(md).toContain("1 disponible.");
    expect(md).toContain("Total disponibles: 1 de 50.");
  });

  it("Crux T6: 'todos disponibles' cuando 4/4 disponibles", () => {
    const inv = parseInventory({
      META: [{ proyecto_id: "crux_t6", total_unidades: "50" }],
      CRUX_TORRE6: [
        { unidad_id: "P1-A", piso: "1", letra: "A", precio_usd: "99246", estado: "disponible" },
        { unidad_id: "P1-B", piso: "1", letra: "B", precio_usd: "99246", estado: "disponible" },
        { unidad_id: "P1-C", piso: "1", letra: "C", precio_usd: "98292", estado: "disponible" },
        { unidad_id: "P1-D", piso: "1", letra: "D", precio_usd: "100009", estado: "disponible" },
      ],
    });
    const md = sectionCruxTorre6(inv);
    expect(md).toContain("todos disponibles.");
  });

  it("PR3: NO muestra reservados — solo disponibles", () => {
    const inv = parseInventory({
      META: [{ proyecto_id: "pr3", total_unidades: "60" }],
      PR3: [
        { unidad_id: "3B", precio_usd: "156000", m2: "52", vista: "Oeste", estado: "disponible" },
        { unidad_id: "3C", precio_usd: "169000", m2: "60", vista: "Este-Oeste", estado: "reservado" },
        { unidad_id: "5B", precio_usd: "159000", m2: "52", vista: "Oeste", estado: "vendido" },
      ],
    });
    const md = sectionPR3(inv);
    expect(md).toContain("3B en US$156,000");
    expect(md).not.toContain("3C"); // reservado oculto
    expect(md).not.toContain("5B"); // vendido oculto
    expect(md).toContain("Total disponibles: 1 de 60.");
  });

  it("PR3: total_unidades viene de META, no de unit count", () => {
    const inv = parseInventory({
      META: [{ proyecto_id: "pr3", total_unidades: "60" }],
      PR3: [
        { unidad_id: "3B", precio_usd: "156000", estado: "disponible" },
      ],
    });
    const md = sectionPR3(inv);
    // Solo 1 unidad en el array, pero META dice 60 total → "1 de 60"
    expect(md).toContain("Total disponibles: 1 de 60.");
  });

  it("formatInventoryMarkdown: estructura completa con headers", () => {
    const inv = parseInventory({ META: [] });
    const md = formatInventoryMarkdown(inv);
    expect(md).toContain("# Inventario y Precios — JPREZ");
    expect(md).toContain("## CRUX DEL PRADO — Unidades Listas para Entrega Inmediata");
    expect(md).toContain("## CRUX DEL PRADO — Torre 6");
    expect(md).toContain("## PRADO RESIDENCES III");
    expect(md).toContain("## PRADO RESIDENCES IV");
    expect(md).toContain("## PRADO SUITES PUERTO PLATA — Etapa 3");
    expect(md).toContain("## PRADO SUITES PUERTO PLATA — Etapa 4");
  });

  it("Golden snapshot: fixture mínimo → output esperado byte-exact", () => {
    const inv = parseInventory({
      META: [
        {
          proyecto_id: "crux_t6",
          total_unidades: "50",
          entrega_fecha: "julio 2027",
          plan_normal: "10/30/60",
          plan_feria: "10/15/80",
        },
        {
          proyecto_id: "pr3",
          total_unidades: "60",
          entrega_fecha: "agosto 2026",
          plan_normal: "10/30/60",
        },
      ],
      CRUX_TORRE6: [
        { unidad_id: "P1-A", piso: "1", letra: "A", precio_usd: "99246", estado: "disponible" },
        { unidad_id: "P1-B", piso: "1", letra: "B", precio_usd: "99246", estado: "reservado" },
      ],
      PR3: [
        { unidad_id: "3B", precio_usd: "156000", m2: "52", vista: "Oeste", estado: "disponible" },
      ],
    });
    const md = formatInventoryMarkdown(inv);
    // Anclas clave (byte-exact en secciones críticas)
    expect(md).toContain("PISO 1: A=US$99,246 / B=US$99,246 (RESERVADO) — 1 disponible.");
    expect(md).toContain("Total disponibles: 1 de 50.");
    expect(md).toContain("3B en US$156,000, 52m², vista Oeste.");
    expect(md).toContain("Total disponibles: 1 de 60.");
    expect(md).toContain("Plan Feria de Mayo 2026: 10/15/80");
  });

  it("Crux Listos: precio en RD$ (no US$)", () => {
    const inv = parseInventory({
      META: [{ proyecto_id: "crux_listos", total_unidades: "4" }],
      CRUX_LISTOS: [
        {
          unidad_id: "T3-2B",
          torre: "T3",
          etapa: "1",
          precio_dop: "5775000",
          parqueo_tipo: "individuales",
          estado: "disponible",
        },
      ],
    });
    const md = formatInventoryMarkdown(inv);
    expect(md).toContain("T3-2B en RD$5,775,000");
    expect(md).not.toMatch(/T3-2B en US\$/);
  });

  it("PSE3 agrupa por edificio + nivel", () => {
    const inv = parseInventory({
      META: [{ proyecto_id: "pse3", total_unidades: "126" }],
      PSE3: [
        { unidad_id: "15-102", edificio: "15", nivel: "1", tipo: "2hab_67", precio_usd: "138000", m2: "67", estado: "disponible" },
        { unidad_id: "15-201", edificio: "15", nivel: "2", tipo: "2hab_67", precio_usd: "140000", m2: "67", estado: "disponible" },
        { unidad_id: "16-101", edificio: "16", nivel: "1", tipo: "2hab_67", precio_usd: "138000", m2: "67", estado: "disponible" },
      ],
    });
    const md = formatInventoryMarkdown(inv);
    expect(md).toContain("#### Disponibles Edificio 15 (2 unidades)");
    expect(md).toContain("#### Disponibles Edificio 16 (1 unidad)"); // singular
    expect(md).toContain("NIVEL 1: 15-102 en US$138,000");
    expect(md).toContain("NIVEL 2: 15-201 en US$140,000");
    expect(md).toContain("Total disponibles E3: 3 de 126.");
  });
});
