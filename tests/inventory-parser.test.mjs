// Bloque 1 Fase 2 — Tests parser inventario.
//
// Cobertura:
//   - Regla Director: estado="disponible" sin precio → SKIP + warn
//   - Estados válidos normalizados (disponible|reservado|vendido|bloqueado)
//   - Tabs por proyecto: PR3, PR4, PSE3, PSE4, CRUX_TORRE6, CRUX_LISTOS, META
//   - Tipos: precio_usd vs precio_dop (crux_listos único)
//   - Skipped array poblado correctamente con tab + unidad_id + reason

import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { parseInventory, toNumber, normEstado, VALID_ESTADOS } = require("../src/inventory/parser");

describe("Bloque 1 — parser inventario", () => {
  it("toNumber: limpia caracteres no numéricos", () => {
    expect(toNumber("156000")).toBe(156000);
    expect(toNumber("US$156,000")).toBe(156000);
    expect(toNumber("RD$5,775,000")).toBe(5775000);
    expect(toNumber("")).toBe(null);
    expect(toNumber(null)).toBe(null);
    expect(toNumber("abc")).toBe(null);
  });

  it("normEstado: normaliza a lowercase y valida", () => {
    expect(normEstado("DISPONIBLE")).toBe("disponible");
    expect(normEstado("Reservado")).toBe("reservado");
    expect(normEstado("vendido")).toBe("vendido");
    expect(normEstado("bloqueado")).toBe("bloqueado");
    // Estado inválido cae a default "disponible"
    expect(normEstado("foo")).toBe("disponible");
    expect(normEstado(null)).toBe("disponible");
    expect(VALID_ESTADOS.size).toBe(4);
  });

  it("regla disponible sin precio: skip + warn (PR3)", () => {
    const inv = parseInventory({
      PR3: [
        { unidad_id: "3B", precio_usd: "156000", m2: "52", vista: "Oeste", estado: "disponible" },
        { unidad_id: "3X", precio_usd: "", m2: "52", estado: "disponible" }, // skip
        { unidad_id: "5C", precio_usd: "172000", estado: "disponible" },
        { unidad_id: "9A", precio_usd: "", estado: "reservado" }, // NO skip (no disponible)
      ],
    });
    expect(inv.proyectos.pr3.length).toBe(3); // 3B + 5C + 9A reservado
    const ids = inv.proyectos.pr3.map((u) => u.unidad_id);
    expect(ids).toContain("3B");
    expect(ids).toContain("5C");
    expect(ids).toContain("9A");
    expect(ids).not.toContain("3X");
    expect(inv.skipped.length).toBe(1);
    expect(inv.skipped[0]).toMatchObject({
      tab: "pr3",
      unidad_id: "3X",
      estado: "disponible",
      reason: "missing_price",
    });
  });

  it("regla disponible sin precio: skip CRUX_LISTOS usa precio_dop", () => {
    const inv = parseInventory({
      CRUX_LISTOS: [
        { unidad_id: "T3-2B", precio_dop: "5775000", torre: "T3", etapa: "1", estado: "disponible" },
        { unidad_id: "T3-2X", precio_dop: "", torre: "T3", etapa: "1", estado: "disponible" }, // skip
      ],
    });
    expect(inv.proyectos.crux_listos.length).toBe(1);
    expect(inv.proyectos.crux_listos[0].unidad_id).toBe("T3-2B");
    expect(inv.skipped[0].tab).toBe("crux_listos");
  });

  it("META tab: parsea campos + total_unidades como int", () => {
    const inv = parseInventory({
      META: [
        {
          proyecto_id: "pr3",
          nombre_display: "Prado Residences III",
          ubicacion: "Churchill",
          entrega_fecha: "agosto 2026",
          plan_normal: "10/30/60",
          plan_feria: "10/20/70",
          total_unidades: "60",
          nota_especial: "Equipado con A/A",
        },
      ],
    });
    expect(inv.meta.length).toBe(1);
    expect(inv.meta[0]).toMatchObject({
      proyecto_id: "pr3",
      nombre_display: "Prado Residences III",
      total_unidades: 60,
      plan_feria: "10/20/70",
    });
  });

  it("PR4 tipo se uppercase y campos opcionales se preservan", () => {
    const inv = parseInventory({
      PR4: [
        {
          unidad_id: "4D",
          tipo: "d",
          precio_usd: "157500",
          m2: "63",
          hab: "1",
          bano: "1.5",
          parqueos: "1",
          orientacion: "Sur",
          estado: "disponible",
        },
      ],
    });
    expect(inv.proyectos.pr4[0]).toMatchObject({
      unidad_id: "4D",
      tipo: "D",
      precio_usd: 157500,
      m2: 63,
      hab: 1,
      bano: 1.5,
      parqueos: 1,
      orientacion: "Sur",
      estado: "disponible",
    });
  });

  it("CRUX_TORRE6 letra uppercase + piso int", () => {
    const inv = parseInventory({
      CRUX_TORRE6: [
        { unidad_id: "P4-D", piso: "4", letra: "d", precio_usd: "105258", estado: "reservado" },
      ],
    });
    expect(inv.proyectos.crux_t6[0]).toMatchObject({
      unidad_id: "P4-D",
      piso: 4,
      letra: "D",
      precio_usd: 105258,
      estado: "reservado",
    });
  });

  it("filas completamente vacías son ignoradas (no causan skip)", () => {
    const inv = parseInventory({
      PR3: [
        { unidad_id: "3B", precio_usd: "156000", estado: "disponible" },
      ],
    });
    expect(inv.proyectos.pr3.length).toBe(1);
    expect(inv.skipped.length).toBe(0);
  });

  it("tabs ausentes en input → arrays vacíos, no error", () => {
    const inv = parseInventory({});
    expect(inv.meta).toEqual([]);
    expect(inv.proyectos.pr3).toEqual([]);
    expect(inv.proyectos.pr4).toEqual([]);
    expect(inv.proyectos.pse3).toEqual([]);
    expect(inv.proyectos.pse4).toEqual([]);
    expect(inv.proyectos.crux_t6).toEqual([]);
    expect(inv.proyectos.crux_listos).toEqual([]);
    expect(inv.skipped).toEqual([]);
  });

  it("PSE3 edificio + nivel preservan tipo correcto", () => {
    const inv = parseInventory({
      PSE3: [
        {
          unidad_id: "15-102",
          edificio: "15",
          nivel: "1",
          tipo: "2hab_67",
          precio_usd: "138000",
          m2: "67",
          estado: "disponible",
        },
        {
          unidad_id: "15-405",
          edificio: "15",
          nivel: "PH",
          tipo: "PH_3hab_134",
          precio_usd: "272000",
          m2: "134",
          estado: "disponible",
        },
      ],
    });
    expect(inv.proyectos.pse3[0].edificio).toBe(15);
    expect(inv.proyectos.pse3[0].nivel).toBe("1"); // string, "PH" coexiste con números
    expect(inv.proyectos.pse3[1].nivel).toBe("PH");
  });
});
