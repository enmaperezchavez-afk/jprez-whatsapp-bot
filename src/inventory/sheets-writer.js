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
const { findHeaderRowIndex } = require("./sheets-client");

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

// findUnitRow: encuentra el row con unidad_id === unitId. Retorna
// { rowNumber (1-indexed), headers, rowValues } o null si no se encontró.
//
// Hotfix-31: detección dinámica de headers + columna unidad_id. Hotfix-29
// estableció que el Sheet real tiene títulos/notas en filas previas a los
// headers (por eso el reader sheets-client usa findHeaderRowIndex), pero
// este writer seguía asumiendo headers en fila 1 y unidad_id en columna A
// — con el Sheet real, TODOS los comandos supervisor de escritura fallaban
// con unit_not_found/column_not_found.
async function findUnitRow(sheets, spreadsheetId, tabName, unitId) {
  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: [tabName + "!A:Z"],
  });
  const allRows = response.data.valueRanges[0].values || [];

  const headerRowIdx = findHeaderRowIndex(allRows);
  if (headerRowIdx === -1) return null;
  const headersRow = (allRows[headerRowIdx] || []).map((h) => String(h || "").trim());
  const idColIdx = headersRow.findIndex((h) => h.toLowerCase() === "unidad_id");
  if (idColIdx === -1) return null;

  const target = String(unitId).trim();
  for (let i = headerRowIdx + 1; i < allRows.length; i++) {
    const row = allRows[i] || [];
    const id = String((row[idColIdx] || "")).trim();
    if (id === target) {
      return {
        rowNumber: i + 1, // 1-indexed para Sheets
        headers: headersRow,
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

// readUnitSnapshot (Sprint1.8 PR-2): LECTURA del estado actual de una
// unidad para el preview de confirmación del admin natural ("¿Confirmo?
// {antes} → {después}"). Cero escritura. Mismo pipeline de detección
// dinámica de headers que las escrituras (Hotfix-31 c2).
async function readUnitSnapshot({ tabName, unitId }) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  if (!spreadsheetId) return { ok: false, reason: "missing_env_vars" };
  const sheets = getSheetsWriter();
  if (!sheets) return { ok: false, reason: "missing_env_vars" };

  const row = await findUnitRow(sheets, spreadsheetId, tabName, unitId);
  if (!row) return { ok: false, reason: "unit_not_found" };

  const col = (name) => {
    const idx = row.headers.findIndex((h) => h === name);
    return idx === -1 ? null : String(row.rowValues[idx] || "");
  };
  const precioCol = tabName === "CRUX_LISTOS" ? "precio_dop" : "precio_usd";
  return {
    ok: true,
    estado: col("estado"),
    precio: col(precioCol),
    moneda: tabName === "CRUX_LISTOS" ? "RD$" : "US$",
  };
}

module.exports = {
  updateUnitStatus,
  updateUnitPrice,
  updateUnitField,
  findUnitRow,
  colIndexToLetter,
  getSheetsWriter,
  readUnitSnapshot,
};
