// api/inventory.js — Bloque 1 Fase 2.
//
// Endpoint público (con auth Bearer) que sirve el inventario actual
// formateado en markdown. Pipeline lazy: Redis cache (TTL 5 min) →
// Google Sheets API → fallback hardcoded (.claude/.../inventario-precios.md).
//
// EN FASE 2: el bot NO usa este endpoint todavía. src/prompts.js sigue
// leyendo el archivo hardcoded directamente. Esta fase es solo
// infraestructura — endpoint + parser + formatter + tests + Sheet
// template. Fase 4 conecta el bot al loader.
//
// AUTH: reusa HEALTH_DASHBOARD_TOKEN existente (Director ya lo tiene
// configurado en Vercel para /api/health). Sin nueva env var de auth.
//
// ENDPOINTS:
//   GET  /api/inventory             — sirve cache o fetch lazy
//   POST /api/inventory?refresh=1   — force refresh, invalida cache
//
// RESPUESTA:
//   {
//     markdown: "...",                  // texto que se inyecta al prompt
//     source: "cache"|"sheet"|"fallback",
//     updated_at: "2026-05-19T...",
//     totals: { pr3: { disponibles: 6, total: 60 }, ... },
//     skipped_count: 0
//   }

const { getRedis } = require("../src/store/redis");
const { loadInventory, CACHE_KEY } = require("../src/inventory/loader");
const { botLog } = require("../src/log");

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.headers["x-real-ip"] || (req.socket && req.socket.remoteAddress) || "unknown";
}

function tokenSuffix(token) {
  if (!token || typeof token !== "string") return null;
  return token.length <= 4 ? "***" : "..." + token.slice(-4);
}

module.exports = async function handler(req, res) {
  const clientIp = getClientIp(req);
  const userAgent = String(req.headers["user-agent"] || "unknown").slice(0, 200);

  // Auth: reusa HEALTH_DASHBOARD_TOKEN current o PREV (rotation soportada).
  const expectedToken = process.env.HEALTH_DASHBOARD_TOKEN;
  const expectedTokenPrev = process.env.HEALTH_DASHBOARD_TOKEN_PREV;
  if (!expectedToken) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({
      error: "HEALTH_DASHBOARD_TOKEN no configurado",
      hint: "Setear en Vercel Project Settings > Environment Variables",
    });
  }

  const authHeader = req.headers.authorization || "";
  const providedToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  let tokenSource = null;
  if (providedToken && providedToken === expectedToken) {
    tokenSource = "current";
  } else if (providedToken && expectedTokenPrev && providedToken === expectedTokenPrev) {
    tokenSource = "prev";
  }
  if (!tokenSource) {
    botLog("warn", "inventory_access_denied", {
      ip: clientIp,
      userAgent,
      reason: providedToken ? "invalid_token" : "no_token",
    });
    res.setHeader("Cache-Control", "no-store");
    return res.status(401).json({ error: "Unauthorized" });
  }

  const method = req.method || "GET";
  const forceRefresh = method === "POST" || req.query?.refresh === "1";

  try {
    const redis = await getRedis();
    const inventory = await loadInventory({ redis, forceRefresh });

    botLog("info", "inventory_access", {
      ip: clientIp,
      userAgent,
      tokenSuffix: tokenSuffix(providedToken),
      tokenSource,
      source: inventory.source,
      forceRefresh,
    });

    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=30");
    return res.status(200).json(inventory);
  } catch (e) {
    botLog("error", "inventory_endpoint_error", { error: e.message, stack: e.stack?.slice(0, 500) });
    return res.status(500).json({ error: "Internal server error", message: e.message });
  }
};

module.exports.CACHE_KEY = CACHE_KEY;
