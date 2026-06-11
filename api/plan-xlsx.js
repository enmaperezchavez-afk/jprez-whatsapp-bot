// api/plan-xlsx.js — Sprint1 PR-4.
//
// Endpoint que sirve EN VIVO el Excel del plan de pago de una unidad.
// Patrón /api/price-list (Bloque 2): público para que WhatsApp Cloud API
// descargue el documento sin Authorization, cero storage, cero TTL de
// archivos — pero con FIRMA: el plan lleva números parametrizados por
// cliente, así que solo se sirve si la URL viene firmada por el bot
// (src/security/doc-signing.js, HMAC derivado de META_APP_SECRET) y no
// está vencida (exp 7 días). Fail-closed: sin secret o sin firma -> 403.
//
//   GET /api/plan-xlsx?p=<payload base64url>&s=<hmac>  → .xlsx
//
// El payload trae el plan YA CALCULADO (y el reajuste opcional) — este
// endpoint solo presenta, no recalcula: así la lambda no carga el
// handler completo del bot y los números del Excel son EXACTAMENTE los
// que Mateo mostró en el chat al firmar la URL.

const { verifyDocPayload } = require("../src/security/doc-signing");
const { generatePlanXlsx } = require("../src/documents/plan-xlsx-generator");
const { botLog } = require("../src/log");

module.exports = async function handler(req, res) {
  if ((req.method || "GET") !== "GET") {
    res.setHeader("Cache-Control", "no-store");
    return res.status(405).send("Method Not Allowed");
  }

  const { p, s } = req.query || {};
  const v = verifyDocPayload(p, s);
  if (!v.ok) {
    res.setHeader("Cache-Control", "no-store");
    botLog("warn", "plan_xlsx_denied", { reason: v.reason });
    // expired merece mensaje distinguible (el cliente puede pedir uno nuevo)
    const code = v.reason === "expired" ? 410 : 403;
    return res.status(code).json({ error: v.reason === "expired" ? "link vencido — pide el plan de nuevo por WhatsApp" : "forbidden" });
  }

  try {
    const { plan, reajuste, proyectoCalc, etapa } = v.data;
    const xlsx = await generatePlanXlsx({ plan, reajuste, proyectoCalc, etapa });

    const fechaSlug = new Date().toISOString().slice(0, 10);
    const filename = "JPREZ-plan-pago-" + (proyectoCalc || "unidad") + "-" + fechaSlug + ".xlsx";

    botLog("info", "plan_xlsx_generated", {
      proyecto: proyectoCalc,
      con_reajuste: Boolean(reajuste),
      bytes: xlsx.length,
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store"); // documento por-cliente, no cachear
    return res.status(200).send(xlsx);
  } catch (e) {
    console.error("[plan-xlsx] error:", e.message);
    res.setHeader("Cache-Control", "no-store");
    return res.status(500).json({ error: "Internal server error" });
  }
};
