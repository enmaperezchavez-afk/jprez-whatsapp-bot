// src/handlers/parameter-block-cleaner.js — Hotfix-24 (R4 caso 5).
//
// PROBLEMA RAÍZ:
//   El R4 actual (Hotfix-22 V3 r4, PR #35) cubre 6 casos de empty-reply
//   guard, todos enfocados en el bloque <perfil_update>. PERO el LLM
//   también puede emitir XML de tool-use (<function_calls>, <invoke>,
//   <parameter>) como TEXTO en el campo content[].text — no como tool_use
//   estructurado. Si max_tokens corta a mitad de un <parameter ...> sin
//   </parameter> cerrante, el bloque truncado leakea al cliente: este
//   modulo lo strippea.
//
//   EVIDENCIA: 11 mayo 2026 14:33:04, Caso A formal PR4 — Director vio
//   <parameter name="..."> crudo en el reply del bot. R4 dejó pasar porque
//   buscaba <perfil_update>, no <parameter>.
//
// CONTRATO:
//   stripParameterBlocks(text) → { text, stripped, strippedChars }
//     - text: el reply limpio (sin bloques truncados)
//     - stripped: bool, true si hubo strip
//     - strippedChars: cuántos chars se removieron (incluye trim trailing)
//
// HEURÍSTICA:
//   - Tags monitoreados: <parameter>, <invoke>, <function_calls>
//   - Para cada opening tag, busca su closing tag correspondiente más
//     adelante en el texto.
//   - Si NO encuentra closing tag, marca el opening como "truncado".
//   - Strip desde el opening tag MÁS TEMPRANO sin cierre hasta EOF.
//     (Razón: si <function_calls> está sin cierre, todo lo que viene
//     después también está corrupto, incluyendo <invoke> y <parameter>
//     anidados que sí tuvieran "su" cierre falso interno.)
//   - Si NO hay ningún tag truncado, retorna el texto intacto.
//
// LO QUE NO TOCA:
//   - Bloques cerrados completamente: <parameter name="x">val</parameter>
//     pasan intactos (el LLM puede haberlos emitido y cerrado, no es bug).
//   - Otros XML tags: <perfil_update> es manejado por R4 caso 2 + 3,
//     no acá.

const TRACKED_TAGS = ["parameter", "invoke", "function_calls"];

// Chars que indican que `<tagName` es realmente un opening tag (no `<tagNames`).
const TAG_BOUNDARY = new Set([" ", "\t", "\n", "\r", ">"]);

function stripParameterBlocks(text) {
  if (typeof text !== "string" || text.length === 0) {
    return { text: text || "", stripped: false, strippedChars: 0 };
  }

  let earliestTruncated = -1;

  for (const tag of TRACKED_TAGS) {
    const literalTag = `<${tag}`;
    const closeStr = `</${tag}>`;
    let searchFrom = 0;

    while (true) {
      const openIdx = text.indexOf(literalTag, searchFrom);
      if (openIdx === -1) break;

      // Asegurar que es boundary real del tag (descarta "<parameters", etc).
      const charAfterTag = text[openIdx + literalTag.length];
      if (charAfterTag !== undefined && !TAG_BOUNDARY.has(charAfterTag)) {
        searchFrom = openIdx + literalTag.length;
        continue;
      }

      // Caso A: opening tag truncado sin ">" final (e.g. `<parameter name="x"`).
      const openCloseIdx = text.indexOf(">", openIdx + literalTag.length);
      if (openCloseIdx === -1) {
        if (earliestTruncated === -1 || openIdx < earliestTruncated) {
          earliestTruncated = openIdx;
        }
        break;
      }

      // Caso B: opening completo pero closing tag faltante.
      const closeIdx = text.indexOf(closeStr, openCloseIdx + 1);
      if (closeIdx === -1) {
        if (earliestTruncated === -1 || openIdx < earliestTruncated) {
          earliestTruncated = openIdx;
        }
      }

      searchFrom = openCloseIdx + 1;
    }
  }

  if (earliestTruncated === -1) {
    return { text, stripped: false, strippedChars: 0 };
  }

  const cleaned = text.slice(0, earliestTruncated).trimEnd();
  return {
    text: cleaned,
    stripped: true,
    strippedChars: text.length - cleaned.length,
  };
}

// Hotfix-29 Bug 2 P0 (19 may 2026): stripInternalBlocks.
//
// PROBLEMA RAÍZ: stripParameterBlocks solo strip bloques TRUNCADOS
// (sin closing tag). El LLM ahora emite bloques CERRADOS:
//   <parameter name="perfil_update">{...JSON...}</parameter>
//
// Esos bloques no son truncados pero contienen datos internos
// (perfil del cliente, score_lead, tags) que NUNCA deben llegar
// al cliente final. extractProfileUpdate solo busca <perfil_update>,
// no <parameter name="perfil_update">.
//
// stripInternalBlocks se ejecuta DESPUÉS de stripParameterBlocks como
// defensa final: elimina cualquier bloque XML interno (cerrado o no)
// de los tags listados.
//
// Cambio de regla vs Hotfix-24 R4-c5:
//   Antes: "bloques cerrados pasan intactos (el LLM puede haberlos
//   emitido y cerrado, no es bug)". → cambió porque ahora son leak
//   visible al cliente.
//
// CONTRATO:
//   stripInternalBlocks(text) → { text, stripped, strippedChars }

const INTERNAL_BLOCK_PATTERNS = [
  // Multilínea, no-greedy. Captura desde el opening tag (con atributos
  // opcionales) hasta el closing tag correspondiente. Si no hay closing,
  // este regex NO match — esos casos los cubre stripParameterBlocks.
  /<parameter\b[^>]*>[\s\S]*?<\/parameter>/gi,
  /<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi,
  /<function_calls\b[^>]*>[\s\S]*?<\/function_calls>/gi,
  // <perfil_update> también, defensa en profundidad. extractProfileUpdate
  // YA lo strip pero si pasa algo raro (encoding, whitespace), esto cubre.
  /<perfil_update\b[^>]*>[\s\S]*?<\/perfil_update>/gi,
];

function stripInternalBlocks(text) {
  if (typeof text !== "string" || text.length === 0) {
    return { text: text || "", stripped: false, strippedChars: 0 };
  }

  let result = text;
  for (const pattern of INTERNAL_BLOCK_PATTERNS) {
    result = result.replace(pattern, "");
  }

  // Colapsar saltos múltiples que quedan tras el strip
  result = result.replace(/\n{3,}/g, "\n\n").trim();

  if (result === text) {
    return { text, stripped: false, strippedChars: 0 };
  }
  return {
    text: result,
    stripped: true,
    strippedChars: text.length - result.length,
  };
}

module.exports = { stripParameterBlocks, stripInternalBlocks };
