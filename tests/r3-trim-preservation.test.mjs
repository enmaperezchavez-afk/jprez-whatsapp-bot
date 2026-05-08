// Hotfix-22 V3 r3 — Tests de preservación post-trim staticBlock.
//
// El trim eliminó meta-content (ARQUITECTURA MATEO REYES, INTEGRACIÓN
// FUTURA JNE, INTEGRACIÓN FUTURA SCRAPING, FUENTES DE VERDAD,
// LECCIONES BRUTAL, CHECKLIST INTEGRACIÓN), duplicaciones (MANEJO
// OBJECIONES + EJEMPLOS de vendedor-jprez que ya viven en MATEO_V5_2),
// pseudocódigo de calculadora (la tool ya implementa la lógica), y
// duplicación inventario↔calculadora (nota cuotas mensuales).
//
// Estos tests verifican que los INTOCABLES siguen presentes:
//   - Hash MATEO_V5_2 invariante (cardinal: cero invalidación
//     historiales activos)
//   - Casos Gladys Mishell 16-403 y 16-412 con números EXACTOS
//   - Precios pivote por proyecto (US$163,400 PP E4, US$73 PP E3
//     estudio, US$138 PP E3 2hab, US$195,300 PP E4 3hab, RD$5,650,000
//     Crux listo)
//   - Data oficial APAP (12.50% nominal, 13.32% TAE) y leyes RD
//     (Ley 189-11, Ley 158-01, RD$5,025,380.75 Bono Primera Vivienda)
//   - "description" del skill mercado-inmobiliario-rd intacta
//     (referenciada por OVERRIDES_LAYER regla 1)
//   - validateStaticBlockOrder retorna ok=true post-trim

import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import { readFileSync } from "fs";

const require = createRequire(import.meta.url);
const { MATEO_PROMPT_V5_2, buildSystemPromptBlocks } = require("../src/prompts");
const { computePromptHash } = require("../src/prompt-version");
const { validateStaticBlockOrder } = require("../src/validators/static-block-order");

const VENDEDOR_SKILL = readFileSync(".claude/skills/vendedor-whatsapp-jprez/SKILL.md", "utf-8");
const INVENTORY = readFileSync(".claude/skills/vendedor-whatsapp-jprez/references/inventario-precios.md", "utf-8");
const CALCULATOR_SKILL = readFileSync(".claude/skills/calculadora-plan-pago/SKILL.md", "utf-8");
const MARKET_RD_SKILL = readFileSync(".claude/skills/mercado-inmobiliario-rd/SKILL.md", "utf-8");

