// Tests del schema de enums del perfil Mateo.
//
// No requiere mocks. Modulo leaf.

import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { INTENCION_COMPRA, SCORE_LEAD, SIGUIENTE_ACCION } = require("../src/profile/schema");

describe("schema enums", () => {
  it("INTENCION_COMPRA tiene exactamente los 4 valores del prompt v5.2", () => {
    expect(INTENCION_COMPRA).toEqual(["explorando", "calificando", "negociando", "listo_cerrar"]);
  });

  it("SCORE_LEAD tiene exactamente los 4 valores del prompt v5.2", () => {
    expect(SCORE_LEAD).toEqual(["frio", "tibio", "caliente", "ardiente"]);
  });

  it("SIGUIENTE_ACCION incluye 'recomendar_competencia' (Nivel 3 Trusted Advisor)", () => {
    expect(SIGUIENTE_ACCION).toContain("recomendar_competencia");
  });

  it("SIGUIENTE_ACCION incluye todos los valores del brief Día 3", () => {
    const expected = [
      "send_brochure",
      "schedule_visit",
      "calculate_plan",
      "escalate_enmanuel",
      "followup_3d",
      "followup_1w",
      "recomendar_competencia",
      "none",
    ];
    expect(SIGUIENTE_ACCION).toEqual(expected);
  });

  it("ningun enum tiene duplicados", () => {
    expect(new Set(INTENCION_COMPRA).size).toBe(INTENCION_COMPRA.length);
    expect(new Set(SCORE_LEAD).size).toBe(SCORE_LEAD.length);
    expect(new Set(SIGUIENTE_ACCION).size).toBe(SIGUIENTE_ACCION.length);
  });
});
