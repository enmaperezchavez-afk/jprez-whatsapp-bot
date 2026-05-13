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

import { describe, it, expect, afterAll } from "vitest";
import { readFileSync, mkdirSync, writeFileSync, readdirSync } from "fs";
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

// Setup run dir: cada test escribe SU result a un archivo individual aquí.
// Survival-first: si vitest paraleliza workers o si afterAll falla, el
// run dir igual tiene los results parseable después.
const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-");
const RUN_DIR = join(__dirname, "baselines", "_runs", RUN_TIMESTAMP);
if (HAS_API_KEY) {
  mkdirSync(RUN_DIR, { recursive: true });
}

describe("Suite E2E V3.6 — 20 escenarios JPREZ (LLM real)", () => {
  for (const esc of fixtures.escenarios) {
    const runOrSkip = HAS_API_KEY ? it : it.skip;
    runOrSkip(
      `${esc.id}: ${esc.title}`,
      async () => {
        // Pacing 3s entre tests: cada call usa ~30K input tokens.
        // Tier 2 Sonnet = 450K tokens/min sliding window. 20 tests
        // back-to-back saturaron en runs previos → algunos abortan.
        // 3s pacing = ~20 tests/min = 600K/min, todavía caliente pero
        // distribuido. Si vuelve a saturar, subir a 5s.
        await new Promise((r) => setTimeout(r, 3000));

        let response, text, errorMsg = null;
        try {
          response = await askMateo(esc.input);
          text = response.text || "";
        } catch (e) {
          errorMsg = e.message || String(e);
          response = { iterations: 0, stop_reasons: [], tool_calls: [] };
          text = "";
        }

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

        const allPassed = !errorMsg && r1.passed && r2.passed && r3.passed && r4.passed;

        // Persist INMEDIATO a archivo per-scenario (sobrevive a crashes
        // y a paralelización de vitest workers + errores de API).
        const result = {
          id: esc.id,
          bloque: esc.bloque,
          title: esc.title,
          perfil: esc.perfil,
          input: esc.input,
          passed: allPassed,
          api_error: errorMsg,
          reply: text,
          reply_length: text.length,
          iterations: response.iterations,
          stop_reasons: response.stop_reasons,
          tool_calls: response.tool_calls,
          checks: errorMsg ? null : {
            keywords_required: r1,
            keywords_any: r2,
            anti_keywords: r3,
            tone: r4,
          },
        };
        writeFileSync(join(RUN_DIR, `${esc.id}.json`), JSON.stringify(result, null, 2));

        // Build error message si falla
        const errors = [];
        if (errorMsg) errors.push(`API ERROR: ${errorMsg}`);
        if (!errorMsg) {
          if (!r1.passed) errors.push(`KEYWORDS missing: ${r1.missing.join(", ")}`);
          if (!r2.passed) errors.push(`KEYWORDS-ANY missing: ${r2.missing.join(" | ")}`);
          if (!r3.passed) errors.push(`ANTI-KEYWORDS found: ${r3.found.join(", ")}`);
          if (!r4.passed) errors.push(`TONE: ${r4.reasons.join(" | ")}`);
        }

        expect(
          allPassed,
          `\n--- Reply (${text.length} chars) ---\n${text}\n\n--- Errors ---\n${errors.join("\n")}\n`,
        ).toBe(true);
      },
      90000, // 90s timeout por escenario (LLM real puede tardar)
    );
  }

  // afterAll: lee todos los archivos individuales del RUN_DIR y los
  // consolida al baseline JSON. Robust contra paralelización porque
  // cada test escribió SU archivo inmediato.
  afterAll(() => {
    if (!HAS_API_KEY) return;

    const files = readdirSync(RUN_DIR).filter((f) => f.endsWith(".json"));
    if (files.length === 0) return;

    const results = files
      .map((f) => JSON.parse(readFileSync(join(RUN_DIR, f), "utf-8")))
      // Ordenar por bloque + id para output predecible
      .sort((a, b) => a.id.localeCompare(b.id));

    const baselineDir = join(__dirname, "baselines");
    mkdirSync(baselineDir, { recursive: true });

    const today = new Date().toISOString().slice(0, 10);
    const out = {
      version: "1.0",
      generated_at: new Date().toISOString(),
      doctrine: "V3.6 + Hotfix-26 P0 BPV bilingüe (motu proprio fix + guard reactivo es/en)",
      run_dir: RUN_DIR,
      total: results.length,
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
      results,
    };

    writeFileSync(
      join(baselineDir, `baseline-${today}.json`),
      JSON.stringify(out, null, 2),
    );
    writeFileSync(
      join(baselineDir, "baseline-latest.json"),
      JSON.stringify(out, null, 2),
    );
  });
});
