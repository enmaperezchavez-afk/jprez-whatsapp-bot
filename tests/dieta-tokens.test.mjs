// Dieta de tokens [CORE] — el certificador deja de quemar créditos:
// caching del juez, cliente fantasma en Haiku, costo visible por run,
// disciplina de runs (CI = subset only).

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { crearMedidor, formatoCosto, TARIFAS } from "./qa-simulador/helpers/costo.mjs";

describe("DIETA — medidor de costo", () => {
  it("acumula usage real por actor y lo convierte a USD por tarifa de modelo", () => {
    const m = crearMedidor();
    // mateo en sonnet: 1M input fresco + 1M cache read + 100K out
    m.add("mateo", "claude-sonnet-4-6", {
      input_tokens: 1_000_000, output_tokens: 100_000,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 1_000_000,
    });
    // cliente en haiku: 200K in / 50K out
    m.add("cliente", "claude-haiku-4-5-20251001", { input_tokens: 200_000, output_tokens: 50_000 });
    const r = m.resumen();
    // sonnet: 1M*3 + 0.1M*15 + 1M*0.30 = 3 + 1.5 + 0.30 = 4.80
    expect(r.actores.mateo.usd).toBeCloseTo(4.8, 2);
    // haiku: 0.2*1 + 0.05*5 = 0.45
    expect(r.actores.cliente.usd).toBeCloseTo(0.45, 2);
    expect(r.totalUsd).toBeCloseTo(5.25, 2);
    expect(formatoCosto(r)).toMatch(/COSTO DEL RUN: \$5\.25/);
  });

  it("usage null/ausente no rompe (llamadas fallidas no cuentan)", () => {
    const m = crearMedidor();
    m.add("juez", "claude-sonnet-4-6", null);
    expect(m.resumen().totalUsd).toBe(0);
  });

  it("tarifas: Haiku ≈ 1/3 de Sonnet (la razón del downgrade del cliente)", () => {
    expect(TARIFAS["claude-haiku-4-5-20251001"].input * 3).toBe(TARIFAS["claude-sonnet-4-6"].input);
    expect(TARIFAS["claude-haiku-4-5-20251001"].output * 3).toBe(TARIFAS["claude-sonnet-4-6"].output);
  });
});

describe("DIETA — palancas aplicadas en el simulador", () => {
  it("cliente fantasma corre en Haiku (orden 2)", () => {
    const src = readFileSync("tests/qa-simulador/helpers/cliente-fantasma.mjs", "utf8");
    expect(src).toMatch(/CLIENTE_MODEL = "claude-haiku-4-5-20251001"/);
  });

  it("el system del juez lleva cache_control (orden 1)", () => {
    const src = readFileSync("tests/qa-simulador/helpers/evaluador.mjs", "utf8");
    expect(src).toMatch(/system: \[\{ type: "text", text: system, cache_control: \{ type: "ephemeral" \} \}\]/);
  });

  it("el juez sigue en Sonnet hasta superar el gate de coincidencia ≥90%", () => {
    const src = readFileSync("tests/qa-simulador/helpers/evaluador.mjs", "utf8");
    expect(src).toMatch(/const JUEZ_MODEL = "claude-sonnet-4-6"/);
    // pero el downgrade está a un flag de distancia, validado por comparar-juez
    const runner = readFileSync("tests/qa-simulador/run.mjs", "utf8");
    expect(runner).toMatch(/--juez=\(sonnet\|haiku\)/);
    expect(readFileSync("tests/qa-simulador/comparar-juez.mjs", "utf8")).toMatch(/≥ 90%/);
  });

  it("arnés Mateo y prod ya cachean el system grande (verificación)", () => {
    expect(readFileSync("tests/qa-simulador/helpers/arnes-mateo.mjs", "utf8")).toMatch(/cache_control/);
    expect(readFileSync("src/claude.js", "utf8")).toMatch(/cache_read_input_tokens/);
  });

  it("disciplina de runs (orden 3): el workflow CI corre SOLO el subset", () => {
    const wf = readFileSync(".github/workflows/qa-simulador.yml", "utf8");
    expect(wf).toMatch(/npm run qa:simulador:ci/);
    expect(wf).not.toMatch(/npm run qa:simulador\s*$/m); // jamás la completa
  });

  it("el reporte del run incluye el costo (orden 4)", () => {
    const runner = readFileSync("tests/qa-simulador/run.mjs", "utf8");
    expect(runner).toMatch(/formatoCosto/);
    expect(runner).toMatch(/JSON\.stringify\(\{ resultados, costo \}/);
  });
});
