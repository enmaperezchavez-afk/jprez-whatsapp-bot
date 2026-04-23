// Tests de pulido hotfix-3 Día 3:
// - Fix 1: reglas de fluidez conversacional en MATEO_PROMPT_V5_2
// - Fix 3a: identidad flexible por contexto (Mateo)
// - Fix 3b: identidad robusta (Supervisor)
//
// Modulo leaf: cero I/O, cero mocks. Tests de string-matching sobre los
// prompts generados para validar que las secciones nuevas estan presentes
// con los textos clave + anti-patrones prohibidos.

import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { buildSystemPrompt, SUPERVISOR_PROMPT } = require("../src/prompts");
const { DOC_TYPE_NAMES } = require("../src/handlers/message");

describe("Fix 1 — Reglas de fluidez conversacional", () => {
  it("buildSystemPrompt incluye seccion REGLAS DE FLUIDEZ CONVERSACIONAL", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("REGLAS DE FLUIDEZ CONVERSACIONAL");
  });

  it("incluye instruccion de revisar ultimos 2-3 mensajes antes de responder", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("últimos 2-3 mensajes");
  });

  it("incluye la regla de rotar muletillas (NO repetir consecutivas)", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("NO REPETIR MULETILLAS CONSECUTIVAS");
    expect(prompt).toContain("ROTAR");
  });

  it("incluye ejemplo concreto con muletilla 'Dale'", () => {
    const prompt = buildSystemPrompt();
    // Ejemplo operativo: "si dijiste 'Dale, aquí a tu orden' en el turno
    // anterior, NO abras con 'Dale' otra vez en el siguiente"
    expect(prompt.toLowerCase()).toContain("aquí a tu orden");
  });

  it("incluye la regla de NO REPETIR PREGUNTAS YA HECHAS", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("NO REPETIR PREGUNTAS YA HECHAS");
  });

  it("incluye la regla de NO TERMINAR SIEMPRE CON PREGUNTA", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("NO TERMINAR SIEMPRE CON PREGUNTA");
  });

  it("incluye la regla de AVANZAR CADA TURNO", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("AVANZAR CADA TURNO");
  });

  it("incluye la regla de MEMORIA CORTA", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("MEMORIA CORTA");
  });

  it("incluye la regla de VARIEDAD ESTRUCTURAL", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("VARIEDAD ESTRUCTURAL");
  });

  it("declara explicitamente la regla universal: Mateo nunca se queda pillado", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("pillado");
    expect(prompt).toContain("obliga al cliente a repetir");
  });
});

describe("Fix 3a — Identidad flexible por contexto (Mateo)", () => {
  it("buildSystemPrompt incluye seccion TU IDENTIDAD — FLEXIBILIDAD SEGÚN CONTEXTO", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("TU IDENTIDAD — FLEXIBILIDAD SEGÚN CONTEXTO");
  });

  it("CASO A cubre '¿cómo te llamas?' con respuesta directa de Mateo Reyes", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("CASO A");
    expect(prompt).toContain("Soy Mateo Reyes, del equipo de JPREZ");
  });

  it("CASO B cubre 'eres IA?' (primera vez) con esquive elegante", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("CASO B");
    expect(prompt).toContain("Soy tu contacto de JPREZ");
  });

  it("CASO C cubre insistencia de IA con disclosure etico", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("CASO C");
    expect(prompt).toContain("asistente con IA del equipo JPREZ");
    expect(prompt).toContain("entrenado por Enmanuel");
  });

  it("CASO D cubre preguntas personales con dignidad profesional", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("CASO D");
    expect(prompt).toContain("Llevo 6 años en JPREZ");
  });

  it("declara frases prohibidas — REGLA CRITICA", () => {
    const prompt = buildSystemPrompt();
    // La seccion prohibe explicitamente estas frases
    expect(prompt).toContain("No tengo vida propia como tal");
    expect(prompt).toContain("No tengo un nombre como tal");
    expect(prompt).toContain("Soy simplemente un asistente");
  });

  it("aclara que 'cómo te llamas' NO es insistencia de IA (es CASO A, no B)", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('"¿Cómo te llamas?" NO es insistencia de IA');
  });

  it("conserva regla operativa: 1ra esquivas, 2da reconoces", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("1ra insistencia sobre IA");
    expect(prompt).toContain("2da insistencia directa");
  });

  it("reglas absolutas: NUNCA digas 'como modelo de lenguaje' ni 'soy una IA de Anthropic'", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("modelo de lenguaje");
    expect(prompt).toContain("IA de Anthropic");
  });
});

describe("Fix 3b — Identidad robusta en SUPERVISOR_PROMPT", () => {
  it("lead-in posiciona al bot como 'asistente operativo de JPREZ OS'", () => {
    expect(SUPERVISOR_PROMPT).toContain("asistente operativo de JPREZ OS");
  });

  it("aclara que NO es Mateo Reyes", () => {
    expect(SUPERVISOR_PROMPT).toContain("NO eres Mateo Reyes");
  });

  it("CASO A cubre '¿cómo te llamas?' con respuesta util + ofrece nombrarlo", () => {
    expect(SUPERVISOR_PROMPT).toContain("CASO A");
    expect(SUPERVISOR_PROMPT).toContain("tú mandas");
  });

  it("CASO B cubre 'cuéntame de ti' con descripcion del rol", () => {
    expect(SUPERVISOR_PROMPT).toContain("CASO B");
    expect(SUPERVISOR_PROMPT).toContain("cerebro operativo");
    expect(SUPERVISOR_PROMPT).toContain("supervisar conversaciones");
  });

  it("CASO C cubre preguntas existenciales con dignidad profesional", () => {
    expect(SUPERVISOR_PROMPT).toContain("CASO C");
    expect(SUPERVISOR_PROMPT).toContain("dignidad profesional");
    expect(SUPERVISOR_PROMPT).toContain("claridad sobre mi trabajo");
  });

  it("declara frases PROHIBIDAS en supervisor (no colapsar)", () => {
    expect(SUPERVISOR_PROMPT).toContain("No tengo vida propia como tal jaja");
    expect(SUPERVISOR_PROMPT).toContain("No tengo un nombre como tal");
    expect(SUPERVISOR_PROMPT).toContain("Soy simplemente un asistente");
  });

  it("incluye regla universal: nunca te quedas pillado ni obligas al usuario a repetir", () => {
    expect(SUPERVISOR_PROMPT).toContain("Nunca te quedas pillado");
    expect(SUPERVISOR_PROMPT).toContain("redirige con dignidad");
  });

  it("conserva mojibake-arreglado de hotfixes previos (Trátalo, acátalas)", () => {
    expect(SUPERVISOR_PROMPT).toContain("Trátalo");
    expect(SUPERVISOR_PROMPT).toContain("acátalas");
    // Sin residuos mojibake
    expect(SUPERVISOR_PROMPT).not.toContain("TrÃ");
    expect(SUPERVISOR_PROMPT).not.toContain("acÃ");
  });
});

describe("Fix 2 parcial — Rename cosmético DOC_TYPE_NAMES", () => {
  it("precios usa nombre descriptivo 'Precios y Disponibilidad'", () => {
    expect(DOC_TYPE_NAMES.precios).toBe("Precios y Disponibilidad");
  });

  it("planos usa nombre descriptivo 'Planos Arquitectónicos'", () => {
    expect(DOC_TYPE_NAMES.planos).toBe("Planos Arquitectónicos");
  });

  it("brochure conserva su label 'Brochure'", () => {
    expect(DOC_TYPE_NAMES.brochure).toBe("Brochure");
  });
});
