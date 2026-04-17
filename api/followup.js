// ============================================
// FOLLOWUP CRON - Seguimiento automatico a leads dormidos
// Ejecutado por Vercel Cron 2x al dia (ver vercel.json).
//
// Politica:
// - HOT  (lead caliente): seguimiento a los 3, 5 y 7 dias
// - WARM (info general) : seguimiento a los 5, 10 y 20 dias
// - COLD (saludo vago)  : seguimiento a los 7, 15 y 30 dias
// Maximo 3 followups por cliente. Ventana 9am-7pm RD.
//
// Metadata relevante por cliente:
//   followUpCount  : cuantos followups se han enviado (0 a 3)
//   followUpStage  : mismo valor que count, por semantica
//   lastFollowUpAt : ISO timestamp del ultimo followup
//   temperature    : "hot" explicito cuando bot marco [LEAD_CALIENTE].
//                    cold/warm se derivan del historial si no esta seteado.
// ============================================

const Anthropic = require("@anthropic-ai/sdk");

// ============================================
// CONSTANTES
// ============================================

const ENMANUEL_PHONE = "18299943102";
const STAFF_PHONES = {
  [ENMANUEL_PHONE]: { name: "Enmanuel Perez Chavez", role: "director", supervisor: true },
};

const ESCALATION_SILENCE_HOURS = 4;
const MAX_MESSAGES = 20;

// Calendario por temperatura: dias desde lastContact para disparar el followup
// Indice 0 = primer followup, 1 = segundo, 2 = tercero
const SCHEDULES = {
  hot:  [3, 5, 7],
  warm: [5, 10, 20],
  cold: [7, 15, 30],
};

const MAX_FOLLOWUPS = 3;

// Ventana horaria (hora Santo Domingo, UTC-4)
const SEND_WINDOW_START = 9;   // 9am inclusivo
const SEND_WINDOW_END = 19;    // 7pm exclusivo

// Anti-rebote: no mandar dos followups al mismo cliente en menos de N horas
const MIN_HOURS_BETWEEN_FOLLOWUPS = 18;

// ============================================
// REDIS / METADATA / HISTORIAL
// ============================================

async function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const { Redis } = require("@upstash/redis");
    return new Redis({ url, token });
  } catch (e) {
    console.log("Redis no disponible:", e.message);
    return null;
  }
}

async function getClientMeta(redis, phone) {
  const raw = await redis.get("meta:" + phone);
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

// No pisa lastContact: ese campo es "cuando el cliente escribio por ultima vez",
// no cuando nosotros tocamos el registro.
async function saveClientMeta(redis, phone, patch) {
  const existing = await redis.get("meta:" + phone);
  const current = existing ? (typeof existing === "string" ? JSON.parse(existing) : existing) : {};
  const updated = { ...current, ...patch };
  await redis.set("meta:" + phone, JSON.stringify(updated), { ex: 7776000 });
  return updated;
}

async function getHistory(redis, phone) {
  const raw = await redis.get("chat:" + phone);
  if (!raw) return [];
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

async function appendAssistantMessage(redis, phone, content) {
  const history = await getHistory(redis, phone);
  history.push({ role: "assistant", content });
  if (history.length > MAX_MESSAGES) {
    history.splice(0, history.length - MAX_MESSAGES);
  }
  await redis.set("chat:" + phone, JSON.stringify(history), { ex: 2592000 });
}

// ============================================
// WHATSAPP
// ============================================

async function sendWhatsAppMessage(to, text) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  const url = "https://graph.facebook.com/v21.0/" + phoneNumberId + "/messages";
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error("WhatsApp API " + res.status + ": " + err);
  }
  return res.json();
}

// ============================================
// HELPERS DE FLUJO
// ============================================

function isEscalationActive(meta) {
  if (!meta || meta.escalated !== true || !meta.escalatedAt) return false;
  const ageMs = Date.now() - new Date(meta.escalatedAt).getTime();
  return ageMs < ESCALATION_SILENCE_HOURS * 3600000;
}

