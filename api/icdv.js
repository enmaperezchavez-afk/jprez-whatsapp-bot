// ============================================
// ICDV — Índice de Costos Directos de la Construcción de Viviendas (ONE)
// Endpoint read + cron de scraping
// ============================================
//
// Patrón espejo de api/market-data.js (servir) + api/followup.js (cron
// auth). Dos modos según método:
//
//   GET  -> sirve la serie ICDV: Redis cache 24h -> disco (seed) -> mock.
//   POST -> (cron / admin) corre el scrape en vivo contra one.gob.do,
//           mergea el último boletín en la serie y persiste en Redis.
//           Auth con CRON_SECRET (mismo esquema que followup).
//
// STORAGE — por qué Redis y no solo el archivo:
//   El filesystem de Vercel es read-only en runtime (salvo /tmp efímero).
//   La serie ICDV CRECE un dato por mes y debe sobrevivir entre
//   invocaciones, así que la fuente canónica viva es Redis (KV Upstash).
//   data/icdv-history.json es el SEED committeado: arranca la serie y
//   sirve de fallback si Redis no está configurado (local/dev). El cron
//   hace union(seed, redis, nuevo-scrape) para no perder histórico.

const fs = require("fs");
const path = require("path");
const { getRedis } = require("../src/store/redis");
const { mergeIntoSeries } = require("../src/services/icdv-parser");
const { scrapeLatest } = require("../src/services/icdv-scraper");

const CACHE_KEY = "icdv:series:cache";
const STORE_KEY = "icdv:series:store"; // serie canónica persistida por el cron
const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24h: el ICDV es mensual, no cambia intra-día
const DATA_FILE = path.join(__dirname, "..", "data", "icdv-history.json");

// ---- lectura del seed en disco ----
function readSeedFromDisk() {
  try {
    if (!fs.existsSync(DATA_FILE)) return null;
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("[icdv] error leyendo seed data/icdv-history.json:", e.message);
    return null;
  }
}

function buildMockResponse() {
  return {
    indicador: "ICDV",
    updated_at: null,
    source: "mock",
    warning:
      "data/icdv-history.json no existe y Redis vacío. Scraper aún no ha corrido.",
    latest: null,
    serie: [],
  };
}

// normaliza un doc {serie,...} -> array de entradas. Tolera tanto el doc
// completo (seed) como un array crudo (lo que guarda el cron en Redis).
function toSerie(docOrArray) {
  if (!docOrArray) return [];
  if (Array.isArray(docOrArray)) return docOrArray;
  return Array.isArray(docOrArray.serie) ? docOrArray.serie : [];
}

// buildDoc: arma el documento de respuesta a partir de una serie.
function buildDoc(serie, source) {
  const seed = readSeedFromDisk();
  return {
    indicador: "ICDV",
    nombre:
      (seed && seed.nombre) ||
      "Índice de Costos Directos de la Construcción de Viviendas",
    fuente: (seed && seed.fuente) || "ONE - Oficina Nacional de Estadística",
    base: (seed && seed.base) || "octubre 2009",
    region: seed && seed.region,
    updated_at: new Date().toISOString(),
    source,
    latest: serie[0] || null,
    serie,
  };
}

// loadSerie: pipeline de lectura cache -> store Redis -> disco -> mock.
async function loadSerie(redis) {
  if (redis) {
    try {
      const cached = await redis.get(CACHE_KEY);
      if (cached) {
        return typeof cached === "string" ? JSON.parse(cached) : cached;
      }
    } catch (e) {
      console.error("[icdv] error leyendo cache Redis:", e.message);
    }
    // store canónico (lo que escribió el cron)
    try {
      const stored = await redis.get(STORE_KEY);
      const serie = toSerie(typeof stored === "string" ? JSON.parse(stored) : stored);
      if (serie.length) {
        const doc = buildDoc(serie, "redis-store");
        try {
          await redis.set(CACHE_KEY, JSON.stringify(doc), { ex: CACHE_TTL_SECONDS });
        } catch (e) {
          console.error("[icdv] error escribiendo cache:", e.message);
        }
        return doc;
      }
    } catch (e) {
      console.error("[icdv] error leyendo store Redis:", e.message);
    }
  }

  const seed = readSeedFromDisk();
  if (seed) return seed;
  return buildMockResponse();
}

