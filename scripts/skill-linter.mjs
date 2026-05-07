// scripts/skill-linter.mjs — Hotfix-22 V2 b3 (modulo puro, sin CLI logic).
//
// Linter automatico para skills Markdown bajo .claude/skills/**/*.md.
// Detecta formato Excel (bullets / **bold** / tablas) que el LLM imitaria
// al responder al cliente. Previene Bug #29 (asteriscos en produccion)
// por skill nuevo copiado del Drive sin limpiar.
//
// HOTFIX-22 V3 r1: este modulo ahora es PURO (solo logic + exports). El
// CLI entrypoint vive en scripts/skill-linter-cli.mjs. Razon: vitest 4.x
// rompia al colectar tests/skill-linter.test.mjs porque el top-level
// `if (isMain) { ... }` (con import.meta.url + process.argv) tropezaba
// el transformer interno reportando "SyntaxError: Invalid or unexpected
// token" engañoso (real era TypeError en runner.config). Splittear en
// modulo puro + CLI entrypoint resolvio loud el issue: el modulo se
// puede importar desde tests sin side effects, el CLI conserva el
// shebang + behavior idéntico.
//
// THRESHOLDS (configurables via SKILL_LINTER_* env si fuera necesario):
//   MAX_BOLDS       =  5  (1-2 OK por anti-ejemplo, 5+ es Excel)
//   MAX_BULLETS     = 10  (estricto: skill prosa)
//   MAX_TABLES      =  0  (no permitido)
//   MAX_CODE_BLOCKS =  8  (warning si excede)

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execSync } from "node:child_process";

const SKILLS_ROOT = ".claude/skills";

// SKIP_DIRS: skills que existen como referencia para Claude Code (este
// agente AI), NO se inyectan al staticBlock del bot Mateo. Su formato
// (bullets/bold/tablas) es legitimo porque son docs tecnicas para
// otro LLM. Solo aplicamos linter a los skills que SI llegan al cliente
// final via el prompt del bot.
const SKIP_DIRS = [
  "jprez-bot-architecture",   // Doc arquitectura para Claude Code agent
  "jprez-security-patterns",  // Doc patrones de testing para Claude Code agent
];

// LEGACY_WAIVERS: archivos que SI se inyectan al prompt del bot pero que
// arrastran formato Excel pre-Hotfix-22 V2. B5 + B6 limpiaron ambos
// archivos a [GREEN], pero la lista queda como precaucion: si una
// seccion futura agrega bullets/bold por error, el waiver evita que CI
// se rompa hasta que el Director decida limpiar.
const LEGACY_WAIVERS = new Set([
  ".claude/skills/vendedor-whatsapp-jprez/SKILL.md",
  ".claude/skills/vendedor-whatsapp-jprez/references/inventario-precios.md",
]);

const MAX_BOLDS = 5;
const MAX_BULLETS = 10;
const MAX_TABLES = 0;
const MAX_CODE_BLOCKS = 8;

const RE_BOLD = /\*\*[^*\n]+\*\*/g;
const RE_BULLET = /^- /gm;
const RE_TABLE = /^\|.*\|.*\|$/gm;
const RE_CODE_BLOCK = /^```/gm;

// walkSkills: enumera recursivamente .md bajo .claude/skills/, omitiendo
// directorios de SKIP_DIRS (docs Claude Code, no skills de bot).
async function walkSkills(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.includes(entry.name)) {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await walkSkills(path);
      out.push(...sub);
    } else if (entry.isFile() && path.endsWith(".md")) {
      out.push(path);
    }
  }
  return out;
}

// stagedSkills: archivos staged en git diff --cached que matcheen
// .claude/skills/**/*.md. Para uso pre-commit hook.
function stagedSkills() {
  let out = [];
  try {
    const raw = execSync("git diff --cached --name-only --diff-filter=ACM", { encoding: "utf-8" });
    out = raw
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.startsWith(SKILLS_ROOT) && s.endsWith(".md"));
  } catch (e) {
    // Si no hay repo git o no hay staged, retornamos vacio.
  }
  return out;
}

// countMatches: cuenta ocurrencias de un regex en text.
function countMatches(text, re) {
  // re es global; reset lastIndex no requerido si usamos String.match.
  const m = text.match(re);
  return m ? m.length : 0;
}

// classify: dado un fileResult, decide green/yellow/red segun thresholds.
// Los archivos en LEGACY_WAIVERS reportan estado real pero quedan
// marcados como "yellow_waiver" (no escala a red) para no bloquear CI
// mientras el Director decide cuando limpiarlos.
function classify(result) {
  // Normalizar separador de path para match cross-platform.
  const normalized = result.file.replace(/\\/g, "/");
  const waived = LEGACY_WAIVERS.has(normalized);
  if (result.bolds > MAX_BOLDS || result.bullets > MAX_BULLETS || result.tables > MAX_TABLES) {
    return waived ? "yellow_waiver" : "red";
  }
  if (result.codeBlocks > MAX_CODE_BLOCKS) {
    return "yellow";
  }
  return "green";
}

// lintFile: leer + contar + clasificar.
async function lintFile(file) {
  const text = await readFile(file, "utf-8");
  const result = {
    file,
    chars: text.length,
    bolds: countMatches(text, RE_BOLD),
    bullets: countMatches(text, RE_BULLET),
    tables: countMatches(text, RE_TABLE),
    codeBlocks: countMatches(text, RE_CODE_BLOCK),
  };
  result.status = classify(result);
  return result;
}

// formatReport: render texto humano por skill.
function formatReport(results) {
  const lines = [];
  for (const r of results) {
    let tag = "[GREEN]";
    if (r.status === "red") tag = "[RED]";
    else if (r.status === "yellow") tag = "[YELLOW]";
    else if (r.status === "yellow_waiver") tag = "[WAIVER]";
    lines.push(
      tag + " " + r.file +
      "  bolds=" + r.bolds + "/" + MAX_BOLDS +
      "  bullets=" + r.bullets + "/" + MAX_BULLETS +
      "  tables=" + r.tables + "/" + MAX_TABLES +
      "  code=" + r.codeBlocks + "/" + MAX_CODE_BLOCKS
    );
  }
  return lines.join("\n");
}

// runLinter: pipeline completo. Retorna { results, exitCode }.
async function runLinter({ staged = false } = {}) {
  let files;
  if (staged) {
    files = stagedSkills();
    if (files.length === 0) {
      // No hay skills staged — pre-commit hook pasa silencioso.
      return { results: [], exitCode: 0, reason: "no_staged_skills" };
    }
  } else {
    files = await walkSkills(SKILLS_ROOT);
    if (files.length === 0) {
      // Repo sin skills — green por defecto.
      return { results: [], exitCode: 0, reason: "no_skills_found" };
    }
  }

  const results = [];
  for (const f of files) {
    results.push(await lintFile(f));
  }

  const hasRed = results.some((r) => r.status === "red");
  const hasYellow = results.some(
    (r) => r.status === "yellow" || r.status === "yellow_waiver"
  );

  let exitCode = 0;
  if (hasRed) exitCode = 2;
  else if (hasYellow) exitCode = 1;

  return { results, exitCode };
}

export {
  runLinter,
  lintFile,
  classify,
  formatReport,
  walkSkills,
  stagedSkills,
  countMatches,
  MAX_BOLDS,
  MAX_BULLETS,
  MAX_TABLES,
  MAX_CODE_BLOCKS,
  RE_BOLD,
  RE_BULLET,
  RE_TABLE,
  RE_CODE_BLOCK,
  SKILLS_ROOT,
};
