// Hotfix-22 V2 b1 — Token Budget Validator.
//
// Defensa permanente que detecta prompts gigantes ANTES de que lleguen
// a la API de Anthropic. Previene Bug #14/#26 (max_tokens regression
// silenciosa) por skill nuevo gigante sin alarma. Validador puro: sin
// I/O, sin red, sin Redis — testeable directamente.
//
// Cobertura (6 tests):
//   1. estimateTokens calcula correctamente chars/4.
//   2. validateSystemPromptSize retorna green para prompt pequeno.
//   3. validateSystemPromptSize retorna yellow warning >= 30K tokens.
//   4. validateSystemPromptSize retorna red critical >= 35K tokens.
//   5. validateSystemPromptSize maneja systemPrompt como array (cache
//      blocks formato Anthropic) concatenando los .text.
//   6. ok flag: false solo cuando status === "red".

import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const {
  validateSystemPromptSize,
  estimateTokens,
  BUDGET_MAX_TOKENS,
  BUDGET_WARNING_TOKENS,
  CHARS_PER_TOKEN,
} = require("../src/validators/token-budget");

describe("Hotfix-22 V2 b1 — token-budget validator (puro)", () => {
  it("Test 1: estimateTokens calcula chars/4 correctamente (con ceil)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1);          // 3/4 = 0.75 -> ceil = 1
    expect(estimateTokens("abcd")).toBe(1);         // 4/4 = 1
    expect(estimateTokens("abcde")).toBe(2);        // 5/4 = 1.25 -> ceil = 2
    expect(estimateTokens("a".repeat(4000))).toBe(1000);
    // Sanity: input no-string devuelve 0 (defensivo).
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
    expect(estimateTokens(42)).toBe(0);
  });

  it("Test 2: prompt pequeno (<30K tokens) retorna green + ok=true", () => {
    const smallPrompt = "Eres Mateo Reyes, vendedor JPREZ.";
    const result = validateSystemPromptSize(smallPrompt);
    expect(result.status).toBe("green");
    expect(result.ok).toBe(true);
    expect(result.estimatedTokens).toBeLessThan(BUDGET_WARNING_TOKENS);
    expect(result.chars).toBe(smallPrompt.length);
    expect(result.message).toMatch(/OK/);
  });

  it("Test 3: prompt cercano al cap (30K-35K tokens) retorna yellow + ok=true", () => {
    // Construir un prompt de exactamente ~32K tokens (entre warning y max).
    // 32K tokens * 4 chars/token = 128,000 chars.
    const yellowPrompt = "x".repeat(32000 * CHARS_PER_TOKEN);
    const result = validateSystemPromptSize(yellowPrompt);
    expect(result.status).toBe("yellow");
    expect(result.ok).toBe(true); // yellow no bloquea, solo alerta
    expect(result.estimatedTokens).toBeGreaterThanOrEqual(BUDGET_WARNING_TOKENS);
    expect(result.estimatedTokens).toBeLessThan(BUDGET_MAX_TOKENS);
    expect(result.message).toMatch(/WARNING/);
  });

  it("Test 4: prompt gigante (>35K tokens) retorna red + ok=false", () => {
    // 40K tokens * 4 chars/token = 160,000 chars. Excede el max de 35K.
    const redPrompt = "x".repeat(40000 * CHARS_PER_TOKEN);
    const result = validateSystemPromptSize(redPrompt);
    expect(result.status).toBe("red");
    expect(result.ok).toBe(false); // red SI bloquea (caller decide accion)
    expect(result.estimatedTokens).toBeGreaterThanOrEqual(BUDGET_MAX_TOKENS);
    expect(result.message).toMatch(/CRITICAL/);
    expect(result.message).toContain(String(BUDGET_MAX_TOKENS));
  });

  it("Test 5: systemPrompt como array (cache blocks Anthropic) concatena los .text", () => {
    // Formato real que usa src/handlers/message.js para prompt caching:
    //   [{ type: "text", text: "...", cache_control: {...} },
    //    { type: "text", text: "..." }]
    const blocks = [
      { type: "text", text: "Bloque estatico grande con skill", cache_control: { type: "ephemeral" } },
      { type: "text", text: "Bloque dinamico con fecha y contexto cliente" },
    ];
    const result = validateSystemPromptSize(blocks);
    // Concatena ambos textos separados por "\n", entonces chars =
    // sum(textos) + 1 (el \n del join).
    const expectedChars = blocks[0].text.length + blocks[1].text.length + 1;
    expect(result.chars).toBe(expectedChars);
    expect(result.status).toBe("green"); // textos chicos
    expect(result.ok).toBe(true);
  });

  it("Test 6: bloques sin type='text' o sin .text se ignoran (defensivo)", () => {
    // Sanity: si pasan formatos raros (image, tool_use, bloque sin text),
    // el validador los ignora en lugar de crashear.
    const blocks = [
      { type: "text", text: "hola" },
      { type: "image", source: {} },          // no es text -> ignorado
      { type: "text" },                        // sin .text -> ignorado
      { type: "text", text: "mundo" },
      null,                                    // null -> ignorado
      { type: "text", text: 42 },              // text no-string -> ignorado
    ];
    const result = validateSystemPromptSize(blocks);
    // Solo "hola\nmundo" deberia contarse.
    expect(result.chars).toBe("hola".length + 1 + "mundo".length);
    expect(result.status).toBe("green");
  });
});
