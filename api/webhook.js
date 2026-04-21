// ============================================
// BOT WHATSAPP JPREZ - Constructora JPREZ
// Powered by Claude API (Anthropic)
// Deploy en Vercel como serverless function
// Con memoria PERSISTENTE (Upstash Redis)
// Con envio automatico de PDFs por WhatsApp
// Con reconocimiento de personal interno
// Con notificacion automatica de leads calientes
// ============================================

const { botLog, logToAxiom } = require("../src/log");
const { getRedis } = require("../src/store/redis");
const { getHistory, addMessage } = require("../src/store/history");
const { saveClientMeta, getClientMeta, markDocSent } = require("../src/store/meta");
const { callClaudeWithTools } = require("../src/claude");
const {
  sendWhatsAppMessage,
  sendWhatsAppDocument,
  sendWhatsAppImage,
  transcribeWhatsAppAudio,
} = require("../src/whatsapp");
const { toProxyUrl, toImageProxyUrl } = require("../src/proxy");
const { ENMANUEL_PHONE, notifyEnmanuel, notifyEnmanuelBooking } = require("../src/notify");
const { detectDocumentRequest, detectDocumentType, detectLeadSignals } = require("../src/detect");
const { buildSystemPrompt, SUPERVISOR_PROMPT } = require("../src/prompts");
const { readRawBody, verifyWebhookSignature } = require("../src/security/hmac");
const { getRatelimit } = require("../src/security/ratelimit");
const { checkIdempotency } = require("../src/security/idempotency");

// Wrappers internos que resuelven dependencias (clientMeta, projectName)
// antes de delegar a src/notify.js. Estos se moverán a src/handlers/message.js
// cuando se extraiga store/meta.js y se elimine el problema del ciclo.
async function _notifyWithMeta(senderPhone, userMessage, botReply, signalType) {
  const clientMeta = await getClientMeta(senderPhone);
  return notifyEnmanuel(senderPhone, userMessage, botReply, signalType, clientMeta);
}

async function _notifyBookingWithMeta(senderPhone, booking) {
  const clientMeta = await getClientMeta(senderPhone);
  const projectName = PROJECT_NAMES[booking.project] || booking.project;
  return notifyEnmanuelBooking(senderPhone, booking, clientMeta, projectName);
}

// ============================================
// CONFIGURACION DE PERSONAL INTERNO
// ============================================

const STAFF_PHONES = {
  [ENMANUEL_PHONE]: {
    name: "Enmanuel PÃ©rez ChÃ¡vez",
    role: "director",
    supervisor: true,
  },
};

// Parsea env vars con URLs separadas por coma (IMG_CRUX="url1,url2,url3")
function parseImageUrls(envVar) {
  if (!envVar) return [];
  return envVar.split(",").map((s) => s.trim()).filter(Boolean);
}

// PROJECT_DOCS — env vars con URLs de PDFs/imagenes por proyecto.
// Las URLs de Drive se transforman a traves de src/proxy.js antes
// de enviarse a WhatsApp.
const PROJECT_DOCS = {
  crux: {
    brochure: process.env.PDF_CRUX_BROCHURE || null,
    precios: process.env.PDF_CRUX_PRECIOS || null,
    planos: process.env.PDF_CRUX_PLANOS || null,
    images: parseImageUrls(process.env.IMG_CRUX),
  },
  pr3: {
    brochure: process.env.PDF_PR3_BROCHURE || null,
    precios: process.env.PDF_PR3_PRECIOS || null,
    planos: process.env.PDF_PR3_PLANOS || null,
    images: parseImageUrls(process.env.IMG_PR3),
  },
  pr4: {
    brochure: process.env.PDF_PR4_BROCHURE || null,
    precios: process.env.PDF_PR4_PRECIOS || null,
    planos: process.env.PDF_PR4_PLANOS || null,
    images: parseImageUrls(process.env.IMG_PR4),
  },
  puertoPlata: {
    brochure: process.env.PDF_PP_BROCHURE || null,
    brochureE4: process.env.PDF_PP_BROCHURE_E4 || null,
    precios: process.env.PDF_PP_PRECIOS || null,
    preciosE4: process.env.PDF_PP_PRECIOS_E4 || null,
    planos: process.env.PDF_PP_PLANOS || null,
    images: parseImageUrls(process.env.IMG_PP),
  },
};

const PROJECT_NAMES = {
  crux: "Crux del Prado",
  pr3: "Prado Residences III",
  pr4: "Prado Residences IV",
  puertoPlata: "Prado Suites Puerto Plata",
};