function isWithinSendWindow() {
  const rdHourStr = new Date().toLocaleString("en-US", {
    timeZone: "America/Santo_Domingo",
    hour: "2-digit",
    hour12: false,
  });
  const rdHour = parseInt(rdHourStr, 10);
  return rdHour >= SEND_WINDOW_START && rdHour < SEND_WINDOW_END;
}

function daysSinceLastContact(meta) {
  if (!meta?.lastContact) return Infinity;
  return (Date.now() - new Date(meta.lastContact).getTime()) / 86400000;
}

function detectTemperature(meta, history) {
  if (meta.temperature === "hot") return "hot";
  if (meta.temperature === "warm") return "warm";
  if (meta.temperature === "cold") return "cold";
  // Derivar de historial si no esta marcado
  const userMsgCount = (history || []).filter((m) => m.role === "user").length;
  if (userMsgCount <= 2) return "cold";
  return "warm";
}

// ============================================
// GENERACION DE MENSAJES POR STAGE
// ============================================

const FOLLOWUP_BASE_PROMPT = `Eres el MEJOR vendedor de bienes raices del Caribe, de Constructora JPREZ. Redactas un mensaje de seguimiento de WhatsApp para un cliente que no ha respondido en dias.

Reglas obligatorias:
- Maximo 3 lineas. Texto plano, sin markdown ni bullets.
- NO saludes como primera vez. El cliente ya te conoce.
- Tono dominicano profesional, calido, cercano. Nada de presion.
- Maximo 1 emoji y solo si es natural.
- Referencia CONCRETA a la conversacion previa cuando sea posible (proyecto que le intereso, pregunta pendiente, visita hablada).
- NO inventes datos falsos. Si no tienes dato personalizado, usa la escasez real del proyecto listada abajo.
- NO incluyas prefacios tipo "aqui va el mensaje". Devuelve SOLO el texto que se enviara.
- NUNCA incluyas etiquetas [LEAD_CALIENTE], [ESCALAR], ni [AGENDAR].

ESCASEZ REAL POR PROYECTO (datos reales para usar):
- Crux del Prado (crux): Etapa 1 y 2 LISTOS, SOLO 4 UNIDADES DISPONIBLES desde RD$5.65M. Torre 6 en construccion, 42 de 50 disponibles, entrega julio 2027.
- Prado Residences III (pr3): SOLO 6 DE 60 UNIDADES DISPONIBLES. Equipado, listo para Airbnb, entrega agosto 2026.
- Prado Residences IV (pr4): 13 de 72 unidades disponibles (82% vendido), entrega septiembre 2027.
- Prado Suites Puerto Plata (puertoPlata): Etapa 3 con 63 de 126 disponibles, desde US$73K.`;

const STAGE_PROMPTS = {
  1:
    "\n\nTIPO DE MENSAJE: Primer seguimiento (URGENCIA SUTIL).\n" +
    "- Recuerda de forma natural lo que le intereso ('me acorde de ti porque...').\n" +
    "- Menciona escasez real del proyecto (unidades disponibles, plazo de entrega cercano).\n" +
    "- Cierra con pregunta ligera: si pudo revisar material o si quiere agendar visita.\n" +
    "Tono: interesado pero relajado, sin presion.",
  2:
    "\n\nTIPO DE MENSAJE: Segundo seguimiento (VALOR AGREGADO).\n" +
    "- Comparte un dato o beneficio que probablemente NO se menciono antes.\n" +
    "  Opciones naturales: plan de pago flexible, apreciacion historica de la zona, facilidad con banco, ventaja de comprar en construccion, cercania a servicios, ingreso por Airbnb.\n" +
    "- NO repitas lo que dijiste en el primer seguimiento.\n" +
    "- Cierra invitando a conversar, no a comprar.\n" +
    "Tono: aportas valor, no persigues.",
  3:
    "\n\nTIPO DE MENSAJE: Tercer y ULTIMO seguimiento (DESPEDIDA HONESTA).\n" +
    "- Directo y respetuoso: preguntar si todavia tiene interes o si 'lo dejamos aqui'.\n" +
    "- Reconoce sin rencor que entiendes si ya no le interesa.\n" +
    "- Deja la puerta abierta explicitamente ('cuando quieras retomar, aqui estoy').\n" +
    "Tono: honesto, sereno, digno. Ejemplo de vibe: 'no quiero seguir escribiendote si ya no te interesa, tu tiempo vale'.",
};

