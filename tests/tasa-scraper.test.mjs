// Sprint 1 PR-1 — tasa USD/DOP (BCRD): capa de red con deps inyectables.
// Molde icdv-scraper.test.mjs: cero red real, fetch inyectado.

import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import { buildXlsxFixture, rowXml, HEADER_ROWS } from "./helpers/mini-xlsx.mjs";

const require = createRequire(import.meta.url);
const scraper = require("../src/services/tasa-scraper.js");
const parser = require("../src/services/tasa-parser.js");

const JUN = 10;

function fixtureJunio() {
  return buildXlsxFixture(
    HEADER_ROWS +
      rowXml(4, 2026, JUN, 9, 58.4112, 58.9825) +
      rowXml(5, 2026, JUN, 10, 58.5264, 59.3263)
  );
}

describe("TASA — scraper (deps inyectables)", () => {
  it("scrapeLatest: fetch inyectado -> { latest, serie, xlsxUrl }", async () => {
    const urls = [];
    const out = await scraper.scrapeLatest({
      fetchXlsxBuffer: async (url) => {
        urls.push(url);
        return fixtureJunio();
      },
    });
    expect(urls).toEqual([parser.BCRD_XLSX_URL]); // default = CDN estable del BCRD
    expect(out.latest.fecha).toBe("2026-06-10");
    expect(out.latest.venta).toBe(59.3263);
    expect(out.serie).toHaveLength(2);
    expect(out.xlsxUrl).toBe(parser.BCRD_XLSX_URL);
  });

  it("scrapeLatest respeta url y dias inyectados", async () => {
    const out = await scraper.scrapeLatest({
      fetchXlsxBuffer: async () => fixtureJunio(),
      url: "https://example.test/tasa.xlsx",
      dias: 1,
    });
    expect(out.xlsxUrl).toBe("https://example.test/tasa.xlsx");
    expect(out.serie).toHaveLength(1);
    expect(out.serie[0].fecha).toBe("2026-06-10");
  });

  it("fail-closed: si el CDN devuelve HTML (mantenimiento/error), el parse lanza", async () => {
    await expect(
      scraper.scrapeLatest({
        fetchXlsxBuffer: async () => Buffer.from("<html>mantenimiento</html>"),
      })
    ).rejects.toThrow(/PK/i);
  });

  it("fail-closed: XLSX sin filas válidas no produce doc vacío", async () => {
    await expect(
      scraper.scrapeLatest({
        fetchXlsxBuffer: async () => buildXlsxFixture(HEADER_ROWS),
      })
    ).rejects.toThrow(/ninguna fila/i);
  });

  it("expone fetchXlsxBuffer real con UA propio y tope de bytes", () => {
    expect(typeof scraper.fetchXlsxBuffer).toBe("function");
    expect(scraper.DEFAULT_UA).toMatch(/jprez-bot/);
    expect(scraper.MAX_XLSX_BYTES).toBe(10 * 1024 * 1024);
  });
});
