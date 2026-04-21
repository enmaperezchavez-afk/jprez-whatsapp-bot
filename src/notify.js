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

module.exports = { ENMANUEL_PHONE, notifyEnmanuel, notifyEnmanuelBooking };
