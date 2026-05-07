// Hotfix-22 V2 b4 — Tests del staticBlock order guard.
//
// Cobertura (4 tests, no 3 — agregue uno extra para casos defensivos):
//   1. validateStaticBlockOrder retorna ok=true sobre el orden REAL
//      del repo (sanity: el guard NO falsifica el invariante actual).
//   2. ok=false si STYLE_LAYER aparece ANTES de los skills.
//   3. ok=false si MATEO_V5_2 falta o GLOSSARY aparece antes que MATEO.
//   4. Defensive: input no-string -> violations + ok=false.

import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { validateStaticBlockOrder, ANCHORS } = require("../src/validators/static-block-order");
const { buildSystemPromptBlocks } = require("../src/prompts");

describe("Hotfix-22 V2 b4 — static-block-order guard", () => {
  it("Test 1: orden real del repo (post-Hotfix-22 V2 a3) es OK", () => {
    const { staticBlock } = buildSystemPromptBlocks();
    const result = validateStaticBlockOrder(staticBlock);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("Test 2: STYLE_LAYER antes de skills -> violation 'style_last'", () => {
    // Construimos un staticBlock simulado con STYLE en el medio.
    const broken = [
      "INVENTORY...",
      ANCHORS.MATEO + " texto identidad",
      ANCHORS.GLOSSARY + " glosario",
      ANCHORS.COMMERCIAL + " comercial",
      ANCHORS.STYLE + " estilo PRIMERO MAL",   // STYLE aqui MAL
      ANCHORS.CALCULATOR + " skill calc",
      ANCHORS.MARKET_RD + " skill rd",
    ].join("\n");

    const result = validateStaticBlockOrder(broken);
    expect(result.ok).toBe(false);
    // Debe haber al menos una violation 'style_last' por skills despues de STYLE.
    const styleLastViolations = result.violations.filter((v) => v.rule === "style_last");
    expect(styleLastViolations.length).toBeGreaterThanOrEqual(2);
    // Anchors involucrados: CALCULATOR_SKILL y MARKET_RD_SKILL.
    const anchors = styleLastViolations.map((v) => v.anchor);
    expect(anchors).toContain("CALCULATOR_SKILL");
    expect(anchors).toContain("MARKET_RD_SKILL");
  });

  it("Test 3: MATEO_V5_2 missing + GLOSSARY antes de MATEO -> violations correctas", () => {
    // MATEO ausente.
    const noMateo = [
      ANCHORS.GLOSSARY + " glosario",
      ANCHORS.STYLE + " estilo",
    ].join("\n");
    const r1 = validateStaticBlockOrder(noMateo);
    expect(r1.ok).toBe(false);
    expect(r1.violations.some((v) => v.rule === "mateo_present")).toBe(true);

    // MATEO presente pero GLOSSARY antes.
    const wrongOrder = [
      ANCHORS.GLOSSARY + " glosario PRIMERO MAL",
      ANCHORS.MATEO + " texto identidad",
      ANCHORS.STYLE + " estilo",
    ].join("\n");
    const r2 = validateStaticBlockOrder(wrongOrder);
    expect(r2.ok).toBe(false);
    expect(r2.violations.some((v) => v.rule === "layers_after_mateo")).toBe(true);
  });

  it("Test 4: input no-string retorna ok=false con violation 'input_type'", () => {
    const r1 = validateStaticBlockOrder(null);
    expect(r1.ok).toBe(false);
    expect(r1.violations[0].rule).toBe("input_type");

    const r2 = validateStaticBlockOrder(undefined);
    expect(r2.ok).toBe(false);

    const r3 = validateStaticBlockOrder({ not: "string" });
    expect(r3.ok).toBe(false);

    const r4 = validateStaticBlockOrder(42);
    expect(r4.ok).toBe(false);
  });
});
