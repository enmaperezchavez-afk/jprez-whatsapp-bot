// ============================================
// CLIENTE ANTHROPIC (Claude API) + tool-use loop
// ============================================
// Extraido desde api/webhook.js en Dia 2 sin cambios de comportamiento
// observable. Preserva los hardcodes actuales: modelo claude-sonnet-4-6,
// max_tokens 500, MAX_TOOL_ITERATIONS 3. Cliente construido por request
// (no memoizada, igual que hoy).

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
      max_tokens: 500,
      system,
      tools,
      messages: workingMessages,
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
