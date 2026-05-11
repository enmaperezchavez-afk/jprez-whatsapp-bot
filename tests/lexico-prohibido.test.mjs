// Hotfix-23 V3.6 — Léxico prohibido (Director veto explicito).
//
// Estos tests garantizan que dos patrones VETADOS por el Director en el
// doc V3.6 NUNCA aparecen como uso positivo en el codigo de produccion:
//
//   1. "bajas $X" — Director lo vetó en el diccionario §3. Usar "pones $X"
//      o "el 10% son $X" o "$X para apartar".
//   2. "Bono Primera Vivienda" como OFERTA positiva — JPREZ no califica
//      como Vivienda Bajo Costo en DGII. Solo permitido en contexto
//      "JPREZ NO aplica" / "no califican" / aclaración honesta.
//
// Si estos tests fallan, alguien re-introdujo el lexico vetado y se debe
// auditar antes de mergear.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { OVERRIDES_LAYER } = require("../src/prompts/overrides-layer");
const { STYLE_LAYER } = require("../src/prompts/style-layer");
const { COMMERCIAL_LAYER } = require("../src/prompts/commercial-layer");
const { GLOSSARY_LAYER } = require("../src/prompts/glossary-layer");
const { MATEO_PROMPT_V5_2 } = require("../src/prompts");

const VENDEDOR_SKILL = readFileSync(".claude/skills/vendedor-whatsapp-jprez/SKILL.md", "utf-8");
const CALCULATOR_SKILL = readFileSync(".claude/skills/calculadora-plan-pago/SKILL.md", "utf-8");
const MARKET_RD_SKILL = readFileSync(".claude/skills/mercado-inmobiliario-rd/SKILL.md", "utf-8");

// Pattern "bajas $X" o "bajas US$X" (cualquier moneda) — uso positivo
// como conector de venta. Director veto.
const BAJAS_POSITIVE = /\bbajas?\s+(US)?\$/i;

describe("Hotfix-23 V3.6 — lexico prohibido 'bajas $X'", () => {
  it("OVERRIDES_LAYER no contiene 'bajas $X' como conector positivo", () => {
    // El layer puede mencionar 'bajas' en contexto de regla negativa
    // ("NUNCA digas 'bajas $X'" / dentro de la lista VETADAS).
    // Ventana amplia (300 chars) para capturar el header de seccion vetada.
    const matches = [...OVERRIDES_LAYER.matchAll(/\bbajas?\s+(US)?\$/gi)];
    for (const m of matches) {
      const start = Math.max(0, m.index - 300);
      const end = Math.min(OVERRIDES_LAYER.length, m.index + 100);
      const ctx = OVERRIDES_LAYER.slice(start, end);
      expect(ctx).toMatch(/NUNCA|VETAD|vetad|prohibid|no usar|cero|no-JPREZ/i);
    }
  });

  it("STYLE_LAYER no contiene 'bajas $X' como conector positivo", () => {
    const matches = [...STYLE_LAYER.matchAll(/\bbajas?\s+(US)?\$/gi)];
    for (const m of matches) {
      const start = Math.max(0, m.index - 200);
      const end = Math.min(STYLE_LAYER.length, m.index + 100);
      const ctx = STYLE_LAYER.slice(start, end);
      expect(ctx).toMatch(/NUNCA|vetad|prohibid|no usar/i);
    }
  });

  it("COMMERCIAL_LAYER no contiene 'bajas $X' como conector positivo", () => {
    expect(COMMERCIAL_LAYER).not.toMatch(BAJAS_POSITIVE);
  });

  it("GLOSSARY_LAYER no contiene 'bajas $X'", () => {
    expect(GLOSSARY_LAYER).not.toMatch(BAJAS_POSITIVE);
  });

  it("Skills .md no contienen 'bajas $X' (vendedor / calculadora / mercado-rd)", () => {
    expect(VENDEDOR_SKILL).not.toMatch(BAJAS_POSITIVE);
    expect(CALCULATOR_SKILL).not.toMatch(BAJAS_POSITIVE);
    expect(MARKET_RD_SKILL).not.toMatch(BAJAS_POSITIVE);
  });

  it("MATEO_V5_2 no contiene 'bajas $X' (cardinal — hash intocable)", () => {
    expect(MATEO_PROMPT_V5_2).not.toMatch(BAJAS_POSITIVE);
  });
});

describe("Hotfix-23 V3.6 — Bono Primera Vivienda solo en contexto negativo", () => {
  function findBPVMatches(text) {
    return [...text.matchAll(/Bono Primera Vivienda|BONO PRIMERA VIVIENDA/g)];
  }

  function isInNegativeContext(text, matchIndex) {
    // Aceptamos BPV mention si en una ventana de ±400 chars aparece
    // contexto explicito de "no aplica" / "NO ofrece" / "no califican" /
    // "estatus DGII" / "vetado" / "POR QUÉ JPREZ NO". Ventana amplia
    // porque la seccion entera "POR QUÉ JPREZ NO OFRECE BPV" pone el
    // contexto negativo al principio y luego explica detalles.
    const start = Math.max(0, matchIndex - 400);
    const end = Math.min(text.length, matchIndex + 400);
    const ctx = text.slice(start, end);
    return /no aplica|NO ofrece|NO califica|no califican|estatus DGII|vetad|NUNCA prometer|NUNCA mencion|POR QUÉ JPREZ|por qué JPREZ|honestidad|aclar|no es decisi[oó]n|honesto/i.test(ctx);
  }

  it("OVERRIDES_LAYER: toda mencion BPV en contexto negativo", () => {
    const matches = findBPVMatches(OVERRIDES_LAYER);
    expect(matches.length).toBeGreaterThan(0); // sanity: si decimos algo de BPV
    for (const m of matches) {
      expect(isInNegativeContext(OVERRIDES_LAYER, m.index)).toBe(true);
    }
  });

  it("MARKET_RD_SKILL: toda mencion BPV en contexto negativo", () => {
    const matches = findBPVMatches(MARKET_RD_SKILL);
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      expect(isInNegativeContext(MARKET_RD_SKILL, m.index)).toBe(true);
    }
  });

  it("VENDEDOR_SKILL no menciona BPV (no le toca explicar bonos)", () => {
    expect(findBPVMatches(VENDEDOR_SKILL).length).toBe(0);
  });

  it("CALCULATOR_SKILL no menciona BPV", () => {
    expect(findBPVMatches(CALCULATOR_SKILL).length).toBe(0);
  });

  it("MATEO_V5_2 no menciona BPV (cardinal — hash intocable)", () => {
    expect(findBPVMatches(MATEO_PROMPT_V5_2).length).toBe(0);
  });
});
