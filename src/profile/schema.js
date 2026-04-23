// src/profile/schema.js — Enums del bloque <perfil_update> que emite Mateo.
//
// CONTRATO: módulo hoja (LEAF). Solo exporta constantes. Cero I/O, cero
// dependencias internas. Importable desde cualquier módulo sin riesgo de
// ciclos.
//
// Por qué enums explícitos:
//   - El prompt v5.2 documenta los valores permitidos a Claude, pero
//     Claude puede alucinar valores nuevos. Validamos acá antes de
//     persistir para que no se filtre basura al Redis profile:<phone>.
//   - Un enum desconocido bloquea la escritura del campo entero (no
//     todo el perfil) — degradación granular en storage.js.
//
// AGREGAR UN VALOR:
//   1) Extender el array acá (agregar al final).
//   2) Documentar el valor en src/prompts.js (sección <perfil_update>).
//   3) Si el nuevo valor dispara un side-effect (como
//      "recomendar_competencia" → notifyRecomendacionCompetencia), agregar
//      el branch en src/handlers/message.js.
//   4) Agregar test en tests/profile-schema.test.mjs.

const INTENCION_COMPRA = ["explorando", "calificando", "negociando", "listo_cerrar"];

const SCORE_LEAD = ["frio", "tibio", "caliente", "ardiente"];

const SIGUIENTE_ACCION = [
  "send_brochure",
  "schedule_visit",
  "calculate_plan",
  "escalate_enmanuel",
  "followup_3d",
  "followup_1w",
  "recomendar_competencia",
  "none",
];

module.exports = { INTENCION_COMPRA, SCORE_LEAD, SIGUIENTE_ACCION };
