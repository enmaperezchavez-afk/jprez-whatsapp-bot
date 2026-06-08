// src/services/icdv-scraper.js — Scraper ICDV (ONE), capa de RED + PDF.
//
// Orquesta las 3 etapas puras de icdv-parser.js contra la web real:
//   listado HTML -> landing HTML -> PDF (slug random) -> texto -> objeto.
//
// Toda la lógica frágil de parseo vive en icdv-parser.js (puro, testeable
// con fixtures). Este módulo es deliberadamente FINO: solo I/O. Las
// dependencias de red (fetch) y de extracción de PDF (pdf-parse) se
// INYECTAN para que los tests corran sin tocar la red ni el binario de
// PDF. En producción usan los defaults reales.
//
// Por qué pdf-parse y no pdftotext: poppler/pdftotext NO existe en el
// runtime serverless de Vercel. pdf-parse es JS puro y da texto UTF-8
// limpio (acentos correctos, sin mojibake) — verificado contra el
// boletín real de abril 2026.

const parser = require("./icdv-parser");

const DEFAULT_UA =
  "Mozilla/5.0 (compatible; jprez-bot/1.0; +https://constructorajprez.com) icdv-scraper";
const FETCH_TIMEOUT_MS = 20000;

// fetchText: GET de una página HTML. Lanza si el status no es 2xx.
async function fetchText(url, { ua = DEFAULT_UA, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const res = await fetchWithTimeout(url, { ua, timeoutMs });
  if (!res.ok) {
    throw new Error(`ICDV fetch ${res.status} en ${url}`);
  }
  return res.text();
}

// fetchPdfBuffer: GET binario del PDF -> Buffer.
async function fetchPdfBuffer(url, { ua = DEFAULT_UA, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const res = await fetchWithTimeout(url, { ua, timeoutMs });
  if (!res.ok) {
    throw new Error(`ICDV fetch PDF ${res.status} en ${url}`);
  }
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

async function fetchWithTimeout(url, { ua, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: { "User-Agent": ua, Accept: "text/html,application/pdf,*/*" },
      signal: controller.signal,
      redirect: "follow",
    });
  } finally {
    clearTimeout(timer);
  }
}

// pdfBufferToText: extrae texto de un Buffer de PDF con pdf-parse.
// require() perezoso para no cargar la lib salvo que de verdad se scrape
// (los tests inyectan su propio pdfToText y no pagan el import).
async function pdfBufferToText(buffer) {
  const pdf = require("pdf-parse");
  const data = await pdf(buffer);
  return data.text;
}

// scrapeFromLanding: dado el HTML de una landing ya descargada, completa
// el resto (extraer URL del PDF -> descargar -> texto -> parsear). Se
// separa para poder testear el tramo PDF sin volver a tocar el listado.
async function scrapeFromLanding(landingHtml, deps = {}) {
  const _fetchPdf = deps.fetchPdfBuffer || fetchPdfBuffer;
  const _pdfToText = deps.pdfToText || pdfBufferToText;

  const pdfUrl = parser.extractPdfUrl(landingHtml);
  if (!pdfUrl) {
    throw new Error("ICDV scrape: no se encontró el link al PDF en la landing");
  }
  const buffer = await _fetchPdf(pdfUrl);
  const text = await _pdfToText(buffer);
  const entry = parser.parseBulletinText(text);
  return { entry, pdfUrl };
}

// scrapeLatest: pipeline completo "¿cuál es el último boletín?".
//   1. GET listado -> descubrir el más reciente.
//   2. GET su landing -> extraer URL del PDF (slug random).
//   3. GET PDF -> texto -> objeto estructurado.
// deps inyectables: fetchText, fetchPdfBuffer, pdfToText. Devuelve
//   { entry, pdfUrl, discovered }.
async function scrapeLatest(deps = {}) {
  const _fetchText = deps.fetchText || fetchText;

  const listingUrl =
    deps.listingUrl ||
    `${parser.ONE_ORIGIN}/publicaciones/?categoria=indice-de-costos-directos-de-la-construccion-de-viviendas`;
  const listingHtml = await _fetchText(listingUrl);
  const discovered = parser.discoverLatestFromListing(listingHtml);
  if (!discovered) {
    throw new Error("ICDV scrape: no se halló ningún boletín ICDV en el listado");
  }

  const landingHtml = await _fetchText(discovered.landing_url);
  const { entry, pdfUrl } = await scrapeFromLanding(landingHtml, deps);
  return { entry, pdfUrl, discovered };
}

// scrapeMonth: scrape dirigido a un mes/año específico. Usa la URL de
// landing DERIVABLE (patrón estable) sin pasar por el listado — útil
// para backfill de la serie histórica. deps inyectables igual.
async function scrapeMonth(mes, anio, deps = {}) {
  const _fetchText = deps.fetchText || fetchText;

  const landingUrl = parser.buildLandingUrl(mes, anio);
  if (!landingUrl) {
    throw new Error(`ICDV scrape: mes/año inválidos (${mes}, ${anio})`);
  }
  const landingHtml = await _fetchText(landingUrl);
  const { entry, pdfUrl } = await scrapeFromLanding(landingHtml, deps);
  return { entry, pdfUrl, landingUrl };
}

module.exports = {
  scrapeLatest,
  scrapeMonth,
  scrapeFromLanding,
  // I/O expuesto para test / reuso
  fetchText,
  fetchPdfBuffer,
  pdfBufferToText,
  DEFAULT_UA,
};
