// Hotfix-22 V3.5 (R5) — Tests del post-processor HARD de formato.
//
// Cobertura (11 tests aprobados Director):
//   1-4: bullets en sus 4 variantes (-, *, •, ·)
//   5-6: asteriscos (** y *) — orden importante
//   7-8: emojis (Pictographic + Regional Indicator banderas)
//   9: texto sin formato → unchanged + counts en 0
//   10: edge empty post-strip → returns string vacio (caller maneja)
//   11: URLs/contenido con * suelto → preservado (regex no-greedy)

import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { cleanFormat } = require("../src/handlers/format-postprocess");

describe("Hotfix-22 V3.5 R5 — cleanFormat post-processor", () => {

  it("Test 1: bullets con dash '-' al inicio de linea", () => {
    const input = "Mira, los bancos:\n- Popular\n- BanReservas\n- APAP";
    const r = cleanFormat(input);
    expect(r.text).toBe("Mira, los bancos:\nPopular\nBanReservas\nAPAP");
    expect(r.counts.bullets).toBe(3);
  });

  it("Test 2: bullets con asterisco '*' al inicio de linea", () => {
    const input = "Opciones:\n* Crux\n* PR4\n* Puerto Plata";
    const r = cleanFormat(input);
    expect(r.text).toBe("Opciones:\nCrux\nPR4\nPuerto Plata");
    expect(r.counts.bullets).toBe(3);
  });

  it("Test 3: bullets con bullet point '•' al inicio de linea", () => {
    const input = "Detalles:\n• Item 1\n• Item 2";
    const r = cleanFormat(input);
    expect(r.text).toBe("Detalles:\nItem 1\nItem 2");
    expect(r.counts.bullets).toBe(2);
  });

  it("Test 4: bullets con middle dot '·' al inicio de linea", () => {
    const input = "Ventajas:\n· Punto 1\n· Punto 2";
    const r = cleanFormat(input);
    expect(r.text).toBe("Ventajas:\nPunto 1\nPunto 2");
    expect(r.counts.bullets).toBe(2);
  });

  it("Test 5: asteriscos ** wrappers (negrita) → strip wrappers, mantener contenido", () => {
    const input = "Esto es **importante** y esto **muy importante**.";
    const r = cleanFormat(input);
    expect(r.text).toBe("Esto es importante y esto muy importante.");
    expect(r.counts.bolds).toBe(2);
  });

  it("Test 6: orden importa — ** se procesa ANTES que * (sin residuos)", () => {
    // Si se procesara * primero, "**negrita**" se rompería en "*negrita*" + asteriscos sueltos.
    // Como ** se procesa primero, queda "negrita" limpio.
    const input = "**Negrita** y *cursiva* y **otra negrita**.";
    const r = cleanFormat(input);
    expect(r.text).toBe("Negrita y cursiva y otra negrita.");
    expect(r.counts.bolds).toBe(2);
    expect(r.counts.italics).toBe(1);
    // Caso del smoke real: "*¿Qué es?*" estilo header.
    const headerCase = cleanFormat("*¿Qué es?* Es un banco. *¿Cómo funciona?* Asi.");
    expect(headerCase.text).toBe("¿Qué es? Es un banco. ¿Cómo funciona? Asi.");
    expect(headerCase.counts.italics).toBe(2);
  });

  it("Test 7: emojis pictograficos (single codepoint) strip", () => {
    const input = "Mira 🌎 los precios 🔥 son brutales 😊";
    const r = cleanFormat(input);
    expect(r.text).toBe("Mira los precios son brutales");
    expect(r.counts.emojis).toBe(3);
  });

  it("Test 8: banderas (Regional Indicators, 2 codepoints) strip", () => {
    // 🇩🇴 = 2 codepoints regional indicator. Pictographic NO los strippea.
    const input = "Soy de 🇩🇴 y trabajo con clientes en 🇺🇸 y 🇪🇸";
    const r = cleanFormat(input);
    expect(r.text).toBe("Soy de y trabajo con clientes en y");
    // 3 banderas × 2 codepoints cada = 6 emojis_count.
    expect(r.counts.emojis).toBeGreaterThan(0);
  });

  it("Test 9: texto sin formato → unchanged + counts todos en 0", () => {
    const input = "Mira, los precios de PR4 arrancan en US$140,000 y van hasta US$310,000.";
    const r = cleanFormat(input);
    expect(r.text).toBe(input);
    expect(r.counts.bullets).toBe(0);
    expect(r.counts.bolds).toBe(0);
    expect(r.counts.italics).toBe(0);
    expect(r.counts.emojis).toBe(0);
  });

  it("Test 10: edge empty post-strip → returns string vacio (caller R4 atrapa)", () => {
    // Bot solo emitio "*hola*" (italic wrapper) → strip wrappers queda "hola".
    // Caso brutal: "*🌎*" → strip italic + emoji → vacio.
    const r1 = cleanFormat("*🌎*");
    expect(r1.text).toBe("");
    // Solo emojis → vacio.
    const r2 = cleanFormat("🔥🌎😊");
    expect(r2.text).toBe("");
    // Solo bullets sin contenido (caso degenerado, no realista).
    const r3 = cleanFormat("- \n- \n- ");
    expect(r3.text.length).toBeLessThanOrEqual(2); // maybe trailing newlines
  });

  it("Test 11: URL con caracteres especiales preservada (asterisco solitario no toca)", () => {
    // Asterisco SUELTO sin pareja → no match no-greedy, preservado.
    const input = "Visita constructorajprez.com o llama al 8095551234. Math: 5 * 4 = 20.";
    const r = cleanFormat(input);
    expect(r.text).toBe(input);
    expect(r.counts.italics).toBe(0);
    // URL con scheme no contiene asteriscos típicamente, sanity.
    const url = cleanFormat("https://example.com/path?x=1&y=2");
    expect(url.text).toBe("https://example.com/path?x=1&y=2");
  });

  it("Test 12: input no-string → returns shape valido vacio (defensive)", () => {
    expect(cleanFormat(null).text).toBe("");
    expect(cleanFormat(undefined).text).toBe("");
    expect(cleanFormat(42).text).toBe("");
    expect(cleanFormat({}).text).toBe("");
    // counts siempre presente y todos 0.
    const r = cleanFormat(null);
    expect(r.counts).toEqual({ bullets: 0, bolds: 0, italics: 0, emojis: 0 });
  });

  it("Test 13: combinación brutal del smoke real (4 tipos mezclados)", () => {
    // Caso real del smoke: bullets + asteriscos + emojis + headers.
    const input = "Mira 🌎 las opciones:\n*¿Qué es?*\n- Banco Popular\n- BanReservas\n- APAP\n**Tasa**: 12.50% 😊";
    const r = cleanFormat(input);
    expect(r.text).not.toContain("🌎");
    expect(r.text).not.toContain("😊");
    expect(r.text).not.toContain("**");
    expect(r.text).not.toMatch(/^\*[^*]/m);
    expect(r.text).not.toMatch(/^- /m);
    expect(r.text).toContain("Banco Popular");
    expect(r.text).toContain("BanReservas");
    expect(r.text).toContain("12.50%");
    expect(r.counts.bullets).toBe(3);
    expect(r.counts.bolds).toBeGreaterThanOrEqual(1);
    expect(r.counts.italics).toBeGreaterThanOrEqual(1);
    expect(r.counts.emojis).toBeGreaterThanOrEqual(2);
  });
});
