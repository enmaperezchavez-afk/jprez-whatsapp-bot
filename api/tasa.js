// ============================================
// TASA — Tasa de cambio USD/DOP de referencia del mercado spot (BCRD)
// Endpoint read + cron de scraping
// ============================================
//
// Patrón espejo de api/icdv.js. Dos modos según método:
//
//   GET  -> sirve la serie: Redis cache 6h -> store del cron -> mock.
//   POST / cron -> corre el scrape en vivo contra el CDN del BCRD y
//           persiste en Redis. Auth con CRON_SECRET, FAIL-CLOSED desde el
//           día 1 (doctrina Hotfix-31: sin secret configurado el trigger
//           queda CERRADO, no abierto).
//
// STORAGE — a diferencia del ICDV, aquí NO hay seed en disco: el XLSX
// del BCRD trae la serie completa desde 1991 en cada descarga, así que
// cada scrape reemplaza el store entero (no hay histórico que acumular
// ni que perder). Redis guarda la serie capada (~90 días) + el latest.

const { getRedis } = require("../src/store/redis");
const { scrapeLatest } = require("../src/services/tasa-scraper");
const { safeEqual } = require("../src/security/safe-compare");

const CACHE_KEY = "tasa:usd:cache";
const STORE_KEY = "tasa:usd:store"; // doc canónico persistido por el cron
// 6h: la tasa es diaria (un dato por día laborable, publicado al cierre).
// El cron diario refresca; la cache solo amortigua lecturas intra-día.
const CACHE_TTL_SECONDS = 6 * 60 * 60;

function buildMockResponse() {
  return {
    indicador: "TASA_USD_DOP",
    updated_at: null,
    source: "mock",
    warning: "Redis vacío y sin datos. El scraper de tasa aún no ha corrido.",
    latest: null,
    serie: [],
  };
}

// buildDoc: documento de respuesta a partir de un resultado de scrape.
function buildDoc({ latest, serie, xlsxUrl }, source) {
  return {
    indicador: "TASA_USD_DOP",
    nombre: "Tasa de cambio del dólar de referencia del mercado spot (USD/DOP)",
    fuente: "BCRD - Banco Central de la República Dominicana",
    fuente_url: xlsxUrl,
    unidad: "DOP por USD",
    updated_at: new Date().toISOString(),
    source,
    latest: latest || null,
    serie: Array.isArray(serie) ? serie : [],
  };
}

// loadDoc: pipeline de lectura cache -> store Redis -> mock. (Sin disco:
// no hay seed committeado, ver nota de STORAGE arriba.)
async function loadDoc(redis) {
  if (redis) {
    try {
      const cached = await redis.get(CACHE_KEY);
      if (cached) {
        return typeof cached === "string" ? JSON.parse(cached) : cached;
      }
    } catch (e) {
      console.error("[tasa] error leyendo cache Redis:", e.message);
    }
    try {
      const stored = await redis.get(STORE_KEY);
      const doc = typeof stored === "string" ? JSON.parse(stored) : stored;
      if (doc && doc.latest) {
        try {
          await redis.set(CACHE_KEY, JSON.stringify(doc), { ex: CACHE_TTL_SECONDS });
        } catch (e) {
          console.error("[tasa] error escribiendo cache:", e.message);
        }
        return doc;
      }
    } catch (e) {
      console.error("[tasa] error leyendo store Redis:", e.message);
    }
  }
  return buildMockResponse();
}

// ---- cron auth (mismo esquema fail-closed que api/icdv.js) ----
function isAuthorized(req) {
  const cronSecret = process.env.CRON_SECRET;
  // FAIL-CLOSED desde el día 1: sin CRON_SECRET el trigger queda cerrado.
  if (!cronSecret) return false;
  const auth = req.headers.authorization || "";
  const vercelCronAuth = req.headers["x-vercel-cron-authorization"] || "";
  const querySecret = (req.query && req.query.secret) || "";
  const bearerFormat = "Bearer " + cronSecret;
  return (
    safeEqual(auth, bearerFormat) ||
    safeEqual(vercelCronAuth, bearerFormat) ||
    safeEqual(vercelCronAuth, cronSecret) ||
    safeEqual(querySecret, cronSecret)
  );
}

// runScrapeAndStore: scrape en vivo -> reemplaza el store -> invalida
// cache. Devuelve el resumen. scrapeImpl inyectable para tests.
async function runScrapeAndStore(redis, scrapeImpl = scrapeLatest) {
  // latest previo (para reportar si llegó un día nuevo)
  let fechaPrevia = null;
  if (redis) {
    try {
      const stored = await redis.get(STORE_KEY);
      const prev = typeof stored === "string" ? JSON.parse(stored) : stored;
      fechaPrevia = (prev && prev.latest && prev.latest.fecha) || null;
    } catch (e) {
      console.error("[tasa] cron: error leyendo store previo:", e.message);
    }
  }

  const resultado = await scrapeImpl();
  const doc = buildDoc(resultado, "cron-scrape");

  if (redis) {
    try {
      await redis.set(STORE_KEY, JSON.stringify(doc));
      await redis.del(CACHE_KEY); // invalida cache para servir lo fresco
    } catch (e) {
      console.error("[tasa] cron: error persistiendo store:", e.message);
    }
  }

  return {
    ok: true,
    fecha: doc.latest.fecha,
    compra: doc.latest.compra,
    venta: doc.latest.venta,
    nuevoDia: doc.latest.fecha !== fechaPrevia,
    totalDias: doc.serie.length,
    updated_at: doc.updated_at,
  };
}

// isCronTrigger: mismo contrato que api/icdv.js — los Cron Jobs de
// Vercel invocan por GET con header x-vercel-cron; ?cron=1 viene de
// vercel.json (self-documenting); POST = trigger manual/admin.
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
      console.error("[tasa] cron scrape error:", e.message);
      // El caller ya pasó la auth del cron: e.message ayuda a operar
      // (mismo contrato que api/icdv.js).
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // GET público: servir el doc.
  try {
    const redis = await getRedis();
    const data = await loadDoc(redis);
    res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
    return res.status(200).json(data);
  } catch (e) {
    // No exponer e.message al público (doctrina Hotfix-31).
    console.error("[tasa] error:", e.message);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// Exports para testing.
module.exports.buildMockResponse = buildMockResponse;
module.exports.buildDoc = buildDoc;
module.exports.loadDoc = loadDoc;
module.exports.runScrapeAndStore = runScrapeAndStore;
module.exports.isAuthorized = isAuthorized;
module.exports.isCronTrigger = isCronTrigger;
module.exports.CACHE_KEY = CACHE_KEY;
module.exports.STORE_KEY = STORE_KEY;
module.exports.CACHE_TTL_SECONDS = CACHE_TTL_SECONDS;
