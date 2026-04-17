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
- Referencia algo concreto de la conversacion previa (proyecto que le intereso, pregunta pendiente, visita que hablaron).
- Da un motivo real para responder: una novedad, una disponibilidad, una pregunta clara.
- Nada de presion. Tono calido, cercano, dominicano profesional.
- Maximo 1 emoji, solo si es natural. Nunca forzado.
- NO inventes datos ni novedades falsas. Si no tienes novedad concreta, usa una pregunta abierta ("como van tus planes?", "pudiste revisar el material?").
- NO incluyas ningun prefacio tipo "aqui va el mensaje:". Devuelve SOLO el texto que se le enviara al cliente.

Proyectos activos (por si los necesitas):
1. CRUX DEL PRADO (SDN, 3 hab, listos desde RD$5.65M o Torre 6 desde US$99K)
2. PRADO RESIDENCES III (Av. Churchill, 1 hab equipado, desde US$156K, solo 6 unidades)
3. PRADO RESIDENCES IV (Evaristo Morales, 1 y 3 hab, desde US$140K)
4. PRADO SUITES PUERTO PLATA (frente a Playa Dorada, 1-3 hab, desde US$73K)

NUNCA incluyas etiquetas [LEAD_CALIENTE] ni [ESCALAR] en el mensaje.`;

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
    details: [],
  };

  for (const key of keys) {
    const phone = key.replace("meta:", "");
    try {
      if (STAFF_PHONES[phone]) { summary.skipped++; continue; }

      const meta = await getClientMeta(redis, phone);
      if (!meta) { summary.skipped++; continue; }

      // Cliente activamente escalado: humano se encarga, no interferimos
      if (isEscalationActive(meta)) { summary.skipped++; continue; }

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
