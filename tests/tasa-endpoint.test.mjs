// Sprint 1 PR-1 — tasa USD/DOP (BCRD): endpoint api/tasa.js.
//
// Molde icdv-endpoint.test.mjs: GET sirve, cron POST scrapea con auth
// CRON_SECRET fail-closed DESDE EL DÍA 1 (no hubo fase fail-open que
// corregir, doctrina Hotfix-31 aplicada de nacimiento).

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

describe("TASA — api/tasa.js endpoint", () => {
  it("exporta handler async + helpers + keys de cache/store", () => {
    expect(existsSync("api/tasa.js")).toBe(true);
    const mod = require("../api/tasa.js");
    expect(typeof mod).toBe("function");
    expect(mod.constructor.name).toBe("AsyncFunction");
    expect(typeof mod.buildMockResponse).toBe("function");
    expect(typeof mod.loadDoc).toBe("function");
    expect(typeof mod.runScrapeAndStore).toBe("function");
    expect(mod.CACHE_KEY).toBe("tasa:usd:cache");
    expect(mod.STORE_KEY).toBe("tasa:usd:store");
    expect(mod.CACHE_TTL_SECONDS).toBe(6 * 60 * 60);
  });

  it("buildMockResponse tiene shape degradado (serie vacía + warning)", () => {
    const { buildMockResponse } = require("../api/tasa.js");
    const mock = buildMockResponse();
    expect(mock.source).toBe("mock");
    expect(mock.latest).toBeNull();
    expect(mock.serie).toEqual([]);
    expect(mock.warning).toMatch(/scraper/i);
  });

  it("loadDoc sin Redis devuelve mock (no hay seed en disco: el XLSX trae todo)", async () => {
    const { loadDoc } = require("../api/tasa.js");
    const data = await loadDoc(null);
    expect(data.source).toBe("mock");
    expect(data.latest).toBeNull();
  });

  it("loadDoc: cache hit gana; store hit re-cachea", async () => {
    const { loadDoc, CACHE_KEY, STORE_KEY } = require("../api/tasa.js");
    const doc = { indicador: "TASA_USD_DOP", latest: { fecha: "2026-06-10" }, serie: [] };

    // cache hit
    let redis = { get: async (k) => (k === CACHE_KEY ? JSON.stringify(doc) : null) };
    expect((await loadDoc(redis)).latest.fecha).toBe("2026-06-10");

    // store hit -> escribe cache
    const setCalls = [];
    redis = {
      get: async (k) => (k === STORE_KEY ? JSON.stringify(doc) : null),
      set: async (...args) => setCalls.push(args),
    };
    expect((await loadDoc(redis)).latest.fecha).toBe("2026-06-10");
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0][0]).toBe(CACHE_KEY);
  });

  it("runScrapeAndStore persiste el doc, invalida cache y reporta nuevoDia", async () => {
    const { runScrapeAndStore, CACHE_KEY, STORE_KEY } = require("../api/tasa.js");
    const fakeScrape = async () => ({
      latest: { fecha: "2026-06-10", compra: 58.5264, venta: 59.3263 },
      serie: [{ fecha: "2026-06-10" }, { fecha: "2026-06-09" }],
      xlsxUrl: "https://cdn.bancentral.gov.do/x.xlsx",
    });

    const ops = [];
    const redis = {
      get: async () =>
        JSON.stringify({ latest: { fecha: "2026-06-09" } }), // store previo
      set: async (k, v) => ops.push(["set", k, v]),
      del: async (k) => ops.push(["del", k]),
    };
    const summary = await runScrapeAndStore(redis, fakeScrape);
    expect(summary.ok).toBe(true);
    expect(summary.fecha).toBe("2026-06-10");
    expect(summary.venta).toBe(59.3263);
    expect(summary.nuevoDia).toBe(true); // 06-10 vs 06-09 previo
    expect(summary.totalDias).toBe(2);
    expect(ops.map((o) => [o[0], o[1]])).toEqual([
      ["set", STORE_KEY],
      ["del", CACHE_KEY],
    ]);
    const persisted = JSON.parse(ops[0][2]);
    expect(persisted.indicador).toBe("TASA_USD_DOP");
    expect(persisted.fuente).toMatch(/Banco Central/);
    expect(persisted.source).toBe("cron-scrape");
  });

  it("runScrapeAndStore: mismo día previo -> nuevoDia false (fin de semana/feriado)", async () => {
    const { runScrapeAndStore } = require("../api/tasa.js");
    const fakeScrape = async () => ({
      latest: { fecha: "2026-06-10", compra: 58.5, venta: 59.3 },
      serie: [{ fecha: "2026-06-10" }],
      xlsxUrl: "x",
    });
    const redis = {
      get: async () => JSON.stringify({ latest: { fecha: "2026-06-10" } }),
      set: async () => {},
      del: async () => {},
    };
    const summary = await runScrapeAndStore(redis, fakeScrape);
    expect(summary.nuevoDia).toBe(false);
  });

  it("runScrapeAndStore sin redis igual devuelve el resumen del scrape", async () => {
    const { runScrapeAndStore } = require("../api/tasa.js");
    const summary = await runScrapeAndStore(null, async () => ({
      latest: { fecha: "2026-06-10", compra: 58.5, venta: 59.3 },
      serie: [{ fecha: "2026-06-10" }],
      xlsxUrl: "x",
    }));
    expect(summary.ok).toBe(true);
    expect(summary.nuevoDia).toBe(true); // sin store previo todo día es nuevo
  });
});

