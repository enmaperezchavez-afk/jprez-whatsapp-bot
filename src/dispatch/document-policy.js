// src/dispatch/document-policy.js — Hotfix-21 c1.
//
// Bug #23 (5 mayo 2026): cliente recibio Crux brochure + IMG en mensaje 1.
// Mensaje 2 dijo "en planos". Mateo prometio "te paso la informacion" y el
// dispatcher reenvio EL MISMO brochure + IMG aunque sentDocs ya los tenia.
//
// Causa raiz: la regla "no re-enviar lo ya enviado" vivia SOLO en el prompt
// MATEO_V5_2 (linea 497). Cualquier interpretacion del LLM que privilegiara
// "envia brochure cuando preguntan plano" pisaba la regla. El dispatcher
// post-LLM era ciego a meta.sentDocs — solo lo loggeaba post-envio.
//
// Fix: capa de policy en codigo (no prompt). El dispatcher consulta esta
// funcion ANTES de cada sendWhatsAppDocument. Si docKey ya esta en sentDocs
// y el usuario NO esta pidiendo retransmision explicita, se bloquea.
//
// MODULO HOJA: pure functions, sin I/O, sin Redis, sin async, sin imports
// de dominio. Testeable sin mocks. Patron heredado de src/detect.js.

// Frases que el cliente usa cuando legitimamente pide reenvio del archivo.
// Lista cerrada autorizada por Director (Hotfix-21 brief, 6 mayo 2026):
//   "manda otra vez", "reenvialo", "no me llego", "se borro",
//   "perdi el archivo", "no me lo mandaste", "no lo veo",
//   "no encontre el PDF", "mandame otra vez".
// Variantes con/sin tilde se manejan via stripAccents.
const RETRANSMIT_PHRASES = [
  "manda otra vez",
  "mandalo otra vez",
  "mandame otra vez",
  "envialo otra vez",
  "envia otra vez",
  "reenvia",
  "reenvialo",
  "reenviar",
  "no me llego",
  "no me lo mandaste",
  "no me lo enviaste",
  "se borro",
  "se me borro",
  "perdi el archivo",
  "perdi el pdf",
  "no lo veo",
  "no encontre el pdf",
  "no encuentro el pdf",
];

// Frases que parecen pedir reenvio pero son REFERENCIAS al doc anterior, no
// pedidos. Si aparecen, override RETRANSMIT_PHRASES y NO reenviar. Lista
// cerrada autorizada por Director.
//
// Ejemplo: "el ultimo que mandaste tenia un error" — NO es pedido de reenvio,
// es feedback sobre lo que ya mandamos. "ya me lo mandaste" tampoco — es
// confirmacion de recepcion.
const NOT_RETRANSMIT_PHRASES = [
  "el ultimo que mandaste",
  "como dijiste antes",
  "cuando me mandes",
  "ya me lo mandaste",
];

function stripAccents(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// detectIntentRetransmit: pure boolean. true si el usuario esta pidiendo
// reenvio explicito de un documento. Negative precedence sobre referencias.
function detectIntentRetransmit(userMessage) {
  if (!userMessage || typeof userMessage !== "string") return false;
  const text = stripAccents(userMessage.toLowerCase());
  // Negative precedence: referencias bloquean el match aunque haya retransmit.
  if (NOT_RETRANSMIT_PHRASES.some((p) => text.includes(p))) return false;
  return RETRANSMIT_PHRASES.some((p) => text.includes(p));
}

// shouldSendDoc: decide si enviar un docKey dado el estado actual.
// Contrato:
//   { send: true,  reason: "first-send" }          → docKey nunca enviado
//   { send: true,  reason: "explicit-retransmit" } → enviado pero usuario pide
//   { send: false, reason: "already-sent" }        → enviado y NO pide
//
// docKey: formato "<project>.<docType>" (ej "crux.brochure", "puertoPlata.preciosE4").
// sentDocs: meta.sentDocs (objeto plano docKey → ISO timestamp). null/undefined
//   se trata como objeto vacio (cliente nuevo, nunca recibio nada).
function shouldSendDoc({ sentDocs, docKey, userMessage }) {
  const alreadySent = !!(sentDocs && sentDocs[docKey]);
  if (!alreadySent) {
    return { send: true, reason: "first-send" };
  }
  if (detectIntentRetransmit(userMessage)) {
    return { send: true, reason: "explicit-retransmit" };
  }
  return { send: false, reason: "already-sent" };
}

module.exports = { shouldSendDoc, detectIntentRetransmit };
