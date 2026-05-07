// Hotfix-22 c2 — Skill mercado-inmobiliario-rd.
//
// Conocimiento del mercado inmobiliario dominicano (bancos, fideicomiso
// Ley 189-11, Bono Primera Vivienda, CONFOTUR, proceso de compra,
// impuestos, asesoria a extranjeros). Loader independiente
// (MARKET_RD_SKILL_CONTENT) inyectado al final del staticBlock, despues
// del skill calculadora. NO va en el hash de MATEO_V5_2 — agregar/iterar
// no invalida historiales.
//
// Cobertura (8 tests):
//   Smoke (skill como archivo):
//     1. Archivo existe y tamano razonable (> 10KB).
//     2. Frontmatter YAML valido (delimitadores + name + description).
//     3. description menciona triggers clave de activacion.
//     4. Markdown tiene secciones criticas.
//     5. APAP con tasa actualizada 12.50%/13.32% TAE (data real abril 2026).
//     6. Cero mojibake (regression guard del export Drive original).
//   Integration (skill como layer del prompt):
//     7. MARKET_RD_SKILL_CONTENT inyectado en staticBlock, DESPUES del calculador.
//     8. Hash MATEO_V5_2 INTACTO (la constante NO se toco).

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { buildSystemPromptBlocks, MATEO_PROMPT_V5_2 } = require("../src/prompts");

const SKILL_PATH = ".claude/skills/mercado-inmobiliario-rd/SKILL.md";

describe("Hotfix-22 c2 — skill mercado-inmobiliario-rd (smoke)", () => {
  it("Test 1: archivo existe y tiene tamano razonable (> 10KB)", () => {
    expect(existsSync(SKILL_PATH)).toBe(true);
    const content = readFileSync(SKILL_PATH, "utf-8");
    expect(content.length).toBeGreaterThan(10000);
  });

  it("Test 2: frontmatter YAML valido (delimitadores + name + description)", () => {
    // Cross-platform: regex agnostica a CRLF (mismo patron que c22a).
    const content = readFileSync(SKILL_PATH, "utf-8");
    expect(content).toMatch(/^---\r?\n/);
    const closeMatch = content.match(/\r?\n---\r?\n/);
    expect(closeMatch).not.toBeNull();
    const frontmatter = content.slice(content.indexOf("\n") + 1, closeMatch.index);
    expect(frontmatter).toMatch(/^name:\s*mercado-inmobiliario-rd\s*$/m);
    expect(frontmatter).toMatch(/^description:\s*.+$/m);
  });

  it("Test 3: description menciona triggers clave para activacion automatica", () => {
    const content = readFileSync(SKILL_PATH, "utf-8");
    const closeMatch = content.match(/\r?\n---\r?\n/);
    const frontmatter = content.slice(content.indexOf("\n") + 1, closeMatch.index);
    // Frases gatillo del cliente que activan el skill (LLM las usa para
    // decidir cuando consultar este skill). Si el cliente menciona banco,
    // financiamiento, fideicomiso, etc, el modelo trae este contexto.
    expect(frontmatter).toContain("banco");
    expect(frontmatter).toContain("financiamiento");
    expect(frontmatter).toContain("fideicomiso");
    expect(frontmatter).toContain("bono primera vivienda");
    expect(frontmatter).toContain("extranjero");
    expect(frontmatter).toContain("CONFOTUR");
    expect(frontmatter).toContain("proceso de compra");
  });

  it("Test 4: markdown contiene secciones criticas", () => {
    const content = readFileSync(SKILL_PATH, "utf-8");
    // Bloques de conocimiento mercado RD
    expect(content).toContain("FINANCIAMIENTO BANCARIO RD");
    expect(content).toContain("FIDEICOMISO INMOBILIARIO");
    expect(content).toContain("Ley 189-11");
    expect(content).toContain("BONO PRIMERA VIVIENDA");
    expect(content).toContain("PROCESO COMPLETO COMPRA");
    expect(content).toContain("EXTRANJEROS Y DOMINICANOS EXTERIOR");
    expect(content).toContain("CONFOTUR");
    expect(content).toContain("Ley 158-01");
    // Asesoria + limites
    expect(content).toContain("CÓMO MATEO DEBE ASESORAR");
    expect(content).toContain("LÍMITES Y APROBACIONES");
    // Bancos principales con hipotecas
    expect(content).toContain("Banco Popular");
    expect(content).toContain("BanReservas");
    expect(content).toContain("APAP");
    expect(content).toContain("Scotiabank");
  });

  it("Test 5: APAP con tasa actualizada 12.50%/13.32% TAE (data real abril 2026)", () => {
    // Director valido el upgrade de APAP a la tasa actual scrapeada del
    // PDF oficial. Si esto regresa al valor antiguo, el bot daria
    // informacion desactualizada al cliente.
    const content = readFileSync(SKILL_PATH, "utf-8");
    expect(content).toContain("12.50%");
    expect(content).toContain("13.32%");
    expect(content).toMatch(/240 meses|20 a[ñn]os/);
    expect(content).toContain("01 abril 2026");
  });

  it("Test 6: cero mojibake garbled del export original", () => {
    const content = readFileSync(SKILL_PATH, "utf-8");
    // El export Drive de fuente venia con emojis garbled tipo "ð¥·"
    // (codepoint U+00F0 + bytes UTF-8 sueltos). Si reaparecen, la
    // limpieza durante la creacion del archivo se rompio.
    expect(content).not.toMatch(/ðÂ/);
    expect(content).not.toMatch(/Ã°/);
    // Tampoco escapes residuales del Markdown del export.
    expect(content).not.toContain("\\#");
    expect(content).not.toContain("\\*\\*");
  });
});

