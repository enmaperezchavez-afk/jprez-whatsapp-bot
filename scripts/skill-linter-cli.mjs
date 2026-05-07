#!/usr/bin/env node
// scripts/skill-linter-cli.mjs — Hotfix-22 V3 r1.
//
// CLI entrypoint del skill linter. Importa el modulo puro
// scripts/skill-linter.mjs y orquesta args + exit codes. Refactor del
// archivo original que mezclaba modulo + CLI: vitest 4.x rompia al
// colectar tests/skill-linter.test.mjs porque el top-level
// `if (isMain) { ... }` (con import.meta.url + process.argv) tropezaba
// el transformer interno reportando "SyntaxError" engañoso. Splittear
// resolvio loud el issue: el modulo se puede importar desde tests sin
// side effects, este CLI conserva el shebang + behavior identico.
//
// MODOS:
//   default: escanea todo .claude/skills/**/*.md y reporta.
//   --strict: exit code 2 si rojo (CI bloquea merge).
//   --staged: solo archivos en git diff --cached (pre-commit hook).
//
// EXIT CODES:
//   0 = todos los skills OK (o solo green)
//   1 = al menos un yellow warning (sin --strict no bloquea)
//   2 = al menos un red critical (excede thresholds duros)

import { runLinter, formatReport, SKILLS_ROOT } from "./skill-linter.mjs";

const args = process.argv.slice(2);
const STRICT = args.includes("--strict");
const STAGED = args.includes("--staged");

const { results, exitCode, reason } = await runLinter({ staged: STAGED });
if (results.length === 0) {
  if (reason === "no_staged_skills") {
    // Pre-commit hook: nada que validar — exit silencioso.
  } else {
    console.log("[skill-linter] no skills found in " + SKILLS_ROOT);
  }
} else {
  console.log(formatReport(results));
  const summary =
    "[skill-linter] " + results.length + " skills scanned. " +
    "exitCode=" + exitCode + (STRICT ? " (--strict)" : "");
  console.log(summary);
}
// En modo no-strict, yellow (1) NO bloquea — devolvemos 0.
// Red (2) siempre bloquea.
process.exit(STRICT ? exitCode : (exitCode === 2 ? 2 : 0));
