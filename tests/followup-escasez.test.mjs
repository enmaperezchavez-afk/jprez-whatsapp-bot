// ============================================
// Tests Sprint0 PR-F — escasez del followup desde inventario vivo
// ============================================
// Bug: FOLLOWUP_BASE_PROMPT llevaba conteos hardcodeados que drifteaban
// (42/50, 6/60, "63 de 126", PR4 "entrega septiembre 2027" cuando es
// agosto) — y ese prompt genera mensajes REALES a clientes. Ahora el
// bloque de escasez se arma en vivo desde inventory.totals (Sheet manda)
// con fallback genérico que prohíbe citar números.

import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const {
  buildEscasezBlock,
  buildFollowupSystemPrompt,
  ESCASEZ_FALLBACK,
} = require("../api/followup.js");

describe("buildEscasezBlock (Sprint0 PR-F)", () => {
  it("arma el bloque desde totals vivos del inventario", () => {
    const totals = {
      pr3: { disponibles: 13, total: 60 },
      crux_t6: { disponibles: 43, total: 50 },
      pse4: { disponibles: 19, total: 80 },
    };
    const block = buildEscasezBlock(totals);
    expect(block).toContain("conteo vivo del inventario");
    expect(block).toContain("Prado Residences III (pr3): 13 de 60 unidades disponibles");
    expect(block).toContain("Torre 6 (construccion): 43 de 50");
    expect(block).toContain("Puerto Plata E4: 19 de 80");
    // Fechas correctas en los labels (PR4 = agosto 2027, no septiembre).
    expect(block).not.toContain("septiembre 2027");
  });

  it("sin totals → fallback genérico que prohíbe citar números", () => {
    expect(buildEscasezBlock(null)).toBe(ESCASEZ_FALLBACK);
    expect(buildEscasezBlock({})).toBe(ESCASEZ_FALLBACK);
    expect(ESCASEZ_FALLBACK).toContain("NUNCA cites numeros exactos");
  });

  it("el system prompt inyecta el bloque y no deja el placeholder", () => {
    const sys = buildFollowupSystemPrompt(1, buildEscasezBlock({ pr3: { disponibles: 5, total: 60 } }));
    expect(sys).not.toContain("{{ESCASEZ}}");
    expect(sys).toContain("5 de 60");
    // Sin bloque → usa fallback, nunca el placeholder crudo.
    const sysFallback = buildFollowupSystemPrompt(2);
    expect(sysFallback).not.toContain("{{ESCASEZ}}");
    expect(sysFallback).toContain("NUNCA cites numeros exactos");
  });

  it("el prompt base ya no tiene conteos hardcodeados", () => {
    const src = require("fs").readFileSync("api/followup.js", "utf8");
    expect(src).not.toContain("42 de 50");
    expect(src).not.toContain("6 DE 60");
    expect(src).not.toContain("63 de 126");
    expect(src).not.toContain("septiembre 2027");
  });
});
