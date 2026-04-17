// ============================================
// FOLLOWUP CRON - Seguimiento automatico a clientes
// Ejecutado por Vercel Cron (ver vercel.json).
// Tambien expuesto como GET /api/followup para pruebas
// manuales (requiere ?secret=CRON_SECRET).
//
// Politica (alineada con SYSTEM_PROMPT de webhook.js):
// - HOT  : seguir a las 24h, luego 48h, luego escalar a Enmanuel
// - WARM : seguir a los 2d, luego 5d, luego detener
//
// nextFollowupAt y followupStage viven en meta del cliente.
// El webhook los reprograma/resetea cada vez que el cliente
// escribe, por lo que solo hacemos followup si el cliente
// dejo de responder.
// ============================================

const Anthropic = require("@anthropic-ai/sdk");

// ============================================
// CONSTANTES (duplicadas de webhook.js a proposito
// para mantener followup.js autocontenido)
// ============================================

const ENMANUEL_PHONE = "18299943102";
const STAFF_PHONES = {
  [ENMANUEL_PHONE]: { name: "Enmanuel Perez Chavez", role: "director", supervisor: true },
};

const ESCALATION_SILENCE_HOURS = 4;
const MAX_MESSAGES = 20;

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

// Nota: a diferencia de webhook.js, NO pisamos lastContact:
// lastContact representa cuando el cliente escribio por ultima vez,
// no cuando nosotros actualizamos el registro.
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

// Dado el stage completado, calcula el proximo trigger (o null si ya no hay mas).
function computeNextFollowupAt(temperature, completedStage) {
  const now = Date.now();
  const H = 3600000, D = 86400000;
  if (temperature === "hot") {
    if (completedStage === 1) return new Date(now + 48 * H).toISOString();
    return null; // despues del stage 2 se escala
  }
  // warm / default
  if (completedStage === 1) return new Date(now + 3 * D).toISOString();
  return null; // despues del stage 2 se detiene
}

// ============================================
// GENERACION DEL MENSAJE DE SEGUIMIENTO
// ============================================

const FOLLOWUP_SYSTEM_PROMPT = `Eres el MEJOR vendedor de bienes raices del Caribe. Trabajas para Constructora JPREZ. Estas redactando un mensaje de SEGUIMIENTO proactivo para un cliente que dejo de responder hace varios dias.

Reglas del mensaje:
- Maximo 3 lineas de WhatsApp. Texto plano, sin markdown, sin bullets.
- NO saludes como si fuera primera vez. El cliente ya te conoce.
- Referencia algo CONCRETO de la conversacion previa (el proyecto exacto que le intereso, la pregunta pendiente, la visita que hablaron).
- Da un motivo real para responder. Opciones poderosas:
  a) ESCASEZ real por proyecto (ver lista abajo) - ideal si ya le mandaste ese brochure
  b) Una pregunta concreta sobre su decision
  c) Disponibilidad de unidad o visita
- Nada de presion. Tono calido, cercano, dominicano profesional.
- Maximo 1 emoji, solo si es natural. Nunca forzado.
- NO inventes datos ni novedades falsas. Si no tienes novedad concreta de ese cliente especifico, usa la escasez real del proyecto.
- NO incluyas ningun prefacio tipo "aqui va el mensaje:". Devuelve SOLO el texto que se enviara.

ESCASEZ REAL POR PROYECTO (usa estos datos, son reales):
- Crux del Prado (crux): Etapa 1 y 2 listos, SOLO 4 UNIDADES DISPONIBLES desde RD$5.65M. Torre 6 en construccion, 42 de 50 disponibles (84%).
- Prado Residences III (pr3): SOLO 6 DE 60 UNIDADES DISPONIBLES, entrega agosto 2026 (ya faltan pocos meses). Equipado y listo para Airbnb.
- Prado Residences IV (pr4): 13 de 72 unidades disponibles (82% vendido), entrega septiembre 2027.
- Prado Suites Puerto Plata (puertoPlata): Etapa 3 con 63 de 126 disponibles (50% vendido), desde US$73K.

Si el cliente recibio un brochure especifico, DA PRIORIDAD a mencionar la escasez de ESE proyecto en particular ("en PR3 solo quedan 6 unidades y ya se acerca la entrega de agosto").

NUNCA incluyas etiquetas [LEAD_CALIENTE], [ESCALAR], ni [AGENDAR] en el mensaje.`;

