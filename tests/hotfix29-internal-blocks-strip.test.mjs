// Hotfix-29 Bug 2 P0 (19 may 2026) — Tests del strip de bloques internos
// CERRADOS que leakean al cliente.
//
// EVIDENCIA: Director vio el bloque <parameter name="perfil_update">
// {nombre, score_lead, tags...}</parameter> CRUDO en el reply del bot
// vía WhatsApp. stripParameterBlocks solo strippea TRUNCADOS; cuando
// el LLM emite el bloque CERRADO (con </parameter>), pasaba intacto.
//
// stripInternalBlocks complementa stripParameterBlocks: strippea
// bloques CERRADOS de tags internos (<parameter>, <invoke>,
// <function_calls>, <perfil_update>) como defensa final antes de
// enviar al cliente.
//
// CONTRATO testeado:
//   stripInternalBlocks(text) → { text, stripped, strippedChars }

import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { stripInternalBlocks } = require("../src/handlers/parameter-block-cleaner");

describe("Hotfix-29 Bug 2 P0 — stripInternalBlocks (bloques internos cerrados)", () => {
  it("Test 1: bloque <parameter name='perfil_update'> CERRADO con JSON → strippea", () => {
    const jsonPayload = '{"nombre":"Juan","score_lead":75,"tags":["puerto_plata","interesado"]}';
    const input = `Hola Juan, te tengo info de PR4. <parameter name="perfil_update">${jsonPayload}</parameter>`;
    const result = stripInternalBlocks(input);
    expect(result.stripped).toBe(true);
    expect(result.strippedChars).toBeGreaterThan(0);
    expect(result.text).toContain("Hola Juan");
    expect(result.text).toContain("PR4");
    expect(result.text).not.toContain("<parameter");
    expect(result.text).not.toContain("score_lead");
    expect(result.text).not.toContain("perfil_update");
  });

  it("Test 2: bloque <perfil_update> cerrado → strippea (defensa en profundidad)", () => {
    const input = "Mira los precios.\n\n<perfil_update>{\"score_lead\":80}</perfil_update>\n\nPSE3 arranca en US$124k.";
    const result = stripInternalBlocks(input);
    expect(result.stripped).toBe(true);
    expect(result.text).toContain("Mira los precios");
    expect(result.text).toContain("PSE3 arranca");
    expect(result.text).not.toContain("perfil_update");
    expect(result.text).not.toContain("score_lead");
  });

  it("Test 3: bloque <invoke> cerrado con contenido → strippea", () => {
    const input = "Te calculo el plan. <invoke name=\"calcular_plan_pago\"><parameter name=\"x\">val</parameter></invoke>\n\nResultado: 5%.";
    const result = stripInternalBlocks(input);
    expect(result.stripped).toBe(true);
    expect(result.text).toContain("Te calculo");
    expect(result.text).toContain("Resultado: 5%");
    expect(result.text).not.toContain("<invoke");
    expect(result.text).not.toContain("<parameter");
  });

  it("Test 4: bloque <function_calls> cerrado → strippea", () => {
    const input = "Procesando.\n<function_calls><invoke name=\"foo\"></invoke></function_calls>\nListo.";
    const result = stripInternalBlocks(input);
    expect(result.stripped).toBe(true);
    expect(result.text).toContain("Procesando");
    expect(result.text).toContain("Listo");
    expect(result.text).not.toContain("function_calls");
    expect(result.text).not.toContain("invoke");
  });

  it("Test 5: múltiples bloques de distintos tags → strippea todos", () => {
    const input = "Inicio. <parameter name=\"a\">1</parameter> medio <invoke name=\"f\"></invoke> y <perfil_update>{}</perfil_update> fin.";
    const result = stripInternalBlocks(input);
    expect(result.stripped).toBe(true);
    expect(result.text).toContain("Inicio");
    expect(result.text).toContain("medio");
    expect(result.text).toContain("fin");
    expect(result.text).not.toContain("<parameter");
    expect(result.text).not.toContain("<invoke");
    expect(result.text).not.toContain("<perfil_update");
  });

  it("Test 6: reply válido sin bloques → pass intacto", () => {
    const input = "Mira, el PSE3 arranca en US$124,000. ¿Quieres que te calcule el plan?";
    const result = stripInternalBlocks(input);
    expect(result.stripped).toBe(false);
    expect(result.strippedChars).toBe(0);
    expect(result.text).toBe(input);
  });

  it("Test 7: bloque TRUNCADO (sin closing tag) → NO strippea (lo cubre stripParameterBlocks)", () => {
    // stripInternalBlocks usa regex non-greedy con closing tag obligatorio.
    // Si no hay closing, NO match. Estos casos los cubre stripParameterBlocks.
    const input = "Hola. <parameter name=\"x\">val_truncado";
    const result = stripInternalBlocks(input);
    expect(result.stripped).toBe(false);
    expect(result.text).toBe(input);
  });

  it("Test 8: bloque multilínea con saltos internos → strippea correctamente", () => {
    const input = "Antes.\n<parameter name=\"perfil_update\">\n{\n  \"nombre\": \"Juan\",\n  \"score_lead\": 75\n}\n</parameter>\nDespués.";
    const result = stripInternalBlocks(input);
    expect(result.stripped).toBe(true);
    expect(result.text).toContain("Antes");
    expect(result.text).toContain("Después");
    expect(result.text).not.toContain("score_lead");
    expect(result.text).not.toContain("Juan");
  });

  it("Test 9: input vacío/null retorna defensa contract sin strip", () => {
    expect(stripInternalBlocks("")).toEqual({ text: "", stripped: false, strippedChars: 0 });
    expect(stripInternalBlocks(null)).toEqual({ text: "", stripped: false, strippedChars: 0 });
    expect(stripInternalBlocks(undefined)).toEqual({ text: "", stripped: false, strippedChars: 0 });
  });

  it("Test 10: case-insensitive — <PARAMETER>, <Invoke> etc. también strippean", () => {
    const input = "Hola <PARAMETER name=\"x\">val</PARAMETER> y <Invoke></Invoke> mundo.";
    const result = stripInternalBlocks(input);
    expect(result.stripped).toBe(true);
    expect(result.text).toContain("Hola");
    expect(result.text).toContain("mundo");
    expect(result.text).not.toMatch(/<parameter/i);
    expect(result.text).not.toMatch(/<invoke/i);
  });

  it("Test 11: colapsa saltos múltiples post-strip (no deja '\\n\\n\\n\\n')", () => {
    const input = "Antes\n\n<parameter name=\"x\">val</parameter>\n\nDespués";
    const result = stripInternalBlocks(input);
    expect(result.stripped).toBe(true);
    // No deben quedar 3+ saltos consecutivos
    expect(result.text).not.toMatch(/\n{3,}/);
  });

  it("Test 12: caso real del Director — JSON perfil_update completo no leakea", () => {
    const realPayload = `{"nombre":"María González","telefono":"18299123456","score_lead":85,"tags":["puerto_plata","cash","extranjero","interesado_pse3"],"presupuesto_usd":150000,"intencion":"compra_inversion"}`;
    const input = `¡Hola María! Excelente, te tengo info de PSE3. Está en US$124k arranque, con CONFOTUR aplicable porque es Puerto Plata. ¿Te calculo el plan? <parameter name="perfil_update">${realPayload}</parameter>`;
    const result = stripInternalBlocks(input);
    expect(result.stripped).toBe(true);
    // El reply visible al cliente queda preservado
    expect(result.text).toContain("Hola María");
    expect(result.text).toContain("PSE3");
    expect(result.text).toContain("CONFOTUR");
    // Ningún dato interno leakea
    expect(result.text).not.toContain("score_lead");
    expect(result.text).not.toContain("telefono");
    expect(result.text).not.toContain("18299123456");
    expect(result.text).not.toContain("tags");
    expect(result.text).not.toContain("presupuesto_usd");
    expect(result.text).not.toContain("perfil_update");
  });
});
