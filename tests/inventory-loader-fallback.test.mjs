// ============================================
// Tests Hotfix-31 — fallback del loader no cachea fallos
// ============================================
// Bug: si la lectura de inventario-precios.md fallaba, se cacheaba ""
// para siempre (hasta el próximo cold start) y el bot quedaba sin
// inventario aunque el problema fuera transitorio.

import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("readFallbackInventory (Hotfix-31)", () => {
  it("archivo legible → retorna el markdown real del repo", async () => {
    vi.resetModules();
    const { readFallbackInventory } = await import("../src/inventory/loader.js");
    const md = readFallbackInventory();
    expect(typeof md).toBe("string");
    expect(md.trim().length).toBeGreaterThan(0);
    expect(md).not.toContain("Inventario temporalmente no disponible");
  });

  it("lectura falla → mensaje de escalación y NO cachea el fallo", async () => {
    vi.resetModules();
    const spy = vi
      .spyOn(fs, "readFileSync")
      .mockImplementation(() => {
        throw new Error("ENOENT simulado");
      });
    const { readFallbackInventory } = await import("../src/inventory/loader.js");

    const md = readFallbackInventory();
    expect(md).toContain("Inventario temporalmente no disponible");
    expect(md).toContain("NO inventes precios");

    // Al desaparecer el problema, la siguiente llamada reintenta y lee
    // el archivo real (antes: quedaba "" cacheado para siempre).
    spy.mockRestore();
    const md2 = readFallbackInventory();
    expect(md2).not.toContain("Inventario temporalmente no disponible");
    expect(md2.trim().length).toBeGreaterThan(0);
  });

  it("archivo vacío → también usa mensaje de escalación", async () => {
    vi.resetModules();
    vi.spyOn(fs, "readFileSync").mockReturnValue("   \n  ");
    const { readFallbackInventory } = await import("../src/inventory/loader.js");
    const md = readFallbackInventory();
    expect(md).toContain("Inventario temporalmente no disponible");
  });
});
