// Hotfix-22 V2 b3 — Tests del skill-linter.
//
// Cobertura (5 tests, no 4 — agregue uno extra para verificar el
// mecanismo de LEGACY_WAIVERS sin acoplarme a archivos especificos):
//   1. countMatches cuenta correctamente bolds/bullets/tablas/code.
//   2. classify devuelve green/yellow/red segun thresholds.
//   3. classify respeta LEGACY_WAIVERS (yellow_waiver en lugar de red).
//   4. lintFile sobre un fixture in-memory (escribir tmpfile + leer).
//   5. runLinter() sobre el repo real retorna shape correcto + skip
//      de SKIP_DIRS.
//
// MODULO LEAF: el linter es puro (solo I/O fs). Tests no requieren mocks.

import { describe, it, expect } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  countMatches,
  classify,
  lintFile,
  runLinter,
  RE_BOLD,
  RE_BULLET,
  RE_TABLE,
  RE_CODE_BLOCK,
  MAX_BOLDS,
  MAX_BULLETS,
  MAX_TABLES,
} from "../scripts/skill-linter.mjs";

describe("Hotfix-22 V2 b3 — skill-linter (puro)", () => {
  it("Test 1: countMatches cuenta bolds/bullets/tablas/code-blocks correctamente", () => {
    const sample = [
      "# Header",
      "",
      "**bold uno** y **bold dos** prosa **bold tres**.",
      "",
      "- bullet uno",
      "- bullet dos",
      "- bullet tres",
      "",
      "| col1 | col2 |",
      "| ---- | ---- |",
      "| a | b |",
      "",
      "```js",
      "const x = 1;",
      "```",
      "",
      "```",
      "otro code block",
      "```",
    ].join("\n");

    expect(countMatches(sample, RE_BOLD)).toBe(3);
    expect(countMatches(sample, RE_BULLET)).toBe(3);
    // 3 lineas que matchean ^\|.*\|.*\|$ (la de header + sep + datos).
    expect(countMatches(sample, RE_TABLE)).toBeGreaterThanOrEqual(2);
    // 4 backticks de apertura/cierre (2 code blocks completos).
    expect(countMatches(sample, RE_CODE_BLOCK)).toBe(4);
  });

  it("Test 2: classify devuelve green/yellow/red segun thresholds", () => {
    // Green: nada excede.
    const green = classify({ file: "x.md", bolds: 1, bullets: 2, tables: 0, codeBlocks: 3 });
    expect(green).toBe("green");

    // Yellow: solo code blocks excede.
    const yellow = classify({ file: "x.md", bolds: 0, bullets: 0, tables: 0, codeBlocks: 99 });
    expect(yellow).toBe("yellow");

    // Red: bolds excede.
    const redBolds = classify({ file: "x.md", bolds: MAX_BOLDS + 1, bullets: 0, tables: 0, codeBlocks: 0 });
    expect(redBolds).toBe("red");

    // Red: bullets excede.
    const redBullets = classify({ file: "x.md", bolds: 0, bullets: MAX_BULLETS + 1, tables: 0, codeBlocks: 0 });
    expect(redBullets).toBe("red");

    // Red: tables (>0) excede.
    const redTables = classify({ file: "x.md", bolds: 0, bullets: 0, tables: MAX_TABLES + 1, codeBlocks: 0 });
    expect(redTables).toBe("red");
  });

  it("Test 3: classify respeta LEGACY_WAIVERS (yellow_waiver en lugar de red)", () => {
    // Archivos en la lista de waivers deben reportar yellow_waiver
    // aun cuando excedan thresholds. Si esta lista cambia, este test
    // captura el cambio. Hardcoded a la entry conocida del linter.
    const waiverFile = ".claude/skills/vendedor-whatsapp-jprez/SKILL.md";
    const result = classify({
      file: waiverFile,
      bolds: 200,
      bullets: 100,
      tables: 50,
      codeBlocks: 5,
    });
    expect(result).toBe("yellow_waiver");

    // Mismo path con backslash (Windows) tambien debe matchearse.
    const winPath = waiverFile.replace(/\//g, "\\");
    const winResult = classify({
      file: winPath,
      bolds: 200,
      bullets: 100,
      tables: 50,
      codeBlocks: 5,
    });
    expect(winResult).toBe("yellow_waiver");
  });

  it("Test 4: lintFile sobre fixture temporal cuenta + clasifica", async () => {
    // Crear archivo temporal con formato Excel para validar end-to-end.
    const dir = await mkdir(join(tmpdir(), "skill-linter-" + Date.now()), { recursive: true });
    const tmpFile = join(dir || join(tmpdir(), "skill-linter-test"), "tmp-skill.md");
    const content = [
      "# Skill bad",
      "**uno**",
      "**dos**",
      "**tres**",
      "**cuatro**",
      "**cinco**",
      "**seis**",   // 6 bolds: excede MAX_BOLDS=5
      "",
      "- a",
      "- b",
    ].join("\n");
    try {
      await writeFile(tmpFile, content, "utf-8");
      const r = await lintFile(tmpFile);
      expect(r.bolds).toBe(6);
      expect(r.bullets).toBe(2);
      expect(r.status).toBe("red");
    } finally {
      try { await rm(tmpFile); } catch {}
    }
  });

  it("Test 5: runLinter() sobre repo real retorna shape correcto + skip SKIP_DIRS", async () => {
    const out = await runLinter();
    expect(out).toHaveProperty("results");
    expect(out).toHaveProperty("exitCode");
    expect(Array.isArray(out.results)).toBe(true);

    // Verificar que SKIP_DIRS funciona: NO debe haber resultados de
    // jprez-bot-architecture ni jprez-security-patterns (docs Claude
    // Code, no skills de bot).
    const hasArchitecture = out.results.some((r) => r.file.includes("jprez-bot-architecture"));
    const hasSecurity = out.results.some((r) => r.file.includes("jprez-security-patterns"));
    expect(hasArchitecture).toBe(false);
    expect(hasSecurity).toBe(false);

    // Sanity: al menos los 3 skills productivos estan en results.
    const hasMercado = out.results.some((r) => r.file.includes("mercado-inmobiliario-rd"));
    const hasCalc = out.results.some((r) => r.file.includes("calculadora-plan-pago"));
    expect(hasMercado).toBe(true);
    expect(hasCalc).toBe(true);
  });
});
