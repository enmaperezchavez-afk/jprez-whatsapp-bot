// ============================================
// CLIENTE ANTHROPIC (Claude API) + tool-use loop
// ============================================
// Extraido desde api/webhook.js en Dia 2 sin cambios de comportamiento
// observable. Modelo claude-sonnet-4-6 sigue hardcoded.
//
// MAX_TOKENS history: 500 (pre-Hotfix-20B) -> 2048 (Hotfix-20B Bug #14)
// -> 4096 (Hotfix-22 V2 — PR #30 sumo skill mercado-inmobiliario-rd 22.5KB
// al staticBlock, prompt crecio ~25-30%, modelo razonaba con mas material
// y la iter final tendia a truncarse mid-respuesta tras emitir
// <perfil_update> pero antes del reply al cliente — empty-reply guard
// disparaba el fallback "Dame un segundo, se me complico". Es Bug #14/#26
// reapareciendo por skill mas grande).
//
// HOTFIX-22 V2 c3: max_tokens es ahora env var CLAUDE_MAX_TOKENS con
// default 4096. Permite tunear sin redeploy si el cap vuelve a quedar
// corto (skill nuevo grande, perfil_update v2, etc). Director ajusta
// en Vercel env settings sin tocar codigo. Cap parseado UNA vez al
// cargar el modulo y loggeado al boot para auditoria.

const Anthropic = require("@anthropic-ai/sdk");
const { botLog } = require("./log");

const DEFAULT_MAX_TOKENS = 4096;
const MAX_TOKENS = (() => {
  const raw = process.env.CLAUDE_MAX_TOKENS;
  if (!raw) return DEFAULT_MAX_TOKENS;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 256 || parsed > 32000) {
    botLog("warn", "claude_max_tokens_invalid", {
      raw, fallback: DEFAULT_MAX_TOKENS,
    });
    return DEFAULT_MAX_TOKENS;
  }
  return parsed;
})();

botLog("info", "claude_max_tokens_configured", {
  max_tokens: MAX_TOKENS,
  source: process.env.CLAUDE_MAX_TOKENS ? "env" : "default",
});

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
      max_tokens: MAX_TOKENS,
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