const DOC_TYPE_NAMES = {
  brochure: "Brochure",
  precios: "Listado de Precios",
  planos: "Planos",
};

// ============================================
// CALCULADORA DE PLAN DE PAGO (Tool use)
// ============================================

// Planes de pago por proyecto (porcentajes)
const PAYMENT_PLANS = {
  crux: { separacion: 0.10, completivo: 0.20, entrega: 0.70 }, // Torre 6
  pr3: { separacion: 0.10, completivo: 0.30, entrega: 0.60 },
  pr4: { separacion: 0.10, completivo: 0.30, entrega: 0.60 },
  puertoPlata: { separacion: 0.10, completivo: 0.30, entrega: 0.60 },
};

// Fechas aproximadas de entrega para calcular meses de cuota
const DELIVERY_DATES = {
  crux: "2027-07-01",
  pr3: "2026-08-01",
  pr4: "2027-09-01",
  puertoPlata: "2027-12-01",
};

function calcularPlanPago(proyecto, precioUsd) {
  const plan = PAYMENT_PLANS[proyecto];
  const delivery = DELIVERY_DATES[proyecto];
  if (!plan || !delivery) {
    return { error: "Proyecto no reconocido: " + proyecto };
  }
  const now = new Date();
  const deliveryDate = new Date(delivery);
  const monthsRemaining = Math.max(1, Math.round((deliveryDate - now) / (30 * 86400 * 1000)));
  const separacion = Math.round(precioUsd * plan.separacion);
  const completivoTotal = Math.round(precioUsd * plan.completivo);
  const contraEntrega = Math.round(precioUsd * plan.entrega);
  const cuotaMensual = Math.round(completivoTotal / monthsRemaining);
  return {
    proyecto: PROJECT_NAMES[proyecto] || proyecto,
    precio_total_usd: precioUsd,
    separacion_usd: separacion,
    separacion_pct: Math.round(plan.separacion * 100),
    completivo_total_usd: completivoTotal,
    completivo_pct: Math.round(plan.completivo * 100),
    meses_hasta_entrega: monthsRemaining,
    cuota_mensual_usd: cuotaMensual,
    contra_entrega_usd: contraEntrega,
    contra_entrega_pct: Math.round(plan.entrega * 100),
    nota: "Cuota mensual = completivo total / meses hasta entrega. Contra entrega se cubre con banco o pago directo.",
  };
}

const TOOLS = [
  {
    name: "calcular_plan_pago",
    description:
      "Calcula el plan de pago desglosado de una unidad JPREZ: separacion, cuota mensual durante construccion, y monto contra entrega. " +
      "Usalo SIEMPRE que el cliente pregunte 'cuanto pago al mes', 'cuotas', 'financiamiento', 'inicial', 'mensualidad', o pida numeros concretos de pago. " +
      "Devuelve JSON con los montos exactos para que puedas mostrarlos al cliente.",
    input_schema: {
      type: "object",
      properties: {
        proyecto: {
          type: "string",
          enum: ["crux", "pr3", "pr4", "puertoPlata"],
          description: "Codigo del proyecto: crux=Crux del Prado Torre 6, pr3=Prado Residences III, pr4=Prado Residences IV, puertoPlata=Prado Suites Puerto Plata",
        },
        precio_usd: {
          type: "number",
          description: "Precio total de la unidad en USD. Usa el precio base del proyecto si no sabes uno especifico.",
        },
      },
      required: ["proyecto", "precio_usd"],
    },
  },
];

// ============================================
// CONTEXTO DINAMICO DEL CLIENTE + ESCALAMIENTO
// ============================================

const ESCALATION_SILENCE_HOURS = 4;
const REMINDER_THROTTLE_HOURS = 1;

