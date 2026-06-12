// Sprint1.7 PR-3 — calendario de cuotas mes a mes (Adendum v1.2 B2/B3).
// La garantía dura: el TOTAL suma EXACTO al precio o el documento no sale.

import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { buildCuotasSchedule, RESERVAS } = require("../src/documents/cuotas-schedule.js");

const PLAN = {
  proyecto: "Crux del Prado",
  precio_total_usd: 137000,
  separacion_usd: 13700,
  separacion_pct: 10,
  completivo_total_usd: 27400,
  completivo_pct: 20,
  cuota_mensual_usd: 2108, // round(27400/13) — NO divide exacto a propósito
  meses_hasta_entrega: 13,
  contra_entrega_usd: 95900,
  contra_entrega_pct: 70,
  entrega_fecha: "2027-07-01",
};
const HOY = new Date(2026, 5, 12); // 12 jun 2026

describe("CUOTAS — estructura y fechas reales (B3)", () => {
  it("reserva y firma primero, cuotas mes a mes, contra entrega al final", () => {
    const s = buildCuotasSchedule({ plan: PLAN, proyectoCalc: "crux", hoy: HOY });
    expect(s.filas[0].concepto).toMatch(/Reserva/);
    expect(s.filas[0].monto).toBe(1000); // Crux US$1,000 (doctrina v1.1)
    expect(s.filas[0].fecha).toBe("jun 2026");
    expect(s.filas[1].concepto).toMatch(/firma/i);
    expect(s.filas[1].monto).toBe(12700); // separación - reserva
    // 13 cuotas: jul 2026 ... jul 2027
    expect(s.filas[2].fecha).toBe("jul 2026");
    expect(s.filas[2].monto).toBe(2108);
    expect(s.filas[14].fecha).toBe("jul 2027");
    const ultima = s.filas[s.filas.length - 1];
    expect(ultima.concepto).toMatch(/Contra entrega/);
    expect(ultima.fecha).toBe("jul 2027"); // entrega_fecha del plan, nunca hardcode
    expect(ultima.saldo).toBe(0);
  });

  it("reserva por proyecto: PR4/PSE US$2,000", () => {
    const s = buildCuotasSchedule({ plan: { ...PLAN, proyecto: "PR4" }, proyectoCalc: "pr4", hoy: HOY });
    expect(s.filas[0].monto).toBe(2000);
    expect(RESERVAS.puertoPlata).toBe(2000);
  });

  it("GARANTÍA DURA: el total suma EXACTO al precio (última cuota ajusta el residuo)", () => {
    const s = buildCuotasSchedule({ plan: PLAN, proyectoCalc: "crux", hoy: HOY });
    expect(s.total).toBe(137000);
    // cuota base 2108 × 12 = 25,296; última = 27,400 - 25,296 = 2,104
    const cuotas = s.filas.filter((f) => /^Cuota/.test(f.concepto));
    expect(cuotas).toHaveLength(13);
    expect(cuotas[12].monto).toBe(2104);
    // saldo decreciente y exacto
    expect(cuotas[0].saldo).toBe(137000 - 13700 - 2108);
  });

  it("cuadre con precios feos: cualquier combinación suma exacta", () => {
    for (const precio of [163400, 98292, 157333, 100001]) {
      const sep = Math.round(precio * 0.1);
      const comp = Math.round(precio * 0.3);
      const plan = {
        ...PLAN,
        precio_total_usd: precio,
        separacion_usd: sep,
        completivo_total_usd: comp,
        cuota_mensual_usd: Math.round(comp / 17),
        meses_hasta_entrega: 17,
        contra_entrega_usd: Math.round(precio * 0.6),
      };
      const s = buildCuotasSchedule({ plan, proyectoCalc: "pr4", hoy: HOY });
      expect(s.total).toBe(precio);
      expect(s.filas[s.filas.length - 1].saldo).toBe(0);
    }
  });

  it("plan corrupto -> throw (documento bloqueado, no sale mal sumado)", () => {
    expect(() => buildCuotasSchedule({ plan: null, proyectoCalc: "crux" })).toThrow();
    expect(() =>
      buildCuotasSchedule({
        plan: { ...PLAN, completivo_total_usd: 999999 }, // contra entrega negativo
        proyectoCalc: "crux",
        hoy: HOY,
      })
    ).toThrow(/no positivo|documento bloqueado/);
  });
});
