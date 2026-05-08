// Hotfix-22 V3 r3 — Test CI defensivo: budget REAL via count_tokens API.
//
// El validator existente (src/validators/token-budget.js) usa estimación
// naive chars/4. R3 descubrio que el BPE real es ~42% MAYOR que naive
// (33,535 naive vs 47,629 reales pre-trim). Esa brecha explica por qué
// el bot saturaba Tier 1 (30K tokens/min) sin que el validator avisara.
//
// Este test cierra la brecha: llama anthropic.messages.countTokens()
// con el staticBlock real y falla si excede el target post-r3 (28K
// tokens REALES).
//
// FALLBACK GRACEFUL (Director aprobado): si la API key no está
// disponible (fork PR sin secrets en CI, dev sin .env.local), el test
// se SKIPea con warning. NO bloquea merge en ese caso. El test corre
// real cuando hay key (preview deploys, PRs internos).
//
// HARD LIMIT vs SOFT TARGET:
//   - SOFT TARGET (28K tokens reales) = aspiracion Director post-r3.
//     Si se excede, log warning brutal pero NO bloquea merge. R3.5
//     (refactor inventario a tool dinamica) compensaria. Esta primera
//     entrega R3 reduce 47.6K → ~42K reales — yellow alto, no <28K.
//   - HARD LIMIT (50K tokens reales) = romperia el deploy en serio.
//     Si se excede, FALLA el test (defensa contra refactor accidental
//     que duplique el prompt o inserte skills gigantes en el futuro).
//
// COSTO: count_tokens es FREE en Anthropic API (no cobra por tokens).
// El unico limite es rate limit ~100 req/min Tier 1. Cada run del
// test es ~1 call. Costo total CI por PR: $0.00.

import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { buildSystemPromptBlocks } = require("../src/prompts");
const { estimateTokens } = require("../src/validators/token-budget");

// Director aprobado dos thresholds:
const BUDGET_REAL_TARGET = 28000;       // soft target — warn si excede
const BUDGET_REAL_HARD_LIMIT = 50000;   // hard limit — FALLA si excede

// Helper: load env from .env.local for local dev (CI usa secrets).
function loadEnvLocal() {
  try {
    const fs = require("fs");
    const content = fs.readFileSync(".env.local", "utf-8");
    for (const line of content.split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch (e) {
    // .env.local no existe (CI). Esperar secrets de GitHub Actions.
  }
}

describe("Hotfix-22 V3 r3 — budget REAL via count_tokens API", () => {
  it("staticBlock REAL: warn si excede 28K target, FALLA si excede 50K hard limit", async () => {
    loadEnvLocal();
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const { staticBlock } = buildSystemPromptBlocks();

    // Ratio naive vs real visible siempre (incluso sin API).
    const naiveTokens = estimateTokens(staticBlock);
    console.log("[budget-real] staticBlock chars:", staticBlock.length);
    console.log("[budget-real] tokens naive (chars/4):", naiveTokens);

    // Fallback graceful: si no hay API key, log warning y skip assertion.
    // NO bloquea merge — Director aprobado.
    if (!apiKey || apiKey.startsWith("sk-ant-test")) {
      console.warn(
        "[budget-real] ANTHROPIC_API_KEY no disponible (CI fork PR o dev sin .env.local). " +
        "SKIPPING real countTokens call. Naive estimate=" + naiveTokens + " tokens. " +
        "Test se ejecuta real en CI con secrets."
      );
      // Sanity assertion mínima: naive debe estar bajo limite generoso (40K)
      // para detectar deploys con bundle roto que duplican el prompt.
      expect(naiveTokens).toBeLessThan(40000);
      return;
    }

    // API key presente: medir REAL.
    const Anthropic = require("@anthropic-ai/sdk");
    const anthropic = new Anthropic({ apiKey });

    let realTokens;
    try {
      const r = await anthropic.messages.countTokens({
        model: "claude-sonnet-4-6",
        system: staticBlock,
        messages: [{ role: "user", content: "hi" }],
      });
      realTokens = r.input_tokens;
    } catch (e) {
      console.warn(
        "[budget-real] countTokens API error (status=" + (e.status || "?") +
        "): " + e.message + ". SKIPPING assertion. NO bloquea merge."
      );
      // Sanity fallback igual que sin key.
      expect(naiveTokens).toBeLessThan(40000);
      return;
    }

    const ratio = (realTokens / naiveTokens).toFixed(2);
    console.log("[budget-real] tokens REAL (countTokens API):", realTokens);
    console.log("[budget-real] BPE ratio (real/naive):", ratio);
    console.log("[budget-real] soft target:", BUDGET_REAL_TARGET);
    console.log("[budget-real] hard limit:", BUDGET_REAL_HARD_LIMIT);

    // Soft target: warn si excede pero NO bloquea (Director aprobado).
    if (realTokens >= BUDGET_REAL_TARGET) {
      console.warn(
        "[budget-real] WARN: staticBlock REAL " + realTokens +
        " tokens >= target " + BUDGET_REAL_TARGET +
        ". Considerar R3.5 (refactor inventario a tool) o trim adicional."
      );
    }

    // Hard limit: si se excede, FALLA. Defensa contra duplicacion
    // accidental del prompt o skills gigantes en el futuro.
    expect(realTokens,
      "staticBlock REAL tokens (" + realTokens + ") excede HARD LIMIT " +
      BUDGET_REAL_HARD_LIMIT + ". Refactor obligatorio."
    ).toBeLessThan(BUDGET_REAL_HARD_LIMIT);
  }, 30000); // 30s timeout para call HTTP.
});
