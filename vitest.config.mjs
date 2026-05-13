// vitest.config.mjs — Hotfix-25 Día 2.
//
// Excluye tests/e2e-suite/ del `npm test` general (508 tests verde).
// La suite e2e con LLM real es on-demand vía `npm run test:e2e-suite`
// con --include explícito que bypassea este exclude.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.idea/**",
      "**/.git/**",
      "**/.cache/**",
      "tests/e2e-suite/**",
    ],
  },
});
