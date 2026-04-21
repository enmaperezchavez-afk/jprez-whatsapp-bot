// src/proxy.js — Helpers para URLs del proxy de Google Drive.
//
// POR QUÉ EXISTE ESTE PROXY: WhatsApp Cloud API necesita recibir una URL
// que sirva el contenido REAL (PDF o imagen) con el Content-Type correcto.
// Google Drive, en cambio, responde HTML envuelto ("Open with Docs") cuando
// se le pide una URL directa. Por eso tenemos dos endpoints internos:
//   - /api/pdf?id=<driveId> → devuelve el PDF real
//   - /api/img?id=<driveId> → devuelve la imagen real
// Los endpoints viven en api/pdf.js y api/img.js. Este módulo solo se
// ocupa de CONSTRUIR las URLs que apuntan a ellos.

// NOTA: VERCEL_DOMAIN hardcoded a propósito.
// Vercel expone VERCEL_URL como env var en runtime, pero esa cambia
// con cada preview deployment (ej: jprez-bot-git-feature-xyz.vercel.app).
// El proxy necesita un dominio ESTABLE porque las URLs viven dentro de
// mensajes de WhatsApp ya enviados al cliente — si el dominio cambia,
// los PDFs viejos quedan rotos.
// Si en el futuro renombramos el proyecto Vercel, hay que actualizar
// esta constante y redeployar TODO el bot (los mensajes viejos se mueren).
const VERCEL_DOMAIN = "https://v0-meta-whatsapp-webhook.vercel.app";

// Extrae el ID de una URL de Google Drive en cualquier formato comun
// (?id=XXX, /file/d/XXX/, /open?id=XXX, etc.)
function extractDriveId(url) {
  if (!url) return null;
  const queryMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (queryMatch) return queryMatch[1];
  const pathMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (pathMatch) return pathMatch[1];
  return null;
}

// Convierte URL de Google Drive a URL de nuestro proxy de PDFs
function toProxyUrl(driveUrl) {
  if (!driveUrl) return null;
  const id = extractDriveId(driveUrl);
  if (id) return VERCEL_DOMAIN + "/api/pdf?id=" + id;
  return driveUrl;
}

// Convierte URL de Google Drive a URL de nuestro proxy de imagenes
function toImageProxyUrl(url) {
  if (!url) return null;
  const id = extractDriveId(url);
  if (id) return VERCEL_DOMAIN + "/api/img?id=" + id;
  return url;
}

module.exports = { extractDriveId, toProxyUrl, toImageProxyUrl };
