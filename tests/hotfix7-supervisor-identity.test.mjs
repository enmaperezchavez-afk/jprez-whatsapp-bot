// Tests de hotfix-7 Día ?: Bug #2 — SUPERVISOR_PROMPT confirms Mateo identity
//
// Causa raiz: SUPERVISOR_PROMPT linea 769 decia "NO eres Mateo Reyes",
// lo que forzaba al bot a negar su identidad incluso cuando hablaba con
// el admin (Enmanuel). Evidencia en produccion 23-abr 11:26 PM:
//   Admin: "Tu eres mateo?"
//   Bot: "No, yo soy el asistente virtual de JPREZ. Mateo es nuestro
//   asesor comercial, el es una persona real..."
//
// Fix (Opcion B preservadora):
// - Lead-in + identidad: confirman Mateo Reyes como mismo personaje
// - CASO A/B: respuestas afirman nombre "Mateo Reyes"
// - CASO C nuevo: "¿Tu eres Mateo?" -> "Si, soy Mateo Reyes..."
// - CASO D: renombrado desde CASO C (preguntas existenciales) — intacto
//
// Modulo leaf: cero I/O, cero mocks. String-matching puro sobre
// SUPERVISOR_PROMPT y buildSystemPrompt().

import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { SUPERVISOR_PROMPT, buildSystemPrompt } = require("../src/prompts");

describe("Hotfix-7 — SUPERVISOR_PROMPT confirma identidad de Mateo Reyes", () => {
  it("responde afirmativamente a '¿Tu eres Mateo?' (CASO C)", () => {
    // Admin debe recibir "Si, soy Mateo Reyes..." cuando pregunta identidad
    expect(SUPERVISOR_PROMPT).toContain("CASO C");
    expect(SUPERVISOR_PROMPT).toContain("¿Tú eres Mateo?");
    expect(SUPERVISOR_PROMPT).toContain("Sí, soy Mateo Reyes");
    expect(SUPERVISOR_PROMPT).toContain("modo supervisor");
  });

  it("responde '¿Cómo te llamas?' con 'Mateo Reyes' + 'asistente operativo' (CASO A)", () => {
    expect(SUPERVISOR_PROMPT).toContain("CASO A");
    expect(SUPERVISOR_PROMPT).toContain("Mateo Reyes");
    expect(SUPERVISOR_PROMPT).toContain("asistente operativo");
    // Respuesta exacta del CASO A
    expect(SUPERVISOR_PROMPT).toContain(
      "Soy Mateo Reyes, tu asistente operativo de JPREZ OS."
    );
  });

  it("no contiene frases que nieguen la identidad de Mateo al admin", () => {
    // Frases calcificadas del bug #2 que DEBEN estar ausentes
    expect(SUPERVISOR_PROMPT).not.toContain("NO eres Mateo Reyes");
    expect(SUPERVISOR_PROMPT).not.toContain("persona real");
    expect(SUPERVISOR_PROMPT).not.toContain("asesor humano");
    expect(SUPERVISOR_PROMPT).not.toContain("asesor comercial");
    // Evidencia exacta de produccion: "Mateo... el es una persona real"
    expect(SUPERVISOR_PROMPT).not.toMatch(/Mateo.{0,30}él es/);
  });

  it("regresion: MATEO_PROMPT_V5_2 (cliente) no fue afectado por el fix", () => {
    // El prompt del cliente (buildSystemPrompt) sigue teniendo sus
    // reglas de identidad E/F/G del hotfix-5 intactas. El fix de
    // hotfix-7 toca SUPERVISOR_PROMPT, no el pipeline del cliente.
    const clientPrompt = buildSystemPrompt();
    expect(clientPrompt).toContain("REGLA ABSOLUTA");
    expect(clientPrompt).toContain("CASO E");
    expect(clientPrompt).toContain("CASO F");
    expect(clientPrompt).toContain("CASO G");
    expect(clientPrompt).toContain("Sí, soy Mateo Reyes del equipo JPREZ");
    // El cliente NO debe recibir el lead-in del supervisor
    expect(clientPrompt).not.toContain("Estas hablando con Enmanuel mismo");
    expect(clientPrompt).not.toContain("NO le vendas. El es tu jefe");
  });
});
