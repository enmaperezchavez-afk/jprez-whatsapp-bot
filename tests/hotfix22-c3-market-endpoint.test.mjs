// Hotfix-22 c3 — Endpoint api/market-data.js + tool stub.
//
// Skeleton verde de la Fase 2 (scraping de tasas hipotecarias RD): el
// endpoint y el schema de la tool quedan listos como drop-in, NO
// conectados al bot. Cuando llegue el JSON real (cron de scraping),
// integrar es 3 lineas en src/handlers/message.js.
//
// Cobertura (5 tests):
//   Endpoint:
//     1. api/market-data.js exporta handler async + helpers (mock, loader, cache key).
//     2. Mock fallback tiene shape correcto (bancos vacios, warning, source mock).
//     3. consultarTasasBancarias retorna warning si data/market-rates.json no existe.
//   Tool schema:
//     4. src/tools/market.js exporta schema valido (name, description, input_schema)
//        + stub function + lista de bancos.
//   Disciplina:
//     5. Tool consultar_tasas_bancarias NO esta agregado a TOOLS[] en
//        src/handlers/message.js todavia (se conecta en Fase 2).

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

describe("Hotfix-22 c3 — api/market-data.js endpoint skeleton", () => {
  it("Test 1: api/market-data.js exporta handler async + helpers + cache key/ttl", () => {
    expect(existsSync("api/market-data.js")).toBe(true);
    const mod = require("../api/market-data.js");
    expect(typeof mod).toBe("function"); // module.exports = handler
    expect(mod.constructor.name).toBe("AsyncFunction");
    expect(typeof mod.buildMockResponse).toBe("function");
    expect(typeof mod.loadMarketData).toBe("function");
    expect(typeof mod.readMarketDataFromDisk).toBe("function");
    expect(mod.CACHE_KEY).toBe("market:rates:cache");
    // 24h TTL deliberado: las tasas oficiales no cambian intra-dia.
    expect(mod.CACHE_TTL_SECONDS).toBe(24 * 60 * 60);
  });

  it("Test 2: buildMockResponse tiene shape esperado (bancos vacios, warning, source mock)", () => {
    const { buildMockResponse } = require("../api/market-data.js");
    const mock = buildMockResponse();
    expect(mock).toHaveProperty("updated_at", null);
    expect(mock).toHaveProperty("source", "mock");
    expect(mock).toHaveProperty("warning");
    expect(mock.warning).toMatch(/scraper pendiente|Fase 2/i);
    expect(Array.isArray(mock.bancos)).toBe(true);
    expect(mock.bancos.length).toBe(0);
  });

  it("Test 3: consultarTasasBancarias retorna warning cuando data/market-rates.json no existe", async () => {
    // En el branch Hotfix-22, data/market-rates.json todavia no existe
    // (lo introducira hotfix/22c-tasas-bancos o el cron de scraping de
    // Fase 2). Verificamos que el stub maneja ese caso degradado.
    expect(existsSync("data/market-rates.json")).toBe(false);
    const { consultarTasasBancarias } = require("../src/tools/market.js");
    const out = await consultarTasasBancarias({ banco: "all" });
    expect(out.ok).toBe(false);
    expect(out.warning).toMatch(/Escala.*Enmanuel|scraper pendiente/i);
    expect(Array.isArray(out.bancos)).toBe(true);
    expect(out.bancos.length).toBe(0);
  });
});

describe("Hotfix-22 c3 — src/tools/market.js schema (drop-in para Fase 2)", () => {
  it("Test 4: TOOL_CONSULTAR_TASAS exporta schema Anthropic valido + stub function + enum bancos", () => {
    const mod = require("../src/tools/market.js");
    expect(mod.TOOL_CONSULTAR_TASAS).toBeDefined();
    const tool = mod.TOOL_CONSULTAR_TASAS;
    expect(tool.name).toBe("consultar_tasas_bancarias");
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(50);
    // Input schema valido
    expect(tool.input_schema).toBeDefined();
    expect(tool.input_schema.type).toBe("object");
    expect(tool.input_schema.required).toContain("banco");
    expect(tool.input_schema.properties.banco.enum).toEqual(
      ["all", "apap", "popular", "bhd", "scotiabank", "reservas", "cibao"],
    );
    // Stub function exportado
    expect(typeof mod.consultarTasasBancarias).toBe("function");
    expect(mod.consultarTasasBancarias.constructor.name).toBe("AsyncFunction");
    // Lista de bancos publica para reusar en validaciones de admin
    expect(Array.isArray(mod.BANCOS_VALIDOS)).toBe(true);
    expect(mod.BANCOS_VALIDOS.length).toBe(7);
  });

  it("Test 5: tool consultar_tasas_bancarias NO esta conectada a TOOLS[] todavia (Fase 2)", () => {
    // Disciplina del C3: schema drop-in pero NO agregar al array TOOLS
    // de message.js. El bot solo expone calcular_plan_pago hasta que el
    // scraper este listo y validado.
    const messageHandler = readFileSync("src/handlers/message.js", "utf8");
    expect(messageHandler).not.toContain("consultar_tasas_bancarias");
    expect(messageHandler).not.toContain("require(\"../tools/market\")");
    expect(messageHandler).not.toContain('require("../tools/market")');
  });
});
