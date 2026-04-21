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
//
// DEUDA TECNICA CONOCIDA: mojibake (informaciÃ³n, catÃ¡logo, paraÃ­so, etc.)
// preservado byte-exact desde webhook — arreglar en commit separado de
// normalizacion de encoding (NO parte del refactor estructural).

// ============================================
// DETECCION INTELIGENTE DE DOCUMENTOS
// ============================================

function detectDocumentRequest(botReply, userMessage) {
  const botText = botReply.toLowerCase();
  const userText = userMessage.toLowerCase();
  const combined = botText + " " + userText;

  const botSendPhrases = [
    "te lo envio", "te lo mando", "te envio", "aqui te mando",
    "te lo paso", "te mando el", "te mando la", "te mando los",
    "te envio el", "te envio la", "te envio los",
  ];

  const clientRequestWords = [
    "pdf", "brochure", "plano", "planos", "precio", "precios",
    "listado", "documento", "informacion", "informaciÃ³n", "info",
    "ficha", "catalogo", "catÃ¡logo", "enviame", "envÃ­ame",
    "mandame", "mÃ¡ndame", "pasame", "pÃ¡same", "quiero ver",
    "me puedes enviar", "me puedes mandar", "tienes material", "presentacion", "presentaciÃ³n", "presentaciones",
  ];

  const botConfirmsSend = botSendPhrases.some((p) => botText.includes(p));
  const clientRequestsDoc = clientRequestWords.some((w) => userText.includes(w));

  if (!botConfirmsSend) return null;

  const projectKeywords = {
    crux: ["crux", "crux del prado", "torre 6", "santo domingo norte", "colinas"],
    pr3: ["pr3", "prado 3", "prado residences 3", "prado residences iii", "prado iii", "churchill", "paraiso", "paraÃ­so", "ensanche paraiso"],
    pr4: ["pr4", "prado 4", "prado residences 4", "prado residences iv", "prado iv", "evaristo", "evaristo morales"],
    puertoPlata: ["puerto plata", "playa dorada", "prado suites", "prado suites puerto plata", "etapa 3", "etapa 4", "etapa 3 y 4"],
  };

  for (const [project, words] of Object.entries(projectKeywords)) {
    if (words.some((w) => combined.includes(w))) {
      return project;
    }
  }

  // No project matched but docs requested - send all
  return "all";
}

function detectDocumentType(botReply, userMessage) {
  const combined = (botReply + " " + userMessage).toLowerCase();
  const types = [];

  if (combined.includes("brochure") || combined.includes("catalogo") || combined.includes("catÃ¡logo") || combined.includes("ficha") || combined.includes("presentacion") || combined.includes("presentaciones")) {
    types.push("brochure");
  }
  if (combined.includes("precio") || combined.includes("listado") || combined.includes("costo") || combined.includes("cuanto") || combined.includes("cuÃ¡nto")) {
    types.push("precios");
  }
  if (combined.includes("plano") || combined.includes("distribucion") || combined.includes("distribuciÃ³n") || combined.includes("layout")) {
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

module.exports = { detectDocumentRequest, detectDocumentType, detectLeadSignals };
