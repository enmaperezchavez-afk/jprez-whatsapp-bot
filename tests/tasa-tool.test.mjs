// Sprint 1 PR-1 — tool consultar_tasa_dolar: skeleton drop-in, NO cableada.
//
// Disciplina del Bloque 3 / ICDV Fase 1: la tool queda lista pero NO se
// conecta a TOOLS[] de message.js hasta la Fase 2 (cablear toca prompt
// budget y comportamiento de Mateo — decisión aparte). El test de
// disciplina se INVERTIRÁ cuando la Fase 2 la active, igual que pasó con
// el ICDV en Sprint0 PR-D.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

describe("TASA — src/tools/tasa.js schema (drop-in para Fase 2)", () => {
  it("TOOL_CONSULTAR_TASA expone schema Anthropic válido + handler async", () => {
    const mod = require("../src/tools/tasa.js");
    const tool = mod.TOOL_CONSULTAR_TASA;
    expect(tool).toBeDefined();
    expect(tool.name).toBe("consultar_tasa_dolar");
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(50);
    expect(tool.description).toMatch(/nunca inventes/i); // guard anti-alucinación
    expect(tool.input_schema.type).toBe("object");
    expect(tool.input_schema.properties.detalle.enum).toEqual(["resumen", "serie"]);
    expect(typeof mod.consultarTasaDolar).toBe("function");
    expect(mod.consultarTasaDolar.constructor.name).toBe("AsyncFunction");
  });

  it("consultarTasaDolar('resumen') sirve el latest del doc vivo inyectado", async () => {
    const { consultarTasaDolar } = require("../src/tools/tasa.js");
    const liveDoc = {
      latest: {
        fecha: "2026-06-10",
        compra: 58.5264,
        venta: 59.3263,
        promedio: 58.9264,
        var_dia_pct: 0.5829,
        var_30d_pct: -0.417,
      },
      serie: [
        { fecha: "2026-06-10", compra: 58.5264, venta: 59.3263, promedio: 58.9264 },
        { fecha: "2026-06-09", compra: 58.4112, venta: 58.9825, promedio: 58.6969 },
      ],
      updated_at: "2026-06-11T00:00:00Z",
    };
    const out = await consultarTasaDolar(
      { detalle: "resumen" },
      { getRedis: async () => null, loadDoc: async () => liveDoc }
    );
    expect(out.ok).toBe(true);
    expect(out.latest.venta).toBe(59.3263);
    expect(out.latest.var_dia_pct).toBe(0.5829);
    expect(out.serie).toBeUndefined(); // resumen no incluye serie
  });

  it("consultarTasaDolar('serie', dias) acota la serie", async () => {
    const { consultarTasaDolar } = require("../src/tools/tasa.js");
    const liveDoc = {
      latest: { fecha: "2026-06-10", compra: 58.5, venta: 59.3, promedio: 58.9 },
      serie: Array.from({ length: 30 }, (_, i) => ({
        fecha: `2026-05-${String(30 - i).padStart(2, "0")}`,
        compra: 58,
        venta: 59,
        promedio: 58.5,
      })),
      updated_at: "2026-06-11T00:00:00Z",
    };
    const out = await consultarTasaDolar(
      { detalle: "serie", dias: 5 },
      { getRedis: async () => null, loadDoc: async () => liveDoc }
    );
    expect(out.ok).toBe(true);
    expect(out.serie).toHaveLength(5);
    expect(out.serie[0]).toHaveProperty("fecha");
    expect(out.serie[0]).not.toHaveProperty("var_dia_pct"); // proyección limpia
  });

  it("degrada con ok:false y guard anti-invento si no hay datos (sin seed en disco)", async () => {
    const { consultarTasaDolar } = require("../src/tools/tasa.js");
    const out = await consultarTasaDolar(
      { detalle: "resumen" },
      { getRedis: async () => null, loadDoc: async () => ({ latest: null, serie: [] }) }
    );
    expect(out.ok).toBe(false);
    expect(out.latest).toBeNull();
    expect(out.warning).toMatch(/NO inventes/i);
  });

  it("degrada con ok:false si loadDoc revienta (Redis caído)", async () => {
    const { consultarTasaDolar } = require("../src/tools/tasa.js");
    const out = await consultarTasaDolar(
      {},
      {
        getRedis: async () => {
          throw new Error("redis caído");
        },
      }
    );
    expect(out.ok).toBe(false);
    expect(out.latest).toBeNull();
  });
});

describe("TASA — disciplina Fase 1: NO cableada a Mateo", () => {
  it("consultar_tasa_dolar NO está en TOOLS[] de message.js (se activa en Fase 2)", () => {
    const messageHandler = readFileSync("src/handlers/message.js", "utf8");
    expect(messageHandler).not.toContain("TOOL_CONSULTAR_TASA");
    expect(messageHandler).not.toContain("consultar_tasa_dolar");
    expect(messageHandler).not.toContain('require("../tools/tasa")');
  });
});
