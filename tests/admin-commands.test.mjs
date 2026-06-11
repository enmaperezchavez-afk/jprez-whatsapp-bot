// Bloque 1 Fase 3.5c — Tests parser + executor de comandos supervisor.
//
// Tests del Director (10) + extras de robustez.
//
// Cobertura mínima pedida por Director:
//   1. /reservar pse3 15-102 → write + confirmación
//   2. /vender pr4 5A → write + confirmación
//   3. /liberar crux_t6 P3-B 99000 → write + confirmación
//   4. /inventario pse3 → resumen con conteos
//   5. /inventario → resumen todos
//   6. /reservar sin proyecto → pide proyecto
//   7. /reservar pse3 sin unidad → pide unidad
//   8. /reservar foo XXXX → proyecto inválido
//   9. /reservar pse3 XXXXX → unidad no existe
//   10. /liberar pse3 15-102 sin precio → pide precio
//   + extras: parser robusto, cliente ignorado (parser devuelve null
//     para texto sin /), Redis cache invalidada post-write.

import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// Mocks
const sheetsWriterCalls = [];
let nextWriterResult;
const fakeSheetsWriter = {
  updateUnitStatus: async (args) => {
    sheetsWriterCalls.push({ op: "status", ...args });
    return nextWriterResult || { ok: true, range: "PSE3!H10", oldValue: "disponible" };
  },
  updateUnitPrice: async (args) => {
    sheetsWriterCalls.push({ op: "price", ...args });
    return nextWriterResult || { ok: true, range: "PSE3!E10", oldValue: "138000" };
  },
};

const loaderCalls = [];
let nextLoaderResult;
const fakeLoader = {
  loadInventory: async (opts) => {
    loaderCalls.push(opts);
    return nextLoaderResult || {
      markdown: "fake",
      source: "sheet",
      totals: {
        pr3: { disponibles: 6, total: 60 },
        pr4: { disponibles: 13, total: 72 },
        pse3: { disponibles: 55, total: 126 },
        pse4: { disponibles: 19, total: 80 },
        crux_t6: { disponibles: 42, total: 50 },
        crux_listos: { disponibles: 4, total: 4 },
      },
      skipped_count: 0,
    };
  },
};

const redisCalls = [];
const fakeRedis = {
  get: async () => null,
  set: async () => "OK",
  del: async (key) => {
    redisCalls.push({ op: "del", key });
    return 1;
  },
};

const {
  parseAdminCommand,
  executeAdminCommand,
  resolveProjectTab,
  formatSummary,
  VALID_PROJECTS,
} = require("../src/inventory/admin-commands");

function newCtx() {
  return {
    supervisorPhone: "18299943102",
    sheetsWriter: fakeSheetsWriter,
    inventoryLoader: fakeLoader,
    redis: fakeRedis,
  };
}

describe("Bloque 1 Fase 3.5 — admin commands parser", () => {
  it("parsea /reservar pse3 15-102 correctamente", () => {
    expect(parseAdminCommand("/reservar pse3 15-102")).toEqual({
      command: "reservar",
      project: "pse3",
      unit: "15-102",
    });
  });

  it("parsea con espacios extra", () => {
    expect(parseAdminCommand("  /reservar   pse3   15-102  ")).toEqual({
      command: "reservar",
      project: "pse3",
      unit: "15-102",
    });
  });

  it("texto sin / → null (no es comando)", () => {
    expect(parseAdminCommand("hola que tal")).toBe(null);
    expect(parseAdminCommand("reservar pse3 15-102")).toBe(null);
  });

  it("comando desconocido → null", () => {
    expect(parseAdminCommand("/foo bar")).toBe(null);
  });

  it("/inventario solo → command sin project", () => {
    expect(parseAdminCommand("/inventario")).toEqual({ command: "inventario" });
  });

  it("/inventario pse3 → command + project", () => {
    expect(parseAdminCommand("/inventario pse3")).toEqual({
      command: "inventario",
      project: "pse3",
    });
  });

  it("/liberar parsea precio", () => {
    expect(parseAdminCommand("/liberar crux_t6 P3-B 99000")).toEqual({
      command: "liberar",
      project: "crux_t6",
      unit: "P3-B",
      price: 99000,
    });
  });

  it("/liberar sin precio → error missing_price", () => {
    const r = parseAdminCommand("/liberar pse3 15-102");
    expect(r.error).toBe("missing_price");
  });

  it("/reservar sin proyecto → error missing_project", () => {
    const r = parseAdminCommand("/reservar");
    expect(r.error).toBe("missing_project");
  });

  it("/reservar pse3 sin unidad → error missing_unit", () => {
    const r = parseAdminCommand("/reservar pse3");
    expect(r.error).toBe("missing_unit");
    expect(r.project).toBe("pse3");
  });

  it("unidad con espacios (Hotfix-31): /reservar y /precio", () => {
    expect(parseAdminCommand("/reservar pr3 APT 201")).toEqual({
      command: "reservar",
      project: "pr3",
      unit: "APT 201",
    });
    // Con precio: el precio es el ÚLTIMO token, la unidad lo de en medio.
    expect(parseAdminCommand("/precio pr3 APT 201 99000")).toEqual({
      command: "precio",
      project: "pr3",
      unit: "APT 201",
      price: 99000,
    });
  });

  it("precio con coma de miles y coma decimal (Hotfix-31)", () => {
    expect(parseAdminCommand("/precio pse3 15-102 95,000").price).toBe(95000);
    expect(parseAdminCommand("/liberar pse3 15-102 US$120,500.50").price).toBe(120500.5);
    expect(parseAdminCommand("/precio pse3 15-102 abc").error).toBe("invalid_price");
  });
});

