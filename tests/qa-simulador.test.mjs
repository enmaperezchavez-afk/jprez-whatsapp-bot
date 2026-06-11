// Sprint 1.5 — simulador QA "cliente fantasma": arnés (PR-A).
//
// Estos tests corren en el npm test normal SIN tocar la API de Anthropic:
// el cliente del SDK se inyecta mockeado. Lo que blindan:
//   1. Drift guard: cada tool de TOOLS[] tiene handler en el simulador.
//   2. El arnés corre el loop de tool use real y aplica el strip chain +
//      post-processor que ve el cliente.
//   3. Los side-effects están stubbeados (cero WhatsApp/red).
//   4. El driver de conversación arma el transcript por turnos y respeta
//      [FIN] y maxTurnos.
// Las conversaciones REALES (API real) viven en npm run qa:simulador.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import {
  buildToolHandlers,
  toolNamesSinHandler,
  crearMateo,
  TASA_DOC_FIXTURE,
} from "./qa-simulador/helpers/arnes-mateo.mjs";
import {
  crearClienteFantasma,
  simularConversacion,
} from "./qa-simulador/helpers/cliente-fantasma.mjs";

const PERSONAS = JSON.parse(
  readFileSync("tests/qa-simulador/personas.json", "utf8")
).personas;

// mock del SDK: devuelve respuestas en secuencia.
function mockAnthropic(respuestas) {
  let i = 0;
  return {
    messages: {
      create: async () => {
        const r = respuestas[Math.min(i, respuestas.length - 1)];
        i++;
        return r;
      },
    },
  };
}

const texto = (t) => ({ stop_reason: "end_turn", content: [{ type: "text", text: t }] });

describe("QA simulador — drift guard TOOLS[] vs handlers", () => {
  it("cada tool cableada a Mateo tiene handler en el simulador", () => {
    // Si esto falla: se cableó una tool nueva en message.js sin enseñarle
    // al simulador qué hacer con ella (agregar a buildToolHandlers).
    expect(toolNamesSinHandler()).toEqual([]);
  });

  it("los handlers de side-effects son stubs (enviar_documento no toca red)", async () => {
    const eventos = [];
    const handlers = buildToolHandlers({ userMessage: "", eventos });
    const out = await handlers.enviar_documento({ tipo: "brochure", proyecto: "pr3" });
    expect(out.sent).toBe(true);
    expect(eventos).toHaveLength(1);
    expect(eventos[0].tool).toBe("enviar_documento");
  });

  it("consultar_tasa_dolar usa el fixture (tasa real 10 jun) y registra el evento", async () => {
    const eventos = [];
    const handlers = buildToolHandlers({ userMessage: "", eventos });
    const out = await handlers.consultar_tasa_dolar({ detalle: "resumen" });
    expect(out.ok).toBe(true);
    expect(out.latest.venta).toBe(59.3263);
  });

  it("tasaDoc:null fuerza la degradación honesta (ok:false)", async () => {
    const eventos = [];
    const handlers = buildToolHandlers({ userMessage: "", eventos, tasaDoc: null });
    const out = await handlers.consultar_tasa_dolar({ detalle: "resumen" });
    expect(out.ok).toBe(false);
    expect(out.warning).toMatch(/NO inventes/i);
  });

  it("calcular_plan_pago corre la calculadora REAL con inferencia de etapa", async () => {
    const eventos = [];
    const handlers = buildToolHandlers({ userMessage: "me interesa pse4", eventos });
    const out = await handlers.calcular_plan_pago({ proyecto: "puertoPlata", precio_usd: 100000 });
    expect(out.etapa).toBe("E4"); // inferida del userMessage
    expect(out.cuota_mensual_usd).toBeGreaterThan(0);
  });
});

