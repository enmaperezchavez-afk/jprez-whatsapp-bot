// Hotfix-24 (R4 caso 5) — Tests del strip de bloques <parameter>/<invoke>/
// <function_calls> truncados al final por max_tokens hit.
//
// EVIDENCIA: 11 mayo 2026 14:33:04, Caso A formal PR4 — Director vio
// <parameter name="..."> crudo en el reply del bot. El R4 existente
// (Hotfix-22 V3 r4, PR #35) solo cubre <perfil_update> truncado; este
// caso 5 cubre tool-use XML emitido como texto en content[].text que
// llega al cliente sin cerrar.
//
// CONTRATO testeado:
//   stripParameterBlocks(text) → { text, stripped, strippedChars }
//
// COBERTURA (5 tests, spec del Director):
//   1. Reply válido + <parameter> cerrado → pass intacto (no strip).
//   2. Reply válido + <parameter> truncado → strip + pass (texto preservado).
//   3. Reply solo <parameter> truncado → fallback (todo strippeado, queda "").
//   4. Reply válido sin bloque → pass intacto (no strip).
//   5. Múltiples <parameter> uno cerrado uno no → strip solo el no cerrado.

import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { stripParameterBlocks } = require("../src/handlers/parameter-block-cleaner");

describe("Hotfix-24 R4 caso 5 — stripParameterBlocks (función pura)", () => {
  it("Test 1: reply válido + <parameter> cerrado → pass intacto", () => {
    const input = "Mira, el PSE3 está en US$124,000.\n\n<parameter name=\"proyecto\">puertoPlata</parameter>";
    const result = stripParameterBlocks(input);
    expect(result.stripped).toBe(false);
    expect(result.strippedChars).toBe(0);
    expect(result.text).toBe(input);
  });

  it("Test 2: reply válido + <parameter> truncado al final → strip + pass texto antes", () => {
    const input = "Mira, el PSE3 está en US$124,000.\n\n<parameter name=\"proyecto\">puertoPlata";
    const result = stripParameterBlocks(input);
    expect(result.stripped).toBe(true);
    expect(result.strippedChars).toBeGreaterThan(0);
    // El texto válido antes del bloque queda preservado.
    expect(result.text).toContain("PSE3");
    expect(result.text).toContain("US$124,000");
    // El bloque truncado quedó stripeado.
    expect(result.text).not.toContain("<parameter");
    expect(result.text).not.toContain("puertoPlata");
  });

  it("Test 3: reply SOLO <parameter> truncado → strip total, queda vacío (cae al guard caso 4)", () => {
    const input = "<parameter name=\"precio_usd\">163";
    const result = stripParameterBlocks(input);
    expect(result.stripped).toBe(true);
    expect(result.strippedChars).toBe(input.length);
    expect(result.text).toBe("");
    // El handler con texto vacío cae al empty-reply guard caso 4 → fallback.
  });

  it("Test 4: reply válido sin bloque → pass intacto (no strip aplicado)", () => {
    const input = "Mira, los precios de PR4 arrancan en US$140,000 y van hasta US$310,000.";
    const result = stripParameterBlocks(input);
    expect(result.stripped).toBe(false);
    expect(result.strippedChars).toBe(0);
    expect(result.text).toBe(input);
  });

  it("Test 5: múltiples <parameter> uno cerrado uno no → strip solo el no cerrado (desde el truncado)", () => {
    // El primer <parameter> cierra OK. El segundo está truncado.
    const input = "Calculo: <parameter name=\"proyecto\">puertoPlata</parameter> y <parameter name=\"precio_usd\">124";
    const result = stripParameterBlocks(input);
    expect(result.stripped).toBe(true);
    expect(result.strippedChars).toBeGreaterThan(0);
    // El primer bloque cerrado queda intacto.
    expect(result.text).toContain("<parameter name=\"proyecto\">puertoPlata</parameter>");
    // El segundo bloque (truncado) fue stripeado.
    expect(result.text).not.toMatch(/<parameter name="precio_usd">/);
    expect(result.text).not.toMatch(/124$/);
    // El texto antes del segundo bloque truncado queda preservado.
    expect(result.text).toContain("Calculo:");
    expect(result.text).toContain("y");
  });
});

describe("Hotfix-24 R4 caso 5 — edge cases adicionales (sanity)", () => {
  it("Tag <invoke> truncado también se strippea", () => {
    const input = "Te calculo. <invoke name=\"calcular_plan_pago\"";
    const result = stripParameterBlocks(input);
    expect(result.stripped).toBe(true);
    expect(result.text).toBe("Te calculo.");
  });

  it("Tag <function_calls> truncado también se strippea", () => {
    const input = "Mira. <function_calls>";
    const result = stripParameterBlocks(input);
    expect(result.stripped).toBe(true);
    expect(result.text).toBe("Mira.");
  });

  it("Input vacío/null retorna texto vacío sin strip (defensa contract)", () => {
    expect(stripParameterBlocks("")).toEqual({ text: "", stripped: false, strippedChars: 0 });
    expect(stripParameterBlocks(null)).toEqual({ text: "", stripped: false, strippedChars: 0 });
    expect(stripParameterBlocks(undefined)).toEqual({ text: "", stripped: false, strippedChars: 0 });
  });

  it("Bloque cerrado embebido entre texto preservado (sanity)", () => {
    const input = "Hola <parameter name=\"x\">val</parameter> mundo";
    const result = stripParameterBlocks(input);
    expect(result.stripped).toBe(false);
    expect(result.text).toBe(input);
  });
});