describe("Hotfix-22 c2 — skill RD integrado al loader (integration)", () => {
  it("Test 7: MARKET_RD_SKILL_CONTENT inyectado DESPUES del calculador en staticBlock", () => {
    const { staticBlock } = buildSystemPromptBlocks();
    // Anchors unicos del skill RD: si estan en el staticBlock, el loader
    // cargo el archivo y lo concateno al final.
    expect(staticBlock).toContain("mercado-inmobiliario-rd");
    expect(staticBlock).toContain("Ley 189-11");
    expect(staticBlock).toContain("BONO PRIMERA VIVIENDA");
    // Orden: calculadora va antes que market-rd (loader las carga en
    // ese orden y staticBlock concatena).
    const idxCalc = staticBlock.indexOf("calculadora-plan-pago");
    const idxMarket = staticBlock.indexOf("mercado-inmobiliario-rd");
    expect(idxCalc).toBeGreaterThan(-1);
    expect(idxMarket).toBeGreaterThan(idxCalc);
  });

  it("Test 8: hash MATEO_V5_2 INTACTO (constante no modificada por skill nuevo)", () => {
    // Anchors invariantes de MATEO_PROMPT_V5_2 — su contenido define el
    // hash de prompt-version. Si cambia, todos los clientes activos
    // pierden su historia. Hotfix-22 c2 NO toca esta constante; solo
    // extiende el staticBlock con un layer composable mas.
    expect(MATEO_PROMPT_V5_2).toContain("Eres Mateo Reyes");
    expect(MATEO_PROMPT_V5_2).toContain("FILOSOFÍA DE VENTA");
    expect(MATEO_PROMPT_V5_2).toContain("CALIFICACIÓN INTELIGENTE CONVERSACIONAL");
    // Sanity: la constante NO fue contaminada con contenido del skill nuevo.
    expect(MATEO_PROMPT_V5_2).not.toContain("mercado-inmobiliario-rd");
    expect(MATEO_PROMPT_V5_2).not.toContain("Ley 189-11");
    expect(MATEO_PROMPT_V5_2).not.toContain("CONFOTUR");
  });
});
