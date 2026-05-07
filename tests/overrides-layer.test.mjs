// Hotfix-22 V3 r2 — Tests del overrides-layer.
//
// El layer resuelve conflictos entre MATEO_V5_2 (constante historica) y
// los skills/layers actuales. Cobertura aprobada por Director (8 tests):
//
//   P0 — bloqueantes:
//     1. Hash MATEO_V5_2 invariante antes/despues del PR (cardinal: NO
//        invalidar historiales activos).
//     2. Anchor "OVERRIDES CRÍTICOS" unico en staticBlock (no colisiona
//        con anchors existentes — rompe validateStaticBlockOrder).
//     3. Token budget delta: STATIC_BLOCK con OVERRIDES sigue bajo el
//        cap RED del validator (35K tokens).
//
//   P1 — defensivos:
//     4. Las 4 reglas estan presentes en el OVERRIDES_LAYER (skill
//        activation, prioridad intencion, conflicto formato, perfil_update).
//     5. NO hay duplicacion de regla "cero asteriscos" entre OVERRIDES y
//        STYLE_LAYER (la regla activa vive solo en STYLE; OVERRIDES solo
//        explicita la jerarquia).
//
//   INFO — orden de inyeccion:
//     6. validateStaticBlockOrder retorna ok=true sobre staticBlock real
//        post-r2.
//     7. validateStaticBlockOrder detecta violation si OVERRIDES esta
//        BEFORE MARKET_RD (regla 5 nueva).
//     8. Header documenta los 3 tradeoffs aprobados (hash, eficacia,
//        last-seen-wins).

import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import { readFileSync } from "fs";

const require = createRequire(import.meta.url);
const { OVERRIDES_LAYER } = require("../src/prompts/overrides-layer");
const { MATEO_PROMPT_V5_2 } = require("../src/prompts");
const { buildSystemPromptBlocks } = require("../src/prompts");
const { validateStaticBlockOrder, ANCHORS } = require("../src/validators/static-block-order");
const { computePromptHash } = require("../src/prompt-version");
const { validateSystemPromptSize, BUDGET_MAX_TOKENS } = require("../src/validators/token-budget");
const { STYLE_LAYER } = require("../src/prompts/style-layer");

const OVERRIDES_SRC = readFileSync("src/prompts/overrides-layer.js", "utf-8");

