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

// HOTFIX-22 c1 (6 mayo 2026): el bloque §4 fue renombrado de
// "FORMATO CALCULADORA — habla, no listes" a "FORMATO NÚMEROS — siempre
// exactos, prosa natural" como parte del cleanup de prosa + numeros exactos.
// Ademas el scope se generalizo (universal vs solo tool calcular_plan_pago) y
// los ejemplos BIEN se reescribieron con numeros exactos ($163,000) en lugar
// de redondeados ($163K). Estos tests fueron actualizados para validar el
// nuevo bloque preservando la intencion original (anti-pattern Excel + prosa
// con numeros embebidos + flujo 2 escenarios).

describe("Hotfix-20 c1 — STYLE_LAYER incluye FORMATO NÚMEROS (post-Hotfix-22)", () => {
  it("Test 1: STYLE_LAYER contiene seccion 'FORMATO NÚMEROS'", () => {
    expect(STYLE_LAYER).toContain("FORMATO NÚMEROS");
    expect(STYLE_LAYER).toContain("siempre exactos");
  });

  it("Test 2: anti-pattern Excel/academico esta explicitamente prohibido", () => {
    // El bloque debe nombrar el formato que estamos eliminando para que el
    // modelo lo reconozca como anti-pattern, no como ejemplo.
    expect(STYLE_LAYER).toContain("Down Payment");
    expect(STYLE_LAYER).toMatch(/MAL:|PROHIBIDO/);
    expect(STYLE_LAYER).toMatch(/Excel|academico|reporte financiero/);
  });

  it("Test 3: pro-pattern muestra prosa con numeros EXACTOS (post-Hotfix-22)", () => {
    // Hotfix-22 invirtio la regla de redondeo. Ejemplos BIEN ahora usan
    // numeros exactos ($163,000, $2,038, $114,100) y verbos de accion.
    expect(STYLE_LAYER).toMatch(/\$\d{1,3}(?:,\d{3})+/);
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

  it("Test 5: buildSystemPrompt incluye FORMATO NÚMEROS al final (despues de Mateo + GLOSARIO + JUICIO)", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("FORMATO NÚMEROS");
    // Orden: Mateo → GLOSARIO → JUICIO COMERCIAL (ambos en glossary-layer) → STYLE → FORMATO NÚMEROS.
    const idxMateo = prompt.indexOf("Eres Mateo Reyes");
    const idxGlossary = prompt.indexOf("GLOSARIO DE ABREVIATURAS");
    const idxJuicio = prompt.indexOf("JUICIO COMERCIAL");
    const idxFormato = prompt.indexOf("FORMATO NÚMEROS");
    expect(idxMateo).toBeGreaterThan(-1);
    expect(idxGlossary).toBeGreaterThan(idxMateo);
    expect(idxJuicio).toBeGreaterThan(idxGlossary);
    expect(idxFormato).toBeGreaterThan(idxJuicio);
  });
});
