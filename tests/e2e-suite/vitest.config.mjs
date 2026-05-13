// tests/e2e-suite/vitest.config.mjs — Hotfix-25 Día 2.
//
// Config dedicado para la suite E2E con LLM real. Bypasea el exclude
// del root vitest.config.mjs (que excluye tests/e2e-suite/ del
// `npm test` general).
//
// Uso (vía npm scripts):
//   npm run test:e2e-suite
//   npm run test:e2e-suite:report

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e-suite/**/*.test.mjs"],
    testTimeout: 120000, // 120s — LLM real puede tardar con tool loop
    hookTimeout: 30000,
    // Sequencial estricto para que el afterAll capture TODOS los results
    // en una sola instancia del array baselineResults. Sin esto, vitest
    // paraleliza tests dentro del file (fork pool) y cada worker tiene
    // su propio scope → afterAll escribe parcial.
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
  },
});
