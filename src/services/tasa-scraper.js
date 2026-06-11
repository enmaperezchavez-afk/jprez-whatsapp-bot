// src/services/tasa-scraper.js — Tasa USD/DOP (BCRD), capa de RED.
//
// Deliberadamente FINO (espejo de icdv-scraper.js): un solo GET al XLSX
// del CDN del BCRD y delega todo el parseo a tasa-parser.js (puro,
// blindado con fixtures). fetch se INYECTA para que los tests corran sin
// red; en producción usa el default real.
//
// A diferencia del ICDV (listado -> landing -> PDF con slug random), la
// URL del XLSX es ESTABLE: el pipeline es una sola etapa.

const parser = require("./tasa-parser");

const DEFAULT_UA =
  "Mozilla/5.0 (compatible; jprez-bot/1.0; +https://constructorajprez.com) tasa-scraper";
const FETCH_TIMEOUT_MS = 20000;
// Tope de descarga: el XLSX real pesa ~350KB. 10MB de margen holgado;
// más que eso es señal de respuesta rota (misma doctrina readBodyCapped
// de Hotfix-31 en los proxies pdf/img).
const MAX_XLSX_BYTES = 10 * 1024 * 1024;

// fetchXlsxBuffer: GET binario del XLSX -> Buffer. Lanza si el status no
// es 2xx o si el body excede el tope. La validación de que el contenido
// sea un zip real (magic PK) la hace el parser — fail-closed ahí.
async function fetchXlsxBuffer(url, { ua = DEFAULT_UA, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": ua,
        Accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      throw new Error(`TASA fetch ${res.status} en ${url}`);
    }
    const arrayBuf = await res.arrayBuffer();
    if (arrayBuf.byteLength > MAX_XLSX_BYTES) {
      throw new Error(
        `TASA fetch: respuesta de ${arrayBuf.byteLength} bytes excede el tope de ${MAX_XLSX_BYTES}`
      );
    }
    return Buffer.from(arrayBuf);
  } finally {
    clearTimeout(timer);
  }
}

// scrapeLatest: pipeline completo. deps inyectables: fetchXlsxBuffer,
// url, dias. Devuelve { latest, serie, total_filas_archivo, xlsxUrl }.
async function scrapeLatest(deps = {}) {
  const _fetch = deps.fetchXlsxBuffer || fetchXlsxBuffer;
  const xlsxUrl = deps.url || parser.BCRD_XLSX_URL;

  const buffer = await _fetch(xlsxUrl);
  const { latest, serie, total_filas_archivo } = parser.parseWorkbook(buffer, {
    dias: deps.dias,
  });
  return { latest, serie, total_filas_archivo, xlsxUrl };
}

module.exports = {
  scrapeLatest,
  // I/O expuesto para test / reuso
  fetchXlsxBuffer,
  DEFAULT_UA,
  MAX_XLSX_BYTES,
};
