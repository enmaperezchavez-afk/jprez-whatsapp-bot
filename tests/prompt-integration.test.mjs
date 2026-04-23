// Tests de integracion alrededor de prompts.js y notify.js:
// - buildSystemPrompt contiene Mateo + hora SD + inventario
// - SUPERVISOR_PROMPT no tiene mojibake
// - detectDiscountOffer patterns
// - calcular_plan_pago accepts etapa for Puerto Plata

import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { buildSystemPrompt, SUPERVISOR_PROMPT } = require("../src/prompts");
const { detectDiscountOffer } = require("../src/notify");

describe("buildSystemPrompt", () => {
  it("incluye la identidad de Mateo Reyes", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Mateo Reyes");
    expect(prompt).toContain("asesor de ventas senior");
  });

  it("inyecta hora actual de Santo Domingo en formato HH:MM", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/Hora actual: \d{2}:\d{2} \(Santo Domingo\)/);
  });

  it("inyecta fecha ISO del dia", () => {
    const prompt = buildSystemPrompt();
    const iso = new Date().toISOString().slice(0, 10);
    expect(prompt).toContain("Hoy es: " + iso);
  });

  it("mantiene inyeccion de INVENTARIO (regla archivo manda)", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("INVENTARIO Y PRECIOS DETALLADOS");
  });

  it("incluye Trusted Advisor Nivel 3 con umbral US$70,000", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("US$70,000");
    expect(prompt).toContain("Trusted Advisor");
  });

  it("incluye contrato del bloque <perfil_update>", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("<perfil_update>");
    expect(prompt).toContain("recomendar_competencia");
  });

  it("reconoce Puerto Plata como 2 etapas E3/E4", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("ETAPA 3 (E3)");
    expect(prompt).toContain("ETAPA 4 (E4)");
  });

  it("explica tool calcular_plan_pago con parametro etapa", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/etapa.*E3.*E4/is);
  });
});

describe("SUPERVISOR_PROMPT — encoding", () => {
  it("no tiene mojibake (TrÃ¡talo, acÃ¡talas deben estar arreglados)", () => {
    expect(SUPERVISOR_PROMPT).not.toContain("TrÃ");
    expect(SUPERVISOR_PROMPT).not.toContain("acÃ");
  });

  it("tiene 'Trátalo' y 'acátalas' con acentos correctos", () => {
    expect(SUPERVISOR_PROMPT).toContain("Trátalo");
    expect(SUPERVISOR_PROMPT).toContain("acátalas");
  });
});

describe("detectDiscountOffer", () => {
  it("detecta $1,000 con separador de miles", () => {
    const r = detectDiscountOffer("te puedo hacer un descuento de $1,000 si cierras hoy");
    expect(r).not.toBeNull();
    expect(r.monto).toBe(1000);
  });

  it("detecta US$2000 sin separador", () => {
    const r = detectDiscountOffer("US$2000 de rebaja");
    expect(r.monto).toBe(2000);
  });

  it("detecta 'mil' textual cuando co-ocurre con 'descuento'", () => {
    const r = detectDiscountOffer("te doy mil de descuento");
    expect(r.monto).toBe(1000);
  });

  it("detecta 'dos mil' textual con 'te bajo'", () => {
    const r = detectDiscountOffer("te bajo dos mil para cerrar hoy");
    expect(r.monto).toBe(2000);
  });

  it("ignora precios de unidades (>$5000)", () => {
    expect(detectDiscountOffer("la unidad cuesta $156,000")).toBeNull();
    expect(detectDiscountOffer("el apartamento vale $98,292")).toBeNull();
  });

  it("ignora 'mil' sin co-ocurrencia de palabra descuento", () => {
    expect(detectDiscountOffer("faltan mil kilometros")).toBeNull();
  });

  it("retorna null para input vacio o no-string", () => {
    expect(detectDiscountOffer("")).toBeNull();
    expect(detectDiscountOffer(null)).toBeNull();
    expect(detectDiscountOffer(undefined)).toBeNull();
  });

  it("retorna null cuando no hay pattern de descuento", () => {
    expect(detectDiscountOffer("Hola como estas")).toBeNull();
  });
});
