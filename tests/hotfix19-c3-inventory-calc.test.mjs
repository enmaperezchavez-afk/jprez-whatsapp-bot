// Hotfix-19 Commit 3 — Bug #4 (inventario actualizado) + Bug #6 (calc flexible).

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

const { SUPERVISOR_PROMPT } = require("../src/prompts");

const INVENTORY_PATH = ".claude/skills/vendedor-whatsapp-jprez/references/inventario-precios.md";
const INVENTORY = readFileSync(INVENTORY_PATH, "utf-8");
const HANDLER_SRC = readFileSync("src/handlers/message.js", "utf-8");

// Aislar dependencias del handler que tocan Redis/IO. El test solo invoca
// calcularPlanPago (puro, sin I/O), pero el require de handlers/message.js
// dispara init de adminTesting + profile/storage etc. Mockeamos lo minimo.
{
  // Stub de log (sin Axiom).
  const id = require.resolve("../src/log");
  require.cache[id] = {
    id, filename: id, loaded: true,
    exports: { botLog: () => {}, logToAxiom: async () => {} },
  };
}
const { calcularPlanPago } = require("../src/handlers/message");

describe("Hotfix-19 Commit 3 — Bug #4 inventario", () => {
  it("Test 1: cifras actualizadas (PR3 6/60, PSE3 55/126, Crux 42/50, PSE4 19/80)", () => {
    expect(INVENTORY).toContain("Total disponibles: 6 de 60");
    expect(INVENTORY).toContain("Total disponibles E3: 55 de 126");
    expect(INVENTORY).toContain("Total disponibles: 42 de 50");
    // PSE4 ya estaba 19/80 — verificacion de que no rompimos
    expect(INVENTORY).toMatch(/19[\s\S]{0,20}80/);
  });

  it("Test 2: SUPERVISOR_PROMPT mini-fichas SIN conteos hardcoded (Sprint0-delta)", () => {
    // Sprint0-delta: los conteos se des-hardcodearon — drifteaban del Sheet
    // (6/60 vs 13 listadas, 42/50 vs 43). El supervisor usa /inventario.
    expect(SUPERVISOR_PROMPT).toContain("PR3 - Churchill: Equipado, desde US$156K, entrega agosto 2026");
    expect(SUPERVISOR_PROMPT).toContain("Puerto Plata E3: Desde US$73K, entrega marzo 2029");
    expect(SUPERVISOR_PROMPT).toContain("Puerto Plata E4: Desde US$163K, entrega diciembre 2027");
    expect(SUPERVISOR_PROMPT).toContain("usa /inventario");
    // Ningún conteo N/M en las fichas de proyectos.
    const fichas = SUPERVISOR_PROMPT.slice(SUPERVISOR_PROMPT.indexOf("PROYECTOS ACTIVOS"));
    expect(fichas).not.toMatch(/\d+\/\d+ (disponibles|quedan)/);
  });

  it("Test 3: cifras viejas removidas (no quedan rastros del prompt anterior)", () => {
    expect(INVENTORY).not.toContain("Total disponibles: 13 de 60");
    expect(INVENTORY).not.toContain("Total disponibles E3: 63 de 126");
    expect(INVENTORY).not.toContain("Total disponibles: 43 de 50");
    expect(SUPERVISOR_PROMPT).not.toContain("US$156K, 13/60");
    expect(SUPERVISOR_PROMPT).not.toContain("US$73K, 63/126");
  });
});

describe("Hotfix-19 Commit 3 — Bug #6 calc flexible", () => {
  it("Test 4: porcentajes custom validos (70/0/30) se usan en lugar del plan estandar", () => {
    // Cliente quiere 70% inicial. Suma 70+0+30 = 100. Dado que la calculadora
    // sumariza por porcentajes, validamos los valores absolutos.
    const out = calcularPlanPago("pr3", 200000, undefined, 70, 0, 30);
    expect(out.error).toBeUndefined();
    expect(out.separacion_usd).toBe(140000);  // 70% de 200K
    expect(out.contra_entrega_usd).toBe(60000); // 30% de 200K
    expect(out.separacion_pct).toBe(70);
    expect(out.contra_entrega_pct).toBe(30);
  });

  it("Test 5: porcentajes custom suma != 100 → error claro", () => {
    const out = calcularPlanPago("pr3", 200000, undefined, 50, 30, 30); // suma 110
    expect(out.error).toBeDefined();
    expect(out.error).toContain("100");
    expect(out.error).toContain("110");
  });

  it("Test 6: porcentajes negativos → error", () => {
    const out = calcularPlanPago("pr3", 200000, undefined, -10, 50, 60);
    expect(out.error).toBeDefined();
    expect(out.error.toLowerCase()).toContain("negativ");
  });

  it("Test 7: sin porcentajes custom → fallback al plan estandar (no rompimos contrato previo)", () => {
    // PR3 estandar: 10/30/60 sobre 200K = 20K / 60K / 120K
    const out = calcularPlanPago("pr3", 200000);
    expect(out.error).toBeUndefined();
    expect(out.separacion_usd).toBe(20000);
    expect(out.completivo_total_usd).toBe(60000);
    expect(out.contra_entrega_usd).toBe(120000);
  });

  it("Test 8: handler TOOLS schema declara los 3 parametros opcionales", () => {
    // Object literal en JS — keys sin comillas
    expect(HANDLER_SRC).toMatch(/inicial_pct:\s*{/);
    expect(HANDLER_SRC).toMatch(/completivo_pct:\s*{/);
    expect(HANDLER_SRC).toMatch(/entrega_pct:\s*{/);
    // Los nuevos NO estan en required (son opcionales)
    expect(HANDLER_SRC).toMatch(/required:\s*\["proyecto",\s*"precio_usd"\]/);
  });
});
