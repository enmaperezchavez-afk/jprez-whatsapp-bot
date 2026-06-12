// Sprint1.8 PR-4 — handoff cubeta B endurecido: detector determinista
// pre-LLM. "quiero hablar con una persona" → [ESCALAR] inmediato con el
// mensaje doctrinal; el LLM nunca tiene chance de retener.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const {
  detectHumanHandoffRequest,
  HUMAN_HANDOFF_REPLY_ES,
  HUMAN_HANDOFF_REPLY_EN,
} = require("../src/detect.js");

describe("HANDOFF — detector determinista", () => {
  it("español: variantes de 'quiero hablar con una persona'", () => {
    expect(detectHumanHandoffRequest("quiero hablar con una persona")).toBe("es");
    expect(detectHumanHandoffRequest("Necesito hablar con un humano por favor")).toBe("es");
    expect(detectHumanHandoffRequest("¿puedo hablar con alguien?")).toBe("es");
    expect(detectHumanHandoffRequest("pásame con un agente")).toBe("es");
    expect(detectHumanHandoffRequest("comunícame con Enmanuel")).toBe("es");
    expect(detectHumanHandoffRequest("prefiero hablar con una persona real")).toBe("es");
  });

  it("inglés: el extranjero también dispara el handoff", () => {
    expect(detectHumanHandoffRequest("I want to talk to a person")).toBe("en");
    expect(detectHumanHandoffRequest("can I speak with a human?")).toBe("en");
    expect(detectHumanHandoffRequest("connect me with an agent please")).toBe("en");
  });

  it("NO dispara con menciones que no piden persona (cero falsos positivos)", () => {
    expect(detectHumanHandoffRequest("quiero hablar con mi esposa primero")).toBeNull();
    expect(detectHumanHandoffRequest("¿cuánto cuesta el 2 habitaciones?")).toBeNull();
    expect(detectHumanHandoffRequest("una persona me recomendó el proyecto")).toBeNull();
    expect(detectHumanHandoffRequest("Enmanuel me dijo que escribiera por aquí")).toBeNull();
    expect(detectHumanHandoffRequest("")).toBeNull();
    expect(detectHumanHandoffRequest(null)).toBeNull();
  });

  it("mensajes doctrinales: el CANÓNICO v1.1 del vendedor SKILL (alineado Sprint1.7)", () => {
    // Single source: el guard usa el mismo "Mensaje de escalamiento" del SKILL.
    const skill = readFileSync(".claude/skills/vendedor-whatsapp-jprez/SKILL.md", "utf8");
    expect(skill).toContain(HUMAN_HANDOFF_REPLY_ES);
    expect(HUMAN_HANDOFF_REPLY_ES).toMatch(/equipo de ventas/);
    expect(HUMAN_HANDOFF_REPLY_ES).toMatch(/personalmente/);
    expect(HUMAN_HANDOFF_REPLY_ES).not.toMatch(/te lo resuelvo yo|seguro\?|primero/i);
    expect(HUMAN_HANDOFF_REPLY_EN).toMatch(/sales team/);
    expect(HUMAN_HANDOFF_REPLY_EN).toMatch(/personally/);
  });
});

describe("HANDOFF — wiring pre-LLM en message.js", () => {
  const handler = readFileSync("src/handlers/message.js", "utf8");

  it("el guard corre ANTES del call a Claude y solo para clientes", () => {
    const idxGuard = handler.indexOf("detectHumanHandoffRequest(userMessage)");
    const idxClaude = handler.indexOf("callClaudeWithTools({");
    expect(idxGuard).toBeGreaterThan(0);
    expect(idxGuard).toBeLessThan(idxClaude);
    // gated a !isStaff y respeta el holding ya escalado
    expect(handler).toMatch(/yaEscalado\s*=\s*clientMeta\?\.escalated === true && isEscalationActive/);
  });

  it("escala de verdad: notifica + marca escalated + persiste el reply en historial", () => {
    expect(handler).toMatch(/human_handoff_guard/);
    expect(handler).toMatch(/notifyWithMeta\(senderPhone, userMessage, reply, "escalation"\)/);
    const guardBlock = handler.slice(
      handler.indexOf("Sprint1.8 PR-4: handoff cubeta B"),
      handler.indexOf("human_handoff_guard")
    );
    expect(guardBlock).toMatch(/escalated: true/);
    expect(guardBlock).toMatch(/addMessage\(storageKey, "assistant", reply/);
  });

  it("la doctrina dura vive en el vendedor SKILL (cubeta B sin retener)", () => {
    const skill = readFileSync(".claude/skills/vendedor-whatsapp-jprez/SKILL.md", "utf8");
    expect(skill).toMatch(/handoff es INMEDIATO/);
    expect(skill).toMatch(/PROHIBIDO intentar retener/);
    expect(skill).toMatch(/a ver si te lo resuelvo yo/);
  });

  it("el simulador tiene el escenario que lo certifica (subset CI)", () => {
    const personas = JSON.parse(readFileSync("tests/qa-simulador/personas.json", "utf8")).personas;
    const escenarios = JSON.parse(readFileSync("tests/qa-simulador/escenarios.json", "utf8")).escenarios;
    const persona = personas.find((p) => p.id === "quiere-humano");
    expect(persona).toBeDefined();
    expect(persona.estresa.join(" ")).toMatch(/handoff cubeta B/);
    const esc = escenarios.find((e) => e.id === "handoff-humano");
    expect(esc).toBeDefined();
    expect(esc.ci).toBe(true);
  });
});
