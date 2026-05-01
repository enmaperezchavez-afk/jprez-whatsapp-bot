#!/usr/bin/env node
// scripts/check-encoding.mjs - Detector de mojibake (UTF-8 -> Latin-1
// corruption) en archivos del repo.
//
// MODOS:
//   --staged (default): escanea solo archivos en `git diff --cached`.
//                       Pensado para pre-commit hook (Husky).
//   --all:              escanea recursivamente src/ y api/.
//                       Pensado para CI (GitHub Action).
//
// IMPLEMENTACION: Node.js (no bash) para:
//   - Regex Unicode preciso que NO da falsos positivos en UTF-8 limpio.
//     Los caracteres usados como needles (codepoints U+00C3, U+00C2,
//     U+00F0, U+00E2, U+00EF + U+00B8) NO existen en espanol natural,
//     su presencia indica corrupcion.
//   - Portabilidad cross-platform (Windows Git Bash, Linux, macOS).
//   - Compartir filosofia con el regression-guard de Hotfix-8
//     (tests/hotfix8-mojibake.test.mjs).
//
// HISTORIA: el commit 527a90d (17 abril 2026, GitHub web editor)
// introdujo 21 mojibakes en una sola edicion. Hotfix-8 (27 abril 2026)
// limpio. Este script + CI + docs son la defensa para que no vuelva.
//
// AUTO-RECURSION: este archivo NO debe contener los caracteres mojibake
// como literales en codigo activo (gatillaria al validarse a si mismo).
// Por eso el regex usa Unicode escapes (Ã etc.) y este header evita
// caracteres acentuados que pudieran confundir.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execSync } from "node:child_process";

// Patron: codepoints U+00C3 (Ã), U+00C2 (Â), U+00F0 (ð), seguido de
// alternativas para mojibake de emoji ⚠️ y variation selectors.
const MOJIBAKE_RE = /[\u00C3\u00C2\u00F0]|\u00E2\s|\u00EF\u00B8/;

// NOTA SOBRE SCOPE: escaneamos src/ y api/ (codigo productivo), NO tests/.
// Los tests de regresion (hotfix3-polish, hotfix8-mojibake, prompt-integration)
// usan caracteres mojibake como NEEDLES en .not.toContain(...) para
// asegurar AUSENCIA en SUPERVISOR_PROMPT - assertions defensivas
// legitimas. Exclusion consistente con el regression-guard del Hotfix-8
// (tests/hotfix8-mojibake.test.mjs), que tambien escanea solo src/.
const SOURCE_DIRS = ["src", "api"];
const EXTENSIONS = [".js", ".mjs", ".ts"];

function stripComments(content) {
  // Quitar comentarios para permitir documentacion honesta de incidentes
  // historicos (retros, comentarios sobre bugs pasados pueden citar
  // strings corruptos como ejemplo) sin gatillar el detector.
  return content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

async function findStagedFiles() {
  const out = execSync("git diff --cached --name-only --diff-filter=ACM", {
    encoding: "utf-8",
  });
  // Hotfix-19B unblock: respetar SOURCE_DIRS igual que findAllFiles. Antes
  // solo filtraba por extension, lo que escaneaba tests/ — donde los
  // regression guards (hotfix8-mojibake, etc) usan mojibake como needles
  // legitimos en .not.toContain(...). El comentario de scope al inicio del
  // archivo ya documentaba "NO tests/", solo faltaba honrarlo en --staged.
  return out
    .split("\n")
    .filter(Boolean)
    .filter((f) => EXTENSIONS.some((e) => f.endsWith(e)))
    .filter((f) => SOURCE_DIRS.some((d) => f.startsWith(d + "/")));
}

async function findAllFiles(roots) {
  const results = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(path);
      } else if (EXTENSIONS.some((ext) => e.name.endsWith(ext))) {
        results.push(path);
      }
    }
  }
  for (const root of roots) await walk(root);
  return results;
}

async function main() {
  const mode = process.argv.includes("--all") ? "all" : "staged";
  const files =
    mode === "staged" ? await findStagedFiles() : await findAllFiles(SOURCE_DIRS);

  if (files.length === 0) {
    if (mode === "all") console.log("OK No source files found to scan");
    process.exit(0);
  }

  const offenders = [];
  for (const file of files) {
    let content;
    try {
      content = await readFile(file, "utf-8");
    } catch {
      continue;
    }
    const codeOnly = stripComments(content);
    if (MOJIBAKE_RE.test(codeOnly)) offenders.push(file);
  }

  if (offenders.length > 0) {
    console.error("\nMOJIBAKE DETECTADO - operacion abortada\n");
    console.error("Archivos afectados:");
    offenders.forEach((f) => console.error(`  - ${f}`));
    console.error("\nCausa probable: copy/paste con encoding mal configurado");
    console.error("Solucion: revisa encoding del editor (debe ser UTF-8)\n");
    console.error("Mas info: cat docs/ENCODING_RULES.md\n");
    process.exit(1);
  }

  if (mode === "all") console.log(`OK No encoding corruption detected (${files.length} files scanned)`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[check-encoding] unexpected error:", err.message);
  process.exit(2);
});
