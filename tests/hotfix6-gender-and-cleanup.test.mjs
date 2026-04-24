// Tests hotfix-6 del Día 3:
// - Bug 1: identidad de género masculino fija de Mateo Reyes
// - Cleanup: api/followup.js importa STAFF_PHONES de src/staff.js
//   (elimina duplicacion de single-source-of-truth)
//
// Modulo leaf: string-matching puro sobre buildSystemPrompt() + leer
// el archivo fuente de followup.js para validar imports.

import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const { buildSystemPrompt } = require("../src/prompts");

describe("Bug 1 (hotfix-6) — Identidad de género masculino fija de Mateo", () => {
  it("declara 'IDENTIDAD DE GÉNERO (REGLA INVIOLABLE)'", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("IDENTIDAD DE GÉNERO");
    expect(prompt).toContain("REGLA INVIOLABLE");
  });

  it("declara explicitamente que Mateo Reyes es HOMBRE", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Mateo Reyes es HOMBRE");
    expect(prompt).toContain("MASCULINO FIJO");
  });

  it("incluye los 6 ejemplos ✅ CORRECTO con adjetivos masculinos", () => {
    const prompt = buildSystemPrompt();
    // Cada ejemplo es una linea entera con comilla inicial.
    expect(prompt).toContain('"Déjame ser honesto contigo"');
    expect(prompt).toContain('"Voy a ser sincero"');
    expect(prompt).toContain('"Estoy tranquilo"');
    expect(prompt).toContain('"Soy nuevo en este proyecto"');
    expect(prompt).toContain('"Quedo atento"');
    expect(prompt).toContain('"Estoy contento de ayudarte"');
  });

  it("incluye los 6 ejemplos ❌ INCORRECTO con adjetivos femeninos prohibidos", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('"Déjame ser honesta"');
    expect(prompt).toContain('"Voy a ser sincera"');
    expect(prompt).toContain('"Estoy tranquila"');
    expect(prompt).toContain('"Soy nueva"');
    expect(prompt).toContain('"Quedo atenta"');
    expect(prompt).toContain('"Estoy contenta"');
  });

  it("aclara que el género del cliente NO afecta — menciona María, Carolina, Ana", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("El género del cliente NO afecta");
    // Nombres femeninos explicitos para disparar contexto (few-shot ancla)
    expect(prompt).toContain("María");
    expect(prompt).toContain("Carolina");
    expect(prompt).toContain("Ana");
  });

  it("indica que Mateo sigue usando masculino aunque la clienta sea mujer", () => {
    const prompt = buildSystemPrompt();
    // Frase que cierra la regla: reafirma masculino incluso con nombre femenino
    expect(prompt).toMatch(/Mateo sigue diciendo.*honesto.*sincero/);
  });
});

describe("Cleanup (hotfix-6) — STAFF_PHONES single-source en api/followup.js", () => {
  // Leer el archivo fuente en vez de hacer require, porque followup.js es un
  // handler de Vercel cron con dependencias que requieren env (@anthropic-ai/sdk).
  const followupSrc = readFileSync(
    join(__dirname, "..", "api", "followup.js"),
    "utf8"
  );

  it("importa STAFF_PHONES desde src/staff (single source of truth)", () => {
    expect(followupSrc).toMatch(/require\(["']\.\.\/src\/staff["']\)/);
    expect(followupSrc).toMatch(/{\s*STAFF_PHONES\s*}\s*=\s*require/);
  });

  it("NO redefine STAFF_PHONES localmente", () => {
    // El patron viejo era `const STAFF_PHONES = {` como declaracion de objeto.
    // La linea nueva es `const { STAFF_PHONES } = require(...)` (destructuring).
    // Diferenciamos con regex: assignment directo a objeto literal.
    expect(followupSrc).not.toMatch(/const\s+STAFF_PHONES\s*=\s*\{\s*$/m);
    expect(followupSrc).not.toMatch(/const\s+STAFF_PHONES\s*=\s*\{[^}]*ENMANUEL_PHONE/);
  });

  it("NO hardcodea ENMANUEL_PHONE localmente (ya no lo necesita)", () => {
    expect(followupSrc).not.toMatch(/const\s+ENMANUEL_PHONE\s*=\s*["']\d+["']/);
  });

  it("el numero admin hardcodeado vive solo en src/notify.js (fuente de verdad)", () => {
    // Validacion paralela: followup.js ya no tiene el numero.
    expect(followupSrc).not.toContain("18299943102");
  });
});
