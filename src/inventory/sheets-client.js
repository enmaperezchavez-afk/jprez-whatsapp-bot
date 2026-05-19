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

// rowsToObjects: dado [headers, ...rows], retorna [{col1: val1, ...}, ...]
// Headers que falten o estén vacíos se ignoran. Filas completamente
// vacías se omiten.
function rowsToObjects(tabRows) {
  if (!tabRows || tabRows.length < 2) return [];
  const headers = tabRows[0].map((h) => String(h || "").trim());
  const objects = [];
  for (let r = 1; r < tabRows.length; r++) {
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
};
