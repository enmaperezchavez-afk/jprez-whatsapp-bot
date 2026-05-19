// src/inventory/sheets-client.js — Bloque 1 Fase 2.
//
// Wrapper de Google Sheets API con Service Account auth (read-only).
// Usado por inventory loader para obtener inventario fresco editable
// por Director sin redeploy.
//
// AUTH: Service Account JWT. Director configura 3 env vars en Vercel:
//   - GOOGLE_SHEETS_ID       (id del spreadsheet, del URL)
//   - GOOGLE_SHEETS_CLIENT_EMAIL  (del JSON del Service Account)
//   - GOOGLE_SHEETS_PRIVATE_KEY   (del JSON, con \n literales)
//
// FALLBACK: si alguna env var falta o el JWT falla, el cliente devuelve
// null. El caller debe caer al fallback hardcoded (no romper el bot).

const sheetsApi = require("@googleapis/sheets");

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"];
const TAB_NAMES = ["META", "PR3", "PR4", "PSE3", "PSE4", "CRUX_TORRE6", "CRUX_LISTOS"];

// Lazy singleton: una sola instancia del cliente por container lifecycle.
let cachedSheets = null;

function getSheetsClient() {
  if (cachedSheets) return cachedSheets;

  const clientEmail = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
  const privateKeyRaw = process.env.GOOGLE_SHEETS_PRIVATE_KEY;

  if (!clientEmail || !privateKeyRaw) {
    return null;
  }

  // Vercel almacena private keys con \n literales — restauramos newlines reales.
  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");

  const jwtClient = new sheetsApi.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: SCOPES,
  });

  cachedSheets = sheetsApi.sheets({ version: "v4", auth: jwtClient });
  return cachedSheets;
}

// fetchAllTabs: 1 batchGet pulls 7 tabs en una llamada. Retorna
//   { META: [[header...], [row1...], ...], PR3: [...], ... } o null si falla.
async function fetchAllTabs() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  if (!spreadsheetId) return null;

  const sheets = getSheetsClient();
  if (!sheets) return null;

  const ranges = TAB_NAMES.map((tab) => `${tab}!A:Z`);

  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges,
  });

  const result = {};
  const valueRanges = response.data.valueRanges || [];
  for (let i = 0; i < TAB_NAMES.length; i++) {
    const tab = TAB_NAMES[i];
    const vr = valueRanges[i];
    result[tab] = (vr && vr.values) || [];
  }
  return result;
}

// Hotfix-29 Bug 1 P1 (19 may 2026): detección dinámica de fila de headers.
//
// PROBLEMA RAÍZ: el Sheet del Director NO siempre tiene los headers en
// la fila 1. Usa filas previas para títulos, notas, instrucciones, fila
// vacía como separador, etc. Asumir tabRows[0] daba 0 unidades parseadas.
//
// FIX: buscar la primera fila que contenga la celda "unidad_id"
// (case-insensitive, trimmed). En tab META la celda canónica es
// "proyecto_id". Si no se encuentra ninguna, retornamos [] (defensa).
//
// HEADER_SIGNAL_CELLS: celdas que identifican una fila de headers en
// cualquier tab. Si la fila contiene UNA de estas, es la fila de headers.
const HEADER_SIGNAL_CELLS = new Set(["unidad_id", "proyecto_id"]);

function findHeaderRowIndex(tabRows) {
  if (!Array.isArray(tabRows)) return -1;
  for (let r = 0; r < tabRows.length; r++) {
    const row = tabRows[r];
    if (!Array.isArray(row)) continue;
    for (const cell of row) {
      const norm = String(cell || "").trim().toLowerCase();
      if (HEADER_SIGNAL_CELLS.has(norm)) return r;
    }
  }
  return -1;
}

// rowsToObjects: dado [...filas previas opcionales, headers, ...rows],
// detecta la fila de headers dinámicamente (busca "unidad_id" o
// "proyecto_id") y retorna [{col1: val1, ...}, ...].
// Headers que falten o estén vacíos se ignoran. Filas completamente
// vacías se omiten. Si no encuentra fila de headers, retorna [].
function rowsToObjects(tabRows) {
  if (!tabRows || tabRows.length < 2) return [];

  const headerRowIdx = findHeaderRowIndex(tabRows);
  if (headerRowIdx === -1) return [];

  const headers = tabRows[headerRowIdx].map((h) => String(h || "").trim());
  const objects = [];
  for (let r = headerRowIdx + 1; r < tabRows.length; r++) {
    const row = tabRows[r];
    if (!row || row.every((c) => c == null || String(c).trim() === "")) continue;
    const obj = {};
    let hasAnyValue = false;
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c];
      if (!key) continue;
      const value = row[c];
      if (value != null && String(value).trim() !== "") {
        obj[key] = String(value).trim();
        hasAnyValue = true;
      }
    }
    if (hasAnyValue) objects.push(obj);
  }
  return objects;
}

module.exports = {
  TAB_NAMES,
  getSheetsClient,
  fetchAllTabs,
  rowsToObjects,
  findHeaderRowIndex,
};