describe("Bloque 1 Fase 3.5 — admin commands executor", () => {
  beforeEach(() => {
    sheetsWriterCalls.length = 0;
    loaderCalls.length = 0;
    redisCalls.length = 0;
    nextWriterResult = null;
    nextLoaderResult = null;
  });

  it("Test 1: /reservar pse3 15-102 → write + confirmación + invalida cache", async () => {
    const parsed = parseAdminCommand("/reservar pse3 15-102");
    const result = await executeAdminCommand(parsed, newCtx());
    expect(result.didWrite).toBe(true);
    expect(result.reply).toContain("✅");
    expect(result.reply).toContain("PSE3");
    expect(result.reply).toContain("15-102");
    expect(result.reply).toContain("reservada");
    expect(sheetsWriterCalls).toEqual([
      {
        op: "status",
        tabName: "PSE3",
        unitId: "15-102",
        newStatus: "reservado",
        supervisorPhone: "18299943102",
      },
    ]);
    expect(redisCalls).toContainEqual({ op: "del", key: "inventory:current" });
  });

  it("Test 2: /vender pr4 5A → write 'vendido' + confirmación", async () => {
    const parsed = parseAdminCommand("/vender pr4 5A");
    const result = await executeAdminCommand(parsed, newCtx());
    expect(result.didWrite).toBe(true);
    expect(result.reply).toContain("vendida");
    expect(sheetsWriterCalls[0].newStatus).toBe("vendido");
    expect(sheetsWriterCalls[0].tabName).toBe("PR4");
    expect(sheetsWriterCalls[0].unitId).toBe("5A");
  });

  it("Test 3: /liberar crux_t6 P3-B 99000 → status disponible + precio update", async () => {
    const parsed = parseAdminCommand("/liberar crux_t6 P3-B 99000");
    const result = await executeAdminCommand(parsed, newCtx());
    expect(result.didWrite).toBe(true);
    expect(result.reply).toContain("liberada");
    // Sprint1.8 PR-3: montos formateados en confirmaciones.
    expect(result.reply).toContain("US$99,000");
    // 2 writes: status + price
    expect(sheetsWriterCalls.length).toBe(2);
    expect(sheetsWriterCalls[0]).toMatchObject({
      op: "status",
      tabName: "CRUX_TORRE6",
      unitId: "P3-B",
      newStatus: "disponible",
    });
    expect(sheetsWriterCalls[1]).toMatchObject({
      op: "price",
      tabName: "CRUX_TORRE6",
      unitId: "P3-B",
      newPrice: 99000,
    });
  });

  it("Test 4: /precio pse3 15-102 200000 → solo update precio", async () => {
    const parsed = parseAdminCommand("/precio pse3 15-102 200000");
    const result = await executeAdminCommand(parsed, newCtx());
    expect(result.didWrite).toBe(true);
    expect(result.reply).toContain("Precio");
    expect(result.reply).toContain("US$200,000");
    expect(sheetsWriterCalls).toEqual([
      {
        op: "price",
        tabName: "PSE3",
        unitId: "15-102",
        newPrice: 200000,
        supervisorPhone: "18299943102",
      },
    ]);
  });

  it("Test 5: /inventario pse3 → resumen del proyecto", async () => {
    const parsed = parseAdminCommand("/inventario pse3");
    const result = await executeAdminCommand(parsed, newCtx());
    expect(result.didWrite).toBe(false);
    expect(result.reply).toContain("PSE3");
    expect(result.reply).toContain("55");
    expect(result.reply).toContain("126");
    expect(loaderCalls.length).toBe(1);
    expect(sheetsWriterCalls.length).toBe(0);
  });

  it("Test 6: /inventario sin proyecto → resumen TODOS", async () => {
    const parsed = parseAdminCommand("/inventario");
    const result = await executeAdminCommand(parsed, newCtx());
    expect(result.didWrite).toBe(false);
    expect(result.reply).toContain("Inventario JPREZ");
    expect(result.reply).toContain("PR3:");
    expect(result.reply).toContain("Crux Listos");
    expect(result.reply).toMatch(/6\/60/);
    expect(result.reply).toMatch(/55\/126/);
  });

  it("Test 7: /reservar sin proyecto → pide proyecto", async () => {
    const parsed = parseAdminCommand("/reservar");
    const result = await executeAdminCommand(parsed, newCtx());
    expect(result.didWrite).toBe(false);
    expect(result.reply).toContain("¿En cuál proyecto?");
    expect(result.reply).toContain("pr3");
    expect(sheetsWriterCalls.length).toBe(0);
  });

  it("Test 8: /reservar pse3 sin unidad → pide unidad", async () => {
    const parsed = parseAdminCommand("/reservar pse3");
    const result = await executeAdminCommand(parsed, newCtx());
    expect(result.didWrite).toBe(false);
    expect(result.reply).toContain("¿Cuál unidad");
    expect(result.reply).toContain("pse3");
  });

  it("Test 9: /reservar foo bar → proyecto inválido", async () => {
    const parsed = parseAdminCommand("/reservar foo bar");
    const result = await executeAdminCommand(parsed, newCtx());
    expect(result.didWrite).toBe(false);
    expect(result.reply).toContain("Proyecto foo no reconocido");
    expect(sheetsWriterCalls.length).toBe(0);
  });

  it("Test 10: /reservar pse3 XXXXX (unidad no existe) → mensaje claro", async () => {
    nextWriterResult = { ok: false, reason: "unit_not_found" };
    const parsed = parseAdminCommand("/reservar pse3 XXXXX");
    const result = await executeAdminCommand(parsed, newCtx());
    expect(result.didWrite).toBe(false);
    expect(result.reply).toContain("No encontré XXXXX");
    expect(result.reply).toContain("pse3");
  });

  it("Test 11: /liberar pse3 15-102 sin precio → pide precio", async () => {
    const parsed = parseAdminCommand("/liberar pse3 15-102");
    const result = await executeAdminCommand(parsed, newCtx());
    expect(result.didWrite).toBe(false);
    expect(result.reply).toContain("precio");
    expect(sheetsWriterCalls.length).toBe(0);
  });

  it("Test 12: Sheets sin env vars → mensaje claro al supervisor", async () => {
    nextWriterResult = { ok: false, reason: "missing_env_vars" };
    const parsed = parseAdminCommand("/reservar pse3 15-102");
    const result = await executeAdminCommand(parsed, newCtx());
    expect(result.didWrite).toBe(false);
    expect(result.reply).toContain("Sheets no está configurado");
  });

  it("formatSummary: maneja proyecto sin datos (totals vacíos)", () => {
    const summary = formatSummary({}, "pr3");
    expect(summary).toContain("No tengo conteos");
  });

  it("resolveProjectTab: mapea todos los keys válidos", () => {
    expect(resolveProjectTab("pr3")).toEqual({ key: "pr3", tab: "PR3" });
    expect(resolveProjectTab("CRUX_T6")).toEqual({ key: "crux_t6", tab: "CRUX_TORRE6" });
    expect(resolveProjectTab("crux_listos")).toEqual({ key: "crux_listos", tab: "CRUX_LISTOS" });
    expect(resolveProjectTab("foo")).toBe(null);
    expect(resolveProjectTab(null)).toBe(null);
  });
});