describe("TASA — auth fail-closed desde el día 1 y detección de cron", () => {
  it("isAuthorized: sin CRON_SECRET rechaza; con secret exige Bearer o query", () => {
    const mod = require("../api/tasa.js");
    const prev = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    expect(mod.isAuthorized({ headers: {}, query: {} })).toBe(false);

    process.env.CRON_SECRET = "s3cr3t";
    expect(mod.isAuthorized({ headers: {}, query: {} })).toBe(false);
    expect(
      mod.isAuthorized({ headers: { authorization: "Bearer s3cr3t" }, query: {} })
    ).toBe(true);
    expect(mod.isAuthorized({ headers: {}, query: { secret: "s3cr3t" } })).toBe(true);
    expect(mod.isAuthorized({ headers: {}, query: { secret: "wrong" } })).toBe(false);

    if (prev === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prev;
  });

  it("isCronTrigger: POST, x-vercel-cron o ?cron=1", () => {
    const { isCronTrigger } = require("../api/tasa.js");
    expect(isCronTrigger({ method: "POST", headers: {}, query: {} })).toBe(true);
    expect(
      isCronTrigger({ method: "GET", headers: { "x-vercel-cron": "1" }, query: {} })
    ).toBe(true);
    expect(isCronTrigger({ method: "GET", headers: {}, query: { cron: "1" } })).toBe(true);
    expect(isCronTrigger({ method: "GET", headers: {}, query: {} })).toBe(false);
  });

  it("handler: cron sin auth -> 403 (nunca scrapea)", async () => {
    const handler = require("../api/tasa.js");
    const prev = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;

    let status = null;
    let body = null;
    const res = {
      status: (s) => ({ json: (b) => ((status = s), (body = b)) }),
      setHeader: () => {},
    };
    await handler({ method: "POST", headers: {}, query: {} }, res);
    expect(status).toBe(403);
    expect(body.error).toBe("forbidden");

    if (prev === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prev;
  });

  it("handler: método no soportado -> 405", async () => {
    const handler = require("../api/tasa.js");
    let status = null;
    const res = {
      status: (s) => ({ json: () => (status = s) }),
      setHeader: () => {},
    };
    await handler({ method: "DELETE", headers: {}, query: {} }, res);
    expect(status).toBe(405);
  });
});

describe("TASA — wiring en vercel.json", () => {
  const vercelJson = JSON.parse(readFileSync("vercel.json", "utf8"));

  it("build + route de /api/tasa registrados", () => {
    expect(vercelJson.builds.some((b) => b.src === "api/tasa.js")).toBe(true);
    expect(
      vercelJson.routes.some((r) => r.src === "/api/tasa" && r.dest === "/api/tasa.js")
    ).toBe(true);
  });

  it("cron diario registrado con ?cron=1 (self-documenting)", () => {
    const cron = vercelJson.crons.find((c) => c.path === "/api/tasa?cron=1");
    expect(cron).toBeDefined();
    // diario: la tasa se publica cada día laborable al cierre
    expect(cron.schedule).toBe("0 21 * * *");
  });
});
