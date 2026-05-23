// src/whatsapp-media.js — Bloque 2.
//
// API de alto nivel para enviar media (documentos/imágenes) por WhatsApp.
// Delega en el driver canónico del canal (src/whatsapp.js) para NO duplicar
// la mecánica HTTP (token, phoneNumberId, endpoint, manejo de errores).
//
// Firmas pensadas para el tool handler enviar_documento:
//   sendDocument(phone, documentUrl, filename, caption)
//   sendImage(phone, imageUrl, caption)
//
// La URL debe ser pública y servir el binario real con Content-Type correcto:
//   - Brochures (Drive): vía proxy /api/pdf?id=<driveId>
//   - Listados de precios: vía /api/price-list?proyecto=<id> (PDF on-the-fly)

const { sendWhatsAppDocument, sendWhatsAppImage } = require("./whatsapp");

// sendDocument: envía un PDF/documento al cliente. caption opcional.
async function sendDocument(phone, documentUrl, filename, caption) {
  return sendWhatsAppDocument(phone, documentUrl, filename, caption);
}

// sendImage: envía una imagen al cliente. caption opcional.
async function sendImage(phone, imageUrl, caption) {
  return sendWhatsAppImage(phone, imageUrl, caption);
}

module.exports = { sendDocument, sendImage };
