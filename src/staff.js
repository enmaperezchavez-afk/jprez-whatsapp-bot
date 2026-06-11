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
    name: "Enmanuel Pérez Chávez",
    role: "director",
    supervisor: true,
  },
};

// ADMIN_PHONES (Sprint1.8 PR-2): lista blanca de números con permiso de
// ESCRITURA al inventario vía lenguaje natural (texto o audio). Separada
// de STAFF_PHONES a propósito: ser staff da modo supervisor; escribir el
// Sheet con frases naturales exige estar AQUÍ. La autorización es SOLO
// por número verificado de WhatsApp — conocer la sintaxis no da poder.
// Hoy: solo el Director.
const ADMIN_PHONES = [ENMANUEL_PHONE];

module.exports = { STAFF_PHONES, ADMIN_PHONES };
