// Hotfix-28 — Tests pickRawReply cold-start guard.
//
// Bug Director 18 may 14:51Z: cliente nuevo (cold start) + "soy
// extranjero puedo comprar?" → tool_use loop sin texto → fallback
// genérico "Dejame un momento" → safety net "se me complicó algo".
//
// Path B fix: pickRawReply devuelve saludo contextual warm-first
// cuando customerProfile.is_new=true Y rawReplyJoined está vacío.
//
// Cobertura (5 tests):
//   1. Cold start + empty rawReply → synthetic reply + coldStartSyntheticUsed=true
//   2. Cold start + texto válido → texto (no aplica, sin regresión)
//   3. Cliente con historial (is_new=false) + empty → fallback genérico
//   4. Staff con empty → fallback genérico (no aplica synthetic a staff)
//   5. Supervisor con empty → fallback genérico (no aplica synthetic a supervisor)

import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const {
  pickRawReply,
  COLD_START_SYNTHETIC_REPLY,
  GENERIC_HOLDING_REPLY,
} = require("../src/handlers/message");

describe("Hotfix-28 — pickRawReply cold-start guard", () => {
  it("Test 1: cold start + empty rawReply → synthetic warm-first reply", () => {
    const out = pickRawReply({
      rawReplyJoined: "",
      customerProfile: { is_new: true },
      isStaff: false,
      isSupervisor: false,
    });
    expect(out.reply).toBe(COLD_START_SYNTHETIC_REPLY);
    expect(out.coldStartSyntheticUsed).toBe(true);
    // Sanity check del contenido del synthetic
    expect(out.reply).toMatch(/Hola/);
    expect(out.reply).toMatch(/Mateo/);
    expect(out.reply).toMatch(/JPREZ/);
    expect(out.reply).toMatch(/proyecto/i);
  });

  it("Test 2: cold start + texto válido → texto del LLM (no aplica synthetic)", () => {
    const out = pickRawReply({
      rawReplyJoined: "¡Buenas! Soy Mateo. ¿En qué te ayudo hoy?",
      customerProfile: { is_new: true },
      isStaff: false,
      isSupervisor: false,
    });
    expect(out.reply).toBe("¡Buenas! Soy Mateo. ¿En qué te ayudo hoy?");
    expect(out.coldStartSyntheticUsed).toBe(false);
  });

  it("Test 3: cliente con historial (is_new=false) + empty → fallback genérico (NO regresión)", () => {
    const out = pickRawReply({
      rawReplyJoined: "",
      customerProfile: { is_new: false, nombre: "Juan", proyecto_interes: "pr4" },
      isStaff: false,
      isSupervisor: false,
    });
    expect(out.reply).toBe(GENERIC_HOLDING_REPLY);
    expect(out.coldStartSyntheticUsed).toBe(false);
  });

  it("Test 4: isStaff=true + cold start vibes → fallback genérico (synthetic solo cliente)", () => {
    const out = pickRawReply({
      rawReplyJoined: "",
      customerProfile: { is_new: true },
      isStaff: true,
      isSupervisor: false,
    });
    expect(out.reply).toBe(GENERIC_HOLDING_REPLY);
    expect(out.coldStartSyntheticUsed).toBe(false);
  });

  it("Test 5: isSupervisor=true + cold start vibes → fallback genérico", () => {
    const out = pickRawReply({
      rawReplyJoined: "",
      customerProfile: { is_new: true },
      isStaff: false,
      isSupervisor: true,
    });
    expect(out.reply).toBe(GENERIC_HOLDING_REPLY);
    expect(out.coldStartSyntheticUsed).toBe(false);
  });

  it("Test 6 (extra): customerProfile null + empty → fallback genérico (safety)", () => {
    const out = pickRawReply({
      rawReplyJoined: "",
      customerProfile: null,
      isStaff: false,
      isSupervisor: false,
    });
    expect(out.reply).toBe(GENERIC_HOLDING_REPLY);
    expect(out.coldStartSyntheticUsed).toBe(false);
  });
});
