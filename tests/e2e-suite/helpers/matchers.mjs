// tests/e2e-suite/helpers/matchers.mjs — Hotfix-25 Día 2.
//
// Matchers para validar respuestas reales del LLM contra el doc maestro
// 20 escenarios (Drive 1Tuaw6otd...).
//
// CONTRATO:
//   validateKeywords(text, keywords) → { passed, missing }
//     - Todas las keywords deben estar presentes (case-insensitive default)
//     - Si keyword empieza con "US$" o "$" o "RD$", case-sensitive
//
//   validateKeywordsAny(text, groups) → { passed, missing }
//     - groups es array de arrays. Cada inner array es OR
//     - Pasa si AL MENOS uno de cada inner array aparece
//
//   validateAntiKeywords(text, antiKeywords) → { passed, found }
//     - Ninguna anti-keyword debe estar presente
//
//   validateTone(text, signals, antiSignals) → { passed, reasons }
//     - signals: al menos 1 debe aparecer
//     - antiSignals: ninguno debe aparecer

function isCaseSensitiveKeyword(kw) {
  // Keywords con moneda o números exactos requieren case sensitivity
  return /^(US\$|RD\$|\$|\d)/.test(kw) || /US\$|RD\$|\$\d/.test(kw);
}

function contains(text, keyword) {
  if (isCaseSensitiveKeyword(keyword)) {
    return text.includes(keyword);
  }
  return text.toLowerCase().includes(keyword.toLowerCase());
}

export function validateKeywords(text, keywords) {
  const missing = [];
  for (const kw of keywords) {
    if (!contains(text, kw)) missing.push(kw);
  }
  return { passed: missing.length === 0, missing };
}

export function validateKeywordsAny(text, groups) {
  const missing = [];
  for (const group of groups) {
    const matched = group.some((kw) => contains(text, kw));
    if (!matched) missing.push(`[any of: ${group.join(" | ")}]`);
  }
  return { passed: missing.length === 0, missing };
}

export function validateAntiKeywords(text, antiKeywords) {
  const found = [];
  for (const kw of antiKeywords) {
    if (contains(text, kw)) found.push(kw);
  }
  return { passed: found.length === 0, found };
}

export function validateToneSignals(text, expectedSignals, antiSignals) {
  const reasons = [];
  // Al menos 1 expected signal debe aparecer
  if (expectedSignals && expectedSignals.length > 0) {
    const matched = expectedSignals.some((s) => contains(text, s));
    if (!matched) {
      reasons.push(`No expected tone signal found: [${expectedSignals.join(", ")}]`);
    }
  }
  // Ningún anti signal debe aparecer
  if (antiSignals && antiSignals.length > 0) {
    const found = antiSignals.filter((s) => contains(text, s));
    if (found.length > 0) {
      reasons.push(`Anti tone signals found: [${found.join(", ")}]`);
    }
  }
  return { passed: reasons.length === 0, reasons };
}

// Helper para construir reporte legible de un escenario
export function buildScenarioReport(esc, text, results) {
  return {
    id: esc.id,
    title: esc.title,
    perfil: esc.perfil,
    passed: results.every((r) => r.passed),
    text_preview: text.slice(0, 300),
    text_length: text.length,
    keywords: results[0],
    keywords_any: results[1],
    anti_keywords: results[2],
    tone: results[3],
  };
}
