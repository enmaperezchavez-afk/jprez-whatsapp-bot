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
//
// HOTFIX-22 V3 r1: rate limit retry header-aware (Bug #28 raiz). Smoke
// post-PR #31 detecto que el segundo turno conversacional disparaba
// "se me complico" — root cause: staticBlock 131K chars saturaba el
// rate limit Anthropic Tier 1 (30K tokens/min) y la API devolvia 429
// sin retry. SDK Anthropic ya implementa retry nativo header-aware:
// parsea "retry-after-ms" + "retry-after" headers, cap implicito 60s,
// fallback a exponential backoff (0.5s -> 8s con jitter). Default
// maxRetries=2. Subimos a 3 para cubrir picos transitorios + agregamos
// log "claude_retry_exhausted" cuando el SDK propaga error final.
// MAX_RETRIES tambien tunable via env var CLAUDE_MAX_RETRIES (default 3,
// rango 0-5) para que Director ajuste sin redeploy.

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

const DEFAULT_MAX_RETRIES = 3;
const MAX_RETRIES = (() => {
  const raw = process.env.CLAUDE_MAX_RETRIES;
  if (!raw) return DEFAULT_MAX_RETRIES;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 5) {
    botLog("warn", "claude_max_retries_invalid", {
      raw, fallback: DEFAULT_MAX_RETRIES,
    });
    return DEFAULT_MAX_RETRIES;
  }
  return parsed;
})();

botLog("info", "claude_config", {
  max_tokens: MAX_TOKENS,
  max_retries: MAX_RETRIES,
  max_tokens_source: process.env.CLAUDE_MAX_TOKENS ? "env" : "default",
  max_retries_source: process.env.CLAUDE_MAX_RETRIES ? "env" : "default",
});

function getAnthropic() {
  return new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    // Hotfix-22 V3 r1: el SDK retye automaticamente 429/5xx con
    // header-aware backoff (retry-after-ms + retry-after, cap 60s).
    // maxRetries=3 cubre picos transitorios del rate limit Tier 1.
    maxRetries: MAX_RETRIES,
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
    // Hotfix-22 V3 r1: el SDK Anthropic ya retye 429/5xx automaticamente
    // con header-aware backoff (maxRetries config'd al instanciar el
    // cliente). Si tras los retries el SDK propaga error, lo capturamos
    // aqui para loggear "claude_retry_exhausted" con status, headers de
    // rate limit y attempts. El error sigue propagandose al handler,
    // que tiene su propio safety net (sendWhatsAppMessage fallback).
    try {
      response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: MAX_TOKENS,
        system,
        tools,
        messages: workingMessages,
      });
    } catch (e) {
      const status = e?.status;
      const headers = e?.headers;
      botLog("error", "claude_retry_exhausted", {
        phone,
        iteration,
        status,
        error_type: e?.constructor?.name,
        error_message: e?.message,
        retry_after_ms: headers?.["retry-after-ms"],
        retry_after: headers?.["retry-after"],
        ratelimit_input_tokens_remaining: headers?.["anthropic-ratelimit-input-tokens-remaining"],
        ratelimit_input_tokens_reset: headers?.["anthropic-ratelimit-input-tokens-reset"],
        ratelimit_requests_remaining: headers?.["anthropic-ratelimit-requests-remaining"],
        max_retries_configured: MAX_RETRIES,
      });
      throw e;
    }
    // Hotfix-22 V3 r1: log proactivo de rate limit headers en cada
    // response exitosa. Permite al Director ver en Axiom cuan cerca
    // esta del cap por minuto antes de saturar. Headers vienen en
    // response.headers cuando el SDK los expone (depende de version).
    const respHeaders = response?.headers || {};
    if (respHeaders["anthropic-ratelimit-input-tokens-remaining"]) {
      botLog("info", "claude_ratelimit_status", {
        phone,
        iteration,
        input_tokens_remaining: respHeaders["anthropic-ratelimit-input-tokens-remaining"],
        input_tokens_reset: respHeaders["anthropic-ratelimit-input-tokens-reset"],
        requests_remaining: respHeaders["anthropic-ratelimit-requests-remaining"],
      });
    }
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
