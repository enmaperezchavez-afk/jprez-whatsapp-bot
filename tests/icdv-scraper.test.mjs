// Scraper ICDV — orquestación src/services/icdv-scraper.js.
//
// Toda la red y el PDF se INYECTAN (deps), así estos tests corren sin
// tocar one.gob.do ni pdf-parse. Validan que el pipeline encadena bien
// las etapas puras y que falla limpio en los casos degradados.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const S = require("../src/services/icdv-scraper.js");

const FX = "tests/fixtures/icdv";
const pdfText = readFileSync(`${FX}/icdv-abril-2026.pdfparse.txt`, "utf8");
const listingHtml = readFileSync(`${FX}/listing.html`, "utf8");
const landingHtml = readFileSync(`${FX}/landing-abril-2026.html`, "utf8");

// deps inyectadas que sirven los fixtures
function fakeDeps(overrides = {}) {
  return {
    fetchText: async (url) =>
      url.includes("categoria=") ? listingHtml : landingHtml,
    fetchPdfBuffer: async () => Buffer.from("fake-pdf-bytes"),
    pdfToText: async () => pdfText,
    ...overrides,
  };
}

describe("ICDV scraper — scrapeLatest (deps inyectadas)", () => {
  it("encadena listado -> landing -> PDF -> objeto estructurado", async () => {
    const r = await S.scrapeLatest(fakeDeps());
    expect(r.discovered.periodo).toBe("2026-04");
    expect(r.pdfUrl).toBe("https://www.one.gob.do/media/pffd0cf1/icdv-abril-2026.pdf");
    expect(r.entry.indice).toBe(240.16);
    expect(r.entry.var_12m_pct).toBe(1.65);
    expect(r.entry.periodo).toBe("2026-04");
  });

  it("lanza si el listado no tiene ningún boletín ICDV", async () => {
    const deps = fakeDeps({ fetchText: async () => "<html>vacío</html>" });
    await expect(S.scrapeLatest(deps)).rejects.toThrow(/no se halló ningún boletín/i);
  });

  it("lanza si la landing no tiene link al PDF", async () => {
    const deps = fakeDeps({
      fetchText: async (url) =>
        url.includes("categoria=") ? listingHtml : "<html>landing sin pdf</html>",
    });
    await expect(S.scrapeLatest(deps)).rejects.toThrow(/no se encontró el link al PDF/i);
  });
});

describe("ICDV scraper — scrapeMonth (URL derivada, para backfill)", () => {
  it("scrapea un mes objetivo vía la landing derivable", async () => {
    const r = await S.scrapeMonth("abril", 2026, fakeDeps());
    expect(r.landingUrl).toContain("icdv-abril-2026");
    expect(r.entry.indice).toBe(240.16);
  });

  it("lanza ante mes/año inválidos", async () => {
    await expect(S.scrapeMonth("nomes", 2026, fakeDeps())).rejects.toThrow(
      /inválidos/i
    );
  });
});

describe("ICDV scraper — superficie de I/O", () => {
  it("expone fetchText, fetchPdfBuffer, pdfBufferToText y un User-Agent", () => {
    expect(typeof S.fetchText).toBe("function");
    expect(typeof S.fetchPdfBuffer).toBe("function");
    expect(typeof S.pdfBufferToText).toBe("function");
    expect(S.DEFAULT_UA).toMatch(/jprez-bot/i);
  });
});