function buildClientContext(meta) {
  if (!meta) return "";
  const parts = [];
  if (meta.name && meta.name !== "Desconocido") {
    parts.push("- Nombre: " + meta.name);
  }
  if (meta.temperature) {
    parts.push("- Temperatura del lead: " + meta.temperature);
  }
  if (meta.sentDocs && Object.keys(meta.sentDocs).length > 0) {
    const labels = Object.keys(meta.sentDocs).map((k) => {
      const [proj, type] = k.split(".");
      const projName = PROJECT_NAMES[proj] || proj;
      const typeName = DOC_TYPE_NAMES[type] || type;
      return projName + " (" + typeName + ")";
    });
    parts.push("- Documentos ya enviados antes: " + labels.join(", "));
  }
  if (meta.lastContact) {
    const hoursAgo = (Date.now() - new Date(meta.lastContact).getTime()) / 3600000;
    if (hoursAgo > 1) {
      const label = hoursAgo < 24
        ? Math.round(hoursAgo) + " horas"
        : Math.round(hoursAgo / 24) + " dias";
      parts.push("- Ultimo contacto previo: hace " + label);
    }
  }
  if (meta.escalated === false && meta.escalatedAt) {
    parts.push("- Nota: fue escalado a Enmanuel antes. Retoma de forma natural, sin saludar de nuevo.");
  }
  if (parts.length === 0) return "";
  return "\n\n---\nCONTEXTO DEL CLIENTE (uso interno, NO menciones estos datos literalmente al cliente):\n" +
    parts.join("\n") +
    "\n\nReglas segun este contexto:\n" +
    "- Si hay historial previo, NO saludes como primera vez. Continua la conversacion.\n" +
    "- NO re-envies documentos que figuran como ya enviados, salvo que el cliente lo pida de forma explicita.\n" +
    "- Usa el nombre si lo conoces, pero sin abusar (no en cada mensaje).";
}

function isEscalationActive(meta) {
  if (!meta || meta.escalated !== true || !meta.escalatedAt) return false;
  const ageMs = Date.now() - new Date(meta.escalatedAt).getTime();
  return ageMs < ESCALATION_SILENCE_HOURS * 3600000;
}

function shouldRemindEnmanuel(meta) {
  const last = meta?.lastReminderAt;
  if (!last) return true;
  const ageMs = Date.now() - new Date(last).getTime();
  return ageMs > REMINDER_THROTTLE_HOURS * 3600000;
}

// ============================================
// PROCESAR MENSAJE
// ============================================

