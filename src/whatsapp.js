// src/whatsapp.js — Driver del canal WhatsApp Business Cloud API + Whisper.
//
// MECÁNICA DEL CANAL VIVE ACÁ. Lógica de NEGOCIO (qué/cuándo enviar) vive
// en src/handlers/. Por eso sendProjectImages se quedó en webhook (depende
// de PROJECT_DOCS + proxy URL — que migrará a src/proxy.js en otra extracción).
//
// DEUDA TÉCNICA CONOCIDA: phoneNumberId/token/url se duplican en cada send*.
// Dedup pendiente para commit posterior (no parte del refactor de Día 2).

async function sendWhatsAppMessage(to, text) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  const url = "https://graph.facebook.com/v21.0/" + phoneNumberId + "/messages";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: to,
      type: "text",
      text: { body: text },
    }),
  });

  if (!response.ok) {
    const errorData = await response.text();
    console.error("Error enviando WhatsApp:", errorData);
    throw new Error("WhatsApp API error: " + response.status);
  }

  return response.json();
}

async function sendWhatsAppDocument(to, documentUrl, filename) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  const url = "https://graph.facebook.com/v21.0/" + phoneNumberId + "/messages";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: to,
      type: "document",
      document: {
        link: documentUrl,
        filename: filename,
      },
    }),
  });

  if (!response.ok) {
    const errorData = await response.text();
    console.error("Error enviando documento:", errorData);
    throw new Error("WhatsApp Document API error: " + response.status);
  }

  return response.json();
}

async function sendWhatsAppImage(to, imageUrl, caption) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  const url = "https://graph.facebook.com/v21.0/" + phoneNumberId + "/messages";

  const imagePayload = { link: imageUrl };
  if (caption) imagePayload.caption = caption;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: to,
      type: "image",
      image: imagePayload,
    }),
  });

  if (!response.ok) {
    const errorData = await response.text();
    console.error("Error enviando imagen:", errorData);
    throw new Error("WhatsApp Image API error: " + response.status);
  }

  return response.json();
}

// Descarga el audio desde Meta y lo transcribe con Whisper.
// Retorna el texto transcrito, o null si falla o no hay API key configurada.
//
// Hotfix-19 Bug #1: try/catch wrapper + logs estructurados a Axiom para
// diagnostico de loops "no te capte audio". Cada fallo emite evento
// `audio_transcribe_*` con detalle. NUNCA propaga excepcion al handler.
async function transcribeWhatsAppAudio(audioId) {
  // Lazy require para evitar ciclos en imports tempranos del cold start.
  const { botLog } = require("./log");

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    botLog("warn", "audio_transcribe_skip_no_key", { audioId });
    return null;
  }
  const waToken = process.env.WHATSAPP_TOKEN;

  try {
    // 1. Obtener URL del media desde Meta
    const mediaMetaResp = await fetch("https://graph.facebook.com/v21.0/" + audioId, {
      headers: { Authorization: "Bearer " + waToken },
    });
    if (!mediaMetaResp.ok) {
      const body = await mediaMetaResp.text();
      botLog("warn", "audio_transcribe_meta_failed", {
        audioId, status: mediaMetaResp.status, body: body.slice(0, 200),
      });
      return null;
    }
    const mediaMeta = await mediaMetaResp.json();
    const mediaUrl = mediaMeta.url;
    const mimeType = mediaMeta.mime_type || "audio/ogg";

    // 2. Descargar el audio (requiere el token de WA)
    const audioResp = await fetch(mediaUrl, {
      headers: { Authorization: "Bearer " + waToken },
    });
    if (!audioResp.ok) {
      botLog("warn", "audio_transcribe_download_failed", {
        audioId, status: audioResp.status, mimeType,
      });
      return null;
    }
    const audioBuffer = await audioResp.arrayBuffer();

    // 3. Enviar a Whisper
    const form = new FormData();
    const ext = mimeType.includes("mpeg") ? "mp3" : mimeType.includes("mp4") ? "mp4" : "ogg";
    form.append("file", new Blob([audioBuffer], { type: mimeType }), "audio." + ext);
    form.append("model", "whisper-1");
    form.append("language", "es");

    const whisperResp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: "Bearer " + openaiKey },
      body: form,
    });
    if (!whisperResp.ok) {
      const body = await whisperResp.text();
      botLog("warn", "audio_transcribe_whisper_failed", {
        audioId, status: whisperResp.status, body: body.slice(0, 200),
        audioBytes: audioBuffer.byteLength, mimeType,
      });
      return null;
    }
    const whisperData = await whisperResp.json();
    return (whisperData.text || "").trim();
  } catch (e) {
    botLog("error", "audio_transcribe_exception", {
      audioId, error: e.message, stack: (e.stack || "").slice(0, 500),
    });
    return null;
  }
}

module.exports = {
  sendWhatsAppMessage,
  sendWhatsAppDocument,
  sendWhatsAppImage,
  transcribeWhatsAppAudio,
};
