// Sprint 1 PR-3 — motor de reajuste ICDV: núcleo puro + tool + wiring.
//
// Decisión de diseño: tool HERMANA de calcular_plan_pago (no extensión).
// La calculadora queda pura/sync; el reajuste trae I/O (serie ICDV viva)
// y produce ESTIMADOS, no números de contrato. calcularPlanPago se
// inyecta por DI desde message.js.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const motor = require("../src/services/reajuste.js");
const { TOOL_PROYECTAR_REAJUSTE, proyectarReajusteTool } = require("../src/tools/reajuste.js");

// Serie ICDV sintética: 240.16 (abr 2026) <- 235.0 (dic 2025), span 4 meses.
const SERIE_LARGA = [
  { periodo: "2026-04", indice: 240.16 },
  { periodo: "2026-03", indice: 238.57 },
  { periodo: "2026-02", indice: 237.1 },
  { periodo: "2026-01", indice: 236.0 },
  { periodo: "2025-12", indice: 235.0 },
];

describe("REAJUSTE — tasaMensualDesdeSerie (CAGR)", () => {
  it("CAGR mensual de la serie: (240.16/235)^(1/4)-1", () => {
    const esperado = (Math.pow(240.16 / 235.0, 1 / 4) - 1) * 100; // ~0.5436%
    expect(motor.tasaMensualDesdeSerie(SERIE_LARGA)).toBeCloseTo(esperado, 3);
  });

  it("serie corta (span < 3 meses) -> null (caller usa ancla)", () => {
    const corta = [
      { periodo: "2026-04", indice: 240.16 },
      { periodo: "2026-03", indice: 238.57 },
    ];
    expect(motor.tasaMensualDesdeSerie(corta)).toBeNull();
  });

  it("serie vacía, null o con entradas malformadas -> null", () => {
    expect(motor.tasaMensualDesdeSerie([])).toBeNull();
    expect(motor.tasaMensualDesdeSerie(null)).toBeNull();
    expect(
      motor.tasaMensualDesdeSerie([
        { periodo: "202-4", indice: 240 },
        { periodo: "2026-04", indice: NaN },
      ])
    ).toBeNull();
  });

  it("ICDV a la baja -> CAGR negativo (estimado honesto, no se inventa piso)", () => {
    const bajista = [
      { periodo: "2026-04", indice: 230.0 },
      { periodo: "2025-12", indice: 235.0 },
    ];
    expect(motor.tasaMensualDesdeSerie(bajista)).toBeLessThan(0);
  });

  it("mesesEntrePeriodos cruza años", () => {
    expect(motor.mesesEntrePeriodos("2025-12", "2026-04")).toBe(4);
    expect(motor.mesesEntrePeriodos("2025-01", "2026-01")).toBe(12);
  });
});

describe("REAJUSTE — proyectarReajuste (insoluto amortizado)", () => {
  // Plan sintético redondo: precio 100k, separación 10k, cuota 5k x 6
  // meses, contra entrega 60k.
  const plan = {
    precio_total_usd: 100000,
    separacion_usd: 10000,
    cuota_mensual_usd: 5000,
    meses_hasta_entrega: 6,
    contra_entrega_usd: 60000,
  };

  it("proyección mes a mes con tasa 0.4%: el insoluto baja con cada cuota", () => {
    // insolutos al inicio de mes: 90k, 85k, 80k, 75k, 70k, 65k -> suma 465k
    // total = 465,000 * 0.004 = 1,860
    const out = motor.proyectarReajuste({ plan, tasaMensualPct: 0.4 });
    expect(out.reajuste_total_estimado_usd).toBe(1860);
    expect(out.insoluto_inicial_usd).toBe(90000);
    expect(out.insoluto_final_usd).toBe(60000); // = contra entrega, donde cesa
    expect(out.meses_proyectados).toBe(6);
    expect(out.reajuste_promedio_mensual_usd).toBe(310);
    expect(out.precio_ajustado_estimado_usd).toBe(101860);
  });

  it("la cláusula cesa al entregar: no proyecta más allá de meses_hasta_entrega", () => {
    const out = motor.proyectarReajuste({ plan: { ...plan, meses_hasta_entrega: 2 }, tasaMensualPct: 0.4 });
    // 90k + 85k = 175k * 0.004 = 700
    expect(out.reajuste_total_estimado_usd).toBe(700);
    expect(out.meses_proyectados).toBe(2);
  });

  it("plan inválido o tasa inválida -> throw (fail-closed)", () => {
    expect(() => motor.proyectarReajuste({ plan: null, tasaMensualPct: 0.4 })).toThrow();
    expect(() => motor.proyectarReajuste({ plan, tasaMensualPct: NaN })).toThrow();
  });

  it("ancla doctrinal expuesta: 0.3-0.5%, punto medio 0.4%", () => {
    expect(motor.ANCLA_DOCTRINAL).toEqual({ min_pct: 0.3, max_pct: 0.5, mid_pct: 0.4 });
  });
});

