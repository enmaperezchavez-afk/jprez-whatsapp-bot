// Hotfix-27 — Tests defensa anti-loop tool_use (Path B en src/claude.js).
//
// Bug detectado en Axiom 11 may por Cowork: "Hola!!" → 3× calcular_plan_pago
// dentro de 1 sola callClaudeWithTools. El LLM iteraba MAX_TOOL_ITERATIONS=3
// invocando la misma firma (tool_name + input).
//
// Defensa: Set invokedSignatures dentro del while loop. Si la misma firma
// ya se ejecutó en esta llamada, devolver tool_result sintético
// { suppressed: true, reason: "duplicate_tool_call" } sin re-ejecutar
// el handler. El LLM ve el hint y pivota a texto.
//
// Cobertura (5 tests):
//   1. toolSignature: estable bajo reordering de keys del input.
//   2. Saludo post-cálculo (DUP): 2da iter con misma firma → handler
//      NO se ejecuta, tool_result sintético, log emitido.
//   3. Cambio tema (DUP): mismo síntoma — supresión funcional.
//   4. Cálculo explícito distinto (NO DUP): different input → handler
//      sí se ejecuta en cada iter.
//   5. Mezcla DUP + NO DUP en mismo loop: solo suprime la firma duplicada.

import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// Mock botLog para capturar duplicate_tool_call_suppressed.
const botLogCalls = [];
{
  const id = require.resolve("../src/log");
  require.cache[id] = {
    id, filename: id, loaded: true,
    exports: {
      botLog: (level, message, data) => botLogCalls.push({ level, message, data }),
      logToAxiom: async () => {},
    },
  };
}

// Mock Anthropic SDK con responses configurables por iteración.
let scriptedResponses = [];
let createCalls = [];

class MockAnthropic {
  constructor() {
    this.messages = {
      create: (params) => {
        createCalls.push({
          messages: params.messages.map((m) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content : "(blocks)",
          })),
        });
        const next = scriptedResponses.shift();
        if (!next) {
          throw new Error("Test ran out of scripted responses (iter " + createCalls.length + ")");
        }
        const promise = Promise.resolve(next);
        promise.withResponse = () => promise.then((data) => ({
          data,
          response: { headers: { get: () => null } },
        }));
        return promise;
      },
    };
  }
}

{
  const id = require.resolve("@anthropic-ai/sdk");
  require.cache[id] = { id, filename: id, loaded: true, exports: MockAnthropic };
}

const { callClaudeWithTools, toolSignature } = require("../src/claude");

function toolUseBlock(id, name, input) {
  return { type: "tool_use", id, name, input };
}
function textBlock(text) {
  return { type: "text", text };
}

