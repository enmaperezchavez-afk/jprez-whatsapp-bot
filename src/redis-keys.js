// src/redis-keys.js — Constantes de prefijos de claves Redis.
//
// POR QUÉ UN MÓDULO APARTE: los prefijos viven repartidos en stores
// (chat:, meta:, profile:), security (processed:, ratelimit:) y ahora
// admin-testing (admin:testing-mode:, admin:testing-activations:,
// testing:). Un solo source-of-truth evita typos en strings mágicos
// y facilita renombrar namespaces en el futuro.
//
// CONTRATO: sólo strings + números. Sin side effects. Sin I/O.

module.exports = {
  // Stores existentes (documentados, no se consumen todavía desde aquí —
  // los stores mantienen sus literales por compat; este módulo sólo
  // agrega los prefijos NUEVOS del hotfix-6 + expone los viejos como
  // referencia central).
  CHAT_PREFIX: "chat:",
  META_PREFIX: "meta:",
  PROFILE_PREFIX: "profile:",
  PROCESSED_PREFIX: "processed:",
  RATELIMIT_PREFIX: "ratelimit:",

  // Admin testing mode (hotfix-6). Phone swap B3.
  ADMIN_TESTING_MODE_PREFIX: "admin:testing-mode:",
  ADMIN_TESTING_ACTIVATIONS_PREFIX: "admin:testing-activations:",
  TESTING_PHONE_PREFIX: "testing:",

  // Parámetros del modo testing
  TESTING_MODE_TTL_SECONDS: 1800, // 30 minutos
  ADMIN_TESTING_RATE_LIMIT_MAX: 5,
  ADMIN_TESTING_RATE_LIMIT_WINDOW_SECONDS: 3600, // 1 hora
};
