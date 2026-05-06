// ============================================
// CLIENTE ANTHROPIC (Claude API) + tool-use loop
// ============================================
// Extraido desde api/webhook.js en Dia 2 sin cambios de comportamiento
// observable. Hardcodes actuales: modelo claude-sonnet-4-6,
// max_tokens 2048 (Hotfix-20B Bug #14 — pre-fix era 500, insuficiente
// para la iteracion final post-tool-use que debe emitir <perfil_update>
// JSON + tags [LEAD_CALIENTE]/[ESCALAR]/[AGENDAR|...] + reply al cliente
// en una sola respuesta. Cap se agotaba mid-respuesta tipicamente justo
// despues del bloque perfil_update → cleanedText vacio → empty-reply
// guard "se me complico"), MAX_TOOL_ITERATIONS 3. Cliente construido
// por request (no memoizada, igual que hoy).

const Anthropic = require("@anthropic-ai/sdk");
const { botLog } = require("./log");

function getAnthropic() {
  return new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
}

// callClaudeWithTools: encapsula el tool-use loop contra Anthropic.
// Mecanica del cliente (HTTP + loop) vive aca. Logica de dominio
// (que hace cada herramienta) vive en webhook.js via toolHandlers.
// Para agregar herramientas nuevas: 1) definir en TOOLS array,
// 2) agregar handler a toolHandlers cuando se llama callClaudeWithTools.
// NO agregar ifs de dominio aca -- romperias la separacion.
async function callClaudeWithTools({ system, messages, tools, phone, toolHandlers }) {
  const anthropic = getAnthropic();

  // Loop de tool use: Claude puede pedir la calculadora hasta MAX_TOOL_ITERATIONS veces.
  // Cada iteracion es una llamada a la API. En la mayoria de casos solo hay 1 o 2.
  const MAX_TOOL_ITERATIONS = 3;
  let workingMessages = [...messages];
  let response;
  let iteration = 0;
  while (iteration < MAX_TOOL_ITERATIONS) {
    response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system,
      tools,
      messages: workingMessages,
    });
    // Hotfix-20B Bug #14: log stop_reason + usage por iteracion para
    // diagnostico futuro. Si "max_tokens" vuelve a aparecer como
    // stop_reason, sabemos que el cap quedo corto para algun caso
    // limite (perfil_update v2 mas grande, calculo mas verboso, etc).
    //
    // FASE 1 (prompt caching): cache_creation_input_tokens y
    // cache_read_input_tokens vienen del usage de la API cuando hay
    // cache_control en algun bloque de system. cache_read_input_tokens > 0
    // confirma cache HIT (~10% del costo de un input_token normal).
    // cache_creation_input_tokens > 0 indica cache MISS / primer escritura.
    // Ambos null/undefined → llamada sin caching activo (supervisor o
    // staticBlock < 1024 tokens). Quedan en el log para Axiom dashboard.
    botLog("info", "claude_response", {
      phone,
      iteration,
      stop_reason: response.stop_reason,
      input_tokens: response.usage?.input_tokens,
      output_tokens: response.usage?.output_tokens,
      cache_creation_input_tokens: response.usage?.cache_creation_input_tokens,
      cache_read_input_tokens: response.usage?.cache_read_input_tokens,
    });
    if (response.stop_reason !== "tool_use") break;

    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
    workingMessages.push({ role: "assistant", content: response.content });
    const toolResults = toolUseBlocks.map((block) => {
      const handler = toolHandlers && toolHandlers[block.name];
      const result = handler
        ? handler(block.input)
        : { error: "Herramienta desconocida: " + block.name };
      botLog("info", "Tool use", { phone, tool: block.name, input: block.input, result });
      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
      };
    });
    workingMessages.push({ role: "user", content: toolResults });
    iteration++;
  }

  return response;
}

module.exports = { getAnthropic, callClaudeWithTools };