function buildFollowupSystemPrompt(stage) {
  return FOLLOWUP_BASE_PROMPT + (STAGE_PROMPTS[stage] || STAGE_PROMPTS[1]);
}

function buildFollowupUserPrompt(meta, stage, temperature) {
  const parts = [];
  parts.push("Contexto del cliente:");
  if (meta.name && meta.name !== "Desconocido") parts.push("- Nombre: " + meta.name);
  parts.push("- Temperatura: " + temperature);
  parts.push("- Stage del mensaje: " + stage + " de 3");
  if (meta.sentDocs && Object.keys(meta.sentDocs).length > 0) {
    parts.push("- Documentos que ya recibio: " + Object.keys(meta.sentDocs).join(", "));
  }
  const days = daysSinceLastContact(meta);
  if (isFinite(days)) {
    parts.push("- Sin responder hace " + Math.round(days) + " dias");
  }
  parts.push("");
  parts.push("Redacta ahora el mensaje de seguimiento. Solo el texto, nada mas.");
  return parts.join("\n");
}

async function generateFollowup(history, meta, stage, temperature) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const system = buildFollowupSystemPrompt(stage);
  const userPrompt = buildFollowupUserPrompt(meta, stage, temperature);
  const messages = [
    ...history,
    { role: "user", content: userPrompt },
  ];
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    system,
    messages,
  });
  let text = response.content[0].text.trim();
  text = text
    .replace(/\[LEAD_CALIENTE\]/g, "")
    .replace(/\[ESCALAR\]/g, "")
    .replace(/\[AGENDAR\|[^\]]*\]/g, "")
    .trim();
  return text;
}

// ============================================
// AUTENTICACION DEL CRON
// ============================================

function isAuthorized(req) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true; // sin secret configurado, acceso libre (para compatibilidad)
  const auth = req.headers.authorization || "";
  const vercelCronAuth = req.headers["x-vercel-cron-authorization"] || "";
  const querySecret = req.query?.secret;
  const bearerFormat = "Bearer " + cronSecret;
  return (
    auth === bearerFormat ||
    vercelCronAuth === bearerFormat ||
    vercelCronAuth === cronSecret ||
    querySecret === cronSecret
  );
}

// ============================================
// HANDLER
// ============================================

