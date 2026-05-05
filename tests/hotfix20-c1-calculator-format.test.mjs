// Hotfix-20 Commit 1 — Bug #13 calculadora natural.
//
// Smoke real del sabado revelo que Mateo formateaba resultados de
// calcular_plan_pago en estilo Excel ("Down Payment (10%): US$16,300").
// Director quiere prosa natural ("$16K bajas para apartar"). Este commit
// agrega bloque FORMATO CALCULADORA al style-layer (puro layer, cero codigo).

import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { STYLE_LAYER } = require("../src/prompts/style-layer");
const { buildSystemPrompt } = require("../src/prompts");

describe("Hotfix-20 c1 — STYLE_LAYER incluye FORMATO CALCULADORA", () => {
  it("Test 1: STYLE_LAYER contiene seccion 'FORMATO CALCULADORA'", () => {
    expect(STYLE_LAYER).toContain("FORMATO CALCULADORA");
    expect(STYLE_LAYER).toContain("habla, no listes");
  });

  it("Test 2: anti-pattern Excel/academico esta explicitamente prohibido", () => {
    // El bloque debe nombrar el formato que estamos eliminando para que el
    // modelo lo reconozca como anti-pattern, no como ejemplo.
    expect(STYLE_LAYER).toContain("Down Payment");
    expect(STYLE_LAYER).toMatch(/MAL:|PROHIBIDO/);
    expect(STYLE_LAYER).toMatch(/Excel|academico|reporte financiero/);
  });

  it("Test 3: pro-pattern muestra prosa con numeros redondeados a K", () => {
    // Ejemplo positivo en el layer debe usar la convencion "$XK" y verbos
    // de accion ("bajas", "contra entrega").
    expect(STYLE_LAYER).toMatch(/\$\d+K/);
    expect(STYLE_LAYER).toContain("bajas");
    expect(STYLE_LAYER).toContain("contra entrega");
  });

  it("Test 4: incluye guidance para 2+ escenarios (etapas) en flujo natural", () => {
    // Caso real Puerto Plata E3 vs E4 — el layer debe ensenar a presentar
    // ambos sin caer en formato tabular.
    expect(STYLE_LAYER).toContain("Etapa 4");
    expect(STYLE_LAYER).toContain("Etapa 3");
    expect(STYLE_LAYER).toMatch(/¿[Cc]ual te late|¿con cual quieres avanzar/);
  });

  it("Test 5: buildSystemPrompt incluye FORMATO CALCULADORA al final (despues de Mateo + GLOSARIO + JUICIO)", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("FORMATO CALCULADORA");
    // Orden: Mateo → GLOSARIO → JUICIO COMERCIAL (ambos en glossary-layer) → STYLE → FORMATO CALCULADORA.
    const idxMateo = prompt.indexOf("Eres Mateo Reyes");
    const idxGlossary = prompt.indexOf("GLOSARIO DE ABREVIATURAS");
    const idxJuicio = prompt.indexOf("JUICIO COMERCIAL");
    const idxFormato = prompt.indexOf("FORMATO CALCULADORA");
    expect(idxMateo).toBeGreaterThan(-1);
    expect(idxGlossary).toBeGreaterThan(idxMateo);
    expect(idxJuicio).toBeGreaterThan(idxGlossary);
    expect(idxFormato).toBeGreaterThan(idxJuicio);
  });
});
