// src/security/safe-compare.js — Hotfix-31.
//
// Comparación de secretos en tiempo constante. `===` corta en el primer
// byte distinto, lo que permite timing attacks para descubrir un token
// carácter a carácter. crypto.timingSafeEqual exige buffers del mismo
// largo, así que hasheamos ambos lados con SHA-256: iguala longitudes
// sin filtrar el largo real del secreto.

const crypto = require("crypto");

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length === 0 || b.length === 0) return false;
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = { safeEqual };
