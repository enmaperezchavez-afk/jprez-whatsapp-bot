// Hotfix-22 V3.5 (R6) — Tests source-inspection del refuerzo OVERRIDES.
//
// El smoke final V3 mostro que la activacion del skill mercado-rd seguia
// ~60% (extranjero info corta, banco sin tasas APAP, mal consejo timing
// pre-aprobacion). R6 refuerza la regla 1 del OVERRIDES_LAYER con 3
// few-shot examples brutal (caso INCORRECTO + CORRECTO).
//
// Estos tests verifican source-inspection (NO LLM real) que el OVERRIDES
// post-R6 contiene los keywords obligatorios. La validacion de
// comportamiento real del LLM vive en el smoke MANUAL del Director
// post-merge — los unit tests no pueden validar inteligencia semantica
// del modelo, solo que las instrucciones esten presentes.
//
// Cobertura:
//   1. Few-shot 1 (banco) presente con tasas APAP exactas.
//   2. Few-shot 2 (extranjero) con CONFOTUR, Bono, Ley 158-01.
//   3. Few-shot 3 (pre-aprobacion timing) con AHORA, no esperar.
//   4. Hash MATEO_V5_2 invariante (cardinal — R6 solo toca OVERRIDES).
//   5. validateStaticBlockOrder.ok=true post-R6.

import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { OVERRIDES_LAYER } = require("../src/prompts/overrides-layer");
const { MATEO_PROMPT_V5_2, buildSystemPromptBlocks } = require("../src/prompts");
const { computePromptHash } = require("../src/prompt-version");
const { validateStaticBlockOrder } = require("../src/validators/static-block-order");

describe("Hotfix-22 V3.5 R6 — skill activation few-shots", () => {

  it("Test 1: few-shot banco presente con tasas APAP exactas (12.50% nominal, 13.32% TAE)", () => {
    expect(OVERRIDES_LAYER).toContain("APAP");
    expect(OVERRIDES_LAYER).toContain("12.50%");
    expect(OVERRIDES_LAYER).toContain("13.32%");
    // El INCORRECTO tambien menciona "Espera a fecha de entrega" (lo malo)
    // y el CORRECTO debe enfatizar "pre-aprobacion AHORA".
    expect(OVERRIDES_LAYER).toMatch(/INCORRECTO/i);
    expect(OVERRIDES_LAYER).toMatch(/CORRECTO/i);
  });

  it("Test 2: few-shot extranjero con CONFOTUR + Bono + leyes 158-01/189-11", () => {
    expect(OVERRIDES_LAYER).toContain("CONFOTUR");
    expect(OVERRIDES_LAYER).toContain("Ley 158-01");
    expect(OVERRIDES_LAYER).toContain("Ley 189-11");
    expect(OVERRIDES_LAYER).toContain("Bono Primera Vivienda");
    expect(OVERRIDES_LAYER).toContain("5,025,380.75");
    // 15 anios IPI exento mencionado.
    expect(OVERRIDES_LAYER).toMatch(/15 a[ñn]os IPI/i);
  });

  it("Test 3: few-shot pre-aprobacion timing — AHORA no esperar a entrega", () => {
    // Caso del Bug #32 del smoke real.
    expect(OVERRIDES_LAYER).toMatch(/pre-aprobaci[oó]n/i);
    expect(OVERRIDES_LAYER).toMatch(/AHORA/);
    // Frase clave: "no esperar a la entrega".
    expect(OVERRIDES_LAYER.toLowerCase()).toContain("no esperar");
    // Beneficios: poder negociador, fija tasa, demuestra solvencia.
    expect(OVERRIDES_LAYER.toLowerCase()).toContain("poder negociador");
  });

  it("Test 4: Hash MATEO_V5_2 invariante = 0b18565e4eb3 (R6 solo toca OVERRIDES)", () => {
    // Cardinal: el trim/refuerzo de OVERRIDES NUNCA debe afectar el hash.
    // Si el hash cambia, todos los historiales activos en Redis se invalidan.
    expect(computePromptHash(MATEO_PROMPT_V5_2)).toBe("0b18565e4eb3");
  });

  it("Test 5: validateStaticBlockOrder.ok=true post-R6", () => {
    const { staticBlock } = buildSystemPromptBlocks();
    const r = validateStaticBlockOrder(staticBlock);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
    // Anchor OVERRIDES sigue unico.
    expect(staticBlock.indexOf("OVERRIDES CRÍTICOS")).toBeGreaterThan(-1);
  });

  it("Test 6: OVERRIDES sigue bajo limite razonable (~3K chars target post-R6)", () => {
    // R6 sumo ~700-1300 chars al original 1487. Target documentado en plan
    // ~2200-2300, realidad ~2700 (las explicaciones brutales del Director
    // son largas). Aceptamos hasta 3500 como sanity max — si rebasa,
    // el plan se desvio y hay que auditarlo.
    expect(OVERRIDES_LAYER.length).toBeLessThan(3500);
    // Sigue sobre el original 1487 (sanity: el refuerzo SI se aplico).
    expect(OVERRIDES_LAYER.length).toBeGreaterThan(2000);
  });
});