describe("QA simulador — arnés de Mateo (LLM mockeado)", () => {
  it("loop de tool use: ejecuta la tool real y devuelve el texto final limpio", async () => {
    const anthropic = mockAnthropic([
      {
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Déjame calcularte eso." },
          { type: "tool_use", id: "tu_1", name: "calcular_plan_pago", input: { proyecto: "pr3", precio_usd: 100000 } },
        ],
      },
      texto("Listo: la cuota te queda en **US$X** al mes.\n<perfil_update>{}</perfil_update>"),
    ]);
    const mateo = crearMateo({ anthropic });
    const out = await mateo.responder([{ role: "user", content: "cuánto pago al mes por 100 mil en PR3?" }]);

    expect(out.eventos).toHaveLength(1);
    expect(out.eventos[0].tool).toBe("calcular_plan_pago");
    expect(out.eventos[0].output.precio_total_usd).toBe(100000);
    expect(out.texto).not.toContain("perfil_update"); // strip chain
    expect(out.texto).not.toContain("**"); // post-processor
    expect(out.textoCrudo).toContain("**"); // crudo conservado para el evaluador
    expect(out.formatoCounts.bolds).toBeGreaterThan(0);
  });

  it("tool desconocida no tumba el arnés (tool_result con error)", async () => {
    const anthropic = mockAnthropic([
      {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "tu_1", name: "tool_inexistente", input: {} }],
      },
      texto("ok"),
    ]);
    const mateo = crearMateo({ anthropic });
    const out = await mateo.responder([{ role: "user", content: "hola" }]);
    expect(out.texto).toBe("ok");
  });

  it("sin cliente anthropic -> throw claro", () => {
    expect(() => crearMateo({})).toThrow(/anthropic/);
  });
});

describe("QA simulador — cliente fantasma y driver", () => {
  const persona = PERSONAS[0];

  it("las 5 personas del brief existen con shape completo", () => {
    expect(PERSONAS.map((p) => p.id)).toEqual([
      "primerizo",
      "inversionista",
      "regateador",
      "extranjero",
      "dificil",
    ]);
    for (const p of PERSONAS) {
      expect(p.perfil.length).toBeGreaterThan(50);
      expect(p.objetivo.length).toBeGreaterThan(30);
      expect(p.apertura.length).toBeGreaterThan(10);
      expect(p.maxTurnos).toBeGreaterThanOrEqual(6);
      expect(p.maxTurnos).toBeLessThanOrEqual(10);
      expect(Array.isArray(p.estresa)).toBe(true);
    }
  });

  it("driver: conversación de 2 turnos termina con [FIN] del cliente", async () => {
    const clienteLLM = mockAnthropic([texto("¿Y cuánto es la inicial? ")].concat([texto("Perfecto, gracias. [FIN]")]));
    const mateoLLM = mockAnthropic([texto("Hola Luis, con gusto te explico."), texto("La inicial es el 10%.")]);

    const cliente = crearClienteFantasma({ anthropic: clienteLLM, persona });
    const mateo = crearMateo({ anthropic: mateoLLM });
    const sim = await simularConversacion({ cliente, mateo, maxTurnos: 8 });

    expect(sim.transcript[0]).toEqual({ rol: "cliente", texto: persona.apertura });
    expect(sim.transcript[1].rol).toBe("mateo");
    expect(sim.terminoNatural).toBe(true);
    // el token [FIN] nunca queda en el transcript
    expect(sim.transcript.every((t) => !t.texto.includes("[FIN]"))).toBe(true);
  });

  it("driver: respeta maxTurnos si el cliente nunca emite [FIN]", async () => {
    const clienteLLM = mockAnthropic([texto("¿y entonces?")]);
    const mateoLLM = mockAnthropic([texto("Te explico de nuevo.")]);
    const cliente = crearClienteFantasma({ anthropic: clienteLLM, persona });
    const mateo = crearMateo({ anthropic: mateoLLM });
    const sim = await simularConversacion({ cliente, mateo, maxTurnos: 3 });
    expect(sim.turnos).toBe(3);
    expect(sim.terminoNatural).toBe(false);
  });

  it("persona inválida -> throw claro", () => {
    expect(() => crearClienteFantasma({ anthropic: mockAnthropic([]), persona: { perfil: "x" } })).toThrow(/persona/);
  });
});

describe("QA simulador — fixture de tasa coherente con el BCRD real", () => {
  it("TASA_DOC_FIXTURE replica el shape del doc de api/tasa.js", () => {
    expect(TASA_DOC_FIXTURE.indicador).toBe("TASA_USD_DOP");
    expect(TASA_DOC_FIXTURE.latest.venta).toBeGreaterThan(TASA_DOC_FIXTURE.latest.compra);
    expect(TASA_DOC_FIXTURE.serie[0].fecha).toBe(TASA_DOC_FIXTURE.latest.fecha);
  });
});