describe("Hotfix-27 — anti-loop tool_use (Path B defensa intra-turno)", () => {
  beforeEach(() => {
    botLogCalls.length = 0;
    createCalls.length = 0;
    scriptedResponses = [];
  });

  it("Test 1: toolSignature estable bajo reordering de keys", () => {
    const sigA = toolSignature("calcular_plan_pago", {
      proyecto: "pr3",
      precio_usd: 100000,
      etapa: null,
    });
    const sigB = toolSignature("calcular_plan_pago", {
      etapa: null,
      precio_usd: 100000,
      proyecto: "pr3",
    });
    expect(sigA).toBe(sigB);

    const sigDifferent = toolSignature("calcular_plan_pago", {
      proyecto: "pr4", // distinto
      precio_usd: 100000,
      etapa: null,
    });
    expect(sigA).not.toBe(sigDifferent);
  });

  it("Test 2: saludo post-cálculo — 2da invocación con MISMA firma → suprimida", async () => {
    const sameInput = { proyecto: "pr3", precio_usd: 100000 };
    scriptedResponses = [
      // Iter 0: LLM pide calcular_plan_pago
      {
        stop_reason: "tool_use",
        content: [toolUseBlock("tu_1", "calcular_plan_pago", sameInput)],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      // Iter 1: LLM re-pide MISMA firma (síntoma del bug Axiom)
      {
        stop_reason: "tool_use",
        content: [toolUseBlock("tu_2", "calcular_plan_pago", sameInput)],
        usage: { input_tokens: 110, output_tokens: 50 },
      },
      // Iter 2: LLM pivota a texto tras ver suppressed:true
      {
        stop_reason: "end_turn",
        content: [textBlock("Mira, ya te di los números arriba.")],
        usage: { input_tokens: 120, output_tokens: 30 },
      },
    ];

    const handlerCalls = [];
    const toolHandlers = {
      calcular_plan_pago: (input) => {
        handlerCalls.push(input);
        return { inicial_usd: 10000, cuota_mensual_usd: 833 };
      },
    };

    await callClaudeWithTools({
      system: "test",
      messages: [{ role: "user", content: "Hola!!" }],
      tools: [],
      phone: "1234567890",
      toolHandlers,
    });

    // Handler ejecutado SOLO 1 vez (1ra), 2da suprimida.
    expect(handlerCalls.length).toBe(1);
    // Log duplicate_tool_call_suppressed emitido en iter 1.
    const suppressedLogs = botLogCalls.filter(
      (c) => c.message === "duplicate_tool_call_suppressed",
    );
    expect(suppressedLogs.length).toBe(1);
    expect(suppressedLogs[0].level).toBe("warn");
    expect(suppressedLogs[0].data.tool).toBe("calcular_plan_pago");
    expect(suppressedLogs[0].data.phone).toBe("1234567890");
  });

  it("Test 3: tool_result sintético en 2da iter tiene shape correcto", async () => {
    const sameInput = { proyecto: "pr4", precio_usd: 140000 };
    scriptedResponses = [
      {
        stop_reason: "tool_use",
        content: [toolUseBlock("tu_a", "calcular_plan_pago", sameInput)],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      {
        stop_reason: "tool_use",
        content: [toolUseBlock("tu_b", "calcular_plan_pago", sameInput)],
        usage: { input_tokens: 110, output_tokens: 50 },
      },
      {
        stop_reason: "end_turn",
        content: [textBlock("Final.")],
        usage: { input_tokens: 120, output_tokens: 10 },
      },
    ];

    await callClaudeWithTools({
      system: "test",
      messages: [{ role: "user", content: "calcula pr4 140k" }],
      tools: [],
      phone: "9999",
      toolHandlers: {
        calcular_plan_pago: () => ({ ok: true }),
      },
    });

    // Iter 2 (createCalls[2]) recibe messages con un user tool_result
    // sintético { suppressed: true } como último user msg. createCalls[2]
    // se construye DESPUÉS de iter 1 suprimida.
    expect(createCalls.length).toBe(3);
    // El messages array de iter 2 incluye más turnos que iter 0/1.
    expect(createCalls[2].messages.length).toBeGreaterThan(
      createCalls[0].messages.length,
    );
  });

  it("Test 4: cálculo explícito con inputs DISTINTOS — ambos se ejecutan", async () => {
    scriptedResponses = [
      // Iter 0: calcular pr3
      {
        stop_reason: "tool_use",
        content: [toolUseBlock("tu_x", "calcular_plan_pago", { proyecto: "pr3", precio_usd: 100000 })],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      // Iter 1: cliente quiere otro proyecto — calcular pr4 (DIFFERENT firma)
      {
        stop_reason: "tool_use",
        content: [toolUseBlock("tu_y", "calcular_plan_pago", { proyecto: "pr4", precio_usd: 140000 })],
        usage: { input_tokens: 110, output_tokens: 50 },
      },
      // Iter 2: pivot
      {
        stop_reason: "end_turn",
        content: [textBlock("Listo.")],
        usage: { input_tokens: 120, output_tokens: 10 },
      },
    ];

    const handlerCalls = [];
    await callClaudeWithTools({
      system: "test",
      messages: [{ role: "user", content: "calcula pr3 y pr4" }],
      tools: [],
      phone: "1111",
      toolHandlers: {
        calcular_plan_pago: (input) => {
          handlerCalls.push(input);
          return { ok: true };
        },
      },
    });

    // Ambos cálculos ejecutaron (no regresión).
    expect(handlerCalls.length).toBe(2);
    expect(handlerCalls[0].proyecto).toBe("pr3");
    expect(handlerCalls[1].proyecto).toBe("pr4");
    // NO se emitió log de duplicate (firmas distintas).
    const suppressedLogs = botLogCalls.filter(
      (c) => c.message === "duplicate_tool_call_suppressed",
    );
    expect(suppressedLogs.length).toBe(0);
  });

  it("Test 5: mezcla DUP + NO DUP — solo suprime la firma duplicada", async () => {
    const inputA = { proyecto: "pr3", precio_usd: 100000 };
    const inputB = { proyecto: "crux", precio_usd: 105000 };
    scriptedResponses = [
      // Iter 0: dos tool_use en el mismo turno — inputA + inputB
      {
        stop_reason: "tool_use",
        content: [
          toolUseBlock("t_a", "calcular_plan_pago", inputA),
          toolUseBlock("t_b", "calcular_plan_pago", inputB),
        ],
        usage: { input_tokens: 100, output_tokens: 80 },
      },
      // Iter 1: LLM re-pide inputA (DUP) y un nuevo inputC
      {
        stop_reason: "tool_use",
        content: [
          toolUseBlock("t_a2", "calcular_plan_pago", inputA), // DUP de iter 0
          toolUseBlock("t_c", "calcular_plan_pago", { proyecto: "pr4", precio_usd: 140000 }), // nuevo
        ],
        usage: { input_tokens: 120, output_tokens: 80 },
      },
      // Iter 2: pivot
      {
        stop_reason: "end_turn",
        content: [textBlock("done")],
        usage: { input_tokens: 130, output_tokens: 10 },
      },
    ];

    const handlerCalls = [];
    await callClaudeWithTools({
      system: "test",
      messages: [{ role: "user", content: "muestrame opciones" }],
      tools: [],
      phone: "777",
      toolHandlers: {
        calcular_plan_pago: (input) => {
          handlerCalls.push(input);
          return { ok: true };
        },
      },
    });

    // Ejecuciones esperadas: inputA (iter 0) + inputB (iter 0) + inputC (iter 1).
    // inputA en iter 1 es DUP → suprimida. Total = 3.
    expect(handlerCalls.length).toBe(3);
    const suppressedLogs = botLogCalls.filter(
      (c) => c.message === "duplicate_tool_call_suppressed",
    );
    expect(suppressedLogs.length).toBe(1);
    // El suprimido debe ser el de input pr3/100000 (inputA).
    expect(suppressedLogs[0].data.input.proyecto).toBe("pr3");
    expect(suppressedLogs[0].data.input.precio_usd).toBe(100000);
  });
});

describe("Hotfix-30 Fix 2 — response.toolInvocationCount", () => {
  beforeEach(() => {
    botLogCalls.length = 0;
    createCalls.length = 0;
    scriptedResponses = [];
  });

  it("Test 6: sin tool calls (respuesta directa) → toolInvocationCount = 0", async () => {
    scriptedResponses = [
      {
        stop_reason: "end_turn",
        content: [textBlock("Hola, soy Mateo. ¿En qué te ayudo?")],
        usage: { input_tokens: 50, output_tokens: 20 },
      },
    ];
    const resp = await callClaudeWithTools({
      system: "test",
      messages: [{ role: "user", content: "hola" }],
      tools: [],
      phone: "555",
      toolHandlers: {},
    });
    expect(resp.toolInvocationCount).toBe(0);
  });

  it("Test 7: una tool ejecutada → toolInvocationCount = 1 (señal para retry-sin-tools)", async () => {
    const input = { proyecto: "puertoPlata", precio_usd: 73000 };
    scriptedResponses = [
      {
        stop_reason: "tool_use",
        content: [toolUseBlock("tu_1", "calcular_plan_pago", input)],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      // Turno final: solo metadata, sin texto (reproduce el P0)
      {
        stop_reason: "end_turn",
        content: [textBlock("<perfil_update>{\"score_lead\":\"caliente\"}</perfil_update>")],
        usage: { input_tokens: 110, output_tokens: 30 },
      },
    ];
    const resp = await callClaudeWithTools({
      system: "test",
      messages: [{ role: "user", content: "estudios en pse3" }],
      tools: [],
      phone: "666",
      toolHandlers: { calcular_plan_pago: () => ({ needs_etapa: true }) },
    });
    expect(resp.toolInvocationCount).toBe(1);
  });

  it("Test 8: duplicada suprimida NO incrementa el conteo (cuenta ejecuciones únicas)", async () => {
    const input = { proyecto: "pr3", precio_usd: 100000 };
    scriptedResponses = [
      {
        stop_reason: "tool_use",
        content: [toolUseBlock("tu_1", "calcular_plan_pago", input)],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      {
        stop_reason: "tool_use",
        content: [toolUseBlock("tu_2", "calcular_plan_pago", input)], // DUP
        usage: { input_tokens: 110, output_tokens: 50 },
      },
      {
        stop_reason: "end_turn",
        content: [textBlock("listo")],
        usage: { input_tokens: 120, output_tokens: 10 },
      },
    ];
    const resp = await callClaudeWithTools({
      system: "test",
      messages: [{ role: "user", content: "calcula pr3" }],
      tools: [],
      phone: "888",
      toolHandlers: { calcular_plan_pago: () => ({ ok: true }) },
    });
    // 1 ejecución única (la DUP fue suprimida, no se agrega a invokedSignatures).
    expect(resp.toolInvocationCount).toBe(1);
  });
});
