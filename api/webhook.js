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
const { enforceRateLimit } = require("../src/security/ratelimit");
const { checkIdempotency } = require("../src/security/idempotency");
const { processMessage } = require("../src/handlers/message");
const adminTesting = require("../src/admin-testing-mode");

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
    // Hotfix-20 c2: log inbound antes del idempotency check para diagnostico
    // del Bug #9 (3 respuestas en mismo timestamp). Combinado con
    // idempotency_decision permite reconstruir si Meta envio duplicados,
    // si Redis bypaseo, o si el cliente envio mensajes legitimos rapidos.
    if (messageId) {
      const inboundPhone = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
      botLog("info", "inbound_message_received", {
        event_type: "inbound_message_received",
        messageId,
        phone: inboundPhone || null,
        timestamp: new Date().toISOString(),
      });
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

    // 5. Comandos de admin testing mode (/test-on, /test-off, /test-status).
    //    Se interceptan ANTES del rate limit y del processMessage. Solo tienen
    //    efecto si el phone está en STAFF_PHONES — si un cliente normal manda
    //    "/test-on", se ignora y el mensaje cae al pipeline regular (no se
    //    dan pistas del sistema).
    const inboundPhone = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
    const inboundText = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body;
    const testingCommand = parseTestingCommand(inboundText);
    if (testingCommand && inboundPhone && STAFF_PHONES[inboundPhone]) {
      await handleTestingCommand(testingCommand, inboundPhone);
      return res.status(200).send("EVENT_RECEIVED");
    }

    // 6. Rate limiting por telefono (staff bypass — ver src/security/ratelimit.js).
    //    Si el admin esta en modo testing, NO bypasseamos: queremos fidelidad
    //    con la experiencia cliente real (rate limit aplica a todos).
    if (inboundPhone) {
      const isStaff = !!STAFF_PHONES[inboundPhone];
      const inTesting = isStaff ? await adminTesting.isActive(inboundPhone) : false;
      const bypass = isStaff && !inTesting;
      if (!bypass) {
        const rl = await enforceRateLimit(inboundPhone);
        if (rl.status === "exceeded") {
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
      }
    }

    await processMessage(body);
    return res.status(200).send("EVENT_RECEIVED");
  }

  return res.status(405).send("Method Not Allowed");
}

// parseTestingCommand: retorna "on" | "off" | "status" | null. Trim + lowercase
// para tolerar /Test-On, " /test-on ", etc. Solo reconoce comando exacto;
// "/test-on please" no matchea (se considera texto regular de cliente).
function parseTestingCommand(text) {
  if (typeof text !== "string") return null;
  const t = text.trim().toLowerCase();
  if (t === "/test-on") return "on";
  if (t === "/test-off") return "off";
  if (t === "/test-status") return "status";
  return null;
}

// handleTestingCommand: ejecuta el comando + responde al admin. El caller
// ya validó que phone está en STAFF_PHONES. Todos los errores se capturan
// acá para que el webhook siempre termine con 200 (requisito Meta).
async function handleTestingCommand(command, adminPhone) {
  try {
    if (command === "on") {
      const result = await adminTesting.activate(adminPhone);
      let reply;
      if (result.ok) {
        const mins = Math.round(result.ttlSec / 60);
        reply =
          "✅ Modo testing activado por " + mins + " min. Te trataré como " +
          "cliente nuevo sin historial. Manda /test-off para salir.";
      } else if (result.reason === "rate_limit") {
        reply =
          "⚠️ Llegaste al límite de " + result.max + " activaciones por hora. " +
          "Esperá un rato antes de volver a activar /test-on.";
      } else {
        reply =
          "⚠️ No pude activar el modo testing ahora (" + result.reason + "). " +
          "Intentá de nuevo en un momento.";
      }
      await sendWhatsAppMessage(adminPhone, reply);
      return;
    }
    if (command === "off") {
      const result = await adminTesting.deactivate(adminPhone);
      const reply = result.ok
        ? "✅ Modo testing desactivado. Bienvenido de vuelta. Tu historial admin sigue intacto."
        : "⚠️ No pude desactivar el modo testing ahora (" + result.reason + ").";
      await sendWhatsAppMessage(adminPhone, reply);
      return;
    }
    if (command === "status") {
      const status = await adminTesting.getStatus(adminPhone);
      const reply = status.active
        ? "🟢 Modo testing ACTIVO. Quedan " + status.minutesRemaining + " minutos."
        : "⚪ Modo testing INACTIVO. Manda /test-on para activar.";
      await sendWhatsAppMessage(adminPhone, reply);
      return;
    }
  } catch (e) {
    botLog("error", "admin_testing_command_error", {
      admin: adminPhone,
      command,
      error: e.message,
    });
    try {
      await sendWhatsAppMessage(
        adminPhone,
        "⚠️ Error interno procesando el comando. Revisa logs."
      );
    } catch (_) {
      // swallow — webhook debe seguir respondiendo 200.
    }
  }
}

// Desactiva el bodyParser de Vercel para que podamos leer el stream crudo y
// calcular HMAC sobre los bytes exactos que firmo Meta.
handler.config = {
  api: {
    bodyParser: false,
  },
};

module.exports = handler;
// Exports auxiliares para tests (no se consumen en runtime por nadie más).
module.exports.parseTestingCommand = parseTestingCommand;
module.exports.handleTestingCommand = handleTestingCommand;

