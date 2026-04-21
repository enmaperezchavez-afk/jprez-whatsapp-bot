// src/store/meta.js — Metadata del cliente (meta:<phone>).
//
// CONTRATO:
//   saveClientMeta(phone, meta): Promise<object>
//     Merge-on-write: lee el existing, hace spread + nuevos campos + pisa
//     lastContact con timestamp actual, guarda con TTL 90 días.
//     Retorna el objeto merged. Fail-open: si Redis falla, retorna el meta
//     pasado sin persistir (NO hay fallback a RAM para meta).
//
//   getClientMeta(phone): Promise<object | null>
//     Lee meta:<phone>. Retorna null si no existe, Redis falla, o catch.
//
//   markDocSent(phone, docKey): Promise<void>
//     Helper: marca un docKey como enviado con timestamp. Compone getClientMeta
//     + saveClientMeta internamente.
//
// NAMESPACE: meta:<phone>. TTL: 90 días (7776000s). Ver skill §2.
// FORMATO: objeto plano, serializado con JSON.stringify. Parseo defensivo.
// Campos típicos: name, temperature, hotDetectedAt, escalated, escalatedAt,
//   lastReminderAt, scheduledVisit, sentDocs, lastContact.
//
// lastContact SIEMPRE se pisa en cada save. followup.js usa un variant que
// NO pisa lastContact (porque el cron no es interacción del cliente) — esa
// variante NO está en este módulo, vive en api/followup.js.
//
// LOGS: console.log directo (NO botLog) — preservado byte-exact desde extract.
//
// NO ES LEAF: depende de src/store/redis (getRedis).

const { getRedis } = require("./redis");

// ============================================
// METADATA DEL CLIENTE (meta:<phone>)
// ============================================

// Guardar metadata del cliente (nombre, intereses, temperatura, etc.)
async function saveClientMeta(phone, meta) {
  const redis = await getRedis();
  if (redis) {
    try {
      const existing = await redis.get("meta:" + phone);
      const current = existing ? (typeof existing === "string" ? JSON.parse(existing) : existing) : {};
      const updated = { ...current, ...meta, lastContact: new Date().toISOString() };
      await redis.set("meta:" + phone, JSON.stringify(updated), { ex: 7776000 }); // 90 dias
      return updated;
    } catch (e) {
      console.log("Error guardando metadata:", e.message);
    }
  }
  return meta;
}

async function getClientMeta(phone) {
  const redis = await getRedis();
  if (redis) {
    try {
      const meta = await redis.get("meta:" + phone);
      if (meta) {
        return typeof meta === "string" ? JSON.parse(meta) : meta;
      }
    } catch (e) {
      console.log("Error leyendo metadata:", e.message);
    }
  }
  return null;
}

async function markDocSent(phone, docKey) {
  const meta = (await getClientMeta(phone)) || {};
  const sentDocs = { ...(meta.sentDocs || {}), [docKey]: new Date().toISOString() };
  await saveClientMeta(phone, { sentDocs });
}

module.exports = { saveClientMeta, getClientMeta, markDocSent };
