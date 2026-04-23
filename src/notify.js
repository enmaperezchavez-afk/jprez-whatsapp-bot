// src/notify.js — Notificaciones a staff de JPREZ.
//
// CONTRATO:
//   notifyEnmanuel(senderPhone, userMessage, botReply, signalType, clientMeta)
//     - clientMeta: el caller debe resolver getClientMeta(senderPhone) ANTES
//       de llamar. Esto es dependency injection — notify no toca Redis.
//     - clientMeta puede ser null/undefined si el cliente es nuevo. La función
//       maneja ambos casos y usa "Cliente desconocido" como fallback.
//
//   notifyEnmanuelBooking(senderPhone, booking, clientMeta, projectName)
//     - clientMeta: igual que arriba.
//     - projectName: el caller debe resolver PROJECT_NAMES[booking.project]
//       ANTES de llamar. Si proyecto no está en mapping, pasar booking.project
//       como string directo.
//
// POR QUÉ DEPENDENCY INJECTION:
//   1. Corta ciclo notify → store → webhook que rompería en runtime.
//   2. notify queda 100% testeable sin mockear Redis ni constantes de dominio.
//   3. Inyección explícita > I/O escondido (principio de transparencia).
//
// DEPENDENCIAS:
//   - sendWhatsAppMessage de ./whatsapp (envío del mensaje)
//   - botLog de ./log (registro estructurado)
//   - ENMANUEL_PHONE constante exportada (consumida también por STAFF_PHONES
//     en webhook.js)

const { sendWhatsAppMessage } = require("./whatsapp");
const { botLog } = require("./log");

const ENMANUEL_PHONE = "18299943102";

async function notifyEnmanuel(senderPhone, userMessage, botReply, signalType, clientMeta) {
  const clientName = clientMeta?.name || "Cliente desconocido";

  let notification = "";
  if (signalType === "hot") {
    notification = "ð¥ LEAD CALIENTE\n\n";
    notification += "Nombre: " + clientName + "\n";
    notification += "TelÃ©fono: " + senderPhone + "\n";
    notification += "Canal: WhatsApp\n\n";
    notification += "Ãltimo mensaje del cliente: " + userMessage.substring(0, 200) + "\n\n";
    notification += "Mi respuesta: " + botReply.substring(0, 300) + "\n\n";
    notification += "AcciÃ³n sugerida: Llamar o escribir directamente para cerrar.";
  } else if (signalType === "escalation") {
    notification = "â ï¸ ESCALAMIENTO\n\n";
    notification += "Nombre: " + clientName + "\n";
    notification += "TelÃ©fono: " + senderPhone + "\n";
    notification += "Canal: WhatsApp\n\n";
    notification += "Ãltimo mensaje: " + userMessage.substring(0, 200) + "\n\n";
    notification += "RazÃ³n: El cliente necesita atenciÃ³n humana directa.";
  }

  try {
    await sendWhatsAppMessage(ENMANUEL_PHONE, notification);
    botLog("info", "Notificacion enviada a Enmanuel", { type: signalType, clientPhone: senderPhone });
  } catch (e) {
    console.error("Error notificando a Enmanuel:", e.message);
  }
}

