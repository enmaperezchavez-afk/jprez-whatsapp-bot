// src/handlers/format-postprocess.js — Hotfix-22 V3.5 (R5).
//
// Post-processor HARD del reply de Mateo antes de mandarlo a WhatsApp.
// Smoke test final de Hotfix V3 mostro que el LLM ignora el STYLE_LAYER
// y emite bullets, asteriscos markdown y emojis con frecuencia. R5 cierra
// la brecha del 85% (soft override prompt) al 100% (hard regex strip).
//
// FILOSOFIA: el LLM es persuadido (R2 OVERRIDES + R6 few-shots) pero NO
// confiable al 100% — el cliente NO debe ver formato malo en ningun caso.
// R5 garantiza format limpio aunque el LLM falle. Es la red de seguridad
// final, equivalente a R4 empty-reply guard pero para formato.
//
// CONTRATO:
//   cleanFormat(text): { text: string, counts: { bullets, bolds, italics, emojis } }
//     - text: input limpio (strip de bullets, ** y * wrappers, emojis,
//             normalize newlines).
//     - counts: cuantas instancias de cada tipo se removieron. Director
//             ve en Axiom si el LLM sigue emitiendo formato malo.
//
// ORDEN DE STRIP (importante):
//   1. Bullets al inicio de linea: /^[-*•·]\s+/gm
//      (antes de asteriscos para no confundir bullet "* " con cursiva *X*)
//   2. Bold ** wrappers: /\*\*([^*\n]+?)\*\*/g
//      (antes de italic para no comer asteriscos pares)
//   3. Italic * wrappers: /\*([^*\n]+?)\*/g
//      (mantiene contenido, strip wrappers)
//   4. Emojis Extended_Pictographic: /\p{Extended_Pictographic}/gu
//   5. Banderas (Regional Indicators): /[\u{1F1E6}-\u{1F1FF}]/gu
//   6. Variation Selectors + ZWJ: /[️‍]/g
//   7. Normalize: \n{3,} -> \n\n, multiple spaces -> single.
//
// EDGE CASES:
//   - Texto sin formato: returned tal cual (counts todos en 0).
//   - Asterisco solitario sin pareja: no toca (regex no-greedy
//     [^*\n]+? requiere par).
//   - URLs/code: regex no-greedy + clase [^*\n] preserva contenido
//     que tenga algun "*" suelto en code blocks.
//   - Empty post-strip: si el bot solo emitio "*X*" y al stripear
//     queda vacio, R4 empty-reply guard caso 4 lo cubre downstream.
//
// MODULO LEAF: cero I/O, cero red. Testeable sin mocks.

const RE_BULLET_LINE = /^[-*•·]\s+/gm;
const RE_BOLD_WRAPPER = /\*\*([^*\n]+?)\*\*/g;
const RE_ITALIC_WRAPPER = /\*([^*\n]+?)\*/g;
const RE_EMOJI_PICTO = /\p{Extended_Pictographic}/gu;
const RE_EMOJI_FLAGS = /[\u{1F1E6}-\u{1F1FF}]/gu;
const RE_EMOJI_MODIFIERS = /[️‍]/g;

function cleanFormat(text) {
  if (typeof text !== "string") {
    return { text: "", counts: { bullets: 0, bolds: 0, italics: 0, emojis: 0 } };
  }

  let cleaned = text;
  const counts = { bullets: 0, bolds: 0, italics: 0, emojis: 0 };

  // 1. Bullets al inicio de linea (antes que asteriscos wrappers).
  cleaned = cleaned.replace(RE_BULLET_LINE, () => {
    counts.bullets++;
    return "";
  });

  // 2. Bold ** wrappers (antes que italic para no comer pares).
  cleaned = cleaned.replace(RE_BOLD_WRAPPER, (_m, inner) => {
    counts.bolds++;
    return inner;
  });

  // 3. Italic * wrappers.
  cleaned = cleaned.replace(RE_ITALIC_WRAPPER, (_m, inner) => {
    counts.italics++;
    return inner;
  });

  // 4. Emojis pictograficos.
  cleaned = cleaned.replace(RE_EMOJI_PICTO, () => {
    counts.emojis++;
    return "";
  });

  // 5. Banderas (Regional Indicators) — los Pictograficos no las cubren.
  cleaned = cleaned.replace(RE_EMOJI_FLAGS, () => {
    counts.emojis++;
    return "";
  });

  // 6. Variation Selectors + ZWJ (residuos de emojis compuestos).
  cleaned = cleaned.replace(RE_EMOJI_MODIFIERS, "");

  // 7. Normalizar saltos multiples + espacios duplicados (cleanup post-strip).
  cleaned = cleaned
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    // Trim trailing whitespace por linea (residuo de strip de emoji al final).
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  return { text: cleaned, counts };
}

module.exports = {
  cleanFormat,
  // Re-exports para testing puro (regex independientes).
  RE_BULLET_LINE,
  RE_BOLD_WRAPPER,
  RE_ITALIC_WRAPPER,
  RE_EMOJI_PICTO,
  RE_EMOJI_FLAGS,
  RE_EMOJI_MODIFIERS,
};
