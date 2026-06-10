// Scraper ICDV — núcleo puro src/services/icdv-parser.js.
//
// Tests contra fixtures REALES del boletín de la ONE (abril 2026):
//   - tests/fixtures/icdv/icdv-abril-2026.pdfparse.txt  (salida de pdf-parse)
//   - tests/fixtures/icdv/listing.html                  (listado publicaciones)
//   - tests/fixtures/icdv/landing-abril-2026.html       (landing del boletín)
//
// El parser es la pieza frágil (depende del formato del PDF), por eso se
// blinda con el texto real, no con mocks inventados.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const P = require("../src/services/icdv-parser.js");

const FX = "tests/fixtures/icdv";
const pdfText = readFileSync(`${FX}/icdv-abril-2026.pdfparse.txt`, "utf8");
const listingHtml = readFileSync(`${FX}/listing.html`, "utf8");
const landingHtml = readFileSync(`${FX}/landing-abril-2026.html`, "utf8");

describe("ICDV parser — parseBulletinText (fixture real abril 2026)", () => {
  const r = P.parseBulletinText(pdfText);

  it("extrae el índice general y el periodo correctos", () => {
    expect(r.mes).toBe("abril");
    expect(r.anio).toBe(2026);
    expect(r.month_index).toBe(4);
    expect(r.periodo).toBe("2026-04");
    expect(r.indice).toBe(240.16);
    expect(r.indice_anterior).toBe(238.57);
  });

  it("calcula delta en puntos y variación mensual desde los índices", () => {
    expect(r.delta_puntos).toBe(1.59);
    expect(r.var_mensual_pct).toBe(0.67);
    expect(r.tendencia).toBe("alza");
  });

  it("parsea variaciones acumulada (año corrido) e interanual (12 meses)", () => {
    expect(r.var_anio_corrido_pct).toBe(1.69);
    expect(r.var_12m_pct).toBe(1.65);
  });

  it("parsea los 4 sub-índices por tipología de vivienda", () => {
    expect(r.sub_indices).toEqual({
      unifamiliar_1n: 247.57,
      unifamiliar_2n: 242.4,
      multifamiliar_4n: 235.31,
      multifamiliar_8n: 235.37,
    });
  });

  it("parsea las variaciones por grupo de costos (best-effort)", () => {
    expect(r.grupos).toEqual({
      herramientas: 9.94,
      materiales: 1.37,
      subcontratos: 0.72,
      mano_obra: 0,
      maquinarias: -0.16,
    });
  });

  it("marca metadatos de fuente y base", () => {
    expect(r.fuente).toBe("ONE");
    expect(r.indicador).toBe("ICDV");
    expect(r.base).toMatch(/octubre 2009/i);
  });

  it("lanza si falta la frase ancla del índice (no sirve datos a medias)", () => {
    expect(() => P.parseBulletinText("texto sin el boletín")).toThrow(/frase ancla/i);
  });
});

describe("ICDV parser — parseNum (regresión del punto de cierre de oración)", () => {
  it("ignora el punto final pegado: '238.57.' -> 238.57", () => {
    // Bug encontrado en build: el grupo ([\\d.]+) captura el '.' de fin de
    // oración ('238.57. Desde'), y Number('238.57.') es NaN. parseNum debe
    // extraer solo el token numérico válido.
    expect(P.parseNum("238.57.")).toBe(238.57);
    expect(P.parseNum("240.16")).toBe(240.16);
    expect(P.parseNum("-0.16")).toBe(-0.16);
    expect(P.parseNum("0.00")).toBe(0);
    expect(P.parseNum("sin numero")).toBe(null);
    expect(P.parseNum(null)).toBe(null);
  });

  it("acepta decimales sin dígito inicial: '.5' (Hotfix-31)", () => {
    expect(P.parseNum(".5")).toBe(0.5);
    expect(P.parseNum("-.16")).toBe(-0.16);
  });
});

