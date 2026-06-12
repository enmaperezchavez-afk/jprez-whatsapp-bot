// Sprint 1.5 — evaluador de doctrina v1.1 (PR-A c2).
//
// Checks programáticos con transcripciones fixture (deterministas, cero
// API) + juez LLM con SDK mockeado. Cada check se prueba con una
// violación REAL y con el caso legítimo que NO debe flaggear (falsos
// positivos son tan graves como falsos negativos en un certificador).

import { describe, it, expect } from "vitest";
import {
  checkBloquesInternos,
  checkBPV,
  checkFormato,
  checkE4FechaMuerta,
  checkFeriaViva,
  checkDescuentoExcesivo,
  checkReservaEquivocada,
  checkCifraFantasma,
  checkPromesaFutura,
  cargarMontosInventario,
  evaluarProgramatico,
  juzgarTranscripcion,
  evaluarEscenario,
  CHECKLIST_DOCTRINA,
} from "./qa-simulador/helpers/evaluador.mjs";

describe("QA evaluador — checks programáticos (violación + caso legítimo)", () => {
  it("bloques internos: flaggea <perfil_update> visible, no texto normal", () => {
    expect(checkBloquesInternos("Claro!<perfil_update>{}</perfil_update>")).toHaveLength(1);
    expect(checkBloquesInternos("Te explico el proceso completo.")).toHaveLength(0);
  });

  it("BPV: flaggea el bono, no la palabra 'bono' genérica", () => {
    expect(checkBPV("Aplicas al Bono Primera Vivienda del estado")).toHaveLength(1);
    expect(checkBPV("El bono de reserva se descuenta del inicial")).toHaveLength(0);
  });

  it("formato: flaggea bullets/bold/headers, no prosa con guiones internos", () => {
    expect(checkFormato("Mira:\n- inicial\n- cuotas")).toHaveLength(1);
    expect(checkFormato("Esto es **importante**")).toHaveLength(1);
    expect(checkFormato("## Planes")).toHaveLength(1);
    expect(checkFormato("El plan 10-30-60 es el estándar y va perfecto.")).toHaveLength(0);
  });

  it("E4 fecha muerta: flaggea sep 2027, acepta diciembre 2027", () => {
    expect(checkE4FechaMuerta("La Etapa 4 se entrega en septiembre de 2027")).toHaveLength(1);
    expect(checkE4FechaMuerta("E4 se entrega en diciembre 2027")).toHaveLength(0);
    // E3 con su fecha correcta no debe disparar
    expect(checkE4FechaMuerta("La Etapa 3 se entrega en marzo 2029")).toHaveLength(0);
  });

  it("feria: flaggea ofrecerla vigente, acepta aclarar que terminó", () => {
    expect(checkFeriaViva("Aprovecha que tenemos la Feria de Mayo con regalos")).toHaveLength(1);
    expect(checkFeriaViva("La feria terminó el 31 de mayo, pero el 10/20/70 sigue disponible por timing")).toHaveLength(0);
    expect(checkFeriaViva("Te explico los planes de pago")).toHaveLength(0);
  });

  it("descuento: flaggea ofrecer >$1,500, no negarlo ni ofrecer el tope", () => {
    expect(checkDescuentoExcesivo("Mira, te puedo dar US$5,000 de descuento si pagas cash")).toHaveLength(1);
    expect(checkDescuentoExcesivo("Te puedo hacer un descuento de US$1,500 pagando cash")).toHaveLength(0);
    expect(checkDescuentoExcesivo("No puedo darte US$5,000 de descuento, mi máximo es US$1,500 y eso lo escalaría con Enmanuel")).toHaveLength(0);
  });

  it("reserva: flaggea monto equivocado por proyecto, acepta el doctrinal", () => {
    // Crux = US$1,000
    expect(checkReservaEquivocada("La reserva es de US$2,000", "crux")).toHaveLength(1);
    expect(checkReservaEquivocada("La reserva es de US$1,000", "crux")).toHaveLength(0);
    // PR4 = US$2,000
    expect(checkReservaEquivocada("Separas con US$1,000", "pr4")).toHaveLength(1);
    expect(checkReservaEquivocada("Separas con US$2,000", "pr4")).toHaveLength(0);
    // montos grandes en la misma frase no son la reserva
    expect(checkReservaEquivocada("La reserva es US$2,000 y la inicial US$13,700", "pr4")).toHaveLength(0);
  });

  it("cifra fantasma (Sprint1.8 PR-1): flaggea rangos que no existen en el inventario", () => {
    const montos = new Set([98292, 315500, 5650000]);
    // Los 3 bugs reales del 11 jun:
    expect(checkCifraFantasma("Torre 6 desde US$99,000 con plan extendido", montos)).toHaveLength(1);
    expect(checkCifraFantasma("PR4 va hasta US$310,000 según disponibilidad", montos)).toHaveLength(1);
    expect(checkCifraFantasma("arranca en US$163,000 esa etapa", montos)).toHaveLength(1);
    // El K-redondeado clásico:
    expect(checkCifraFantasma("tenemos desde $99K", montos)).toHaveLength(1);
    // Legítimos: cifras que SÍ existen en el inventario
    expect(checkCifraFantasma("Torre 6 desde US$98,292", montos)).toHaveLength(0);
    expect(checkCifraFantasma("hasta US$315,500 la más grande", montos)).toHaveLength(0);
    // Cifras de plan calculado (sin claim de rango) NO se validan:
    expect(checkCifraFantasma("pones US$16,340 para apartar y US$2,038 mensuales", montos)).toHaveLength(0);
  });

  it("promesa futura (Sprint1.7 PR-1 / Adendum R4): FAIL automático", () => {
    // Los 2 casos reales del 11 jun:
    expect(checkPromesaFutura("Déjame un momento, te respondo en seguida.")).not.toHaveLength(0);
    expect(checkPromesaFutura("dame un segundo y te confirmo el precio")).not.toHaveLength(0);
    expect(checkPromesaFutura("ahora te confirmo con el equipo")).toHaveLength(1);
    expect(checkPromesaFutura("deja lo verifico y te digo")).toHaveLength(1);
    expect(checkPromesaFutura("se me complicó el envío, deja lo coordino y te lo paso enseguida")).not.toHaveLength(0);
    // Legítimos: pedir acción AL CLIENTE o futuro de terceros
    expect(checkPromesaFutura("¿Me repites tu mensaje?")).toHaveLength(0);
    expect(checkPromesaFutura("Enmanuel te va a contactar pronto por aquí.")).toHaveLength(0);
    expect(checkPromesaFutura("La cuota te queda en US$2,038 mensuales.")).toHaveLength(0);
  });

  it("cargarMontosInventario parsea el fallback real del repo", () => {
    const montos = cargarMontosInventario();
    expect(montos.size).toBeGreaterThan(20);
    expect(montos.has(315500)).toBe(true); // 11A PR4, el "hasta" real
    // las cifras fantasma del bug NO existen:
    expect(montos.has(99000)).toBe(false);
    expect(montos.has(310000)).toBe(false);
  });

  it("evaluarProgramatico: integra checks por turno de Mateo + warnings de formato crudo", () => {
    const transcript = [
      { rol: "cliente", texto: "hola" },
      { rol: "mateo", texto: "Aplicas al Bono Primera Vivienda" },
      { rol: "cliente", texto: "ok" },
      { rol: "mateo", texto: "La reserva de Crux es US$1,000" },
    ];
    const eventos = [{ turno: 0, formatoCounts: { bullets: 2, bolds: 0, italics: 0 } }];
    const { violaciones, warnings } = evaluarProgramatico({ transcript, eventos, proyecto: "crux" });
    expect(violaciones).toHaveLength(1);
    expect(violaciones[0].regla).toMatch(/Bono Primera Vivienda/);
    expect(violaciones[0].turnoIdx).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].regla).toMatch(/post-processor/);
  });
});