module.exports = async function handler(req, res) {
  if (!isAuthorized(req)) {
    return res.status(403).json({ error: "forbidden" });
  }

  const redis = await getRedis();
  if (!redis) {
    return res.status(500).json({ error: "redis not configured" });
  }

  const withinWindow = isWithinSendWindow();
  const summary = {
    ranAt: new Date().toISOString(),
    withinSendWindow: withinWindow,
    totalClients: 0,
    visitReminders: 0,
    sent: 0,
    skippedOutsideWindow: 0,
    skippedNotDue: 0,
    skippedMaxReached: 0,
    skippedEscalated: 0,
    skippedVisitScheduled: 0,
    skippedStaff: 0,
    errors: 0,
    details: [],
  };

  const keys = await redis.keys("meta:*");
  summary.totalClients = keys.length;

  // ============================================
  // PASE 1: RECORDATORIOS DE VISITA
  // (No dependen de la ventana horaria de followups;
  // son operativos y se mandan cuando toca, 12-36h antes de la cita)
  // ============================================
  for (const key of keys) {
    const phone = key.replace("meta:", "");
    try {
      if (STAFF_PHONES[phone]) continue;
      const meta = await getClientMeta(redis, phone);
      if (!meta?.scheduledVisit?.at) continue;
      if (meta.scheduledVisit.reminder24hSent) continue;

      const visitAt = new Date(meta.scheduledVisit.at).getTime();
      const hoursUntil = (visitAt - Date.now()) / 3600000;
      if (hoursUntil < 12 || hoursUntil > 36) continue;

      const projectNames = {
        crux: "Crux del Prado",
        pr3: "Prado Residences III",
        pr4: "Prado Residences IV",
        puertoPlata: "Prado Suites Puerto Plata",
      };
      const projectName = projectNames[meta.scheduledVisit.project] || meta.scheduledVisit.project;
      const horaLegible = new Date(visitAt).toLocaleString("es-DO", {
        timeZone: "America/Santo_Domingo",
        weekday: "long", hour: "numeric", minute: "2-digit", hour12: true,
      });

      const reminderText = "Hola! Recordatorio: manana tenemos tu visita a " + projectName + " (" + horaLegible + "). Si necesitas cambiar algo, avisame por aqui. Te esperamos!";
      await sendWhatsAppMessage(phone, reminderText);
      await appendAssistantMessage(redis, phone, reminderText);
      await saveClientMeta(redis, phone, {
        scheduledVisit: {
          ...meta.scheduledVisit,
          reminder24hSent: true,
          reminder24hSentAt: new Date().toISOString(),
        },
      });
      summary.visitReminders++;
      summary.details.push({ phone, action: "visit_reminder_24h", project: meta.scheduledVisit.project });
    } catch (e) {
      summary.errors++;
      summary.details.push({ phone, action: "visit_reminder_error", error: e.message });
      console.error("Visit reminder error para " + phone + ":", e.message);
    }
  }

  // ============================================
  // PASE 2: FOLLOWUPS A LEADS DORMIDOS
  // ============================================

  if (!withinWindow) {
    console.log("Fuera de ventana (9am-7pm RD), se saltan todos los followups");
    // Contamos los elegibles como skippedOutsideWindow para visibilidad
    for (const key of keys) {
      const phone = key.replace("meta:", "");
      if (STAFF_PHONES[phone]) continue;
      summary.skippedOutsideWindow++;
    }
    console.log("Followup summary:", JSON.stringify(summary));
    return res.status(200).json(summary);
  }

  for (const key of keys) {
    const phone = key.replace("meta:", "");
    try {
      if (STAFF_PHONES[phone]) { summary.skippedStaff++; continue; }
      const meta = await getClientMeta(redis, phone);
      if (!meta) continue;

      // Cliente escalado activamente -> humano encargado
      if (isEscalationActive(meta)) { summary.skippedEscalated++; continue; }

      // Visita agendada a futuro -> no interrumpir
      if (meta.scheduledVisit?.at && new Date(meta.scheduledVisit.at).getTime() > Date.now()) {
        summary.skippedVisitScheduled++;
        continue;
      }

      const followUpCount = meta.followUpCount || 0;
      if (followUpCount >= MAX_FOLLOWUPS) {
        summary.skippedMaxReached++;
        continue;
      }

      const history = await getHistory(redis, phone);
      if (history.length === 0) continue;

      const temperature = detectTemperature(meta, history);
      const schedule = SCHEDULES[temperature] || SCHEDULES.warm;
      const requiredDays = schedule[followUpCount];
      const days = daysSinceLastContact(meta);

      if (days < requiredDays) {
        summary.skippedNotDue++;
        continue;
      }

      // Anti-rebote: el cron corre 2x al dia; no mandar dos followups al mismo
      // cliente dentro de 18h
      if (meta.lastFollowUpAt) {
        const hoursSinceLast = (Date.now() - new Date(meta.lastFollowUpAt).getTime()) / 3600000;
        if (hoursSinceLast < MIN_HOURS_BETWEEN_FOLLOWUPS) {
          summary.skippedNotDue++;
          continue;
        }
      }

      const stage = followUpCount + 1;
      const text = await generateFollowup(history, meta, stage, temperature);
      await sendWhatsAppMessage(phone, text);
      await appendAssistantMessage(redis, phone, text);
      await saveClientMeta(redis, phone, {
        followUpCount: stage,
        followUpStage: stage,
        lastFollowUpAt: new Date().toISOString(),
      });

      summary.sent++;
      summary.details.push({ phone, action: "sent", stage, temperature, daysSinceContact: Math.round(days) });
    } catch (e) {
      summary.errors++;
      summary.details.push({ phone, action: "error", error: e.message });
      console.error("Followup error para " + phone + ":", e.message);
    }
  }

  console.log("Followup summary:", JSON.stringify(summary));
  return res.status(200).json(summary);
};
