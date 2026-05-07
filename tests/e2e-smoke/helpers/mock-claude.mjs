// Hotfix-22 V2 b2 — helper para mock Claude API determinístico.
//
// Construye responses Anthropic-shape a partir de fixtures JSON. El
// patching de require.cache para @anthropic-ai/sdk debe hacerlo el
// archivo de tests directamente (require.cache es global y debe
// patchearse ANTES del require del handler). Este helper solo provee
// los builders.
//
// CONTRATO:
//   buildTextResponse(text): respuesta Claude shape end_turn con un
//     unico bloque de texto. Para escenarios simples sin tool_use.
//
//   buildToolUseResponse(toolName, toolInput, toolUseId): respuesta
//     iter 0 que pide el tool. El handler ejecuta el tool y vuelve
//     a llamar al mock para iter 1 (texto final).
//
//   buildScenarioMock(scenario): segun fixtures/responses.json,
//     devuelve un MockSequence — array de responses en orden que el
//     mock debe servir cuando se llame a messages.create() varias
//     veces (tool_use loop).

export function buildTextResponse(text) {
  return {
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

export function buildToolUseResponse(toolName, toolInput, toolUseId = "tu_smoke_1") {
  return {
    content: [
      { type: "tool_use", id: toolUseId, name: toolName, input: toolInput },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 30 },
  };
}

// buildScenarioMock: dado un fixture, devuelve la lista de responses
// que el MockAnthropic debe servir secuencialmente. Para escenarios
// con useTool=true, devuelve [tool_use, end_turn]; sin tool, [end_turn].
export function buildScenarioMock(scenario) {
  if (scenario.useTool) {
    return [
      buildToolUseResponse(scenario.toolName, scenario.toolInput),
      buildTextResponse(scenario.mockResponse),
    ];
  }
  if (typeof scenario.mockResponse === "string") {
    return [buildTextResponse(scenario.mockResponse)];
  }
  return [];
}
