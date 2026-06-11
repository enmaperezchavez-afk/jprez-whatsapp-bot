// Sprint1.8 PR-2 — ADMIN NATURAL: parser determinista + confirmación
// en dos pasos + reversión. Cero LLM en el camino de escritura.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const natural = require("../src/inventory/natural-admin.js");

describe("ADMIN NATURAL — parseNaturalAdminIntent", () => {
  it("'ponle X al {unidad} de {proyecto}' -> precio", () => {
    const p = natural.parseNaturalAdminIntent("ponle 95 mil al 15-102 de puerto plata etapa 4");
    expect(p).toEqual({
      command: "precio",
      natural: true,
      project: "pse4",
      unit: "15-102",
      price: 95000,
    });
  });

  it("'reserva el {unidad} de {proyecto}' -> reservar (sin precio)", () => {
    const p = natural.parseNaturalAdminIntent("resérvame el 11A de prado 4");
    expect(p.command).toBe("reservar");
    expect(p.project).toBe("pr4");
    expect(p.unit).toBe("11A");
    expect(p.price).toBeUndefined();
    expect(p.error).toBeUndefined();
  });

  it("'libera el {unidad} de {proyecto} en {monto}' -> liberar con precio", () => {
    const p = natural.parseNaturalAdminIntent("libera el 8C de crux torre 6 en 176,500");
    expect(p.command).toBe("liberar");
    expect(p.project).toBe("crux_t6");
    expect(p.unit).toBe("8C");
    expect(p.price).toBe(176500);
  });

  it("'márcalo vendido' / 'véndelo' -> vender", () => {
    expect(natural.parseNaturalAdminIntent("marca como vendido el 12D de pr4").command).toBe("vender");
    expect(natural.parseNaturalAdminIntent("véndelo, el 12D de prado 4").command).toBe("vender");
  });

  it("audio: el marker [audio transcrito] se ignora al parsear", () => {
    const p = natural.parseNaturalAdminIntent("[audio transcrito] ponle 95k al 15-102 de pse4");
    expect(p.command).toBe("precio");
    expect(p.price).toBe(95000);
  });

  it("faltantes -> mismos códigos de error que el parser slash", () => {
    expect(natural.parseNaturalAdminIntent("ponle 95 mil al 15-102").error).toBe("missing_project");
    expect(natural.parseNaturalAdminIntent("reserva algo en pse4").error).toBe("missing_unit");
    expect(natural.parseNaturalAdminIntent("cámbiale el precio al 15-102 de pse4").error).toBe("missing_price");
  });

  it("mensajes normales del supervisor NO parsean (cero falsos positivos)", () => {
    expect(natural.parseNaturalAdminIntent("¿cómo va el inventario de pse4?")).toBeNull();
    expect(natural.parseNaturalAdminIntent("dame el resumen del día")).toBeNull();
    expect(natural.parseNaturalAdminIntent("la reserva del cliente Juan va bien")).toBeNull();
    // wait — 'reserva' aparece... el comando exige verbo imperativo
  });

  it("slash commands NO entran por el camino natural (vía clásica intacta)", () => {
    expect(natural.parseNaturalAdminIntent("/reservar pse4 15-102")).toBeNull();
  });
});

describe("ADMIN NATURAL — montos y formato", () => {
  it("parseMonto entiende mil/k/comas", () => {
    expect(natural.parseMonto("95 mil")).toBe(95000);
    expect(natural.parseMonto("95k")).toBe(95000);
    expect(natural.parseMonto("95,000")).toBe(95000);
    expect(natural.parseMonto("176,500")).toBe(176500);
    expect(natural.parseMonto("sin numeros")).toBeNull();
  });

  it("formatMonto: 'US$95,000', no '95000' (PR-3 adelantado en este flujo)", () => {
    expect(natural.formatMonto(95000)).toBe("US$95,000");
    expect(natural.formatMonto(5650000, "RD$")).toBe("RD$5,650,000");
  });
});

