// src/detect.js — Detectores puros sobre mensajes.
//
// CONTRATO: todas las funciones exportadas son sincronas y puras:
//   - entrada: strings (botReply, userMessage)
//   - salida: valores primitivos o objetos planos
//   - sin I/O, sin Redis, sin acceso a dominio (PROJECT_NAMES), sin async
//
// Keywords inline en cada funcion para que sean autocontenidas. Si alguna
// lista crece mucho, considerar mover a module-scope antes de duplicarla
// entre funciones. Hoy no hay duplicacion.
//
// MÓDULO HOJA (LEAF): no importa otros módulos del proyecto. Cero ciclos
// posibles. Refactorizable en isolación. Testeable sin mocks.

// ============================================
// DETECCION INTELIGENTE DE DOCUMENTOS
// ============================================

// stripAccents: normaliza diacriticos para que "envío" matchee contra "envio".
// Descubierto durante el hotfix Día 3: Mateo escribe "te envío el brochure"
// con tilde (lo correcto en español) pero las keywords estaban sin acento.
// Normalizamos ambos lados para robustez.
function stripAccents(s) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function detectDocumentRequest(botReply, userMessage) {
  const botText = stripAccents(botReply.toLowerCase());
  const userText = stripAccents(userMessage.toLowerCase());
  const combined = botText + " " + userText;

  const botSendPhrases = [
    "te lo envio", "te lo mando", "te envio", "aqui te mando",
    "te lo paso", "te mando el", "te mando la", "te mando los",
    "te envio el", "te envio la", "te envio los",
  ];

  const clientRequestWords = [
    "pdf", "brochure", "plano", "planos", "precio", "precios",
    "listado", "documento", "informacion", "info",
    "ficha", "catalogo", "enviame",
    "mandame", "pasame", "quiero ver",
    "me puedes enviar", "me puedes mandar", "tienes material", "presentacion", "presentaciones",
  ];

  const botConfirmsSend = botSendPhrases.some((p) => botText.includes(p));
  const clientRequestsDoc = clientRequestWords.some((w) => userText.includes(w));

  if (!botConfirmsSend) return null;

  // Hotfix-19 Bug #5: aliases brutales — PSE3/PSE4 son la abreviatura corta
  // de Prado Suites Etapa 3/4 (Puerto Plata). El cliente las usa por escrito.
  // Pre-fix caian a "all" porque ningun proyecto matcheaba → bot mandaba
  // los 4 brochures cuando solo querian Puerto Plata.
  // ORDEN IMPORTA: aliases mas especificos (PSE3 antes que "etapa 3") evitan
  // colisiones — "pse3" matchea solo Puerto Plata, "etapa 3" sin contexto
  // tambien va a Puerto Plata (E3 es de PP). Iteracion por keys preserva
  // orden de declaracion en JS modernos.
  const projectKeywords = {
    crux: ["crux", "crux del prado", "torre 6", "santo domingo norte", "colinas"],
    pr3: ["pr3", "prado 3", "prado residences 3", "prado residences iii", "prado iii", "churchill", "paraiso", "ensanche paraiso"],
    pr4: ["pr4", "prado 4", "prado residences 4", "prado residences iv", "prado iv", "evaristo", "evaristo morales"],
    puertoPlata: ["pse3", "pse4", "puerto plata", "playa dorada", "prado suites", "prado suites puerto plata", "etapa 3", "etapa 4", "etapa 3 y 4"],
  };

  for (const [project, words] of Object.entries(projectKeywords)) {
    if (words.some((w) => combined.includes(w))) {
      return project;
    }
  }

  // No project matched but docs requested - send all
  return "all";
}

// Hotfix-19 Bug #2: detecta si el cliente pidio una etapa especifica de
// Puerto Plata. Retorna "E3", "E4" o null (ambiguo, mandar ambas como antes).
// Solo aplica cuando project === "puertoPlata"; el caller debe verificar.
function detectPuertoPlataStage(botReply, userMessage) {
  const combined = stripAccents((botReply + " " + userMessage).toLowerCase());
  // E3 keywords explicitos. "pse3" desambigua frente a "etapa 3" si ambos
  // aparecen — preferimos sefial mas precisa.
  const e3Markers = ["pse3", "etapa 3", "e3"];
  const e4Markers = ["pse4", "etapa 4", "e4"];
  const hasE3 = e3Markers.some((w) => combined.includes(w));
  const hasE4 = e4Markers.some((w) => combined.includes(w));
  if (hasE3 && !hasE4) return "E3";
  if (hasE4 && !hasE3) return "E4";
  return null; // ambos o ninguno → mandar las dos (comportamiento previo)
}

function detectDocumentType(botReply, userMessage) {
  const combined = stripAccents((botReply + " " + userMessage).toLowerCase());
  const types = [];

  if (combined.includes("brochure") || combined.includes("catalogo") || combined.includes("ficha") || combined.includes("presentacion") || combined.includes("presentaciones")) {
    types.push("brochure");
  }
  if (combined.includes("precio") || combined.includes("listado") || combined.includes("costo") || combined.includes("cuanto")) {
    types.push("precios");
  }
  if (combined.includes("plano") || combined.includes("distribucion") || combined.includes("layout")) {
    types.push("planos");
  }

  if (types.length === 0) {
    return ["brochure"];
  }

  return types;
}

// ============================================
// DETECCION DE LEAD CALIENTE Y ESCALAMIENTO
// ============================================

function detectLeadSignals(botReply) {
  const isHotLead = botReply.includes("[LEAD_CALIENTE]");
  const needsEscalation = botReply.includes("[ESCALAR]");

  // Parseo de agendamiento: [AGENDAR|proyecto|fecha_iso|notas]
  // notas puede estar vacio y no contener "]"
  let booking = null;
  const bookingMatch = botReply.match(/\[AGENDAR\|([^|\]]+)\|([^|\]]+)\|([^\]]*)\]/);
  if (bookingMatch) {
    const proyecto = bookingMatch[1].trim();
    const fechaIso = bookingMatch[2].trim();
    const notas = (bookingMatch[3] || "").trim();
    const at = new Date(fechaIso);
    booking = {
      project: proyecto,
      at: isNaN(at.getTime()) ? null : at.toISOString(),
      atRaw: fechaIso,
      notas,
      scheduledAt: new Date().toISOString(),
    };
  }

  // Limpiar las etiquetas del mensaje antes de enviarlo al cliente
  const cleanReply = botReply
    .replace(/\[LEAD_CALIENTE\]/g, "")
    .replace(/\[ESCALAR\]/g, "")
    .replace(/\[AGENDAR\|[^\]]*\]/g, "")
    .trim();

  return { isHotLead, needsEscalation, booking, cleanReply };
}

module.exports = { detectDocumentRequest, detectDocumentType, detectLeadSignals, detectPuertoPlataStage };