async function processMessage(body) {
  try {
    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) {
      console.log("Evento sin mensajes (status update o similar)");
      return;
    }

    const message = messages[0];
    const senderPhone = message.from;
    const messageType = message.type;
    const senderName = value?.contacts?.[0]?.profile?.name || "Desconocido";

    // Guardar nombre del cliente en metadata
    await saveClientMeta(senderPhone, { name: senderName });

    // Soporte de audio (notas de voz) via Whisper
    let userMessage;
    if (messageType === "text") {
      userMessage = message.text.body;
    } else if (messageType === "audio" || messageType === "voice") {
      const audioId = message.audio?.id || message.voice?.id;
      botLog("info", "Audio recibido, intentando transcribir", { phone: senderPhone, audioId });
      const transcribed = audioId ? await transcribeWhatsAppAudio(audioId) : null;
      if (!transcribed) {
        await sendWhatsAppMessage(
          senderPhone,
          "Escuche tu audio pero tuve problemas procesandolo. Me lo puedes escribir por texto y te ayudo al instante?"
        );
        return;
      }
      userMessage = transcribed;
      botLog("info", "Audio transcrito", { phone: senderPhone, length: transcribed.length });
    } else {
      await sendWhatsAppMessage(
        senderPhone,
        "Hola! Por el momento solo puedo leer texto y notas de voz. Escribeme tu consulta y con gusto te ayudo."
      );
      return;
    }

    // ============================================
    // DETECTAR SI ES PERSONAL INTERNO (por numero)
    // ============================================
    const isStaff = STAFF_PHONES[senderPhone];
    botLog("info", "Mensaje recibido", { phone: senderPhone, name: senderName, message: userMessage, isStaff: !!isStaff });
    const isSupervisor = isStaff?.supervisor === true;
    const activePrompt = isSupervisor ? SUPERVISOR_PROMPT : buildSystemPrompt();

    if (isStaff) {
      console.log("PERSONAL INTERNO detectado: " + isStaff.name + " (" + isStaff.role + ")");
    }

    // Cargar metadata del cliente (para contexto dinamico + gestion de escalamiento)
    const clientMeta = !isStaff ? await getClientMeta(senderPhone) : null;

    // Si hay un escalamiento activo (< 4h), el bot se silencia.
    // Guarda el mensaje en historial y avisa a Enmanuel (con throttle de 1h).
    if (!isStaff && isEscalationActive(clientMeta)) {
      await addMessage(senderPhone, "user", userMessage);
      botLog("info", "Bot silenciado: escalamiento activo", {
        phone: senderPhone,
        escalatedAt: clientMeta.escalatedAt,
      });
      if (shouldRemindEnmanuel(clientMeta)) {
        try {
          const clientLabel = clientMeta.name && clientMeta.name !== "Desconocido"
            ? clientMeta.name
            : senderPhone;
          await sendWhatsAppMessage(
            ENMANUEL_PHONE,
            "Recordatorio: " + clientLabel + " (" + senderPhone + ") sigue escribiendo. Sigue en modo escalado."
          );
          await saveClientMeta(senderPhone, { lastReminderAt: new Date().toISOString() });
        } catch (e) {
          console.log("Error recordando a Enmanuel:", e.message);
        }
      }
      return;
    }

    // Si el escalamiento ya vencio (> 4h), limpiar flag y seguir flujo normal
    if (!isStaff && clientMeta?.escalated === true && !isEscalationActive(clientMeta)) {
      await saveClientMeta(senderPhone, { escalated: false });
    }

    await addMessage(senderPhone, "user", userMessage);
    const messageHistory = await getHistory(senderPhone);

    // Inyectar contexto dinamico del cliente al system prompt (solo flujo de cliente)
    const clientContext = !isSupervisor ? buildClientContext(clientMeta) : "";
    const finalPrompt = activePrompt + clientContext;

    const response = await callClaudeWithTools({
      system: finalPrompt,
      messages: messageHistory,
      tools: TOOLS,
      phone: senderPhone,
      toolHandlers: {
        calcular_plan_pago: (input) => calcularPlanPago(input.proyecto, input.precio_usd),
      },
    });

    // Extraer el texto final (ignorando bloques tool_use residuales)
    const textBlocks = response.content.filter((b) => b.type === "text");
    const rawReply = textBlocks.map((b) => b.text).join("\n").trim() || "Dejame un momento, te respondo en seguida.";
    console.log("Respuesta del bot: " + rawReply);

    // Detectar senales de lead caliente, escalamiento y agendamiento
    const { isHotLead, needsEscalation, booking, cleanReply } = detectLeadSignals(rawReply);
    const botReply = cleanReply;

    await addMessage(senderPhone, "assistant", botReply);
    await sendWhatsAppMessage(senderPhone, botReply);
    botLog("info", "Respuesta enviada", { phone: senderPhone, responseLength: botReply.length });

    // Notificar a Enmanuel si hay seÃ±ales (solo para clientes, no para staff)
    if (!isStaff) {
      if (isHotLead) {
        await _notifyWithMeta(senderPhone, userMessage, botReply, "hot");
        await saveClientMeta(senderPhone, { temperature: "hot", hotDetectedAt: new Date().toISOString() });
      }
      if (needsEscalation) {
        await _notifyWithMeta(senderPhone, userMessage, botReply, "escalation");
        await saveClientMeta(senderPhone, { escalated: true, escalatedAt: new Date().toISOString() });
      }

      // Agendamiento de visita: guardar + notificar con tarjeta estructurada
      if (booking) {
        await _notifyBookingWithMeta(senderPhone, booking);
        await saveClientMeta(senderPhone, {
          scheduledVisit: booking,
          temperature: "hot", // quien agenda visita es lead caliente por definicion
        });
        // Al agendar, suspendemos el followup automatico:
        // la siguiente interaccion sera con Enmanuel cara a cara.
      }

      // Cliente respondio -> resetear contador de followups.
      // El calendario del cron se dispara a partir de lastContact + dias segun
      // temperatura, asi que no hace falta programar un timestamp especifico.
      if (!needsEscalation) {
        await saveClientMeta(senderPhone, {
          followUpCount: 0,
          followUpStage: 0,
        });
      }
    }

    // ============================================
    // ENVIO AUTOMATICO DE PDFs (solo para clientes)
    // ============================================

    // PDFs se envian a todos (clientes y staff)
    {
      const project = detectDocumentRequest(botReply, userMessage);

      if (project === "all") {
        let allSentCount = 0;
        for (const [projKey, projDocs] of Object.entries(PROJECT_DOCS)) {
          if (projDocs.brochure) {
            if (allSentCount > 0) {
              await new Promise((resolve) => setTimeout(resolve, 1500));
            }
            // Enviar imagenes teaser antes del brochure (si estan configuradas)
            await sendProjectImages(senderPhone, projKey);
            const allFilename = PROJECT_NAMES[projKey] + " - Brochure - JPREZ.pdf";
            const allProxyUrl = toProxyUrl(projDocs.brochure);
            await sendWhatsAppDocument(senderPhone, allProxyUrl, allFilename);
            allSentCount++;
            await markDocSent(senderPhone, projKey + ".brochure");
            console.log("PDF enviado (todos): brochure de " + projKey + " a " + senderPhone);
          }
        }
        if (allSentCount > 0) {
          console.log("Total brochures enviados a " + senderPhone + ": " + allSentCount);
        }
      } else if (project && PROJECT_DOCS[project]) {
        const docs = PROJECT_DOCS[project];
        const requestedTypes = detectDocumentType(botReply, userMessage);

        let sentCount = 0;

        // Si el primer doc que se va a mandar es el brochure, enviar imagenes teaser antes
        if (requestedTypes[0] === "brochure" && docs.images && docs.images.length > 0) {
          await sendProjectImages(senderPhone, project);
        }

        for (const docType of requestedTypes) {
          const docUrl = docs[docType];
          if (docUrl) {
            if (sentCount > 0) {
              await new Promise((resolve) => setTimeout(resolve, 1500));
            }

            let filename = PROJECT_NAMES[project] + " - " + DOC_TYPE_NAMES[docType] + " - JPREZ.pdf";
            // Para puertoPlata, distinguir Etapa 3 en el nombre
            if (project === "puertoPlata" && docType === "brochure") {
                filename = PROJECT_NAMES[project] + " - Brochure Etapa 3 - JPREZ.pdf";
              }
              if (project === "puertoPlata" && docType === "precios") {
              filename = PROJECT_NAMES[project] + " - Precios Etapa 3 - JPREZ.pdf";
            }
            // Convertir URL de Google Drive a nuestro proxy para que WhatsApp reciba el PDF real
            const proxyUrl = toProxyUrl(docUrl);
            await sendWhatsAppDocument(senderPhone, proxyUrl, filename);
            sentCount++;
            await markDocSent(senderPhone, project + "." + docType);
            console.log("PDF enviado: " + docType + " de " + project + " a " + senderPhone);
          }
        }

        // Envio especial: Prado Suites Etapa 4 precios
        if (project === "puertoPlata" && requestedTypes.includes("precios") && docs.preciosE4) {
          if (sentCount > 0) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }
          const e4Filename = PROJECT_NAMES[project] + " - Precios Etapa 4 (Entrega Dic. 2027) - JPREZ.pdf";
          const e4ProxyUrl = toProxyUrl(docs.preciosE4);
          await sendWhatsAppDocument(senderPhone, e4ProxyUrl, e4Filename);
          sentCount++;
          await markDocSent(senderPhone, project + ".preciosE4");
          console.log("PDF enviado: preciosE4 de puertoPlata a " + senderPhone);
        }

      // Envio especial: Prado Suites Etapa 4 brochure
      if (project === "puertoPlata" && requestedTypes.includes("brochure") && docs.brochureE4) {
        if (sentCount > 0) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        const e4BrochureFilename = PROJECT_NAMES[project] + " - Brochure Etapa 4 (Entrega Dic. 2027) - JPREZ.pdf";
        const e4BrochureProxyUrl = toProxyUrl(docs.brochureE4);
        await sendWhatsAppDocument(senderPhone, e4BrochureProxyUrl, e4BrochureFilename);
        sentCount++;
        await markDocSent(senderPhone, project + ".brochureE4");
        console.log("PDF enviado: brochureE4 de puertoPlata a " + senderPhone);
      }

        if (sentCount === 0) {
          console.log("AVISO: Solicitud de docs para " + project + " pero no hay URLs configuradas en las variables de entorno");
        } else {
          console.log("Total PDFs enviados a " + senderPhone + ": " + sentCount);
        }
      }
    }
  } catch (error) {
    botLog("error", "Error procesando mensaje", { error: error.message, stack: error.stack });
  }
}

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

// Envia todas las imagenes configuradas de un proyecto. Se usa como teaser antes
// del brochure. Degrada a no-op si no hay imagenes en env vars.
async function sendProjectImages(phone, project) {
  const docs = PROJECT_DOCS[project];
  if (!docs?.images || docs.images.length === 0) return 0;
  let sent = 0;
  for (const imgUrl of docs.images) {
    if (sent > 0) await new Promise((r) => setTimeout(r, 1000));
    try {
      // Si es link de Drive, lo pasamos por nuestro proxy de imagenes
      const finalUrl = toImageProxyUrl(imgUrl);
      await sendWhatsAppImage(phone, finalUrl);
      sent++;
    } catch (e) {
      console.log("Error enviando imagen de " + project + ":", e.message);
    }
  }
  return sent;
}

