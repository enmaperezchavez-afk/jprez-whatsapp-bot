// tests/e2e-suite/escenarios.test.mjs — Hotfix-25 Día 2.
//
// Suite E2E que valida 20 escenarios reales del Director (Drive doc
// 1Tuaw6otd9MccWCXsb3kOmP-YJabaBcM97U4WQuf9Oe4) contra Mateo en LLM real.
//
// Cómo correr:
//   ANTHROPIC_API_KEY=sk-ant-... npm run test:e2e-suite
//
// Cuesta aproximadamente $0.50 USD por full run (20 escenarios x ~30K
// input tokens + 2K output tokens promedio).
//
// IMPORTANTE: La suite NO corre en CI por default. Solo on-demand.
// El `npm test` regular sigue siendo los 508 tests unit/integration.
//
// Si ANTHROPIC_API_KEY no está, la suite skipea todos los tests (sin fallar).

import { describe, it, expect } from "vitest";
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { askMateo } from "./helpers/real-llm-client.mjs";
import {
  validateKeywords,
  validateKeywordsAny,
  validateAntiKeywords,
  validateToneSignals,
  buildScenarioReport,
} from "./helpers/matchers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "escenarios-20.json"), "utf-8"),
);

const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;

// Acumulador de resultados para escribir baseline JSON al final.
const baselineResults = [];

describe("Suite E2E V3.6 — 20 escenarios JPREZ (LLM real)", () => {
  for (const esc of fixtures.escenarios) {
    const runOrSkip = HAS_API_KEY ? it : it.skip;
    runOrSkip(
      `${esc.id}: ${esc.title}`,
      async () => {
        const response = await askMateo(esc.input);
        const text = response.text;

        // Combinar anti-keywords del escenario + universales
        const allAntiKeywords = [
          ...(esc.antiKeywords || []),
          ...(fixtures.universal_antiKeywords || []),
        ];
        const allAntiTone = [
          ...(esc.antiToneSignals || []),
          ...(fixtures.universal_antiToneSignals || []),
        ];

        // Ejecutar validaciones
        const r1 = validateKeywords(text, esc.expectedKeywords || []);
        const r2 = validateKeywordsAny(text, esc.expectedKeywordsAny || []);
        const r3 = validateAntiKeywords(text, allAntiKeywords);
        const r4 = validateToneSignals(text, esc.expectedToneSignals, allAntiTone);

        const allPassed = r1.passed && r2.passed && r3.passed && r4.passed;

        // Guardar para baseline
        baselineResults.push({
          id: esc.id,
          bloque: esc.bloque,
          title: esc.title,
          perfil: esc.perfil,
          input: esc.input,
          passed: allPassed,
          reply: text,
          reply_length: text.length,
          iterations: response.iterations,
          stop_reasons: response.stop_reasons,
          tool_calls: response.tool_calls,
          checks: {
            keywords_required: r1,
            keywords_any: r2,
            anti_keywords: r3,
            tone: r4,
          },
        });

        // Build error message si falla
        const errors = [];
        if (!r1.passed) errors.push(`KEYWORDS missing: ${r1.missing.join(", ")}`);
        if (!r2.passed) errors.push(`KEYWORDS-ANY missing: ${r2.missing.join(" | ")}`);
        if (!r3.passed) errors.push(`ANTI-KEYWORDS found: ${r3.found.join(", ")}`);
        if (!r4.passed) errors.push(`TONE: ${r4.reasons.join(" | ")}`);

        expect(
          allPassed,
          `\n--- Reply (${text.length} chars) ---\n${text}\n\n--- Errors ---\n${errors.join("\n")}\n`,
        ).toBe(true);
      },
      90000, // 90s timeout por escenario (LLM real puede tardar)
    );
  }

  // After-all hook: escribir baseline JSON al disco.
  // No es un test — corre siempre que la suite haya corrido.
  it("zz_write_baseline (writes baseline file, never fails)", () => {
    if (!HAS_API_KEY || baselineResults.length === 0) return;

    const baselineDir = join(__dirname, "baselines");
    mkdirSync(baselineDir, { recursive: true });

    const today = new Date().toISOString().slice(0, 10);
    const out = {
      version: "1.0",
      generated_at: new Date().toISOString(),
      doctrine: "V3.6 base (commit 5925d4c, Hotfix-24 final)",
      total: baselineResults.length,
      passed: baselineResults.filter((r) => r.passed).length,
      failed: baselineResults.filter((r) => !r.passed).length,
      results: baselineResults,
    };

    writeFileSync(
      join(baselineDir, `baseline-${today}.json`),
      JSON.stringify(out, null, 2),
    );
    writeFileSync(
      join(baselineDir, "baseline-latest.json"),
      JSON.stringify(out, null, 2),
    );

    expect(true).toBe(true); // always passes
  });
});
