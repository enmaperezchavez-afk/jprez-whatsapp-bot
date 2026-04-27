// Tests de hotfix-9 Día 4: defensa militar de encoding (4 capas).
//
// Capa 1 — Pre-commit hook (.husky/pre-commit) ejecuta el script Node.
// Capa 2 — GitHub Action CI (.github/workflows/encoding-check.yml).
// Capa 3 — Regression-guard test (tests/hotfix8-mojibake.test.mjs, ya activo).
// Capa 4 — Documentación (docs/ENCODING_RULES.md).
//
// Estos tests verifican que las 3 capas NUEVAS están presentes y bien
// configuradas. La capa 3 ya tiene su propio test desde Hotfix-8.

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

describe("Hotfix-9 — Encoding defense (4 layers)", () => {
  it("Capa 1: scripts/check-encoding.mjs exists with shebang, MOJIBAKE_RE, and dual modes", async () => {
    const content = await readFile(
      join(PROJECT_ROOT, "scripts", "check-encoding.mjs"),
      "utf-8"
    );
    // Shebang Node.js (ejecutable como `node script` o directo si tiene +x)
    expect(content.startsWith("#!/usr/bin/env node")).toBe(true);
    // Regex declarado y nombrado consistentemente
    expect(content).toContain("const MOJIBAKE_RE");
    // Soporte de modos --staged (pre-commit) y --all (CI)
    expect(content).toContain("--staged");
    expect(content).toContain("--all");
    // El script ignora comentarios (consistente con regression-guard del Hotfix-8)
    expect(content).toContain("stripComments");
  });

  it("Capa 1B: .husky/pre-commit invokes check-encoding.mjs", async () => {
    const hook = await readFile(
      join(PROJECT_ROOT, ".husky", "pre-commit"),
      "utf-8"
    );
    expect(hook).toContain("node scripts/check-encoding.mjs");
    // El hook anterior (syntax check de api/*.js) debe seguir intacto
    expect(hook).toContain("node --check");
  });

  it("Capa 2: GitHub Action workflow runs check-encoding.mjs --all on push and PR", async () => {
    const workflow = await readFile(
      join(PROJECT_ROOT, ".github", "workflows", "encoding-check.yml"),
      "utf-8"
    );
    expect(workflow).toContain("Encoding Integrity Check");
    expect(workflow).toContain("node scripts/check-encoding.mjs --all");
    // Triggers: push y pull_request a main
    expect(workflow).toMatch(/on:[\s\S]*push:[\s\S]*pull_request:/);
    expect(workflow).toContain("branches: [main]");
    // Setup Node 20+ (necesario para regex Unicode estable + ESM)
    expect(workflow).toContain("setup-node");
  });

  it("Capa 4: docs/ENCODING_RULES.md exists with all 4 rules + paciente cero reference", async () => {
    const docs = await readFile(
      join(PROJECT_ROOT, "docs", "ENCODING_RULES.md"),
      "utf-8"
    );
    // Las 4 reglas ninja
    expect(docs).toContain("Regla #1");
    expect(docs).toContain("Regla #2");
    expect(docs).toContain("Regla #3");
    expect(docs).toContain("Regla #4");
    // Paciente cero del incidente
    expect(docs).toContain("527a90d");
    // Comando manual del Director
    expect(docs).toContain("node scripts/check-encoding.mjs");
    // Mención del regression-guard (capa 3) para coherencia interna
    expect(docs).toContain("d1322d2");
    // Sección multi-tenant para Closer SD
    expect(docs).toContain("Closer SD");
  });
});
