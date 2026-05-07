// src/validators/token-budget.js — Hotfix-22 V2 b1.
//
// Defensa permanente contra prompts gigantes que crashean al modelo o
// agotan max_tokens en la iteracion final post-tool-use (Bug #14/#26
// historico). Si un skill nuevo agrega 30KB+ al staticBlock, este
// validador lo detecta ANTES de que llegue a la API y emite warning
// estructurado a Axiom para que el Director vea la alarma antes que
// el cliente reciba "Dame un segundo, se me complico".
//
// CONTRATO:
//   estimateTokens(text): number
//     Estimacion brutal chars/4 (regla Anthropic). NO es exacta — el
//     tokenizer real es BPE — pero es suficientemente buena para
//     thresholds de alarma (error +/- 10%).
//
//   validateSystemPromptSize(systemPrompt): { ok, estimatedTokens,
//                                              chars, status, message }
//     Acepta string o array (cache blocks de Anthropic). Si es array,
//     concatena los .text de cada bloque tipo "text".
//     status: "green" | "yellow" | "red".
//     ok: false solo cuando status === "red" (cap superado).
//
// THRESHOLDS:
//   - 30K tokens: warning (85% del max)
//   - 35K tokens: critical (Anthropic Sonnet acepta mucho mas, pero
//     a partir de aqui empieza a degradar performance + costo +
//     riesgo de truncacion en respuestas con tool_use loop).
//
// NO BLOQUEA: este validador solo loguea. La decision de bloquear se
// toma en el caller (message.js) — actualmente no bloquea para no
// dejar al cliente sin respuesta. Si en el futuro Anthropic empieza
// a rechazar prompts de cierto tamano, el caller puede usar el `ok`
// para early-return con fallback.
//
// MODULO HOJA: cero I/O, cero red. Testeable sin mocks.

const BUDGET_MAX_TOKENS = 35000;
const BUDGET_WARNING_TOKENS = 30000;
const CHARS_PER_TOKEN = 4;

function estimateTokens(text) {
  if (typeof text !== "string") return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// extractText: recibe el systemPrompt en cualquiera de las formas que
// el handler usa (string plano, array de cache blocks de Anthropic) y
// devuelve el texto concatenado para medir su tamano.
function extractText(systemPrompt) {
  if (typeof systemPrompt === "string") return systemPrompt;
  if (Array.isArray(systemPrompt)) {
    return systemPrompt
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

function validateSystemPromptSize(systemPrompt) {
  const text = extractText(systemPrompt);
  const chars = text.length;
  const estimatedTokens = estimateTokens(text);

  let status = "green";
  let message = "Prompt size OK: " + estimatedTokens + " tokens";

  if (estimatedTokens >= BUDGET_MAX_TOKENS) {
    status = "red";
    message =
      "Prompt size CRITICAL: " + estimatedTokens +
      " tokens exceeds max " + BUDGET_MAX_TOKENS;
  } else if (estimatedTokens >= BUDGET_WARNING_TOKENS) {
    status = "yellow";
    message =
      "Prompt size WARNING: " + estimatedTokens +
      " tokens approaches max " + BUDGET_MAX_TOKENS;
  }

  return {
    ok: status !== "red",
    estimatedTokens,
    chars,
    status,
    message,
  };
}

module.exports = {
  validateSystemPromptSize,
  estimateTokens,
  BUDGET_MAX_TOKENS,
  BUDGET_WARNING_TOKENS,
  CHARS_PER_TOKEN,
};
