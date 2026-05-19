// Bloque 1 Fase 3 — Tests buildSystemPromptBlocksAsync.
//
// Cubre la nueva función async que carga el inventario via loader.
// La versión sync (buildSystemPromptBlocks) sigue funcionando con
// INVENTORY_CONTENT del cold start, no se rompen 22+ tests existentes.
//
// Cobertura (3 tests):
//   1. async devuelve mismo shape {staticBlock, dynamicHeader} que sync
//   2. async usa inv.markdown del loader cuando está disponible
//   3. async cae a INVENTORY_CONTENT del cold start si loader lanza

import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// Mock botLog
{
  const id = require.resolve("../src/log");
  require.cache[id] = {
    id, filename: id, loaded: true,
    exports: {
      botLog: () => {},
      logToAxiom: async () => {},
    },
  };
}

// Mock store/redis (devuelve objeto Redis fake)
{
  const id = require.resolve("../src/store/redis");
  require.cache[id] = {
    id, filename: id, loaded: true,
    exports: { getRedis: async () => ({ get: async () => null, set: async () => "OK" }) },
  };
}

// Mock inventory/loader controlable
let nextLoaderResult;
let loaderShouldThrow;
{
  const id = require.resolve("../src/inventory/loader");
  require.cache[id] = {
    id, filename: id, loaded: true,
    exports: {
      loadInventory: async () => {
        if (loaderShouldThrow) throw new Error("simulated loader failure");
        return nextLoaderResult;
      },
      CACHE_KEY: "inventory:current",
      CACHE_TTL_SECONDS: 300,
    },
  };
}

const { buildSystemPromptBlocks, buildSystemPromptBlocksAsync } = require("../src/prompts");

describe("Bloque 1 Fase 3 — buildSystemPromptBlocksAsync", () => {
  beforeEach(() => {
    nextLoaderResult = null;
    loaderShouldThrow = false;
  });

  it("Test 1: async devuelve mismo shape {staticBlock, dynamicHeader} que sync", async () => {
    nextLoaderResult = { markdown: "# inv fresh from sheet", source: "sheet" };
    const blocks = await buildSystemPromptBlocksAsync();
    expect(blocks).toHaveProperty("staticBlock");
    expect(blocks).toHaveProperty("dynamicHeader");
    expect(typeof blocks.staticBlock).toBe("string");
    expect(typeof blocks.dynamicHeader).toBe("string");
    expect(blocks.staticBlock.length).toBeGreaterThan(0);
    // Sanity: el shape coincide con la versión sync
    const syncBlocks = buildSystemPromptBlocks();
    expect(Object.keys(blocks).sort()).toEqual(Object.keys(syncBlocks).sort());
  });

  it("Test 2: async usa inv.markdown del loader cuando está disponible", async () => {
    nextLoaderResult = {
      markdown: "## INVENTARIO_FRESH_DESDE_SHEET_12345",
      source: "sheet",
    };
    const { staticBlock } = await buildSystemPromptBlocksAsync();
    expect(staticBlock).toContain("INVENTARIO_FRESH_DESDE_SHEET_12345");
  });

  it("Test 3: async cae a INVENTORY_CONTENT del cold start si loader lanza", async () => {
    loaderShouldThrow = true;
    const { staticBlock } = await buildSystemPromptBlocksAsync();
    // El staticBlock se construye igual, sólo que con el inventario fallback
    // (el inventario hardcoded del archivo .md cargado al cold start).
    expect(staticBlock).toContain("INVENTARIO Y PRECIOS DETALLADOS");
    // Como el archivo .md tiene "CRUX DEL PRADO" en su contenido, debe estar
    expect(staticBlock).toMatch(/CRUX DEL PRADO|Crux del Prado/);
  });

  it("Test 4: async cae a fallback si loader devuelve markdown vacío", async () => {
    nextLoaderResult = { markdown: "", source: "fallback" };
    const { staticBlock } = await buildSystemPromptBlocksAsync();
    // Mismo comportamiento que Test 3 — usa fallback in-memory
    expect(staticBlock).toContain("INVENTARIO Y PRECIOS DETALLADOS");
  });
});
