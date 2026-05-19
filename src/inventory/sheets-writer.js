// src/inventory/sheets-writer.js — Bloque 1 Fase 3.5a.
//
// Escritura al Google Sheet del inventario. Usado SOLO por comandos
// supervisor (/reservar, /vender, /liberar, /precio). Cliente nunca
// invoca este módulo.
//
// REQUIERE que el Service Account del Sheet tenga permiso EDITOR
// (no Reader como sheets-client.js).
//
// AUTH: mismas 3 env vars que sheets-client.js. Scope distinto
// (spreadsheets, no readonly).
//
// CONTRATO:
//   updateUnitStatus({ tabName, unitId, newStatus, supervisorPhone })
//     → { ok, reason?, range?, oldValue? }
//   updateUnitPrice({ tabName, unitId, newPrice, supervisorPhone })
//     → { ok, reason?, range?, oldValue? }
//
//   Reasons posibles: missing_env_vars | unit_not_found | column_not_found
//
// LOG: cada escritura exitosa emite inventory_update (info) con
// supervisorPhone, tab, unitId, column, oldValue, newValue, range.
// Cada fallo emite inventory_update_failed (warn) con la razón.

const sheetsApi = require("@googleapis/sheets");
const { botLog } = require("../log");

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

let cachedSheets = null;
function getSheetsWriter() {
  if (cachedSheets) return cachedSheets;
  const clientEmail = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
  const privateKeyRaw = process.env.GOOGLE_SHEETS_PRIVATE_KEY;
  if (!clientEmail || !privateKeyRaw) return null;
  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");
  const jwtClient = new sheetsApi.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: SCOPES,
  });
  cachedSheets = sheetsApi.sheets({ version: "v4", auth: jwtClient });
  return cachedSheets;
}

// colIndexToLetter: 0→A, 1→B, ..., 25→Z, 26→AA. Sheets API requiere
// letras de columna en sus rangos (no índices).
function colIndexToLetter(idx) {
  let result = "";
  let n = idx;
  do {
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return result;
}

// findUnitRow: lee headers (fila 1) y columna A del tab, encuentra
// el row con unidad_id === unitId. Retorna { rowNumber (1-indexed),
// headers, rowValues } o null si no se encontró.
async function findUnitRow(sheets, spreadsheetId, tabName, unitId) {
  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: [tabName + "!1:1", tabName + "!A:Z"],
  });
  const headersRow = (response.data.valueRanges[0].values || [[]])[0] || [];
  const allRows = response.data.valueRanges[1].values || [];

  const target = String(unitId).trim();
  // allRows[0] son headers. Buscar desde índice 1.
  for (let i = 1; i < allRows.length; i++) {
    const row = allRows[i] || [];
    const id = String((row[0] || "")).trim();
    if (id === target) {
      return {
        rowNumber: i + 1, // 1-indexed para Sheets
        headers: headersRow.map((h) => String(h || "").trim()),
        rowValues: row,
      };
    }
  }
  return null;
}

async function updateUnitField({ tabName, unitId, columnName, newValue, supervisorPhone }) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  if (!spreadsheetId) {
    botLog("warn", "inventory_update_failed", { reason: "missing_env_vars", tabName, unitId });
    return { ok: false, reason: "missing_env_vars" };
  }
  const sheets = getSheetsWriter();
  if (!sheets) {
    botLog("warn", "inventory_update_failed", { reason: "missing_env_vars", tabName, unitId });
    return { ok: false, reason: "missing_env_vars" };
  }

  const row = await findUnitRow(sheets, spreadsheetId, tabName, unitId);
  if (!row) {
    botLog("warn", "inventory_update_failed", { reason: "unit_not_found", tabName, unitId });
    return { ok: false, reason: "unit_not_found" };
  }

  const colIdx = row.headers.findIndex((h) => h === columnName);
  if (colIdx === -1) {
    botLog("warn", "inventory_update_failed", {
      reason: "column_not_found",
      tabName,
      unitId,
      column: columnName,
      headersFound: row.headers,
    });
    return { ok: false, reason: "column_not_found", column: columnName };
  }

  const oldValue = String(row.rowValues[colIdx] || "");
  const colLetter = colIndexToLetter(colIdx);
  const range = tabName + "!" + colLetter + row.rowNumber;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [[String(newValue)]] },
  });

  botLog("info", "inventory_update", {
    supervisorPhone,
    tab: tabName,
    unitId,
    column: columnName,
    oldValue,
    newValue: String(newValue),
    range,
  });

  return { ok: true, range, oldValue };
}

async function updateUnitStatus({ tabName, unitId, newStatus, supervisorPhone }) {
  return updateUnitField({
    tabName, unitId, supervisorPhone,
    columnName: "estado",
    newValue: newStatus,
  });
}

async function updateUnitPrice({ tabName, unitId, newPrice, supervisorPhone }) {
  // Crux Listos usa precio_dop, los demás precio_usd.
  const columnName = tabName === "CRUX_LISTOS" ? "precio_dop" : "precio_usd";
  return updateUnitField({
    tabName, unitId, supervisorPhone, columnName,
    newValue: newPrice,
  });
}

module.exports = {
  updateUnitStatus,
  updateUnitPrice,
  updateUnitField,
  findUnitRow,
  colIndexToLetter,
  getSheetsWriter,
};
