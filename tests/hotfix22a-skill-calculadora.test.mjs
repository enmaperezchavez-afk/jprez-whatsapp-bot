// Hotfix-22a — Skill calculadora-plan-pago + cashflow negotiation.
//
// Version definitiva: archivo skill creado + integrado al loader de
// src/prompts.js (CALCULATOR_SKILL_CONTENT cargado al cold start e
// inyectado en staticBlock al final, despues de STYLE_LAYER).
//
// El skill contiene casos reales Gladys Mishell (16-403 tradicional,
// 16-412 ajustado) + reglas duras/blandas del contrato JPREZ + script
// de negociacion para cashflow ajustado del cliente.
//
// Cobertura (8 tests):
//   Smoke (skill como archivo):
//     1. Archivo existe y tamano razonable (> 5KB).
//     2. Frontmatter YAML valido (delimitadores + name + description).
//     3. description menciona triggers clave de activacion.
//     4. Markdown tiene secciones criticas.
//     5. Cero mojibake (regression guard del export Drive original).
//   Integration (skill como layer del prompt):
//     6. CALCULATOR_SKILL_CONTENT inyectado en staticBlock.
//     7. Posicion: despues de STYLE_LAYER (ultimo layer).
//     8. Hash MATEO_V5_2 INTACTO (la constante NO se toco).

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { buildSystemPromptBlocks, MATEO_PROMPT_V5_2 } = require("../src/prompts");

const SKILL_PATH = ".claude/skills/calculadora-plan-pago/SKILL.md";

describe("Hotfix-22a — skill calculadora-plan-pago (smoke)", () => {
  it("Test 1: archivo existe y tiene tamano razonable (> 5KB)", () => {
    expect(existsSync(SKILL_PATH)).toBe(true);
    const content = readFileSync(SKILL_PATH, "utf-8");
    expect(content.length).toBeGreaterThan(5000);
  });

  it("Test 2: frontmatter YAML valido (delimitadores + name + description)", () => {
    const content = readFileSync(SKILL_PATH, "utf-8");
    // Frontmatter debe abrir con --- en linea 1 y cerrar con --- antes del cuerpo.
    expect(content.startsWith("---\n")).toBe(true);
    const closeIdx = content.indexOf("\n---\n", 4);
    expect(closeIdx).toBeGreaterThan(-1);
    const frontmatter = content.slice(4, closeIdx);
    expect(frontmatter).toMatch(/^name:\s*calculadora-plan-pago\s*$/m);
    expect(frontmatter).toMatch(/^description:\s*.+$/m);
  });

  it("Test 3: description menciona triggers clave para activacion automatica", () => {
    const content = readFileSync(SKILL_PATH, "utf-8");
    const closeIdx = content.indexOf("\n---\n", 4);
    const frontmatter = content.slice(4, closeIdx);
    // Frases gatillo del cliente que activan el skill (el LLM las usa para
    // decidir cuando consultar este skill).
    expect(frontmatter).toContain("no me alcanza");
    expect(frontmatter).toContain("calcula plan");
    expect(frontmatter).toContain("cuotas mensuales");
    expect(frontmatter).toContain("contra entrega");
  });

  it("Test 4: markdown contiene secciones criticas", () => {
    const content = readFileSync(SKILL_PATH, "utf-8");
    // Reglas del contrato JPREZ
    expect(content).toContain("REGLA DURA");
    expect(content).toContain("70% CONTRA ENTREGA");
    expect(content).toContain("REGLA BLANDA");
    // Casos reales Gladys Mishell (PSE3)
    expect(content).toContain("16-403");
    expect(content).toContain("16-412");
    expect(content).toContain("$138,400");
    expect(content).toContain("$124,000");
    // Negociacion + limites
    expect(content).toMatch(/ESCENARIOS DE NEGOCIACI/);
    expect(content).toContain("LÍMITES Y APROBACIONES");
    expect(content).toContain("Mateo PUEDE proponer SIN aprobación Director");
    expect(content).toContain("Mateo DEBE pedir aprobación a Director");
  });

  it("Test 5: cero mojibake garbled del export original", () => {
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

describe("Hotfix-22a — skill calculadora integrado al loader (integration)", () => {
  it("Test 6: CALCULATOR_SKILL_CONTENT cargado e inyectado en staticBlock", () => {
    const { staticBlock } = buildSystemPromptBlocks();
    // Anchors unicos del skill calculadora — si estan en el staticBlock,
    // el loader cargo el archivo y lo concateno.
    expect(staticBlock).toContain("calculadora-plan-pago");
    expect(staticBlock).toContain("16-403");                  // caso Gladys tradicional
    expect(staticBlock).toContain("16-412");                  // caso Gladys ajustado
    expect(staticBlock).toContain("70% CONTRA ENTREGA");       // regla dura
  });

  it("Test 7: skill calculadora aparece DESPUES de STYLE_LAYER en staticBlock", () => {
    const { staticBlock } = buildSystemPromptBlocks();
    // Anchor de STYLE_LAYER (ultimo layer pre-Hotfix-22a):
    const idxStyle = staticBlock.indexOf("RECORDATORIO FINAL DE TONO");
    // Anchor del skill calculadora:
    const idxCalc = staticBlock.indexOf("calculadora-plan-pago");
    expect(idxStyle).toBeGreaterThan(-1);
    expect(idxCalc).toBeGreaterThan(-1);
    // Calculadora va al final del staticBlock, despues de STYLE.
    expect(idxCalc).toBeGreaterThan(idxStyle);
  });

  it("Test 8: hash MATEO_V5_2 INTACTO (constante no modificada)", () => {
    // Anchors invariantes de MATEO_PROMPT_V5_2 — su contenido define el
    // hash de prompt-version usado para invalidar historiales. Si el
    // hash cambia, todos los clientes activos pierden su historia.
    // Hotfix-22a NO modifica esta constante; solo extiende el staticBlock.
    expect(MATEO_PROMPT_V5_2).toContain("Eres Mateo Reyes");
    expect(MATEO_PROMPT_V5_2).toContain("FILOSOFÍA DE VENTA");
    expect(MATEO_PROMPT_V5_2).toContain("CALIFICACIÓN INTELIGENTE CONVERSACIONAL");
    // Sanity: la constante NO fue contaminada con contenido del skill nuevo.
    expect(MATEO_PROMPT_V5_2).not.toContain("calculadora-plan-pago");
    expect(MATEO_PROMPT_V5_2).not.toContain("16-403");
  });
});
