// ============================================
// BOT WHATSAPP JPREZ - Constructora JPREZ
// Powered by Claude API (Anthropic)
// Deploy en Vercel como serverless function
// Con memoria PERSISTENTE (Upstash Redis)
// Con envio automatico de PDFs por WhatsApp
// Con reconocimiento de personal interno
// Con notificacion automatica de leads calientes
// ============================================

const { botLog } = require("../src/log");
const { sendWhatsAppMessage } = require("../src/whatsapp");
const { STAFF_PHONES } = require("../src/staff");
const { readRawBody, verifyWebhookSignature } = require("../src/security/hmac");
const { getRatelimit } = require("../src/security/ratelimit");
const { checkIdempotency } = require("../src/security/idempotency");
const { processMessage } = require("../src/handlers/message");

// ============================================
// HANDLER PRINCIPAL (Vercel serverless)
// ============================================

async function handler(req, res) {
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
      console.log("Webhook verificado correctamente");
      return res.status(200).send(challenge);
    } else {
      return res.status(403).send("Forbidden");
    }
  }

  if (req.method === "POST") {
    // 1. Leer el body crudo ANTES de cualquier parseo (bodyParser desactivado via config)
    let rawBody;
    try {
      rawBody = await readRawBody(req);
    } catch (e) {
      botLog("error", "No se pudo leer raw body", { error: e.message });
      return res.status(400).json({ error: "Could not read body" });
    }

    // 2. Validar firma HMAC sobre el body crudo exacto
    const signatureHeader = req.headers["x-hub-signature-256"];
    const hmac = verifyWebhookSignature(rawBody, signatureHeader);
    const clientIp = req.headers["x-forwarded-for"] || null;

    if (hmac.status === "valid") {
      botLog("info", "HMAC valido", { ip: clientIp });
    } else if (hmac.status === "missing_secret") {
      botLog("warn", "HMAC no validado (META_APP_SECRET ausente)", { ip: clientIp });
    } else {
      // Fase 2: enforcement activo. Firma invalida o ausente = rechazar con 401.
      // Solo requests firmados correctamente por Meta pueden pasar.
      botLog("warn", "Request rechazado por HMAC invalido", {
        status: hmac.status,
        reason: hmac.reason,
        ip: clientIp,
      });
      return res.status(401).json({ error: "Unauthorized: invalid webhook signature" });
    }

    // 3. Parsear JSON manualmente DESPUES de la verificacion HMAC.
    // Si el body no es JSON valido respondemos 400 antes de procesar.
    let body;
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch (e) {
      botLog("error", "Body no es JSON valido", { error: e.message, preview: rawBody.slice(0, 120) });
      return res.status(400).json({ error: "Invalid JSON body" });
    }

    // 4. Idempotencia (ANTES del rate limit — ver src/security/idempotency.js §ORDEN)
    const messageId = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.id;
    if (messageId) {
      const idem = await checkIdempotency(messageId);
      if (idem.status === "duplicate") {
        const phone = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
        botLog("info", "duplicate_message_ignored", {
          event_type: "duplicate_message_ignored",
          messageId,
          phone: phone || null,
          timestamp: new Date().toISOString(),
        });
        return res.status(200).send("EVENT_RECEIVED");
      }
      // fresh | bypassed → continuar
    }

    // 5. Rate limiting por telefono (staff bypass, fail-open si Redis cae).
    // Solo aplica a eventos con mensaje inbound real; status updates (delivery,
    // read, etc.) no tienen `messages[0].from` y pasan sin contar.
    const inboundPhone = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
    if (inboundPhone && !STAFF_PHONES[inboundPhone]) {
      const ratelimit = await getRatelimit();
      if (!ratelimit) {
        // Fail-open: Redis no disponible. Procesamos igual pero dejamos alarma.
        botLog("warn", "rate_limit_bypassed_redis_unavailable", {
          event_type: "rate_limit_bypassed_redis_unavailable",
          phone: inboundPhone,
          timestamp: new Date().toISOString(),
        });
      } else {
        try {
          const { success, limit, remaining, reset } = await ratelimit.limit(inboundPhone);
          if (!success) {
            const usados = limit - remaining;
            botLog("warn", "rate_limit_exceeded", {
              event_type: "rate_limit_exceeded",
              phone: inboundPhone,
              limit,
              remaining,
              reset,
              usados,
              timestamp: new Date().toISOString(),
            });
            // Mensaje amable al cliente. El envio es OUTBOUND a Meta -> no vuelve
            // a entrar a este handler, asi que no hay loop posible con el limiter.
            try {
              await sendWhatsAppMessage(
                inboundPhone,
                "¡Gracias por tu interés en Constructora JPREZ! 🙌 Estoy procesando tus mensajes con calma para darte la mejor atención. En unos segundos te respondo todo con detalle."
              );
            } catch (sendErr) {
              console.log("[ratelimit] Error enviando mensaje amable:", sendErr.message);
            }
            return res.status(200).send("EVENT_RECEIVED");
          }
        } catch (e) {
          // Error del rate limiter (no del check). Fail-open tambien.
          botLog("warn", "rate_limit_bypassed_error", {
            event_type: "rate_limit_bypassed_error",
            phone: inboundPhone,
            error: e.message,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    await processMessage(body);
    return res.status(200).send("EVENT_RECEIVED");
  }

  return res.status(405).send("Method Not Allowed");
}

// Desactiva el bodyParser de Vercel para que podamos leer el stream crudo y
// calcular HMAC sobre los bytes exactos que firmo Meta.
handler.config = {
  api: {
    bodyParser: false,
  },
};

module.exports = handler;