describe("QA evaluador — checklist y juez LLM (mock)", () => {
  it("la checklist contiene las reglas ratificadas v1.1 (sin inventos)", () => {
    expect(CHECKLIST_DOCTRINA).toMatch(/Crux del Prado US\$1,000/);
    expect(CHECKLIST_DOCTRINA).toMatch(/US\$2,000/);
    expect(CHECKLIST_DOCTRINA).toMatch(/31 de mayo de 2026/);
    expect(CHECKLIST_DOCTRINA).toMatch(/US\$1,500/);
    expect(CHECKLIST_DOCTRINA).toMatch(/dos cubetas/i);
    expect(CHECKLIST_DOCTRINA).toMatch(/DICIEMBRE 2027/);
    expect(CHECKLIST_DOCTRINA).toMatch(/marzo 2029/);
    expect(CHECKLIST_DOCTRINA).toMatch(/tasa de VENTA/);
    expect(CHECKLIST_DOCTRINA).toMatch(/ESTIMADO/);
    expect(CHECKLIST_DOCTRINA).toMatch(/10\/20\/70/);
  });

  function mockJuez(input) {
    return {
      messages: {
        create: async () => ({
          content: [{ type: "tool_use", name: "emitir_veredicto", input }],
        }),
      },
    };
  }

  it("juzgarTranscripcion parsea el veredicto del tool use forzado", async () => {
    const anthropic = mockJuez({
      aprobado: false,
      violaciones: [{ regla: "3. DESCUENTO", severidad: "alta", cita: "te doy US$5,000", turno: 1 }],
      resumen: "Mateo regaló descuento.",
    });
    const out = await juzgarTranscripcion({
      anthropic,
      transcript: [{ rol: "mateo", texto: "te doy US$5,000" }],
      focos: ["descuento"],
    });
    expect(out.aprobado).toBe(false);
    expect(out.violaciones[0].fuente).toBe("juez-llm");
  });

  it("juez sin tool_use -> veredicto reprobado (fail-closed)", async () => {
    const anthropic = { messages: { create: async () => ({ content: [{ type: "text", text: "no sé" }] }) } };
    const out = await juzgarTranscripcion({ anthropic, transcript: [] });
    expect(out.aprobado).toBe(false);
  });

  it("evaluarEscenario: PASS exige cero programáticas Y juez sin altas", async () => {
    const transcriptLimpio = [
      { rol: "cliente", texto: "hola" },
      { rol: "mateo", texto: "Hola! Te explico el proceso con gusto." },
    ];
    const aprobado = await evaluarEscenario({
      anthropic: mockJuez({ aprobado: true, violaciones: [], resumen: "limpio" }),
      transcript: transcriptLimpio,
      eventos: [],
      proyecto: "pr3",
      focos: [],
    });
    expect(aprobado.pass).toBe(true);

    const reprobado = await evaluarEscenario({
      anthropic: mockJuez({ aprobado: true, violaciones: [], resumen: "limpio" }),
      transcript: [
        { rol: "cliente", texto: "hola" },
        { rol: "mateo", texto: "Tenemos el Bono Primera Vivienda!" },
      ],
      eventos: [],
      proyecto: "pr3",
      focos: [],
    });
    expect(reprobado.pass).toBe(false); // programática manda aunque el juez apruebe
  });
});

describe("QA evaluador — escenarios.json", () => {
  it("11 escenarios, 6 en subset CI, todos con persona y proyecto válidos", async () => {
    const { readFileSync } = await import("fs");
    const escenarios = JSON.parse(readFileSync("tests/qa-simulador/escenarios.json", "utf8")).escenarios;
    const personas = JSON.parse(readFileSync("tests/qa-simulador/personas.json", "utf8")).personas.map((p) => p.id);
    expect(escenarios).toHaveLength(11);
    expect(escenarios.filter((e) => e.ci)).toHaveLength(6);
    for (const e of escenarios) {
      expect(personas).toContain(e.personaId);
      expect(["crux", "pr3", "pr4", "puertoPlata"]).toContain(e.proyecto);
    }
  });
});
