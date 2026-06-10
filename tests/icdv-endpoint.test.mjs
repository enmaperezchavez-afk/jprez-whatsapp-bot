// Scraper ICDV — endpoint api/icdv.js + tool src/tools/icdv.js + disciplina.
//
// Mismo molde que hotfix22-c3-market-endpoint.test.mjs: el endpoint y el
// schema de la tool quedan listos como drop-in, NO conectados a Mateo.
// El cron de scraping persiste en Redis; el GET sirve la serie.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

describe("ICDV — api/icdv.js endpoint", () => {
  it("exporta handler async + helpers + keys de cache/store", () => {
    expect(existsSync("api/icdv.js")).toBe(true);
    const mod = require("../api/icdv.js");
    expect(typeof mod).toBe("function");
    expect(mod.constructor.name).toBe("AsyncFunction");
    expect(typeof mod.buildMockResponse).toBe("function");
    expect(typeof mod.loadSerie).toBe("function");
    expect(typeof mod.runScrapeAndStore).toBe("function");
    expect(typeof mod.readSeedFromDisk).toBe("function");
    expect(mod.CACHE_KEY).toBe("icdv:series:cache");
    expect(mod.STORE_KEY).toBe("icdv:series:store");
    expect(mod.CACHE_TTL_SECONDS).toBe(24 * 60 * 60);
  });

  it("buildMockResponse tiene shape degradado (serie vacía + warning)", () => {
    const { buildMockResponse } = require("../api/icdv.js");
    const mock = buildMockResponse();
    expect(mock.source).toBe("mock");
    expect(mock.latest).toBeNull();
    expect(Array.isArray(mock.serie)).toBe(true);
    expect(mock.serie.length).toBe(0);
    expect(mock.warning).toMatch(/scraper/i);
  });

  it("readSeedFromDisk lee el seed committeado con la serie real", () => {
    const { readSeedFromDisk } = require("../api/icdv.js");
    const seed = readSeedFromDisk();
    expect(seed).not.toBeNull();
    expect(seed.indicador).toBe("ICDV");
    expect(Array.isArray(seed.serie)).toBe(true);
    expect(seed.serie.length).toBeGreaterThanOrEqual(4);
    // el más reciente primero
    expect(seed.serie[0].periodo).toBe(seed.latest.periodo);
    expect(seed.serie[0].indice).toBe(seed.latest.indice);
  });

  it("loadSerie sin Redis cae al seed de disco", async () => {
    const { loadSerie } = require("../api/icdv.js");
    const data = await loadSerie(null);
    expect(data.indicador).toBe("ICDV");
    expect(data.serie.length).toBeGreaterThanOrEqual(4);
  });

  it("toSerie normaliza doc {serie} y array crudo", () => {
    const { toSerie } = require("../api/icdv.js");
    expect(toSerie({ serie: [{ periodo: "2026-04" }] })).toHaveLength(1);
    expect(toSerie([{ periodo: "2026-04" }])).toHaveLength(1);
    expect(toSerie(null)).toEqual([]);
  });

  it("runScrapeAndStore mergea el scrape sobre el histórico (scrape inyectado, sin redis)", async () => {
    const { runScrapeAndStore } = require("../api/icdv.js");
    const fakeScrape = async () => ({
      entry: {
        periodo: "2026-05",
        indice: 241.0,
        var_12m_pct: 1.7,
        mes: "mayo",
        anio: 2026,
      },
      pdfUrl: "https://www.one.gob.do/media/xxxx/icdv-mayo-2026.pdf",
      discovered: { periodo: "2026-05" },
    });
    const summary = await runScrapeAndStore(null, fakeScrape);
    expect(summary.ok).toBe(true);
    expect(summary.scraped).toBe("2026-05");
    expect(summary.nuevoMes).toBe(true);
    expect(summary.totalMeses).toBeGreaterThanOrEqual(5); // seed (4) + mayo
  });
});

describe("ICDV — auth y detección de cron", () => {
  const { isAuthorized, default: _d } = {};
  it("isAuthorized: sin CRON_SECRET rechaza (fail-closed Hotfix-31); con secret exige Bearer", () => {
    const mod = require("../api/icdv.js");
    const prev = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    // Hotfix-31: antes era fail-open (true). Sin secret = trigger cerrado.
    expect(mod.isAuthorized({ headers: {}, query: {} })).toBe(false);

    process.env.CRON_SECRET = "s3cr3t";
    expect(mod.isAuthorized({ headers: {}, query: {} })).toBe(false);
    expect(
      mod.isAuthorized({ headers: { authorization: "Bearer s3cr3t" }, query: {} })
    ).toBe(true);
    expect(
      mod.isAuthorized({ headers: {}, query: { secret: "s3cr3t" } })
    ).toBe(true);

    if (prev === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prev;
  });
});

describe("ICDV — src/tools/icdv.js schema (drop-in para Fase 2)", () => {
  it("TOOL_CONSULTAR_ICDV expone schema Anthropic válido + handler async", () => {
    const mod = require("../src/tools/icdv.js");
    const tool = mod.TOOL_CONSULTAR_ICDV;
    expect(tool).toBeDefined();
    expect(tool.name).toBe("consultar_icdv");
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(50);
    expect(tool.input_schema.type).toBe("object");
    expect(tool.input_schema.properties.detalle.enum).toEqual(["resumen", "serie"]);
    expect(typeof mod.consultarICDV).toBe("function");
    expect(mod.consultarICDV.constructor.name).toBe("AsyncFunction");
  });

  it("consultarICDV('resumen') devuelve el último mes con sus variaciones", async () => {
    const { consultarICDV } = require("../src/tools/icdv.js");
    const out = await consultarICDV({ detalle: "resumen" });
    expect(out.ok).toBe(true);
    expect(out.latest).toBeTruthy();
    expect(out.latest.indice).toBeGreaterThan(0);
    expect(out.latest).toHaveProperty("var_12m_pct");
    expect(out.latest).toHaveProperty("sub_indices");
    expect(out.serie).toBeUndefined(); // resumen no incluye serie
  });

  it("consultarICDV('serie', meses) incluye histórico acotado", async () => {
    const { consultarICDV } = require("../src/tools/icdv.js");
    const out = await consultarICDV({ detalle: "serie", meses: 3 });
    expect(out.ok).toBe(true);
    expect(Array.isArray(out.serie)).toBe(true);
    expect(out.serie.length).toBeLessThanOrEqual(3);
    expect(out.serie[0]).toHaveProperty("periodo");
  });
});

describe("ICDV — disciplina: tool NO conectada a Mateo todavía (Fase 2)", () => {
  it("consultar_icdv no está en TOOLS[] de src/handlers/message.js", () => {
    const messageHandler = readFileSync("src/handlers/message.js", "utf8");
    expect(messageHandler).not.toContain("consultar_icdv");
    expect(messageHandler).not.toContain("tools/icdv");
  });
});