describe("ICDV parser — discoverLatestFromListing / listIcdvPublications", () => {
  it("descubre el boletín más reciente del listado real (abril 2026)", () => {
    const latest = P.discoverLatestFromListing(listingHtml);
    expect(latest).not.toBeNull();
    expect(latest.periodo).toBe("2026-04");
    expect(latest.mes).toBe("abril");
    expect(latest.anio).toBe(2026);
    expect(latest.landing_url).toBe(
      "https://www.one.gob.do/publicaciones/2026/indice-de-costos-directos-de-la-construccion-de-viviendas-icdv-abril-2026/"
    );
  });

  it("ordena múltiples publicaciones de la más reciente a la más vieja", () => {
    const html = `
      <a href="/publicaciones/2026/indice-de-costos-directos-de-la-construccion-de-viviendas-icdv-enero-2026/">x</a>
      <a href="/publicaciones/2026/indice-de-costos-directos-de-la-construccion-de-viviendas-icdv-marzo-2026/">x</a>
      <a href="/publicaciones/2025/indice-de-costos-directos-de-la-construccion-de-viviendas-icdv-diciembre-2025/">x</a>
    `;
    const list = P.listIcdvPublications(html);
    expect(list.map((e) => e.periodo)).toEqual(["2026-03", "2026-01", "2025-12"]);
  });

  it("devuelve null si no hay ninguna publicación ICDV", () => {
    expect(P.discoverLatestFromListing("<html>nada</html>")).toBeNull();
    expect(P.listIcdvPublications("")).toEqual([]);
  });
});

describe("ICDV parser — extractPdfUrl (slug aleatorio no derivable)", () => {
  it("extrae la URL absoluta del PDF de la landing real", () => {
    expect(P.extractPdfUrl(landingHtml)).toBe(
      "https://www.one.gob.do/media/pffd0cf1/icdv-abril-2026.pdf"
    );
  });

  it("resuelve paths relativos /media/... contra el origin", () => {
    const html = '<a href="/media/zzz999/boletin-icdv-mayo-2026.pdf" download>bajar</a>';
    expect(P.extractPdfUrl(html)).toBe(
      "https://www.one.gob.do/media/zzz999/boletin-icdv-mayo-2026.pdf"
    );
  });

  it("devuelve null si la landing no tiene PDF", () => {
    expect(P.extractPdfUrl("<html>sin pdf</html>")).toBeNull();
  });

  it("tolera espacios alrededor del = en el href (Hotfix-31)", () => {
    const html = '<a href = "/media/abc123/icdv-junio-2026.pdf" download>bajar</a>';
    expect(P.extractPdfUrl(html)).toBe(
      "https://www.one.gob.do/media/abc123/icdv-junio-2026.pdf"
    );
  });
});

describe("ICDV parser — buildLandingUrl (patrón de slug ESTABLE)", () => {
  it("deriva la URL desde número de mes o nombre", () => {
    const expected =
      "https://www.one.gob.do/publicaciones/2026/indice-de-costos-directos-de-la-construccion-de-viviendas-icdv-abril-2026/";
    expect(P.buildLandingUrl(4, 2026)).toBe(expected);
    expect(P.buildLandingUrl("abril", 2026)).toBe(expected);
    expect(P.buildLandingUrl("Abril", 2026)).toBe(expected);
  });

  it("devuelve null ante mes inválido", () => {
    expect(P.buildLandingUrl("nomes", 2026)).toBeNull();
  });
});

describe("ICDV parser — mergeIntoSeries (acumulación de la serie)", () => {
  it("hace upsert por periodo y ordena descendente sin mutar el input", () => {
    const a = { periodo: "2026-01", indice: 237.42 };
    const b = { periodo: "2026-02", indice: 237.81 };
    const base = [a];
    const s1 = P.mergeIntoSeries(base, b);
    expect(s1.map((e) => e.periodo)).toEqual(["2026-02", "2026-01"]);
    expect(base).toEqual([a]); // no mutado

    // re-scrape del mismo periodo reemplaza (rectificación de la ONE)
    const s2 = P.mergeIntoSeries(s1, { periodo: "2026-02", indice: 999 });
    expect(s2.length).toBe(2);
    expect(s2.find((e) => e.periodo === "2026-02").indice).toBe(999);
  });

  it("tolera entrada vacía / serie no-array", () => {
    expect(P.mergeIntoSeries(null, null)).toEqual([]);
    expect(P.mergeIntoSeries(undefined, { periodo: "2026-01" })).toEqual([
      { periodo: "2026-01" },
    ]);
  });

  it("ignora entradas con periodo malformado (Hotfix-31)", () => {
    const base = [{ periodo: "2026-01", indice: 237.42 }];
    // "202-4" rompería el orden cronológico (sort por string) y
    // contaminaría el store canónico de Redis.
    expect(P.mergeIntoSeries(base, { periodo: "202-4", indice: 1 })).toEqual(base);
    expect(P.mergeIntoSeries(base, { periodo: "abril 2026", indice: 1 })).toEqual(base);
    // Formato válido sigue mergeando normal.
    const ok = P.mergeIntoSeries(base, { periodo: "2026-02", indice: 237.81 });
    expect(ok.length).toBe(2);
  });
});
