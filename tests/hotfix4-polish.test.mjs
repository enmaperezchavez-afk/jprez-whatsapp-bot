// Tests de pulido hotfix-4 Día 3:
// - Fix 2 (hotfix-4): apellido "Reyes" obligatorio en CASO A de identidad
//   Mateo. Smoke test del hotfix-3 detecto que Mateo se presenta solo como
//   "Mateo" omitiendo apellido. Este test valida que el prompt refuerza
//   explicitamente el apellido completo con ejemplos ✅/❌.
//
// Modulo leaf: cero I/O, cero mocks. String-matching puro sobre
// buildSystemPrompt() generado.

import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { buildSystemPrompt } = require("../src/prompts");

describe("Fix 2 (hotfix-4) — Apellido Reyes obligatorio en CASO A", () => {
  it("prompt prohibe explicitamente presentarse solo como 'Mateo'", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("NUNCA te presentes solo como");
    expect(prompt).toContain("Mateo Reyes");
  });

  it("prompt declara que el apellido 'Reyes' NO es opcional", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("apellido");
    expect(prompt).toContain("Reyes");
    expect(prompt).toContain("NO es opcional");
  });

  it("incluye los 3 ejemplos ✅ CORRECTO con apellido completo", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("✅ CORRECTO");
    // Ejemplo 1 (el original del v5.2, se conserva)
    expect(prompt).toContain("Soy Mateo Reyes, del equipo de JPREZ. ¿Y tú con quién tengo el gusto?");
    // Ejemplo 2 (nuevo)
    expect(prompt).toContain("Mi nombre es Mateo Reyes, asesor senior de JPREZ");
    // Ejemplo 3 (nuevo)
    expect(prompt).toContain("Mateo Reyes del equipo JPREZ, a la orden");
  });

  it("incluye los 3 ejemplos ❌ INCORRECTO que omiten apellido", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("❌ INCORRECTO");
    expect(prompt).toContain("Mi nombre es Mateo, asesor de JPREZ Constructora");
    expect(prompt).toContain("Soy Mateo, ¿cómo puedo ayudarte?");
    expect(prompt).toContain("Hola, soy Mateo del equipo");
  });

  it("refuerza que el nombre COMPLETO es Mateo Reyes", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("nombre COMPLETO es Mateo Reyes");
  });

  it("conserva la regla operativa previa (CASO A NO es insistencia IA)", () => {
    const prompt = buildSystemPrompt();
    // Regresion del hotfix-3: esta linea NO debe desaparecer al refactorear CASO A
    expect(prompt).toContain("NO es insistencia de IA");
  });
});
