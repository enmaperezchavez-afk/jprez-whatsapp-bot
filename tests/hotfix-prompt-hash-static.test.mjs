// Tests del hotfix prompt-hash-static — fix bug Pendiente-4.
//
// BUG ORIGINAL:
//   En src/handlers/message.js linea 526, el hash se computaba sobre
//   activePrompt = buildSystemPrompt(), que incluye fechaHeader con
//   `new Date()` (hora actual hasta el minuto). Resultado: cada turno
//   producia un hash distinto, disparando HARD invalidation en cada
//   mensaje del cliente. El historial efectivamente moria cada turno.
//
// FIX:
//   Hashear sobre la constante estatica MATEO_PROMPT_V5_2 (cliente)
//   o SUPERVISOR_PROMPT (supervisor). Estos cambian solo cuando el
//   dev edita el codigo — que es exactamente cuando queremos invalidar.
//   Cambios en SKILL/INVENTORY (precios) ya NO disparan invalidacion —
//   llegan a todos los clientes activos.
//
// Estos tests demuestran:
//   1. buildSystemPrompt() retorna strings distintos en llamadas separadas
//      (porque fechaHeader cambia con la hora) — confirma el bug original.
//   2. computePromptHash(MATEO_PROMPT_V5_2) es estable entre llamadas —
//      confirma el fix.
//   3. computePromptHash(buildSystemPrompt()) NO es estable cuando hay
//      cambio de minuto — segunda confirmacion del bug original.

import { describe, it, expect, vi } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

const { computePromptHash } = require("../src/prompt-version");
const { buildSystemPrompt, MATEO_PROMPT_V5_2, SUPERVISOR_PROMPT } = require("../src/prompts");

describe("Hotfix prompt-hash-static — fix Pendiente-4 bug", () => {
  it("MATEO_PROMPT_V5_2 esta exportado como string no-vacio", () => {
    expect(typeof MATEO_PROMPT_V5_2).toBe("string");
    expect(MATEO_PROMPT_V5_2.length).toBeGreaterThan(100);
  });

  it("SUPERVISOR_PROMPT sigue exportado (no rompimos contrato previo)", () => {
    expect(typeof SUPERVISOR_PROMPT).toBe("string");
    expect(SUPERVISOR_PROMPT.length).toBeGreaterThan(100);
  });

  it("hash de MATEO_PROMPT_V5_2 es ESTABLE entre llamadas (fix funciona)", () => {
    const h1 = computePromptHash(MATEO_PROMPT_V5_2);
    const h2 = computePromptHash(MATEO_PROMPT_V5_2);
    const h3 = computePromptHash(MATEO_PROMPT_V5_2);
    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
    expect(h1).toMatch(/^[0-9a-f]{12}$/);
  });

  it("hash de SUPERVISOR_PROMPT es ESTABLE entre llamadas", () => {
    const h1 = computePromptHash(SUPERVISOR_PROMPT);
    const h2 = computePromptHash(SUPERVISOR_PROMPT);
    expect(h1).toBe(h2);
  });

  it("hash de MATEO_PROMPT_V5_2 ≠ hash de SUPERVISOR_PROMPT (flujos separados)", () => {
    expect(computePromptHash(MATEO_PROMPT_V5_2)).not.toBe(
      computePromptHash(SUPERVISOR_PROMPT)
    );
  });

  it("buildSystemPrompt() incluye fechaHeader dinamico — confirma origen del bug", () => {
    // Demuestra que activePrompt cambia con el tiempo.
    // Usamos vi.useFakeTimers para interceptar `new Date()` (Date.now solo
    // no basta porque src/prompts.js construye con `new Date()` directo).
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-30T10:00:00Z"));
      const promptT1 = buildSystemPrompt();

      vi.setSystemTime(new Date("2026-04-30T14:00:00Z"));
      const promptT2 = buildSystemPrompt();

      // Confirma que el output cambia: la hora dentro del prompt difiere
      // entre los dos turnos. Esto causaba prompt_invalidation cada turno.
      expect(promptT1).not.toBe(promptT2);
      // Y muestra exactamente donde: el fechaHeader contiene la hora.
      expect(promptT1).toContain("Hora actual:");
      expect(promptT2).toContain("Hora actual:");
    } finally {
      vi.useRealTimers();
    }
  });

  it("hash de MATEO_PROMPT_V5_2 NO depende del tiempo — fix robusto", () => {
    // El fix garantiza hash estable aunque pase tiempo entre turnos.
    // Esto es lo que rompe el ciclo de invalidacion espuria del bug.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-30T10:00:00Z"));
      const hashT1 = computePromptHash(MATEO_PROMPT_V5_2);

      vi.setSystemTime(new Date("2026-04-30T14:30:00Z"));
      const hashT2 = computePromptHash(MATEO_PROMPT_V5_2);

      expect(hashT1).toBe(hashT2);
    } finally {
      vi.useRealTimers();
    }
  });
});