function buildFollowupUserPrompt(meta, stage, temperature) {
  const parts = [];
  parts.push("Contexto para redactar el seguimiento:");
  if (meta.name && meta.name !== "Desconocido") parts.push("- Nombre del cliente: " + meta.name);
  parts.push("- Temperatura del lead: " + temperature);
  if (meta.sentDocs && Object.keys(meta.sentDocs).length > 0) {
    parts.push("- Documentos que ya recibio: " + Object.keys(meta.sentDocs).join(", "));
  }
  if (meta.lastContact) {
    const hours = (Date.now() - new Date(meta.lastContact).getTime()) / 3600000;
    const label = hours < 48 ? Math.round(hours) + "h" : Math.round(hours / 24) + " dias";
    parts.push("- Sin respuesta desde hace " + label);
  }
  parts.push("- Este es el seguimiento numero " + (stage + 1) + (stage >= 1 ? " (ultimo antes de dejar puerta abierta)" : ""));
  parts.push("");
  parts.push("Redacta ahora el mensaje de seguimiento. Solo el texto, nada mas.");
  return parts.join("\n");
}

async function generateFollowup(history, meta, stage, temperature) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const messages = [
    ...history,
    { role: "user", content: buildFollowupUserPrompt(meta, stage, temperature) },
  ];
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    system: FOLLOWUP_SYSTEM_PROMPT,
    messages,
  });
  let text = response.content[0].text.trim();
  // Limpiar etiquetas por si el LLM las cuela
  text = text.replace(/\[LEAD_CALIENTE\]/g, "").replace(/\[ESCALAR\]/g, "").trim();
  return text;
}

async function notifyEnmanuelHotNoResponse(phone, meta) {
  const name = meta.name && meta.name !== "Desconocido" ? meta.name : phone;
  const msg =
    "LEAD CALIENTE sin respuesta\n\n" +
    "Nombre: " + name + "\n" +
    "Telefono: " + phone + "\n" +
    "Ya se enviaron 2 seguimientos sin respuesta.\n" +
    "Accion sugerida: llamar o escribir personalmente.";
  await sendWhatsAppMessage(ENMANUEL_PHONE, msg);
}

// ============================================
// HANDLER
// ============================================