describe("Hotfix-22 V3 r3 — preservación post-trim", () => {
  // ===== INVARIANTES CARDINALES =====

  it("Test 1 [P0]: Hash MATEO_V5_2 invariante = 0b18565e4eb3 (cero invalidación)", () => {
    // El trim NO debe haber tocado MATEO_PROMPT_V5_2. Si el hash cambia,
    // R3 invalida todos los historiales activos en Redis (chat:<phone>).
    const h = computePromptHash(MATEO_PROMPT_V5_2);
    expect(h).toBe("0b18565e4eb3");
  });

  it("Test 2 [P0]: validateStaticBlockOrder.ok=true post-trim", () => {
    const { staticBlock } = buildSystemPromptBlocks();
    const r = validateStaticBlockOrder(staticBlock);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  // ===== CASOS GLADYS MISHELL (DIRECTOR INTOCABLE) =====

  it("Test 3 [P0]: Casos Gladys Mishell 16-403 y 16-412 preservados con números exactos", () => {
    expect(CALCULATOR_SKILL).toContain("16-403");
    expect(CALCULATOR_SKILL).toContain("16-412");
    // Caso 16-412 (plan ajustado) números brutales del Director.
    expect(CALCULATOR_SKILL).toContain("$3,308.57");
    expect(CALCULATOR_SKILL).toContain("$708.57");
    expect(CALCULATOR_SKILL).toContain("$86,800");
    expect(CALCULATOR_SKILL).toContain("$124,000");
    // Caso 16-403 (plan tradicional).
    expect(CALCULATOR_SKILL).toContain("$138,400");
    expect(CALCULATOR_SKILL).toContain("$11,840");
    expect(CALCULATOR_SKILL).toContain("$96,880");
    // Frase clave Director.
    expect(CALCULATOR_SKILL).toContain("Yo le ofrecí dividir el 10% en meses");
  });

  // ===== PRECIOS PIVOTE (INTOCABLES) =====

  it("Test 4 [P0]: Precios críticos preservados (PP E3/E4 + Crux listos)", () => {
    // PP E4 — 2hab desde US$163,400, 3hab desde US$195,300.
    expect(INVENTORY).toContain("US$163,400");
    expect(INVENTORY).toContain("US$195,300");
    // PP E3 — estudio US$73K, 2hab US$138K (preservados con su forma textual).
    expect(INVENTORY).toMatch(/\$73,?000|\$73K/);
    expect(INVENTORY).toMatch(/\$138,?000|\$138K/);
    // Crux listos (DOP).
    expect(INVENTORY).toContain("RD$5,650,000");
    // Crux Torre 6 piso 1 mínimo.
    expect(INVENTORY).toContain("$98,292");
  });

  // ===== DATA OFICIAL APAP + LEYES (INTOCABLE) =====

  it("Test 5 [P0]: Data oficial APAP + leyes RD preservadas en mercado-inmobiliario-rd", () => {
    // APAP scrapeado oficial (PDF abril 2026).
    expect(MARKET_RD_SKILL).toContain("12.50%");
    expect(MARKET_RD_SKILL).toContain("13.32%");
    expect(MARKET_RD_SKILL).toContain("APAP");
    // Leyes intocables (Director marcó).
    expect(MARKET_RD_SKILL).toContain("Ley 189-11");
    expect(MARKET_RD_SKILL).toContain("Ley 158-01");
    // Bono Primera Vivienda tope 2026.
    expect(MARKET_RD_SKILL).toContain("5,025,380.75");
    // CONFOTUR + IPI.
    expect(MARKET_RD_SKILL).toContain("CONFOTUR");
    expect(MARKET_RD_SKILL).toContain("IPI");
  });

  // ===== description DEL SKILL mercado-rd (REFERENCIADA POR OVERRIDES) =====

  it("Test 6 [P0]: description del skill mercado-rd intacta (override regla 1 la referencia)", () => {
    // El frontmatter "description" es lo que el OVERRIDES_LAYER regla 1
    // referencia para activar el skill ante triggers (banco, fideicomiso,
    // CONFOTUR, etc). Si el trim accidentalmente toca el frontmatter,
    // rompe el override.
    const frontmatter = MARKET_RD_SKILL.slice(0, MARKET_RD_SKILL.indexOf("---", 4));
    expect(frontmatter).toContain("name: mercado-inmobiliario-rd");
    expect(frontmatter).toContain("description:");
    // Triggers críticos del description.
    expect(frontmatter).toContain("banco");
    expect(frontmatter).toContain("financiamiento");
    expect(frontmatter).toContain("fideicomiso");
    expect(frontmatter).toContain("extranjero");
    expect(frontmatter).toContain("CONFOTUR");
    expect(frontmatter).toContain("Bono Primera Vivienda");
    expect(frontmatter).toContain("Ley 189-11");
  });

  // ===== INVARIANTES VENDEDOR-JPREZ (REGLAS DE ORO + PROMOCIÓN) =====

  it("Test 7 [P1]: Reglas de oro 1-14 + Promoción Feria Mayo preservadas en vendedor-jprez", () => {
    // 14 reglas de oro críticas.
    expect(VENDEDOR_SKILL).toMatch(/Reglas de oro/i);
    // Promoción Feria Mayo (vigencia hasta 31 mayo 2026).
    expect(VENDEDOR_SKILL).toContain("Feria de Mayo 2026");
    expect(VENDEDOR_SKILL).toContain("31 de mayo");
    // Advertencia E3 vs E4 (precios + tamaños distintos).
    expect(VENDEDOR_SKILL).toContain("US$73,000");
    expect(VENDEDOR_SKILL).toContain("ADVERTENCIA");
    // Identidad empresa + 1300 unidades + 23 años.
    expect(VENDEDOR_SKILL).toContain("Constructora JPREZ");
    expect(VENDEDOR_SKILL).toContain("1,300");
    expect(VENDEDOR_SKILL).toContain("23 años");
  });

  // ===== TRIM EFECTIVO — meta-content removido =====

  it("Test 8 [P1]: meta-content removido del prompt (ARQUITECTURA, INTEGRACIÓN FUTURA, CHECKLIST)", () => {
    // Estas secciones NO deben aparecer en los skills (eran meta para
    // Director/dev, no operativas para Mateo).
    expect(VENDEDOR_SKILL).not.toContain("ARQUITECTURA MATEO REYES");
    expect(VENDEDOR_SKILL).not.toContain("Pipeline end-to-end por mensaje");
    expect(CALCULATOR_SKILL).not.toContain("INTEGRACIÓN FUTURA — JNE NEGOTIATOR");
    expect(CALCULATOR_SKILL).not.toContain("calcular_plan_pago_v2");
    expect(CALCULATOR_SKILL).not.toContain("CHECKLIST INTEGRACIÓN");
    expect(MARKET_RD_SKILL).not.toContain("INTEGRACIÓN FUTURA — SCRAPING");
    expect(MARKET_RD_SKILL).not.toContain("LECCIONES BRUTAL APRENDIDAS");
  });
});