// ---- cron auth (mismo esquema que api/followup.js) ----
function isAuthorized(req) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true; // sin secret configurado, acceso libre (dev)
  const auth = req.headers.authorization || "";
  const vercelCronAuth = req.headers["x-vercel-cron-authorization"] || "";
  const querySecret = req.query && req.query.secret;
  const bearerFormat = "Bearer " + cronSecret;
  return (
    auth === bearerFormat ||
    vercelCronAuth === bearerFormat ||
    vercelCronAuth === cronSecret ||
    querySecret === cronSecret
  );
}

// runScrapeAndStore: corre el scrape en vivo, mergea sobre la unión de
// (seed de disco + store de Redis) para no perder histórico, persiste el
// nuevo store y limpia la cache. Devuelve el resumen.
async function runScrapeAndStore(redis, scrapeImpl = scrapeLatest) {
  // base histórica = unión seed ∪ store Redis
  let serie = toSerie(readSeedFromDisk());
  if (redis) {
    try {
      const stored = await redis.get(STORE_KEY);
      const storedSerie = toSerie(
        typeof stored === "string" ? JSON.parse(stored) : stored
      );
      for (const e of storedSerie) serie = mergeIntoSeries(serie, e);
    } catch (e) {
      console.error("[icdv] cron: error leyendo store previo:", e.message);
    }
  }

  const before = serie.length;
  const { entry, pdfUrl, discovered } = await scrapeImpl();
  serie = mergeIntoSeries(serie, entry);
  const doc = buildDoc(serie, "cron-scrape");

  if (redis) {
    try {
      await redis.set(STORE_KEY, JSON.stringify(serie));
      await redis.del(CACHE_KEY); // invalida cache para servir lo fresco
    } catch (e) {
      console.error("[icdv] cron: error persistiendo store:", e.message);
    }
  }

  return {
    ok: true,
    scraped: entry.periodo,
    indice: entry.indice,
    pdfUrl,
    discovered: discovered && discovered.periodo,
    nuevoMes: serie.length > before,
    totalMeses: serie.length,
    updated_at: doc.updated_at,
  };
}

// isCronTrigger: los Cron Jobs de Vercel invocan por GET, no POST. Los
// reconocemos por el header x-vercel-cron (lo pone Vercel) o por ?cron=1
// (lo ponemos nosotros en vercel.json, self-documenting). Un POST también
// dispara el scrape (trigger manual/admin).
function isCronTrigger(req) {
  if (req.method === "POST") return true;
  if (req.headers["x-vercel-cron"]) return true;
  if (req.query && (req.query.cron === "1" || req.query.cron === "true")) return true;
  return false;
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // Cron / admin: dispara el scrape en vivo y persiste.
  if (isCronTrigger(req)) {
    if (!isAuthorized(req)) {
      return res.status(403).json({ error: "forbidden" });
    }
    try {
      const redis = await getRedis();
      const summary = await runScrapeAndStore(redis);
      return res.status(200).json(summary);
    } catch (e) {
      console.error("[icdv] cron scrape error:", e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // GET público: servir la serie.
  try {
    const redis = await getRedis();
    const data = await loadSerie(redis);
    res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
    return res.status(200).json(data);
  } catch (e) {
    console.error("[icdv] error:", e.message);
    return res.status(500).json({ error: "Internal server error", message: e.message });
  }
};

// Exports para testing.
module.exports.buildMockResponse = buildMockResponse;
module.exports.readSeedFromDisk = readSeedFromDisk;
module.exports.loadSerie = loadSerie;
module.exports.runScrapeAndStore = runScrapeAndStore;
module.exports.isAuthorized = isAuthorized;
module.exports.toSerie = toSerie;
module.exports.buildDoc = buildDoc;
module.exports.CACHE_KEY = CACHE_KEY;
module.exports.STORE_KEY = STORE_KEY;
module.exports.CACHE_TTL_SECONDS = CACHE_TTL_SECONDS;
