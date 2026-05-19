// src/inventory/loader.js — Bloque 1 Fase 2.
//
// Orquestador del pipeline de inventario:
//   1. Redis cache (key inventory:current, TTL 5 min) — primera fuente.
//   2. Google Sheets API — si cache miss o force refresh.
//   3. Fallback hardcoded — si Sheets falla (env vars ausentes, network,
//      auth error). Lee el archivo inventario-precios.md actual como
//      red de seguridad para que el bot NUNCA quede sin inventario.
//
// Loguea inventory_load_source con el origen efectivo para que Director
// pueda monitorear en Axiom si el fallback está siendo usado.

const fs = require("fs");
const path = require("path");
const { botLog } = require("../log");
const { fetchAllTabs, rowsToObjects, TAB_NAMES } = require("./sheets-client");
const { parseInventory } = require("./parser");
const { formatInventoryMarkdown } = require("./markdown-formatter");

const CACHE_KEY = "inventory:current";
const CACHE_TTL_SECONDS = 5 * 60; // 5 min target

const FALLBACK_PATH = path.join(
  __dirname,
  "..",
  "..",
  ".claude",
  "skills",
  "vendedor-whatsapp-jprez",
  "references",
  "inventario-precios.md",
);

let cachedFallback = null;
function readFallbackInventory() {
  if (cachedFallback !== null) return cachedFallback;
  try {
    cachedFallback = fs.readFileSync(FALLBACK_PATH, "utf8");
  } catch (e) {
    botLog("error", "inventory_fallback_read_failed", { error: e.message });
    cachedFallback = "";
  }
  return cachedFallback;
}

function computeTotals(inventory) {
  const totals = {};
  for (const [key, units] of Object.entries(inventory.proyectos)) {
    const disp = units.filter((u) => u.estado === "disponible").length;
    const meta = (inventory.meta || []).find((m) => m.proyecto_id === key);
    const total = meta && meta.total_unidades != null ? meta.total_unidades : units.length;
    totals[key] = { disponibles: disp, total };
  }
  return totals;
}

// fetchFromSheets: 1 batch read → parse → format. Loguea skipped units.
async function fetchFromSheets() {
  const rawTabs = await fetchAllTabs();
  if (!rawTabs) return null;

  const tabObjects = {};
  for (const tab of TAB_NAMES) {
    tabObjects[tab] = rowsToObjects(rawTabs[tab] || []);
  }

  const inventory = parseInventory(tabObjects);

  if (inventory.skipped && inventory.skipped.length > 0) {
    for (const s of inventory.skipped) {
      botLog("warn", "inventory_unit_skipped_missing_price", s);
    }
  }

  const markdown = formatInventoryMarkdown(inventory);
  const totals = computeTotals(inventory);

  return {
    markdown,
    totals,
    skipped_count: inventory.skipped.length,
    source: "sheet",
    updated_at: new Date().toISOString(),
  };
}

// loadInventory: pipeline completo. forceRefresh=true salta la cache.
async function loadInventory({ redis, forceRefresh = false } = {}) {
  if (!forceRefresh && redis) {
    try {
      const cached = await redis.get(CACHE_KEY);
      if (cached) {
        const obj = typeof cached === "string" ? JSON.parse(cached) : cached;
        botLog("info", "inventory_load_source", { source: "cache" });
        return { ...obj, source: "cache" };
      }
    } catch (e) {
      botLog("warn", "inventory_cache_read_failed", { error: e.message });
    }
  }

  try {
    const fresh = await fetchFromSheets();
    if (fresh) {
      if (redis) {
        try {
          await redis.set(CACHE_KEY, JSON.stringify(fresh), { ex: CACHE_TTL_SECONDS });
        } catch (e) {
          botLog("warn", "inventory_cache_write_failed", { error: e.message });
        }
      }
      botLog("info", "inventory_load_source", {
        source: "sheet",
        skipped_count: fresh.skipped_count,
      });
      return fresh;
    }
  } catch (e) {
    botLog("error", "inventory_sheets_fetch_failed", { error: e.message });
  }

  // Fallback final: archivo hardcoded.
  const fallbackMd = readFallbackInventory();
  botLog("warn", "inventory_load_source", { source: "fallback", reason: "sheets_unavailable" });
  return {
    markdown: fallbackMd,
    totals: {},
    skipped_count: 0,
    source: "fallback",
    updated_at: null,
  };
}

module.exports = {
  loadInventory,
  fetchFromSheets,
  readFallbackInventory,
  computeTotals,
  CACHE_KEY,
  CACHE_TTL_SECONDS,
};