describe("REAJUSTE — tool proyectar_reajuste (schema + handler)", () => {
  const planFijo = {
    proyecto: "Crux del Prado",
    precio_total_usd: 100000,
    separacion_usd: 10000,
    cuota_mensual_usd: 5000,
    meses_hasta_entrega: 6,
    contra_entrega_usd: 60000,
    entrega_fecha: "2027-07-01",
  };
  const calcularFijo = () => planFijo;

  it("schema Anthropic válido: enum SIN crux_listos (la cláusula no existe ahí)", () => {
    expect(TOOL_PROYECTAR_REAJUSTE.name).toBe("proyectar_reajuste");
    expect(TOOL_PROYECTAR_REAJUSTE.description).toMatch(/ESTIMADO/);
    expect(TOOL_PROYECTAR_REAJUSTE.description).toMatch(/NUNCA.*garantía/i);
    const enumProyectos = TOOL_PROYECTAR_REAJUSTE.input_schema.properties.proyecto.enum;
    expect(enumProyectos).toEqual(["crux", "pr3", "pr4", "puertoPlata"]);
    expect(enumProyectos).not.toContain("crux_listos");
  });

  it("con serie ICDV viva usa el CAGR y lo declara como fuente", async () => {
    const out = await proyectarReajusteTool(
      { proyecto: "crux", precio_usd: 100000 },
      {
        calcularPlanPago: calcularFijo,
        loadLiveSerie: async () => ({ serie: SERIE_LARGA, updated_at: "2026-06-11T00:00:00Z" }),
      }
    );
    expect(out.ok).toBe(true);
    expect(out.estimado).toBe(true);
    expect(out.tasa.fuente).toMatch(/CAGR/);
    expect(out.tasa.mensual_pct).toBeCloseTo((Math.pow(240.16 / 235.0, 1 / 4) - 1) * 100, 3);
    expect(out.proyeccion.reajuste_total_estimado_usd).toBeGreaterThan(0);
    expect(out.plan_base.cuota_mensual_usd).toBe(5000);
    expect(out.nota).toMatch(/cesa al entregar/i);
  });

  it("serie corta -> ancla doctrinal 0.4% declarada como fuente", async () => {
    const out = await proyectarReajusteTool(
      { proyecto: "crux", precio_usd: 100000 },
      {
        calcularPlanPago: calcularFijo,
        loadLiveSerie: async () => ({ serie: [{ periodo: "2026-04", indice: 240.16 }] }),
      }
    );
    expect(out.ok).toBe(true);
    expect(out.tasa.mensual_pct).toBe(0.4);
    expect(out.tasa.fuente).toMatch(/ancla/i);
    // 465,000 * 0.004 = 1,860 (mismo plan sintético del test del motor)
    expect(out.proyeccion.reajuste_total_estimado_usd).toBe(1860);
  });

  it("serie ICDV caída -> ancla (la proyección no muere con Redis)", async () => {
    const out = await proyectarReajusteTool(
      { proyecto: "crux", precio_usd: 100000 },
      {
        calcularPlanPago: calcularFijo,
        loadLiveSerie: async () => {
          throw new Error("redis caído");
        },
      }
    );
    expect(out.ok).toBe(true);
    expect(out.tasa.fuente).toMatch(/ancla/i);
  });

  it("needs_etapa de la calculadora pasa intacto (señal soft Hotfix-30)", async () => {
    const out = await proyectarReajusteTool(
      { proyecto: "puertoPlata", precio_usd: 100000 },
      {
        calcularPlanPago: () => ({ needs_etapa: true, ask_client: "pregunta la etapa" }),
        loadLiveSerie: async () => ({ serie: SERIE_LARGA }),
      }
    );
    expect(out.needs_etapa).toBe(true);
    expect(out.ok).toBeUndefined();
  });

  it("error de la calculadora -> ok:false con el mensaje", async () => {
    const out = await proyectarReajusteTool(
      { proyecto: "crux", precio_usd: 100000 },
      {
        calcularPlanPago: () => ({ error: "Proyecto no reconocido: x" }),
        loadLiveSerie: async () => ({ serie: SERIE_LARGA }),
      }
    );
    expect(out.ok).toBe(false);
    expect(out.warning).toMatch(/no reconocido/);
  });

  it("sin calcularPlanPago inyectada degrada con ok:false (nunca lanza)", async () => {
    const out = await proyectarReajusteTool({ proyecto: "crux", precio_usd: 100000 }, {});
    expect(out.ok).toBe(false);
    expect(out.warning).toMatch(/0\.3-0\.5/);
  });
});

describe("REAJUSTE — wiring a Mateo (Sprint1 PR-3)", () => {
  it("proyectar_reajuste está en TOOLS[] de message.js con DI de calcularPlanPago", () => {
    const messageHandler = readFileSync("src/handlers/message.js", "utf8");
    expect(messageHandler).toContain("TOOL_PROYECTAR_REAJUSTE");
    expect(messageHandler).toContain('require("../tools/reajuste")');
    expect(messageHandler).toMatch(/proyectar_reajuste:/);
    expect(messageHandler).toMatch(/proyectarReajusteTool\(\{ \.\.\.input, etapa \}, \{ calcularPlanPago \}\)/);
  });

  it("la doctrina de proyección vive en la calculadora SKILL, NO en OVERRIDES", () => {
    const skill = readFileSync(".claude/skills/calculadora-plan-pago/SKILL.md", "utf8");
    expect(skill).toContain("proyectar_reajuste");
    expect(skill).toMatch(/ESTIMADO honesto/);
    expect(skill).toMatch(/nunca.*garantía/i);
    const overrides = readFileSync("src/prompts/overrides-layer.js", "utf8");
    expect(overrides).not.toContain("proyectar_reajuste");
  });
});
