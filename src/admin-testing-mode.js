// src/admin-testing-mode.js — Modo testing para admin.
//
// OBJETIVO: permitir al admin (Enmanuel) activar un modo donde sus
// mensajes se procesan como si fuera un cliente nuevo. Útil para
// smoke-testear el flujo completo de Mateo Reyes desde su propio
// WhatsApp sin crear usuarios ficticios.
//
// ARQUITECTURA — "Phone swap B3" (decidido en auditoría hotfix-6):
//   - El phone REAL del admin (ej. "18299943102") se preserva para
//     I/O con la Meta WhatsApp API (sendWhatsAppMessage, etc.).
//   - Un "storageKey" derivado ("testing:18299943102") reemplaza al
//     phone en todos los lookups de Redis: history (chat:), metadata
//     (meta:), profile (profile:), rate limit counter, etc.
//   - Como "testing:18299943102" NO está en STAFF_PHONES, el pipeline
//     lo trata automáticamente como cliente (sin bypass de rate
//     limit, sin SUPERVISOR_PROMPT, con profile, con holding mode).
//
// CONTRATO:
//   isActive(phone): Promise<boolean>
//   activate(phone): Promise<{ ok, reason?, ttlSec? }>
//     - Rate limit: ADMIN_TESTING_RATE_LIMIT_MAX activaciones por
//       ADMIN_TESTING_RATE_LIMIT_WINDOW_SECONDS.
//     - Sólo funciona si phone está en STAFF_PHONES. Si un cliente
//       normal manda /test-on, el caller debe IGNORAR el comando
//       y dejar pasar el mensaje al pipeline normal — este módulo
//       retorna {ok:false, reason:"not_admin"} como señal, no como
//       respuesta para el cliente.
//   deactivate(phone): Promise<{ ok, reason? }>
//     - Borra el flag + limpia la caja testing (chat/meta/profile
//       bajo testing:<phone>).
//   getStatus(phone): Promise<{ active, admin, minutesRemaining? }>
//   getStorageKey(phone, inTesting): string
//     - Helper puro, sin I/O. Retorna "testing:<phone>" si inTesting,
//       else phone. Se usa en el pipeline para elegir storage key
//       sin hacer Redis call duplicado.
//
// SEGURIDAD:
//   - Comandos /test-* sólo tienen efecto para números en STAFF_PHONES.
//   - El flag se guarda en admin:testing-mode:<phone> con TTL 30 min.
//     Si el admin olvida desactivar, el modo expira solo.
//   - Notificaciones a Enmanuel se suprimen cuando Enmanuel está en
//     testing (ver src/notify.js) para evitar loop (admin se notifica
//     a sí mismo como cliente hot).
//
// MÓDULO NO-LEAF: depende de ./store/redis (getRedis compartido) y de ./staff, ./log.

const { getRedis } = require("./store/redis");
const {
  ADMIN_TESTING_MODE_PREFIX,
  ADMIN_TESTING_ACTIVATIONS_PREFIX,
  ADMIN_TESTING_WAS_ACTIVE_PREFIX,
  ADMIN_TESTING_STARTED_PREFIX,
  TESTING_PHONE_PREFIX,
  TESTING_MODE_TTL_SECONDS,
  TESTING_MODE_HARD_CAP_SECONDS,
  ADMIN_TESTING_RATE_LIMIT_MAX,
  ADMIN_TESTING_RATE_LIMIT_WINDOW_SECONDS,
  CHAT_PREFIX,
  META_PREFIX,
  PROFILE_PREFIX,
} = require("./redis-keys");
const { STAFF_PHONES } = require("./staff");
const { botLog } = require("./log");

function isAdmin(phone) {
  return !!(phone && STAFF_PHONES[phone]);
}

async function isActive(phone) {
  if (!phone) return false;
  const r = await getRedis();
  if (!r) return false;
  try {
    const v = await r.get(ADMIN_TESTING_MODE_PREFIX + phone);
    return v === "active";
  } catch (e) {
    console.log("[admin-testing] isActive error:", e.message);
    return false;
  }
}

