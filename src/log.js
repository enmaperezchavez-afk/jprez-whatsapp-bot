// ============================================
// AXIOM LOGGING (Logs profesionales)
// ============================================
// Extraido desde api/webhook.js en Dia 2 sin cambios de comportamiento.
// botLog llama console.log sincronicamente y agenda el envio a Axiom
// via waitUntil para que el container de Vercel no se cierre antes de
// terminar el fetch.

const { waitUntil } = require("@vercel/functions");

async function logToAxiom(events) {
  const token = process.env.AXIOM_TOKEN;
  const dataset = process.env.AXIOM_DATASET || "jprez-bot";
  if (!token) {
    console.log("[axiom] AXIOM_TOKEN no configurado, saltando");
    return;
  }
  try {
    const payload = Array.isArray(events) ? events : [events];
    const res = await fetch("https://api.axiom.co/v1/datasets/" + dataset + "/ingest", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text();
      console.log("[axiom] Ingest fallo status=" + res.status + " dataset=" + dataset + " body=" + body.slice(0, 500));
    } else {
      console.log("[axiom] Ingest OK dataset=" + dataset + " count=" + payload.length);
    }
  } catch (e) {
    console.log("[axiom] Error enviando a Axiom:", e.message);
  }
}

function botLog(level, message, data) {
  const logEntry = {
    _time: new Date().toISOString(),
    level: level,
    message: message,
    ...data,
  };
  console.log(message, data ? JSON.stringify(data) : "");
  waitUntil(logToAxiom(logEntry));
}

module.exports = { botLog, logToAxiom };
