// api/price-list.js — Bloque 2 Componente 1b.
//
// Endpoint PÚBLICO que genera EN VIVO un PDF con el listado de precios de un
// proyecto, leyendo la data fresca del inventario (Sheet via loader). No
// almacena nada: WhatsApp Cloud API descarga esta URL como documento y
// nosotros devolvemos los bytes generados al momento. Cero storage, cero TTL.
//
// Es público a propósito (igual que /api/pdf y /api/img): WhatsApp hace el
// GET sin header Authorization. Solo expone material comercial (precios de
// venta). Validamos el enum de proyecto para evitar inputs arbitrarios.
//
//   GET /api/price-list?proyecto=pse3  → application/pdf
//
// Códigos: 400 proyecto inválido/ausente · 503 inventario no disponible
// (Sheets caído + fallback sin estructura) · 500 error inesperado.

const { getRedis } = require("../src/store/redis");
const { generatePriceListPdf, VALID_PROJECTS, PROJECT_META } = require("../src/documents/price-list-generator");
const { botLog } = require("../src/log");

module.exports = async function handler(req, res) {
  if ((req.method || "GET") !== "GET") {
    res.setHeader("Cache-Control", "no-store");
    return res.status(405).send("Method Not Allowed");
  }

  const proyecto = String(req.query?.proyecto || "").trim();
  if (!proyecto || !VALID_PROJECTS.includes(proyecto)) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(400).json({
      error: "proyecto inválido o ausente",
      valid: VALID_PROJECTS,
    });
  }

  try {
    const redis = await getRedis();
    const forceRefresh = req.query?.refresh === "1";
    const pdf = await generatePriceListPdf(proyecto, { redis, forceRefresh });

    const fechaSlug = new Date().toISOString().slice(0, 10);
    const filename = "JPREZ-" + proyecto + "-precios-" + fechaSlug + ".pdf";

    botLog("info", "price_list_generated", {
      proyecto,
      bytes: pdf.length,
      forceRefresh,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="' + filename + '"');
    // Cache corta: la frescura real la controla el loader (cache Redis 5 min).
    res.setHeader("Cache-Control", "public, max-age=60");
    return res.status(200).send(pdf);
  } catch (e) {
    if (e.code === "invalid_project") {
      res.setHeader("Cache-Control", "no-store");
      return res.status(400).json({ error: "proyecto inválido", valid: VALID_PROJECTS });
    }
    if (e.code === "inventory_unavailable") {
      botLog("warn", "price_list_inventory_unavailable", { proyecto });
      res.setHeader("Cache-Control", "no-store");
      return res.status(503).json({
        error: "Inventario no disponible temporalmente",
        proyecto,
      });
    }
    botLog("error", "price_list_endpoint_error", {
      proyecto,
      error: e.message,
      stack: (e.stack || "").slice(0, 500),
    });
    res.setHeader("Cache-Control", "no-store");
    return res.status(500).json({ error: "Internal server error" });
  }
};

module.exports.VALID_PROJECTS = VALID_PROJECTS;
module.exports.PROJECT_META = PROJECT_META;
