// ============================================
// MARKET DATA — tasas hipotecarias bancos RD
// Hotfix-22 c3 (skeleton, NO conectado al bot)
// ============================================
//
// Endpoint read-only que devuelve tasas hipotecarias actualizadas de los
// bancos RD para que en Fase 2 la tool `consultar_tasas_bancarias` (ver
// src/tools/market.js) pueda alimentar a Mateo con datos frescos sin
// hardcodear porcentajes en el skill mercado-inmobiliario-rd.
//
// ESTADO ACTUAL (Hotfix-22 c3): skeleton + fallback mock.
//   - Si data/market-rates.json existe (post-merge de hotfix/22c o un
//     futuro cron de scraping), retorna su contenido parseado.
//   - Si no existe, retorna mock con bancos vacios + warning. Esto
//     permite testear la integracion del endpoint sin bloquear el merge
//     mientras el scraper real se implementa.
//
// CACHE:
//   - Redis 24h, key: market:rates:cache
//   - Si Redis no esta disponible, sirve directamente sin cache.
//   - El TTL de 24h es deliberado: las tasas oficiales de los bancos
//     no cambian intra-dia. Si el Director necesita refresh forzado,
//     puede borrar la key con redis-cli.
//
// TODOs (Fase 2):
//   - Cron Vercel diario (00:30 UTC) que scrape PDFs oficiales de:
//     APAP, Banco Popular, BHD, Scotiabank, BanReservas, Banco Caribe,
//     Asociacion Cibao. Resultado escrito a data/market-rates.json
//     via PR automatico (o KV si lo movemos a runtime).
//   - Validacion de schema antes de servir (zod) para que un scrape
//     malo no contamine al cliente.
//   - Endpoint POST /api/market-data/refresh con auth admin para
//     forzar invalidacion del cache.
//
// IMPORTANTE: este endpoint NO se conecta a Mateo todavia. La tool
// schema en src/tools/market.js esta lista como drop-in, pero no se
// agrega a TOOLS[] en src/handlers/message.js hasta Fase 2.

const fs = require("fs");
const path = require("path");
const { getRedis } = require("../src/store/redis");

const CACHE_KEY = "market:rates:cache";
const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24h
const DATA_FILE = path.join(__dirname, "..", "data", "market-rates.json");

// Mock fallback: estructura mismo shape que el JSON real, con bancos
// vacios y un warning explicito para que cualquier consumidor sepa que
// los datos no son reales todavia.
function buildMockResponse() {
  return {
    updated_at: null,
    source: "mock",
    warning: "data/market-rates.json no existe. Endpoint devolviendo mock. Scraper pendiente (Fase 2).",
    bancos: [],
  };
}

// readMarketDataFromDisk: intenta leer y parsear el JSON. Si falla por
// cualquier razon (no existe, JSON invalido, permisos), devuelve null
// para que el handler caiga al mock — NO lanza, asi un dato corrupto
// no tumba el endpoint.
function readMarketDataFromDisk() {
  try {
    if (!fs.existsSync(DATA_FILE)) return null;
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("[market-data] error leyendo data/market-rates.json:", e.message);
    return null;
  }
}

// loadMarketData: pipeline completo cache -> disco -> mock.
//   1. Si Redis disponible y tiene la key, sirve cache.
//   2. Si no, lee del disco; si existe, escribe cache (best-effort) y sirve.
//   3. Si tampoco hay disco, devuelve mock (sin cachear — no queremos
//      cachear el mock para que apenas exista el JSON real lo recoja).
async function loadMarketData(redis) {
  if (redis) {
    try {
      const cached = await redis.get(CACHE_KEY);
      if (cached) {
        // Upstash devuelve string serializado o el objeto ya parseado
        // segun version del SDK. Normalizamos a objeto.
        return typeof cached === "string" ? JSON.parse(cached) : cached;
      }
    } catch (e) {
      console.error("[market-data] error leyendo cache Redis:", e.message);
    }
  }

  const fromDisk = readMarketDataFromDisk();
  if (fromDisk) {
    if (redis) {
      try {
        await redis.set(CACHE_KEY, JSON.stringify(fromDisk), { ex: CACHE_TTL_SECONDS });
      } catch (e) {
        console.error("[market-data] error escribiendo cache Redis:", e.message);
      }
    }
    return fromDisk;
  }

  return buildMockResponse();
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const redis = await getRedis();
    const data = await loadMarketData(redis);

    res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
    return res.status(200).json(data);
  } catch (e) {
    console.error("[market-data] error:", e.message);
    return res.status(500).json({ error: "Internal server error", message: e.message });
  }
};

// Exports adicionales para testing (skeleton). En Fase 2 cuando se
// agregue el cron de scraping, estos helpers se pueden mover a
// src/services/market.js.
module.exports.buildMockResponse = buildMockResponse;
module.exports.readMarketDataFromDisk = readMarketDataFromDisk;
module.exports.loadMarketData = loadMarketData;
module.exports.CACHE_KEY = CACHE_KEY;
module.exports.CACHE_TTL_SECONDS = CACHE_TTL_SECONDS;