async function activate(phone) {
  if (!isAdmin(phone)) return { ok: false, reason: "not_admin" };
  const r = await getRedis();
  if (!r) return { ok: false, reason: "redis_unavailable" };

  // Rate limit: max N activaciones por admin por hora.
  const activationsKey = ADMIN_TESTING_ACTIVATIONS_PREFIX + phone;
  try {
    const current = await r.incr(activationsKey);
    if (current === 1) {
      await r.expire(activationsKey, ADMIN_TESTING_RATE_LIMIT_WINDOW_SECONDS);
    }
    if (current > ADMIN_TESTING_RATE_LIMIT_MAX) {
      botLog("warn", "admin_testing_rate_limited", {
        admin: phone,
        attemptsInWindow: current,
        max: ADMIN_TESTING_RATE_LIMIT_MAX,
      });
      return {
        ok: false,
        reason: "rate_limit",
        max: ADMIN_TESTING_RATE_LIMIT_MAX,
        windowSec: ADMIN_TESTING_RATE_LIMIT_WINDOW_SECONDS,
      };
    }
  } catch (e) {
    // Fail-open en el counter: si Redis falla acá, permitimos la
    // activación. El counter es de abuso, no de seguridad crítica.
    console.log("[admin-testing] activations counter error:", e.message);
  }

  try {
    await r.set(ADMIN_TESTING_MODE_PREFIX + phone, "active", {
      ex: TESTING_MODE_TTL_SECONDS,
    });
    // Hotfix-32: flags de soporte (best-effort, no bloquean la activación).
    //   was-active: sobrevive a la expiración del modo para anunciar el
    //     flip en el PRÓXIMO mensaje (TTL = hard cap + margen de 24h para
    //     que el aviso llegue aunque el admin vuelva horas después).
    //   started: ancla del tope duro de la renovación deslizante.
    try {
      const supportTtl = TESTING_MODE_HARD_CAP_SECONDS + 24 * 3600;
      await r.set(ADMIN_TESTING_WAS_ACTIVE_PREFIX + phone, "1", { ex: supportTtl });
      await r.set(ADMIN_TESTING_STARTED_PREFIX + phone, String(Date.now()), { ex: supportTtl });
    } catch (e) {
      console.log("[admin-testing] support flags error:", e.message);
    }
  } catch (e) {
    console.log("[admin-testing] activate set error:", e.message);
    return { ok: false, reason: "redis_write_error" };
  }

  const expiresAtMs = Date.now() + TESTING_MODE_TTL_SECONDS * 1000;
  botLog("info", "admin_testing_on", {
    admin: phone,
    timestamp: new Date().toISOString(),
    ttlSec: TESTING_MODE_TTL_SECONDS,
  });
  return { ok: true, ttlSec: TESTING_MODE_TTL_SECONDS, expiresAtMs };
}

async function deactivate(phone) {
  if (!isAdmin(phone)) return { ok: false, reason: "not_admin" };
  const r = await getRedis();
  if (!r) return { ok: false, reason: "redis_unavailable" };

  try {
    await r.del(ADMIN_TESTING_MODE_PREFIX + phone);
    // Hotfix-32: salida EXPLÍCITA no anuncia expiración — limpiar flags.
    await r.del(ADMIN_TESTING_WAS_ACTIVE_PREFIX + phone);
    await r.del(ADMIN_TESTING_STARTED_PREFIX + phone);
    // Limpiar la caja testing (chat, meta, profile bajo storage key
    // "testing:<phone>"). Sin esto queda basura hasta que los TTLs
    // individuales expiren (30d/90d).
    const storageKey = TESTING_PHONE_PREFIX + phone;
    await r.del(CHAT_PREFIX + storageKey);
    await r.del(META_PREFIX + storageKey);
    await r.del(PROFILE_PREFIX + storageKey);
  } catch (e) {
    console.log("[admin-testing] deactivate error:", e.message);
    return { ok: false, reason: "redis_del_error" };
  }

  botLog("info", "admin_testing_off", {
    admin: phone,
    timestamp: new Date().toISOString(),
  });
  return { ok: true };
}

async function getStatus(phone) {
  if (!isAdmin(phone)) return { active: false, admin: false };
  const r = await getRedis();
  if (!r) return { active: false, admin: true, error: "redis_unavailable" };

  try {
    const ttl = await r.ttl(ADMIN_TESTING_MODE_PREFIX + phone);
    // @upstash/redis devuelve -2 si la key no existe, -1 si existe sin TTL.
    if (typeof ttl !== "number" || ttl <= 0) {
      return { active: false, admin: true };
    }
    return {
      active: true,
      admin: true,
      secondsRemaining: ttl,
      minutesRemaining: Math.ceil(ttl / 60),
    };
  } catch (e) {
    console.log("[admin-testing] getStatus error:", e.message);
    return { active: false, admin: true, error: "redis_error" };
  }
}

