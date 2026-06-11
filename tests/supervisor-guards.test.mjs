// Sprint1.8 PR-3 — guards de supervisor: eco de confirmación, guía con
// modo natural, formato de montos, y supervisor prompt sin cifras de
// memoria (el origen REAL del "US$310K" y "US$163K" del bug del 11 jun).

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const natural = require("../src/inventory/natural-admin.js");
const { executeAdminCommand } = require("../src/inventory/admin-commands.js");

describe("GUARDS — eco de confirmación", () => {
  it("detecta las confirmaciones del executor reenviadas", () => {
    expect(natural.esEcoConfirmacion("✅ PSE4 15-102 marcada como reservada.")).toBe(true);
    expect(natural.esEcoConfirmacion("✅ CRUX_TORRE6 8C liberada en US$176,500.")).toBe(true);
    expect(natural.esEcoConfirmacion("✅ Precio de PR4 11A actualizado a US$95,000.")).toBe(true);
  });

  it("NO flaggea mensajes normales ni órdenes", () => {
    expect(natural.esEcoConfirmacion("reserva el 15-102 de pse4")).toBe(false);
    expect(natural.esEcoConfirmacion("✅ perfecto, gracias")).toBe(false);
    expect(natural.esEcoConfirmacion("el cliente confirmó la reserva")).toBe(false);
  });

  it("la respuesta del guard niega el cambio explícitamente", () => {
    expect(natural.ECO_CONFIRMACION_REPLY).toMatch(/NO ejecuté ningún cambio/);
  });

  it("message.js corre el guard ANTES del pending y del parser", () => {
    const handler = readFileSync("src/handlers/message.js", "utf8");
    const idxEco = handler.indexOf("esEcoConfirmacion");
    const idxPending = handler.indexOf("getPendingWrite");
    expect(idxEco).toBeGreaterThan(0);
    expect(idxEco).toBeLessThan(idxPending);
  });
});

describe("GUARDS — 'reservar' suelto guía sintaxis Y modo natural", () => {
  it("missing_project del executor ofrece ambos modos", async () => {
    const out = await executeAdminCommand(
      { command: "reservar", error: "missing_project" },
      { supervisorPhone: "x" }
    );
    expect(out.reply).toMatch(/¿En cuál proyecto\?/);
    expect(out.reply).toMatch(/pr3, pr4/);
    expect(out.reply).toMatch(/natural.*reserva el 15-102 de puerto plata/i);
    expect(out.didWrite).toBe(false);
  });

  it("'reservar' suelto en natural -> missing_project (la guía aplica)", () => {
    const p = natural.parseNaturalAdminIntent("reservar");
    expect(p.command).toBe("reservar");
    expect(p.error).toBe("missing_project");
  });
});

describe("GUARDS — formato de montos en confirmaciones del executor", () => {
  function ctxConWriterMock() {
    return {
      supervisorPhone: "x",
      sheetsWriter: {
        updateUnitStatus: async () => ({ ok: true, range: "X!A1", oldValue: "disponible" }),
        updateUnitPrice: async () => ({ ok: true, range: "X!B1", oldValue: "98000" }),
      },
      inventoryLoader: {},
    };
  }

  it("/precio confirma con US$95,000 (no 95000)", async () => {
    const out = await executeAdminCommand(
      { command: "precio", project: "pse4", unit: "15-102", price: 95000 },
      ctxConWriterMock()
    );
    expect(out.reply).toContain("US$95,000");
    expect(out.reply).not.toMatch(/\b95000\b/);
  });

  it("/liberar en CRUX_LISTOS confirma en RD$", async () => {
    const out = await executeAdminCommand(
      { command: "liberar", project: "crux_listos", unit: "2B", price: 5650000 },
      ctxConWriterMock()
    );
    expect(out.reply).toContain("RD$5,650,000");
  });
});

describe("GUARDS — SUPERVISOR_PROMPT sin cifras de memoria (origen del bug 11 jun)", () => {
  it("las mini-fichas y la lista de proyectos ya NO tienen precios hardcodeados", () => {
    const prompts = readFileSync("src/prompts.js", "utf8");
    // El SUPERVISOR_PROMPT tenía: US$99K, US$140K, US$310K, US$163K, US$73K,
    // US$156K, RD$5.65M — TODOS fantasma/drifteables. Muertos:
    // Mini-fichas: del marcador "mini-ficha" hasta "Si envia un solo".
    const idxFicha = prompts.indexOf("mini-ficha de cada proyecto");
    const fichas = prompts.slice(idxFicha, prompts.indexOf("Si envia un solo proyecto"));
    // La única mención de US$..K permitida es la PROHIBICIÓN misma.
    const kMentions = fichas.match(/US\$\d+K/g) || [];
    expect(kMentions).toEqual(["US$99K"]); // solo dentro de '"desde US$99K" esta PROHIBIDO'
    expect(fichas).toMatch(/PROHIBIDO/);
    expect(fichas).not.toContain("RD$5.65M");
    // Lista de proyectos: sin cifras.
    const lista = prompts.slice(prompts.indexOf("PROYECTOS ACTIVOS"), prompts.indexOf("REGLAS: Solo texto plano"));
    expect(lista).not.toMatch(/US\$\d/);
    expect(lista).not.toContain("RD$5.65M");
    expect(lista).toMatch(/NO cites conteos NI precios de memoria/);
  });
});
