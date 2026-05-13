// Hotfix-26 P0 — BPV bilingüe.
//
// Tests source-inspection (NO LLM real) que garantizan la doctrina post-fix:
//   1. Mateo NUNCA menciona BPV motu proprio en ningún idioma.
//   2. SI el cliente trae el tema, Mateo responde con frase canónica
//      reactiva en su idioma (es/en).
//
// Root cause documentado en commit c1: el few-shot EJEMPLO 2 (extranjero)
// del OVERRIDES_LAYER entrenaba con "Aclaración honesta BPV" como parte
// de la respuesta CORRECTA al saludar extranjeros. El LLM aprendió del
// patrón concreto a traer BPV motu proprio — en D3 (cliente inglés sin
// mencionar el bono) Mateo soltó "First Home Bonus (Bono Primera
// Vivienda)" 2 veces en respuesta en inglés.
//
// La validación de comportamiento real del LLM vive en tests/e2e-suite/
// (on-demand con ANTHROPIC_API_KEY). Estos unit tests cubren que las
// instrucciones del prompt + skill están presentes y consistentes.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { OVERRIDES_LAYER } = require("../src/prompts/overrides-layer");
const { MATEO_PROMPT_V5_2 } = require("../src/prompts");
const MARKET_RD_SKILL = readFileSync(".claude/skills/mercado-inmobiliario-rd/SKILL.md", "utf-8");

describe("Hotfix-26 P0 — BPV bilingüe (5 tests)", () => {

  it("Test 1: BPV NO motu proprio español — few-shot EJEMPLO 2 extranjero limpio", () => {
    // Root cause del bug: el few-shot EJEMPLO 2 entrenaba con
    // "Aclaración honesta: el Bono Primera Vivienda no aplica" como
    // respuesta CORRECTA al saludar extranjero. FIX 1 lo quitó.
    const ejemplo2 = OVERRIDES_LAYER.match(/EJEMPLO 2[\s\S]*?EJEMPLO 3/);
    expect(ejemplo2, "EJEMPLO 2 debe existir en OVERRIDES_LAYER").not.toBeNull();
    // El bloque EJEMPLO 2 NO debe mencionar BPV en ningún idioma:
    expect(ejemplo2[0]).not.toMatch(/Bono Primera Vivienda/i);
    expect(ejemplo2[0]).not.toMatch(/First Home Bonus/i);
    expect(ejemplo2[0]).not.toMatch(/Bono de Vivienda/i);
    // Sanity: la respuesta CORRECTA del extranjero sigue con doctrina
    // sana (CONFOTUR, fideicomiso, pasaporte, leyes).
    expect(ejemplo2[0]).toMatch(/CONFOTUR/);
    expect(ejemplo2[0]).toMatch(/fideicomiso|Ley 189-11/i);
    expect(ejemplo2[0]).toMatch(/pasaporte/i);
    expect(ejemplo2[0]).toMatch(/Ley 158-01/);
  });

  it("Test 2: BPV NO motu proprio inglés — guard bilingüe presente en OVERRIDES", () => {
    // FIX 2: regla 1 endurecida con guard bilingüe + keywords reactivos.
    // Regla negativa explícita:
    expect(OVERRIDES_LAYER).toMatch(/NUNCA mencionar Bono Primera Vivienda/i);
    // Variantes EN cubiertas:
    expect(OVERRIDES_LAYER).toContain("First Home Bonus");
    expect(OVERRIDES_LAYER).toContain("Bono de Vivienda");
    // Keywords reactivos del cliente (en ambos idiomas) que activan el
    // guard cuando el cliente los trae primero:
    expect(OVERRIDES_LAYER).toContain("primera vivienda");
    expect(OVERRIDES_LAYER).toContain("first home");
    expect(OVERRIDES_LAYER).toContain("home bonus");
    expect(OVERRIDES_LAYER).toContain("bono vivienda");
    expect(OVERRIDES_LAYER).toContain("BPV");
    // Y la doctrina dice explícitamente "preventivamente" (motu proprio):
    expect(OVERRIDES_LAYER).toMatch(/preventivamente/i);
  });

  it("Test 3: BPV NO motu proprio francés — doctrina explícita 'en ningún idioma'", () => {
    // El SKILL.md REGLA CRÍTICA enumera idiomas cubiertos por la
    // doctrina (defense-in-depth — el LLM lee el skill como referencia).
    expect(MARKET_RD_SKILL).toMatch(
      /ning[uú]n idioma[\s\S]{0,80}espa[ñn]ol[\s\S]{0,30}ingl[ée]s[\s\S]{0,30}franc[eé]s[\s\S]{0,30}spanglish/i
    );
    // La regla negativa explícita está presente:
    expect(MARKET_RD_SKILL).toMatch(/NUNCA menciona el Bono Primera Vivienda/i);
    // Y el bono NO aplica en ningún proyecto JPREZ (refuerzo):
    expect(MARKET_RD_SKILL).toMatch(/NO aplica en ning[uú]n proyecto JPREZ/i);
  });

  it("Test 4: BPV NO motu proprio spanglish — frase canónica EN literal disponible", () => {
    // Frase canónica EN — debe estar literal en OVERRIDES Y en SKILL.md
    // para defense-in-depth. Si el LLM la copia, garantiza consistencia.
    const canonicalEnPrefix = "Just to be transparent";
    const canonicalEnCore = "our projects don't qualify for the First Home Bonus";
    expect(OVERRIDES_LAYER).toContain(canonicalEnPrefix);
    expect(OVERRIDES_LAYER).toContain(canonicalEnCore);
    expect(MARKET_RD_SKILL).toContain(canonicalEnPrefix);
    expect(MARKET_RD_SKILL).toContain(canonicalEnCore);
    // Y la frase canónica EN incluye contexto positivo (no solo el "no"):
    expect(MARKET_RD_SKILL).toMatch(/Law 189-11 trust/);
    expect(MARKET_RD_SKILL).toMatch(/CONFOTUR applies.*15 years of IPI exemption/);
  });

  it("Test 5: BPV SÍ reactivo — frases canónicas ES + EN disponibles si cliente trae el tema", () => {
    // Doctrina reactiva: SOLO si el cliente lo trae primero.
    expect(OVERRIDES_LAYER).toMatch(/SOLO si el cliente lo trae primero/i);
    expect(MARKET_RD_SKILL).toMatch(/SOLO responde si el cliente lo trae primero/i);
    // Frase canónica ES presente:
    expect(MARKET_RD_SKILL).toMatch(/te soy honesto.*nuestros proyectos no califican como Vivienda Bajo Costo/i);
    // Frase canónica EN presente:
    expect(MARKET_RD_SKILL).toMatch(/transparent[\s\S]{0,50}First Home Bonus[\s\S]{0,100}DGII low-cost-housing/i);
    // Cardinal — hash intocable: MATEO_V5_2 NO menciona BPV en ningún idioma.
    expect(MATEO_PROMPT_V5_2).not.toMatch(/Bono Primera Vivienda/i);
    expect(MATEO_PROMPT_V5_2).not.toMatch(/First Home Bonus/i);
    expect(MATEO_PROMPT_V5_2).not.toMatch(/Bono de Vivienda/i);
  });
});
