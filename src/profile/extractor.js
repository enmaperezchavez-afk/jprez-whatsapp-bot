// src/profile/extractor.js — Parser del bloque <perfil_update> que emite Mateo.
//
// CONTRATO:
//   extractProfileUpdate(claudeResponse): { json, cleanedText }
//     - json: objeto parseado del JSON dentro del bloque, o null si no hay
//       bloque o el JSON no parsea.
//     - cleanedText: claudeResponse sin el bloque (ni tags de apertura/cierre).
//       Preserva saltos de linea razonables y hace .trim().
//
//   validateProfileUpdate(json): boolean
//     - true si el objeto cumple el schema minimo + enums validos (cuando
//       estan presentes). Campos desconocidos se permiten (forward compat).
//     - false si json es null/no-objeto, o si un enum declarado tiene
//       valor fuera de los permitidos.
//
//   cleanResponseForWhatsApp(text): string
//     - Alias defensivo de cleanedText: reaplica el strip del bloque por si
//     - el caller ya tiene texto plano y quiere asegurar que nunca sale a WA.
//     - Idempotente: aplicarlo N veces al mismo texto retorna lo mismo.
//
// REGEX:
//   El bloque es <perfil_update>...</perfil_update>. Usamos [\s\S]*? (no
//   greedy, multiline via class-range) para que funcione cross-line sin
//   depender del flag /s. Si aparecen DOS bloques (Mateo se equivoca y emite
//   dos), extractProfileUpdate usa el PRIMERO como canonico y strip-ea
//   ambos del texto final — no queremos filtrar un bloque residual al
//   cliente jamas.
//
// EDGE CASES CUBIERTOS:
//   - Sin bloque: json=null, cleanedText = input.trim()
//   - Bloque vacio (<perfil_update></perfil_update>): json=null, strip
//   - JSON malformado: json=null, strip del bloque igual (no se envia crudo)
//   - Doble bloque: toma el primero, strip todos
//   - Bloque en el medio del texto (no solo al final): se extrae y strip
//   - Espacios/saltos alrededor: tolerados
//
// DEPENDENCIAS: schema.js (solo para validateProfileUpdate).
//
// MODULO HOJA: cero I/O, cero Redis, cero red. Testeable sin mocks.

const { INTENCION_COMPRA, SCORE_LEAD, SIGUIENTE_ACCION } = require("./schema");

const PERFIL_UPDATE_RE = /<perfil_update>\s*([\s\S]*?)\s*<\/perfil_update>/gi;

function extractProfileUpdate(claudeResponse) {
  if (typeof claudeResponse !== "string" || claudeResponse.length === 0) {
    return { json: null, cleanedText: "" };
  }

  // Buscar TODOS los bloques para tomar el primero y strip-ear todos.
  const matches = [];
  let m;
  const re = new RegExp(PERFIL_UPDATE_RE.source, "gi");
  while ((m = re.exec(claudeResponse)) !== null) {
    matches.push(m);
  }

  let json = null;
  if (matches.length > 0) {
    const firstInner = matches[0][1].trim();
    if (firstInner.length > 0) {
      try {
        json = JSON.parse(firstInner);
      } catch (e) {
        // JSON malformado: json queda null, el bloque igual se strip-ea.
        json = null;
      }
    }
  }

  // Strip de TODOS los bloques (tag apertura + contenido + tag cierre).
  // Normalizamos saltos de linea consecutivos que queden tras el strip.
  const cleanedText = claudeResponse
    .replace(new RegExp(PERFIL_UPDATE_RE.source, "gi"), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { json, cleanedText };
}

function validateProfileUpdate(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return false;
  }

  // Campos enum-gateados: si estan presentes, deben ser valores permitidos.
  // Si estan ausentes/null, ignoramos (forward compat).
  if (json.intencion_compra != null && !INTENCION_COMPRA.includes(json.intencion_compra)) {
    return false;
  }
  if (json.score_lead != null && !SCORE_LEAD.includes(json.score_lead)) {
    return false;
  }
  if (json.siguiente_accion_sugerida != null && !SIGUIENTE_ACCION.includes(json.siguiente_accion_sugerida)) {
    return false;
  }

  // Campos array: si estan presentes, deben ser array.
  const arrayFields = ["tags_nuevos", "documentos_solicitados", "competencia_mencionada"];
  for (const f of arrayFields) {
    if (json[f] != null && !Array.isArray(json[f])) {
      return false;
    }
  }

  // objecion_nueva debe ser boolean si esta presente.
  if (json.objecion_nueva != null && typeof json.objecion_nueva !== "boolean") {
    return false;
  }

  return true;
}

function cleanResponseForWhatsApp(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(new RegExp(PERFIL_UPDATE_RE.source, "gi"), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

module.exports = {
  extractProfileUpdate,
  validateProfileUpdate,
  cleanResponseForWhatsApp,
};
