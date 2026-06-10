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

// Hotfix-31: red de seguridad final si tampoco se puede leer el archivo.
// Instruye al bot a escalar en vez de inventar datos o quedar mudo.
const FALLBACK_UNAVAILABLE_MD =
  "# Inventario temporalmente no disponible\n\n" +
  "No tengo el detalle de unidades/precios a mano en este momento. " +
  "Toma los datos del cliente y escala a Enmanuel para confirmar " +
  "disponibilidad y precios exactos. NO inventes precios.";

let cachedFallback = null;
function readFallbackInventory() {
  if (cachedFallback !== null) return cachedFallback;
  try {
    const raw = fs.readFileSync(FALLBACK_PATH, "utf8");
    if (raw && raw.trim()) {
      cachedFallback = raw;
      return cachedFallback;
    }
    botLog("error", "inventory_fallback_read_failed", { error: "archivo vacio" });
  } catch (e) {
    botLog("error", "inventory_fallback_read_failed", { error: e.message });
  }
  // Hotfix-31: NO cachear el fallo — antes se cacheaba "" para siempre y
  // el bot quedaba sin inventario hasta el próximo cold start aunque el
  // problema fuera transitorio. Reintenta en la próxima invocación.
  return FALLBACK_UNAVAILABLE_MD;
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
    // Bloque 2: exponer el inventario estructurado + meta para que el
    // generador de PDF de precios (src/documents/price-list-generator.js)
    // arme tablas por unidad sin re-parsear el markdown. Es JSON-serializable
    // así que viaja intacto por la cache Redis.
    proyectos: inventory.proyectos,
    meta: inventory.meta,
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