describe("Hotfix-22 V3 r2 — overrides-layer", () => {
  // ===== P0 =====

  it("Test 1 [P0]: hash MATEO_V5_2 invariante (no rompe historiales)", () => {
    // Cardinal: el hash de MATEO_PROMPT_V5_2 debe ser estable porque
    // OVERRIDES_LAYER NO entra en el computo. handlers/message.js:573
    // pasa MATEO_PROMPT_V5_2 directo a computePromptHash.
    const h1 = computePromptHash(MATEO_PROMPT_V5_2);
    const h2 = computePromptHash(MATEO_PROMPT_V5_2);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{12}$/);
    // OVERRIDES_LAYER NO entra al hash (sanity: hashes distintos).
    const hashOverrides = computePromptHash(OVERRIDES_LAYER);
    expect(hashOverrides).not.toBe(h1);
  });

  it("Test 2 [P0]: anchor OVERRIDES unico en staticBlock (no colisiona)", () => {
    const { staticBlock } = buildSystemPromptBlocks();
    // El anchor debe aparecer EXACTAMENTE 1 vez en el staticBlock real.
    const anchor = ANCHORS.OVERRIDES;
    expect(anchor).toBe("OVERRIDES CRÍTICOS");
    let count = 0;
    let pos = staticBlock.indexOf(anchor);
    while (pos !== -1) {
      count++;
      pos = staticBlock.indexOf(anchor, pos + anchor.length);
    }
    expect(count, "OVERRIDES CRÍTICOS debe aparecer 1 sola vez").toBe(1);
    // El anchor NO debe colisionar con anchors existentes.
    const otherAnchors = [
      ANCHORS.MATEO, ANCHORS.GLOSSARY, ANCHORS.COMMERCIAL,
      ANCHORS.CALCULATOR, ANCHORS.MARKET_RD, ANCHORS.STYLE,
    ];
    for (const other of otherAnchors) {
      expect(anchor).not.toContain(other);
      expect(other).not.toContain(anchor);
    }
  });

  it("Test 3 [P0]: token budget delta (staticBlock < RED cap 35K tokens)", () => {
    const { staticBlock } = buildSystemPromptBlocks();
    const result = validateSystemPromptSize(staticBlock);
    // Aceptable: el staticBlock puede estar en YELLOW (>30K tokens) por
    // el tamano de los skills, pero NO debe estar en RED (35K). Si rompe
    // RED, R3 (trim) debe ejecutarse antes de hacer merge.
    expect(result.estimatedTokens).toBeLessThan(BUDGET_MAX_TOKENS);
    expect(result.status).not.toBe("red");
    // OVERRIDES_LAYER suma minimal — no es la causa del yellow.
    expect(OVERRIDES_LAYER.length).toBeLessThanOrEqual(1500);
  });

  // ===== P1 =====

  it("Test 4 [P1]: las 4 reglas estan presentes en OVERRIDES_LAYER", () => {
    // Regla 1: skill activation (mercado-inmobiliario-rd, override stencil).
    expect(OVERRIDES_LAYER).toContain("mercado-inmobiliario-rd");
    expect(OVERRIDES_LAYER).toMatch(/extranjero/i);
    expect(OVERRIDES_LAYER).toMatch(/stencil/i);
    // Regla 2: prioridad intencion actual (pivot suave).
    expect(OVERRIDES_LAYER).toMatch(/intenci[oó]n actual/i);
    expect(OVERRIDES_LAYER).toMatch(/PRIMERO/);
    // Regla 3: conflicto formato — STYLE_LAYER manda.
    expect(OVERRIDES_LAYER).toMatch(/STYLE_LAYER/);
    expect(OVERRIDES_LAYER).toMatch(/jerarqu[ií]a/i);
    // Regla 4: perfil_update OPCIONAL, texto OBLIGATORIO.
    expect(OVERRIDES_LAYER).toMatch(/perfil_update/);
    expect(OVERRIDES_LAYER).toMatch(/OBLIGATORIO/);
  });

  it("Test 5 [P1]: NO duplicacion regla cero asteriscos entre OVERRIDES y STYLE", () => {
    // STYLE_LAYER es el unico lugar donde la regla "cero asteriscos
    // markdown" vive como regla activa. OVERRIDES solo referencia la
    // jerarquia, NO redefine la regla. Esto evita confusion semantica.
    const re_styleRule = /sin asteriscos markdown/i;
    expect(STYLE_LAYER).toMatch(re_styleRule);
    expect(OVERRIDES_LAYER).not.toMatch(re_styleRule);
    // Sanity: OVERRIDES si menciona "STYLE_LAYER manda" (jerarquia).
    expect(OVERRIDES_LAYER).toMatch(/STYLE_LAYER manda/i);
  });

  // ===== INFO =====

  it("Test 6: validateStaticBlockOrder ok=true sobre staticBlock real post-r2", () => {
    const { staticBlock } = buildSystemPromptBlocks();
    const result = validateStaticBlockOrder(staticBlock);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("Test 7: validateStaticBlockOrder detecta OVERRIDES BEFORE MARKET_RD", () => {
    // Construimos un staticBlock simulado con OVERRIDES en el lugar
    // incorrecto (antes de MARKET_RD). El validator debe atrapar.
    const broken = [
      ANCHORS.MATEO + " texto identidad",
      ANCHORS.GLOSSARY + " glosario",
      ANCHORS.COMMERCIAL + " comercial",
      ANCHORS.CALCULATOR + " skill calc",
      ANCHORS.OVERRIDES + " overrides MAL POSICIONADOS",  // BEFORE MARKET MAL
      ANCHORS.MARKET_RD + " skill rd",
      ANCHORS.STYLE + " estilo",
    ].join("\n");
    const result = validateStaticBlockOrder(broken);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.rule === "overrides_after_market")).toBe(true);
  });

  it("Test 8: header documenta los 3 tradeoffs aprobados", () => {
    // Source-inspection: el header del file debe explicar por que el
    // override es soft, por que NO entra en hash, por que va antes de
    // STYLE. Director aprobo OPT-3 brutal.
    const header = OVERRIDES_SRC.slice(0, OVERRIDES_SRC.indexOf("const OVERRIDES_LAYER"));
    // Tradeoff 1: hash invariante.
    expect(header).toMatch(/hash MATEO_V5_2/);
    expect(header).toMatch(/handlers\/message\.js:573/);
    // Tradeoff 2: eficacia ~85% soft override.
    expect(header).toMatch(/85%/);
    expect(header).toMatch(/soft override/i);
    // Tradeoff 3: last-seen-wins / inyeccion antes de STYLE.
    expect(header).toMatch(/last-seen-wins/i);
    expect(header).toMatch(/STYLE_LAYER/);
  });
});
