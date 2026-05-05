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
//
// Hotfix-20 c3: para diagnostico de audios cortos que devuelven "no te
// capte" persistente:
//   - log audio_transcribe_raw_result (200 chars) PRE-threshold del handler.
//     Permite ver en Axiom si Whisper devuelve "" vs hallucination
//     ("Subtítulos por Amara.org") vs texto valido corto.
//   - retry 1 vez si primer intento devuelve null o "". Caso comun: Whisper
//     glitch transitorio recupera al segundo intento.
//   - timeout 30s por intento via AbortController. Evita que fetch cuelgue
//     indefinidamente y agote los 20s de timeout de Meta.
//   - prompt: "audio en español" hint a Whisper. En audios cortos a veces
//     el modelo no esta seguro del idioma y desambigua mal.

const WHISPER_TIMEOUT_MS = 30000;

async function whisperTranscribeOnce(audioBuffer, mimeType, ext, openaiKey, audioId, attemptNum, botLog) {
  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: mimeType }), "audio." + ext);
  form.append("model", "whisper-1");
  form.append("language", "es");
  form.append("prompt", "audio en español");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WHISPER_TIMEOUT_MS);

  try {
    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: "Bearer " + openaiKey },
      body: form,
      signal: controller.signal,
    });
    if (!resp.ok) {
      const body = await resp.text();
      botLog("warn", "audio_transcribe_whisper_failed", {
        audioId, attemptNum, status: resp.status, body: body.slice(0, 200),
        audioBytes: audioBuffer.byteLength, mimeType,
      });
      return null;
    }
    const data = await resp.json();
    const text = (data.text || "").trim();
    botLog("info", "audio_transcribe_raw_result", {
      audioId, attemptNum, rawText: text.slice(0, 200), rawLength: text.length,
    });
    return text;
  } catch (e) {
    if (e.name === "AbortError") {
      botLog("warn", "audio_transcribe_whisper_timeout", {
        audioId, attemptNum, timeoutMs: WHISPER_TIMEOUT_MS,
      });
      return null;
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

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

    // 3. Enviar a Whisper (con retry 1 vez si null/empty)
    const ext = mimeType.includes("mpeg") ? "mp3" : mimeType.includes("mp4") ? "mp4" : "ogg";
    let result = await whisperTranscribeOnce(audioBuffer, mimeType, ext, openaiKey, audioId, 1, botLog);
    if (result === null || result === "") {
      botLog("info", "audio_transcribe_retry", {
        audioId, firstResult: result === null ? "null" : "empty",
      });
      result = await whisperTranscribeOnce(audioBuffer, mimeType, ext, openaiKey, audioId, 2, botLog);
    }
    return result;
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
