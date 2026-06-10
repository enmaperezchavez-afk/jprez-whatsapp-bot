// src/fetch-capped.js — Hotfix-31.
//
// Lee el body de un fetch Response con tope de bytes. Los proxies
// /api/pdf y /api/img cargaban el archivo entero en memoria sin límite
// (response.arrayBuffer()), lo que permitía agotar la memoria de la
// función serverless apuntando el proxy a un archivo gigante de Drive.
//
// Retorna Buffer, o null si el archivo excede maxBytes (declarado en
// Content-Length o medido durante el streaming). Salir del for-await
// con return cancela el stream automáticamente (iterator.return()).

async function readBodyCapped(response, maxBytes) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) return null;

  if (!response.body) {
    const buf = Buffer.from(await response.arrayBuffer());
    return buf.length > maxBytes ? null : buf;
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) return null;
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

module.exports = { readBodyCapped };