function getStorageKey(phone, inTesting) {
  return inTesting ? TESTING_PHONE_PREFIX + phone : phone;
}

// ============================================================
// Hotfix-32 — expiración anunciada + renovación deslizante
// ============================================================

// consumeExpiredFlag: true UNA sola vez si el modo testing del admin
// expiró por TTL (no por /test-off). El caller antepone el aviso
// "⏰ tu sesión terminó" al procesamiento normal del mensaje. Consumir
// borra el flag: cero avisos repetidos. Best-effort: ante cualquier
// error devuelve false (nunca rompe el turno).
async function consumeExpiredFlag(phone) {
  if (!isAdmin(phone)) return false;
  const r = await getRedis();
  if (!r) return false;
  try {
    const active = await r.get(ADMIN_TESTING_MODE_PREFIX + phone);
    if (active === "active") return false; // sigue viva, nada que anunciar
    const was = await r.get(ADMIN_TESTING_WAS_ACTIVE_PREFIX + phone);
    if (!was) return false;
    await r.del(ADMIN_TESTING_WAS_ACTIVE_PREFIX + phone);
    await r.del(ADMIN_TESTING_STARTED_PREFIX + phone);
    botLog("info", "admin_testing_expired_announced", {
      admin: phone,
      timestamp: new Date().toISOString(),
    });
    return true;
  } catch (e) {
    console.log("[admin-testing] consumeExpiredFlag error:", e.message);
    return false;
  }
}

// renewIfActive: renovación deslizante — cada mensaje del admin en modo
// testing re-arma el TTL de 30 min, con tope DURO de 2h desde la
// activación (la sesión vive mientras se usa, nunca infinita). Devuelve
// { renewed, hardCapReached }. Best-effort.
async function renewIfActive(phone) {
  if (!isAdmin(phone)) return { renewed: false, hardCapReached: false };
  const r = await getRedis();
  if (!r) return { renewed: false, hardCapReached: false };
  try {
    const active = await r.get(ADMIN_TESTING_MODE_PREFIX + phone);
    if (active !== "active") return { renewed: false, hardCapReached: false };
    const started = Number(await r.get(ADMIN_TESTING_STARTED_PREFIX + phone));
    // Sin ancla (sesión pre-Hotfix-32): no renovar, muere a su TTL original.
    if (!Number.isFinite(started) || started <= 0) {
      return { renewed: false, hardCapReached: false };
    }
    const elapsedSec = (Date.now() - started) / 1000;
    if (elapsedSec >= TESTING_MODE_HARD_CAP_SECONDS) {
      return { renewed: false, hardCapReached: true };
    }
    // El TTL renovado nunca pasa del tope duro.
    const ttl = Math.min(
      TESTING_MODE_TTL_SECONDS,
      Math.max(1, Math.round(TESTING_MODE_HARD_CAP_SECONDS - elapsedSec))
    );
    await r.expire(ADMIN_TESTING_MODE_PREFIX + phone, ttl);
    return { renewed: true, hardCapReached: false, ttlSec: ttl };
  } catch (e) {
    console.log("[admin-testing] renewIfActive error:", e.message);
    return { renewed: false, hardCapReached: false };
  }
}

// formatHoraRD: "hasta la 1:25 PM" — hora de República Dominicana
// (America/Santo_Domingo, UTC-4 sin DST). Puro, exportado para test.
function formatHoraRD(dateMs) {
  return new Date(dateMs).toLocaleTimeString("es-DO", {
    timeZone: "America/Santo_Domingo",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

const TESTING_EXPIRED_ANNOUNCEMENT =
  "⏰ Tu sesión de prueba (30 min) terminó — estás de vuelta en modo supervisor. " +
  "Manda /test-on para otra ronda.";

module.exports = {
  isActive,
  activate,
  deactivate,
  getStatus,
  getStorageKey,
  isAdmin,
  // Hotfix-32
  consumeExpiredFlag,
  renewIfActive,
  formatHoraRD,
  TESTING_EXPIRED_ANNOUNCEMENT,
};