module.exports = async function handler(req, res) {
  // Auth: Vercel Cron envia "Authorization: Bearer $CRON_SECRET".
  // Tambien aceptamos ?secret= para pruebas manuales.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.authorization || "";
    const querySecret = req.query?.secret;
    const bearerOk = auth === "Bearer " + cronSecret;
    const querySecretOk = querySecret === cronSecret;
    if (!bearerOk && !querySecretOk) {
      return res.status(403).json({ error: "forbidden" });
    }
  }

  const redis = await getRedis();
  if (!redis) {
    return res.status(500).json({ error: "redis not configured" });
  }

  const keys = await redis.keys("meta:*");
  const summary = {
    ranAt: new Date().toISOString(),
    totalClients: keys.length,
    due: 0,
    sent: 0,
    escalated: 0,
    closed: 0,
    skipped: 0,
    errors: 0,
    visitReminders: 0,
    details: [],
  };

  // ============================================
  // PASE 1: RECORDATORIOS DE VISITA (24h antes)
  // ============================================
  for (const key of keys) {
    const phone = key.replace("meta:", "");
    try {
      if (STAFF_PHONES[phone]) continue;
      const meta = await getClientMeta(redis, phone);
      if (!meta?.scheduledVisit?.at) continue;
      if (meta.scheduledVisit.reminder24hSent) continue;

      const visitAt = new Date(meta.scheduledVisit.at).getTime();
      const now = Date.now();
      const hoursUntil = (visitAt - now) / 3600000;

      // Ventana amplia (entre 12h y 36h antes) para cubrir cualquier hora del cron
      if (hoursUntil < 12 || hoursUntil > 36) continue;

      const projectName = (function () {
        const names = {
          crux: "Crux del Prado", pr3: "Prado Residences III",
          pr4: "Prado Residences IV", puertoPlata: "Prado Suites Puerto Plata",
        };
        return names[meta.scheduledVisit.project] || meta.scheduledVisit.project;
      })();
      const horaLegible = new Date(visitAt).toLocaleString("es-DO", {
        timeZone: "America/Santo_Domingo",
        weekday: "long", hour: "numeric", minute: "2-digit", hour12: true,
      });

      const reminderText = "Hola! Recordatorio: manana tenemos tu visita al proyecto " + projectName + " (" + horaLegible + "). Si necesitas cambiar algo, avisame por aqui. Te esperamos!";
      await sendWhatsAppMessage(phone, reminderText);
      await appendAssistantMessage(redis, phone, reminderText);
      await saveClientMeta(redis, phone, {
        scheduledVisit: { ...meta.scheduledVisit, reminder24hSent: true, reminder24hSentAt: new Date().toISOString() },
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
  // PASE 2: FOLLOWUPS POR TEMPERATURA
  // ============================================
  for (const key of keys) {
    const phone = key.replace("meta:", "");
    try {
      if (STAFF_PHONES[phone]) { summary.skipped++; continue; }

      const meta = await getClientMeta(redis, phone);
      if (!meta) { summary.skipped++; continue; }

      // Cliente activamente escalado: humano se encarga, no interferimos
      if (isEscalationActive(meta)) { summary.skipped++; continue; }

      // Si ya tiene visita agendada a futuro, no hacer followup adicional
      if (meta.scheduledVisit?.at && new Date(meta.scheduledVisit.at).getTime() > Date.now()) {
        summary.skipped++;
        continue;
      }

      // Sin schedule o aun no vence
      if (!meta.nextFollowupAt) { summary.skipped++; continue; }
      if (Date.now() < new Date(meta.nextFollowupAt).getTime()) { summary.skipped++; continue; }

      summary.due++;

      const currentStage = meta.followupStage || 0;
      const nextStage = currentStage + 1;
      const temperature = meta.temperature === "hot" ? "hot" : "warm";

      // Lead caliente completo 2 seguimientos sin responder -> escalar
      if (temperature === "hot" && nextStage > 2) {
        await notifyEnmanuelHotNoResponse(phone, meta);
        await saveClientMeta(redis, phone, {
          nextFollowupAt: null,
          followupStage: nextStage,
          escalated: true,
          escalatedAt: new Date().toISOString(),
          escalatedReason: "hot_lead_no_response",
        });
        summary.escalated++;
        summary.details.push({ phone, action: "escalated_hot" });
        continue;
      }

      // Warm completo su ciclo -> detener
      if (temperature === "warm" && nextStage > 2) {
        await saveClientMeta(redis, phone, {
          nextFollowupAt: null,
          followupStage: nextStage,
          followupClosedAt: new Date().toISOString(),
        });
        summary.closed++;
        summary.details.push({ phone, action: "warm_closed" });
        continue;
      }

      // Generar y enviar seguimiento
      const history = await getHistory(redis, phone);
      if (history.length === 0) {
        // Sin historial no tiene sentido hacer followup
        await saveClientMeta(redis, phone, { nextFollowupAt: null });
        summary.skipped++;
        continue;
      }

      const followupText = await generateFollowup(history, meta, currentStage, temperature);
      await sendWhatsAppMessage(phone, followupText);
      await appendAssistantMessage(redis, phone, followupText);

      const next = computeNextFollowupAt(temperature, nextStage);
      await saveClientMeta(redis, phone, {
        followupStage: nextStage,
        lastFollowupAt: new Date().toISOString(),
        nextFollowupAt: next,
      });

      summary.sent++;
      summary.details.push({ phone, action: "sent", stage: nextStage, temperature });
    } catch (e) {
      summary.errors++;
      summary.details.push({ phone, action: "error", error: e.message });
      console.error("Followup error para " + phone + ":", e.message);
    }
  }

  console.log("Followup summary:", JSON.stringify(summary));
  return res.status(200).json(summary);
};
