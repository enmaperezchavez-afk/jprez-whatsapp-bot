// MATEO V6 — F2: el compilador de prompt (núcleo + config + ejemplos).
// Default OFF en producción; el A/B del certificador es el gate de F3.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const {
  compileV6Core,
  compileV6HashSource,
  validarConfigMinima,
  NUCLEO_VERSION,
  EJEMPLOS_ORO,
} = require("../src/prompts/compile-v6.js");
const { buildSystemPromptBlocks, isV6Enabled } = require("../src/prompts.js");
const { estimateTokens } = require("../src/validators/token-budget.js");

const CONFIG = JSON.parse(readFileSync("config/tenants/jprez.json", "utf8"));

describe("V6-F2 — compilador", () => {
  const core = compileV6Core(CONFIG);

  it("compila identidad + doctrina + escalera + reglas + handoff desde la config", () => {
    expect(core).toContain("Eres Mateo Reyes");
    expect(core).toContain("Constructora JPREZ");
    expect(core).toContain("LA ESCALERA");
    expect(core).toContain("US$1,500");
    expect(core).toMatch(/Jamás anuncies que es el tope/);
    expect(core).toContain("plan base 5/25/70"); // Crux T6 doctrinal (Hotfix-33)
    expect(core).toContain("Crux del Prado — Torre 6 [crux_t6]");
    expect(core).toContain("SIN cláusula ICDV"); // crux_listos
    expect(core).toContain(CONFIG.doctrina.handoff_canonico_es);
    expect(core).toContain("[R4]"); // reglas duras numeradas con id
    expect(core).toContain("EJEMPLOS DE ORO");
  });

  it("los 3 ejemplos de oro del Sprint 1.9 (fusionado) atacan los fallos medidos", () => {
    expect(EJEMPLOS_ORO).toMatch(/NUNCA: "te puedo dar hasta US\$X"/);
    expect(EJEMPLOS_ORO).toMatch(/consultar_tasa_dolar/);
    expect(EJEMPLOS_ORO).toMatch(/NUNCA validar la tasa del cliente/);
    expect(EJEMPLOS_ORO).toMatch(/no te voy a inventar un número/);
  });

  it("una sola fuente: el compilado NO contiene contra-instrucciones", () => {
    expect(core).not.toMatch(/ANULA cualquier/);
    expect(core).not.toMatch(/queda ANULADA/);
    expect(core).not.toMatch(/otras capas/);
  });

  it("fail-closed: config rota no compila", () => {
    expect(() => compileV6Core(null)).toThrow(/config inválida/);
    expect(() => compileV6Core({ ...CONFIG, prompt_version: 0 })).toThrow(/prompt_version/);
    expect(() =>
      compileV6Core({
        ...CONFIG,
        proyectos: [{ ...CONFIG.proyectos[0], plan_base: [5, 25, 80] }],
      })
    ).toThrow(/no suma 100/);
    expect(() =>
      compileV6Core({
        ...CONFIG,
        doctrina: { ...CONFIG.doctrina, escalera: { ...CONFIG.doctrina.escalera, revelar_tope: true } },
      })
    ).toThrow(/revelar_tope/);
    expect(() => validarConfigMinima(CONFIG)).not.toThrow();
  });

  it("hash source: estable por núcleo+tenant+versión, cambia con bump deliberado", () => {
    const h1 = compileV6HashSource(CONFIG);
    expect(h1).toBe("mateo-v6:" + NUCLEO_VERSION + ":jprez:1");
    const h2 = compileV6HashSource({ ...CONFIG, prompt_version: 2 });
    expect(h2).not.toBe(h1);
  });
});

describe("V6-F2 — flag y presupuesto", () => {
  it("default OFF: sin PROMPT_V6 el bot sigue en V5.2", () => {
    const prev = process.env.PROMPT_V6;
    delete process.env.PROMPT_V6;
    expect(isV6Enabled()).toBe(false);
    expect(buildSystemPromptBlocks().v6).toBe(false);
    process.env.PROMPT_V6 = "1";
    expect(isV6Enabled()).toBe(true);
    if (prev === undefined) delete process.env.PROMPT_V6;
    else process.env.PROMPT_V6 = prev;
  });

  it("opts.v6 explícito manda sobre el flag (lo usa el A/B)", () => {
    const v5 = buildSystemPromptBlocks({ v6: false });
    const v6 = buildSystemPromptBlocks({ v6: true });
    expect(v5.v6).toBe(false);
    expect(v6.v6).toBe(true);
    expect(v6.staticBlock).toContain("EJEMPLOS DE ORO");
    expect(v5.staticBlock).not.toContain("EJEMPLOS DE ORO");
    // ambos conservan inventario vivo + skills operativos
    expect(v6.staticBlock).toContain("INVENTARIO Y PRECIOS DETALLADOS");
    expect(v6.staticBlock).toMatch(/REAJUSTE ICDV/);
  });

  it("presupuesto: V6 es radicalmente más chico que V5 (≥40% menos tokens)", () => {
    const v5 = estimateTokens(buildSystemPromptBlocks({ v6: false }).staticBlock);
    const v6 = estimateTokens(buildSystemPromptBlocks({ v6: true }).staticBlock);
    expect(v6).toBeLessThan(v5 * 0.6);
  });
});
