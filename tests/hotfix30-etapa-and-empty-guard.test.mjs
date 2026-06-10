// Hotfix-30 (22 may 2026) — Fix 1 (etapa inteligente puertoPlata) +
// señal de exposición toolInvocationCount (soporte de Fix 2).
//
// CONTEXTO P0: query "estudios disponibles en pse3" → el LLM invocaba
// calcular_plan_pago con proyecto=puertoPlata SIN etapa → la tool
// devolvía el error "debes especificar la etapa" → el turno final del
// LLM emitía solo <perfil_update> sin texto → empty-reply guard →
// "se me complicó algo". (Reproducido contra Redis prod + Claude real.)
//
// FIX 1: inferEtapaFromContext(text) resuelve E3/E4 del mensaje;
//        calcularPlanPago ya NO devuelve error duro para puertoPlata
//        sin etapa — devuelve señal soft { needs_etapa: true }.
// FIX 2: callClaudeWithTools expone response.toolInvocationCount para
//        que el handler distinga "vacío tras tool call" de "vacío seco".

import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// Stub de log (sin Axiom) — mismo patrón que hotfix19-c3.
{
  const id = require.resolve("../src/log");
  require.cache[id] = {
    id, filename: id, loaded: true,
    exports: { botLog: () => {}, logToAxiom: async () => {} },
  };
}

const { calcularPlanPago, inferEtapaFromContext } = require("../src/handlers/message");

describe("Hotfix-30 Fix 1 — inferEtapaFromContext", () => {
  it("PSE3 / 'etapa 3' / E3 → E3", () => {
    expect(inferEtapaFromContext("quiero ver estudios disponibles en pse3")).toBe("E3");
    expect(inferEtapaFromContext("me interesa la etapa 3")).toBe("E3");
    expect(inferEtapaFromContext("el de E3 por favor")).toBe("E3");
    expect(inferEtapaFromContext("Prado Suites Puerto Plata etapa III")).toBe("E3");
    expect(inferEtapaFromContext("PSE-3 tiene estudios?")).toBe("E3");
  });

  it("PSE4 / 'etapa 4' / E4 → E4", () => {
    expect(inferEtapaFromContext("dame info de pse4")).toBe("E4");
    expect(inferEtapaFromContext("la etapa 4 cuándo entrega?")).toBe("E4");
    expect(inferEtapaFromContext("quiero E4")).toBe("E4");
    expect(inferEtapaFromContext("etapa IV de puerto plata")).toBe("E4");
  });

  it("menciona ambas etapas → null (ambiguo, pedir aclaración)", () => {
    expect(inferEtapaFromContext("diferencia entre pse3 y pse4")).toBe(null);
    expect(inferEtapaFromContext("E3 o E4, cuál me conviene?")).toBe(null);
  });

  it("no menciona etapa → null", () => {
    expect(inferEtapaFromContext("cuánto cuesta un estudio en puerto plata?")).toBe(null);
    expect(inferEtapaFromContext("hola, info de precios")).toBe(null);
  });

  it("input vacío/no-string → null (defensa)", () => {
    expect(inferEtapaFromContext("")).toBe(null);
    expect(inferEtapaFromContext(null)).toBe(null);
    expect(inferEtapaFromContext(undefined)).toBe(null);
    expect(inferEtapaFromContext(123)).toBe(null);
  });

  it("no confunde números sueltos (precio 'US$3,000', '34 meses') con etapa", () => {
    // "3" suelto en un precio o cantidad NO debe disparar E3.
    expect(inferEtapaFromContext("tengo US$3,000 para reservar")).toBe(null);
    expect(inferEtapaFromContext("son 34 meses hasta entrega")).toBe(null);
  });
});

describe("Hotfix-30 Fix 1 — calcularPlanPago puertoPlata sin etapa NO es error duro", () => {
  it("puertoPlata SIN etapa → señal soft needs_etapa (no { error })", () => {
    const r = calcularPlanPago("puertoPlata", 73000);
    expect(r.needs_etapa).toBe(true);
    expect(typeof r.ask_client).toBe("string");
    expect(r.ask_client.length).toBeGreaterThan(0);
    // Crítico: el error duro que mataba el turno fue eliminado.
    expect(r.error).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("debes especificar la etapa");
  });

  it("puertoPlata con etapa inválida → también señal soft (no error)", () => {
    const r = calcularPlanPago("puertoPlata", 73000, "E9");
    expect(r.needs_etapa).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it("puertoPlata E3 → cálculo normal con fecha de entrega marzo 2029", () => {
    const r = calcularPlanPago("puertoPlata", 73000, "E3");
    expect(r.needs_etapa).toBeUndefined();
    expect(r.error).toBeUndefined();
    expect(r.etapa).toBe("E3");
    expect(r.entrega_fecha).toBe("2029-03-01");
    expect(r.precio_total_usd).toBe(73000);
    expect(r.proyecto).toContain("Etapa E3");
  });

  it("puertoPlata E4 → cálculo normal con fecha de entrega diciembre 2027", () => {
    const r = calcularPlanPago("puertoPlata", 163400, "E4");
    expect(r.error).toBeUndefined();
    expect(r.etapa).toBe("E4");
    // Sprint0-delta: E4 entrega dic 2027 (sep 2027 inflaba la cuota ~20%).
    expect(r.entrega_fecha).toBe("2027-12-01");
  });

  it("otros proyectos (pr3) siguen ignorando etapa y calculan", () => {
    const r = calcularPlanPago("pr3", 156000);
    expect(r.error).toBeUndefined();
    expect(r.needs_etapa).toBeUndefined();
    expect(r.etapa).toBe(null);
    expect(r.entrega_fecha).toBe("2026-08-01");
  });
});
