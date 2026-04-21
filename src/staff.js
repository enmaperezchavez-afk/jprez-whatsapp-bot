// src/staff.js — Personal autorizado JPREZ (consumido por handler para
//                 rate-limit bypass + handlers/message.js para detección
//                 de modo supervisor).
//
// CONTRATO:
//   STAFF_PHONES: { [phone]: { name, role, supervisor } }
//
// POR QUÉ MODULO SEPARADO: shared between webhook (rate limit bypass)
// and src/handlers/message.js (supervisor detection). Avoids duplication
// and keeps single source of truth.
//
// MÓDULO LEAF (excepto la dependencia de ENMANUEL_PHONE de notify).

const { ENMANUEL_PHONE } = require("./notify");

const STAFF_PHONES = {
  [ENMANUEL_PHONE]: {
    name: "Enmanuel PÃ©rez ChÃ¡vez",
    role: "director",
    supervisor: true,
  },
};

module.exports = { STAFF_PHONES };