async function notifyEnmanuelBooking(senderPhone, booking, clientMeta, projectName) {
  const clientName = clientMeta?.name && clientMeta.name !== "Desconocido" ? clientMeta.name : "Cliente";

  let fechaLegible = booking.atRaw;
  if (booking.at) {
    try {
      fechaLegible = new Date(booking.at).toLocaleString("es-DO", {
        timeZone: "America/Santo_Domingo",
        weekday: "long",
        day: "numeric",
        month: "long",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
    } catch (e) {
      fechaLegible = booking.atRaw;
    }
  }

  // wa.me link para que Enmanuel abra el chat con un tap
  const waLink = "https://wa.me/" + senderPhone;

  let notif = "NUEVA VISITA AGENDADA\n\n";
  notif += "Cliente: " + clientName + "\n";
  notif += "Telefono: " + senderPhone + "\n";
  notif += "Proyecto: " + projectName + "\n";
  notif += "Cuando: " + fechaLegible + "\n";
  if (booking.notas) notif += "Notas: " + booking.notas + "\n";
  notif += "\nAbrir chat: " + waLink + "\n\n";
  notif += "Accion sugerida: confirmar manana con el cliente y preparar la visita.";

  try {
    await sendWhatsAppMessage(ENMANUEL_PHONE, notif);
    botLog("info", "Visita agendada notificada", { phone: senderPhone, project: booking.project, at: booking.at });
  } catch (e) {
    console.error("Error notificando visita:", e.message);
  }
}

// ============================================
// NOTIFICACIONES NUEVAS (Día 3) — Descuento ofrecido + Recomendación competencia
// ============================================
// Alimentadas por el pipeline <perfil_update> en src/handlers/message.js.
// Pattern: el caller detecta el evento y dispara la notificación. Fail-open:
// si el envío cae, logueamos pero el flujo del cliente sigue.

// Detecta si la respuesta de Mateo contiene una oferta explícita de descuento.
// Retorna {monto, contexto} si detecta, null si no. El monto se extrae como
// número (USD) o se infiere de palabras ("mil", "dos mil"). Solo cubre
// patrones comunes de oferta — no pretende ser exhaustivo.
function detectDiscountOffer(botReply) {
  if (typeof botReply !== "string" || botReply.length === 0) return null;
  const text = botReply.toLowerCase();

  // Patrones numéricos: $500, $1,000, $2000, US$1500.
  // [0-9][0-9,.]{0,9} matches secuencias como "500", "2000", "1,000", "156,000";
  // el filtro numérico de rango (500–5000) descarta precios de unidades.
  const numericMatch = text.match(/(?:us\$|u\$|\$)\s*([0-9][0-9,.]{0,9})/);
  if (numericMatch) {
    const raw = numericMatch[1].replace(/[,.]/g, "");
    const monto = parseInt(raw, 10);
    if (!isNaN(monto) && monto >= 500 && monto <= 5000) {
      // Rango razonable de descuento. Mayor a $5K probablemente es precio de
      // unidad, no descuento — se ignora.
      return { monto, contexto: botReply.slice(0, 300) };
    }
  }

  // Patrones en letra ("mil", "dos mil") solo si co-ocurren con palabras de
  // descuento para no gatillar por "2027" o cantidades no-descuento.
  const discountWords = ["descuento", "rebaja", "te bajo", "te doy", "te quito"];
  const mentionsDiscount = discountWords.some((w) => text.includes(w));
  if (mentionsDiscount) {
    if (/\bdos\s+mil\b/.test(text)) return { monto: 2000, contexto: botReply.slice(0, 300) };
    if (/\bmil\b/.test(text)) return { monto: 1000, contexto: botReply.slice(0, 300) };
    if (/\bquinientos\b/.test(text)) return { monto: 500, contexto: botReply.slice(0, 300) };
  }

  return null;
}

async function notifyDescuentoOfrecido(senderPhone, monto, contexto, clientMeta) {
  const clientName = clientMeta?.name && clientMeta.name !== "Desconocido" ? clientMeta.name : "Cliente";
  const waLink = "https://wa.me/" + senderPhone;

  let notif = "DESCUENTO OFRECIDO POR MATEO\n\n";
  notif += "Cliente: " + clientName + "\n";
  notif += "Telefono: " + senderPhone + "\n";
  notif += "Monto: US$" + monto + "\n\n";
  if (contexto) notif += "Contexto: " + contexto.slice(0, 300) + "\n\n";
  notif += "Abrir chat: " + waLink + "\n\n";
  notif += "Accion sugerida: confirmar si el descuento cerro la venta.";

  try {
    await sendWhatsAppMessage(ENMANUEL_PHONE, notif);
    botLog("info", "Descuento notificado a Enmanuel", {
      clientPhone: senderPhone,
      monto,
    });
  } catch (e) {
    console.error("Error notificando descuento:", e.message);
  }
}

async function notifyRecomendacionCompetencia(senderPhone, motivo, clientMeta) {
  const clientName = clientMeta?.name && clientMeta.name !== "Desconocido" ? clientMeta.name : "Cliente";
  const waLink = "https://wa.me/" + senderPhone;

  let notif = "MATEO RECOMENDO COMPETENCIA\n\n";
  notif += "Cliente: " + clientName + "\n";
  notif += "Telefono: " + senderPhone + "\n";
  if (motivo) notif += "Motivo: " + motivo.slice(0, 300) + "\n\n";
  notif += "Abrir chat: " + waLink + "\n\n";
  notif += "Cliente fuera de fit JPREZ. Accion sugerida: revisar si hubo oportunidad real o fue mismatch claro.";

  try {
    await sendWhatsAppMessage(ENMANUEL_PHONE, notif);
    botLog("info", "Recomendacion de competencia notificada a Enmanuel", {
      clientPhone: senderPhone,
    });
  } catch (e) {
    console.error("Error notificando recomendacion competencia:", e.message);
  }
}

module.exports = {
  ENMANUEL_PHONE,
  notifyEnmanuel,
  notifyEnmanuelBooking,
  notifyDescuentoOfrecido,
  notifyRecomendacionCompetencia,
  detectDiscountOffer,
};