describe("ADMIN NATURAL — confirmación en dos pasos", () => {
  const parsed = { command: "precio", project: "pse4", unit: "15-102", price: 95000 };
  const snapshot = { ok: true, estado: "disponible", precio: "98000", moneda: "US$" };

  it("preview con valor anterior -> nuevo", () => {
    const prompt = natural.buildConfirmPrompt(parsed, snapshot);
    expect(prompt).toContain("¿Confirmo? PSE4 15-102");
    expect(prompt).toContain("US$98,000 → US$95,000");
    expect(prompt).toMatch(/responde sí/);
  });

  it("preview de reservar/vender muestra el estado", () => {
    const prompt = natural.buildConfirmPrompt(
      { command: "reservar", project: "pr4", unit: "11A" },
      { estado: "disponible", precio: "315500", moneda: "US$" }
    );
    expect(prompt).toContain("disponible → reservado");
  });

  it("esRespuestaConfirmacion: sí/dale/no/cancela y nada más", () => {
    expect(natural.esRespuestaConfirmacion("sí")).toBe("si");
    expect(natural.esRespuestaConfirmacion("Dale")).toBe("si");
    expect(natural.esRespuestaConfirmacion("confirmo!")).toBe("si");
    expect(natural.esRespuestaConfirmacion("no")).toBe("no");
    expect(natural.esRespuestaConfirmacion("cancela")).toBe("no");
    expect(natural.esRespuestaConfirmacion("mejor ponle 90")).toBeNull();
    expect(natural.esRespuestaConfirmacion("si claro como digas")).toBeNull(); // frase larga NO es confirmación
  });

  it("reversión exacta por comando", () => {
    expect(natural.buildRevertCommand(parsed, snapshot)).toBe("/precio pse4 15-102 98000");
    expect(
      natural.buildRevertCommand({ command: "vender", project: "pr4", unit: "11A" }, { estado: "disponible", precio: "315500" })
    ).toBe("/liberar pr4 11A 315500");
    expect(
      natural.buildRevertCommand({ command: "liberar", project: "pse4", unit: "15-102", price: 95000 }, { estado: "reservado", precio: "98000" })
    ).toBe("/reservar pse4 15-102");
  });

  it("pending write: save/get/clear vía Redis mock con TTL", async () => {
    const store = new Map();
    const redis = {
      set: async (k, v, opts) => { store.set(k, { v, ex: opts?.ex }); },
      get: async (k) => (store.has(k) ? store.get(k).v : null),
      del: async (k) => store.delete(k),
    };
    await natural.savePendingWrite(redis, "18290000000", { parsed, snapshot });
    const saved = store.get(natural.PENDING_PREFIX + "18290000000");
    expect(saved.ex).toBe(300); // TTL 5 min
    const pending = await natural.getPendingWrite(redis, "18290000000");
    expect(pending.parsed.price).toBe(95000);
    await natural.clearPendingWrite(redis, "18290000000");
    expect(await natural.getPendingWrite(redis, "18290000000")).toBeNull();
  });
});

describe("ADMIN NATURAL — seguridad y wiring", () => {
  it("ADMIN_PHONES existe, separada de STAFF_PHONES, hoy solo el Director", () => {
    const { ADMIN_PHONES, STAFF_PHONES } = require("../src/staff.js");
    expect(Array.isArray(ADMIN_PHONES)).toBe(true);
    expect(ADMIN_PHONES).toHaveLength(1);
    expect(STAFF_PHONES[ADMIN_PHONES[0]]).toBeDefined();
  });

  it("message.js: autorización por ADMIN_PHONES + confirmación + mismo executor", () => {
    const handler = readFileSync("src/handlers/message.js", "utf8");
    expect(handler).toMatch(/ADMIN_PHONES\.includes\(senderPhone\)/);
    expect(handler).toMatch(/getPendingWrite/);
    expect(handler).toMatch(/executeAdminCommand\(pending\.parsed/); // MISMO executor
    expect(handler).toMatch(/admin_natural_write/); // audit log Axiom
    expect(handler).toMatch(/Para revertir/);
    // nunca escribir sin sí explícito: otro mensaje cancela el pendiente
    expect(handler).toMatch(/Cancelé la operación pendiente/);
  });

  it("readUnitSnapshot exportado del sheets-writer (lectura para el preview)", () => {
    const writer = require("../src/inventory/sheets-writer.js");
    expect(typeof writer.readUnitSnapshot).toBe("function");
  });
});
