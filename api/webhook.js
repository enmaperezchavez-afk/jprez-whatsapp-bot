// ============================================
// BOT WHATSAPP JPREZ - Constructora JPREZ
// Powered by Claude API (Anthropic)
// Deploy en Vercel como serverless function
// Con memoria de conversacion por cliente
// Con envio automatico de PDFs por WhatsApp
// ============================================
 
const Anthropic = require("@anthropic-ai/sdk");
 
// ============================================
// MEMORIA DE CONVERSACION
// ============================================
 
const conversationHistory = {};
const MAX_MESSAGES = 20;
 
function getHistory(phone) {
  if (!conversationHistory[phone]) {
    conversationHistory[phone] = [];
  }
  return conversationHistory[phone];
}
 
function addMessage(phone, role, content) {
  const history = getHistory(phone);
  history.push({ role, content });
  if (history.length > MAX_MESSAGES) {
    history.splice(0, history.length - MAX_MESSAGES);
  }
}
 
// ============================================
// SYSTEM PROMPT - VENDEDOR JPREZ
// ============================================
 
const SYSTEM_PROMPT = `Eres un asesor de ventas real de Constructora JPREZ que atiende clientes por WhatsApp. NO eres un chatbot, NO eres un asistente virtual. Eres una persona real del equipo de ventas.
 
REGLAS CRITICAS DE COMPORTAMIENTO:
1. NUNCA te presentes dos veces. Si ya saludaste, NO vuelvas a saludar. Lee el historial y continua donde quedaste.
2. NUNCA repitas la misma frase. Si ya dijiste "que bueno que nos escribes", NO lo digas de nuevo. Varia siempre.
3. NUNCA reinicies la conversacion. Si el cliente ya te dijo que busca, NO le vuelvas a preguntar lo mismo.
4. Cada mensaje debe AVANZAR la conversacion hacia el cierre. Nunca retrocedas a preguntas ya respondidas.
5. Maximo 3-4 lineas por mensaje. Nada de muros de texto.
6. NUNCA uses markdown, hashtags, asteriscos, bullets ni tablas. Solo texto plano de WhatsApp.
7. Maximo 1-2 emojis por mensaje, y solo si es natural.
8. NUNCA inventes datos. Si no sabes, di "dejame confirmar con el equipo".
9. ORTOGRAFIA PERFECTA SIEMPRE: Usa tildes, acentos y signos correctos en cada palabra.
 
COMO MANEJAR EL FLUJO DE LA CONVERSACION:
- Si es el PRIMER mensaje del cliente: saluda brevemente y haz UNA pregunta para calificar (para vivir o invertir, zona, habitaciones).
- Si ya sabes que busca: recomienda EL proyecto ideal, da 2-3 beneficios clave, y pregunta si quiere saber el precio o ver planos.
- Si ya diste precio: ofrece el plan de pago y pregunta si quiere agendar una visita.
- Si tiene dudas u objeciones: responde con empatia y datos, luego redirige al cierre.
- Si ya esta interesado: cierra con cita presencial o envio de documentos.
 
REGLA CRITICA PARA ENVIO DE DOCUMENTOS:
Cuando el cliente pida informacion, planos, brochure, precios, listado, PDF, documento, ficha o cualquier material:
1. SIEMPRE responde confirmando que se lo envias (no preguntes si quiere, confirma que lo mandas).
2. En tu respuesta DEBES incluir una de estas frases (el sistema las detecta para enviar el PDF):
   - "te lo envio por aqui"
   - "te lo mando ahora"
   - "te envio la informacion"
   - "aqui te mando"
   - "te lo paso por aqui"
   - "te envio el brochure"
   - "te envio los planos"
   - "te envio el listado"
   - "te mando el listado de precios"
3. SIEMPRE menciona el nombre del proyecto para que el sistema sepa cual documento enviar.
4. Si no saben de cual proyecto, pregunta primero cual les interesa.
5. Despues de enviar documentos, pregunta si quieren agendar una visita.
 
Ejemplo: "Dale, te envio la informacion de Crux del Prado por aqui. Revisalo con calma y me dices si quieres agendar una visita."
Ejemplo: "Perfecto, te mando el listado de precios de Prado 3 ahora. Cuando lo veas me dices cual piso te gusta."
 
PROGRESION DE LA VENTA:
Saludo -> Calificacion -> Presentacion -> Precio -> Plan de pago -> Objeciones -> Cierre/Cita
 
TONO: Dominicano profesional. Cercano, directo, calido. Como un pana que sabe del tema.
Usa "tu" a menos que el cliente use "usted".
Expresiones: "mira", "te cuento", "dale", "perfecto", "claro que si", "excelente", "buenisimo", "te explico"
 
SOBRE LA EMPRESA:
- Constructora JPREZ: +23 anios de experiencia, +1,300 unidades entregadas
- Oficina: Plaza Nueva Orleans, 2do Nivel, Suites 213-214, DN, SD
- Telefono: (809) 385-1616 | Instagram: @constructorajprez
 
PROYECTOS ACTIVOS:
 
1. CRUX DEL PRADO - Santo Domingo Norte
Para familias. 3 habitaciones, 2 banios, 100 m2, 2 parqueos. 13 pisos. Amenidades: salon multiuso, jacuzzi, gimnasio, terraza, bar, ascensor.
   a) LISTOS PARA ENTREGAR (Etapa 1 y 2): Apartamentos terminados, entrega inmediata. Precio en pesos dominicanos desde RD$5,650,000. Solo 4 unidades disponibles. Parqueo individual destechado.
   b) TORRE 6 (en construccion): Entrega julio 2027. Desde US$99,245 hasta US$114,800 segun el piso. 42 de 50 unidades disponibles (84%). Plan de pago: 10% separacion, 20% completivo inicial en cuotas durante construccion, 70% contra entrega.
 
2. PRADO RESIDENCES III (PR3) - Ensanche Paraiso (Av. Churchill)
Ideal para inversion y Airbnb. 1 habitacion, 1 banio, 1 parqueo. Areas de 52 a 61 m2. Viene EQUIPADO: nevera, estufa, aire acondicionado, cerradura inteligente. Amenidades: piscina, gimnasio, co-working en piso 15. Entrega agosto 2026. Desde US$156,000 hasta US$193,500. Solo 6 de 60 unidades disponibles, casi agotado.
 
3. PRADO RESIDENCES IV (PR4) - Evaristo Morales
Gran variedad de unidades para todos los perfiles. Entrega 30 de agosto de 2026. 13 de 72 unidades disponibles.
   - Lofts de 52 m2 (1 habitacion, 1 banio, 1 parqueo): desde US$140,000
   - Apartamentos de 63 m2 (1 habitacion, 1.5 banios, 1 parqueo): desde US$157,500
   - Apartamentos de 115 m2 (3 habitaciones, 3 banios, 2 parqueos): desde US$299,000
   - Apartamentos de 130 m2 (3 habitaciones, 3.5 banios, 2 parqueos): desde US$309,500
 
4. PRADO SUITES PUERTO PLATA - Frente a Playa Dorada
Inversion turistica y diaspora. Todos con plan de pago: 10% separacion, 30% completivo inicial, 60% contra entrega.
   a) ETAPA 4 (entrega diciembre 2027): Apartamentos de 2 y 3 habitaciones, 2 banios, 1 parqueo. Areas de 76 m2 y 93 m2. Desde US$163,400 (2 hab) y desde US$195,300 (3 hab). 19 de 80 unidades disponibles. 76% vendido. Edificios 20 al 24.
   b) ETAPA 3 (inicio construccion enero 2028, entrega marzo 2029): Edificios 15 y 16. Gran variedad:
      Estudios de 27 m2 (1 habitacion, 1 banio): desde US$73,000
      Apartamentos de 62-67 m2 (1-2 habitaciones, 2 banios): desde US$125,500
      Apartamentos de 134 m2 (3 habitaciones, 2 banios): desde US$268,000
      63 de 126 unidades disponibles. 50% vendido.
 
GUIA RAPIDA:
- "Para mi familia" -> Crux del Prado (3 hab, listos desde RD$5.6M o Torre 6 desde US$99K)
- "Quiero invertir" -> PR3 (casi agotado, equipado) o Puerto Plata (turistico)
- "Poco presupuesto" -> Puerto Plata Etapa 3 (desde US$73K) o Crux Torre 6 (desde US$99K)
- "Algo premium" -> PR4 en Evaristo Morales (desde US$140K hasta US$315K)
- "Soy de la diaspora" -> Puerto Plata (inversion + vacaciones)
- "Entrega pronto" -> PR3 o PR4 (agosto 2026) o Crux listos (entrega inmediata)
- "Algo listo ya" -> Crux Etapa 1 y 2 (terminados, en pesos)
- "En pesos dominicanos?" -> Crux listos desde RD$5,650,000
 
MANEJO DE OBJECIONES:
- "Muy caro" -> Compara precio por metro con la zona, destaca plan de pago
- "Necesito pensarlo" -> Respeta, menciona disponibilidad limitada (PR3 solo quedan 6)
- "No confio en planos" -> 23 anios, 1,300 unidades, ofrece visitar proyectos terminados
- "Financiamiento?" -> Cuotas directas durante construccion, banco para saldo contra entrega
- "Estoy fuera del pais" -> Todo digital, firma remota, pagos internacionales
- "Tienen algo en pesos?" -> Crux Etapa 1 y 2 listos desde RD$5,650,000
 
ESCALAMIENTO A HUMANO cuando: pidan hablar con persona, queja formal, tema legal, negociar descuento, +10 mensajes sin avance, agendar cita con fecha.
Mensaje: "Dale, te conecto con nuestro equipo de ventas para que te atienda personalmente. Te van a escribir en unos minutos."`;
 
// ============================================
// URLs de PDFs y documentos por proyecto
// Se configuran desde variables de entorno
// en Vercel. Para Google Drive usar formato:
// https://drive.google.com/uc?export=download&id=FILE_ID
// ============================================
  
const PROJECT_DOCS = {
  crux: {
    brochure: process.env.PDF_CRUX_BROCHURE || null,
    precios: process.env.PDF_CRUX_PRECIOS || null,
    planos: process.env.PDF_CRUX_PLANOS || null,
  },
  pr3: {
    brochure: process.env.PDF_PR3_BROCHURE || null,
    precios: process.env.PDF_PR3_PRECIOS || null,
    planos: process.env.PDF_PR3_PLANOS || null,
  },
  pr4: {
    brochure: process.env.PDF_PR4_BROCHURE || null,
    precios: process.env.PDF_PR4_PRECIOS || null,
    planos: process.env.PDF_PR4_PLANOS || null,
  },
  puertoPlata: {
    brochure: process.env.PDF_PP_BROCHURE || null,
    precios: process.env.PDF_PP_PRECIOS || null,
    planos: process.env.PDF_PP_PLANOS || null,
  },
};
 
// Nombres bonitos de los proyectos para el nombre del archivo
const PROJECT_NAMES = {
  crux: "Crux del Prado",
  pr3: "Prado Residences III",
  pr4: "Prado Residences IV",
  puertoPlata: "Prado Suites Puerto Plata",
};
 
// Nombres bonitos para cada tipo de documento
const DOC_TYPE_NAMES = {
  brochure: "Brochure",
  precios: "Listado de Precios",
  planos: "Planos",
};
 
// ============================================
// DETECCION INTELIGENTE DE DOCUMENTOS
// ============================================
 
function detectDocumentRequest(botReply, userMessage) {
  const botText = botReply.toLowerCase();
  const userText = userMessage.toLowerCase();
  const combined = botText + " " + userText;
 
  // Frases que indican que el BOT confirma envio
  const botSendPhrases = [
    "te lo envio", "te lo mando", "te envio", "aqui te mando",
    "te lo paso", "te mando el", "te mando la", "te mando los",
    "te envio el", "te envio la", "te envio los",
  ];
 
  // Palabras que indican que el CLIENTE pide documentos
  const clientRequestWords = [
    "pdf", "brochure", "plano", "planos", "precio", "precios",
    "listado", "documento", "informacion", "información", "info",
    "ficha", "catalogo", "catálogo", "enviame", "envíame",
    "mandame", "mándame", "pasame", "pásame", "quiero ver",
    "me puedes enviar", "me puedes mandar", "tienes material",
  ];
 
  const botConfirmsSend = botSendPhrases.some((p) => botText.includes(p));
  const clientRequestsDoc = clientRequestWords.some((w) => userText.includes(w));
 
  if (!botConfirmsSend && !clientRequestsDoc) return null;
 
  // Detectar proyecto
  const projectKeywords = {
    crux: ["crux", "crux del prado", "torre 6", "santo domingo norte", "colinas"],
    pr3: ["pr3", "prado 3", "prado residences 3", "prado residences iii", "prado iii", "churchill", "paraiso", "paraíso", "ensanche paraiso"],
    pr4: ["pr4", "prado 4", "prado residences 4", "prado residences iv", "prado iv", "evaristo", "evaristo morales"],
    puertoPlata: ["puerto plata", "playa dorada", "prado suites", "prado suites puerto plata"],
  };
 
  for (const [project, words] of Object.entries(projectKeywords)) {
    if (words.some((w) => combined.includes(w))) {
      return project;
    }
  }
 
  return null;
}
 
// Detectar que TIPO de documento piden
function detectDocumentType(botReply, userMessage) {
  const combined = (botReply + " " + userMessage).toLowerCase();
  const types = [];
 
  if (combined.includes("brochure") || combined.includes("catalogo") || combined.includes("catálogo") || combined.includes("ficha")) {
    types.push("brochure");
  }
  if (combined.includes("precio") || combined.includes("listado") || combined.includes("costo") || combined.includes("cuanto") || combined.includes("cuánto")) {
    types.push("precios");
  }
  if (combined.includes("plano") || combined.includes("distribucion") || combined.includes("distribución") || combined.includes("layout")) {
    types.push("planos");
  }
 
  // Si no piden nada especifico, enviar TODO lo disponible
  if (types.length === 0) {
    return ["brochure", "precios", "planos"];
  }
 
  return types;
}
 
// ============================================
// PROCESAR MENSAJE
// ============================================
 
async function processMessage(body) {
  try {
    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;
 
    if (!messages || messages.length === 0) {
      console.log("Evento sin mensajes (status update o similar)");
      return;
    }
 
    const message = messages[0];
    const senderPhone = message.from;
    const messageType = message.type;
 
    if (messageType !== "text") {
      await sendWhatsAppMessage(
        senderPhone,
        "Hola! Por el momento solo puedo leer mensajes de texto. Escribeme tu consulta y con gusto te ayudo."
      );
      return;
    }
 
    const userMessage = message.text.body;
    console.log("Mensaje de " + senderPhone + ": " + userMessage);
 
    addMessage(senderPhone, "user", userMessage);
    const messageHistory = getHistory(senderPhone);
 
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
 
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: messageHistory,
    });
 
    const botReply = response.content[0].text;
    console.log("Respuesta del bot: " + botReply);
 
    addMessage(senderPhone, "assistant", botReply);
    await sendWhatsAppMessage(senderPhone, botReply);
    console.log("Respuesta enviada a " + senderPhone);
 
    // ============================================
    // ENVIO AUTOMATICO DE PDFs
    // ============================================
 
    const project = detectDocumentRequest(botReply, userMessage);
 
    if (project && PROJECT_DOCS[project]) {
      const docs = PROJECT_DOCS[project];
      const requestedTypes = detectDocumentType(botReply, userMessage);
 
      let sentCount = 0;
 
      for (const docType of requestedTypes) {
        const docUrl = docs[docType];
        if (docUrl) {
          // Pausa entre documentos para que lleguen en orden
          if (sentCount > 0) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }
 
          const filename = PROJECT_NAMES[project] + " - " + DOC_TYPE_NAMES[docType] + " - JPREZ.pdf";
          await sendWhatsAppDocument(senderPhone, docUrl, filename);
          sentCount++;
          console.log("PDF enviado: " + docType + " de " + project + " a " + senderPhone);
        }
      }
 
      if (sentCount === 0) {
        console.log("AVISO: Solicitud de docs para " + project + " pero no hay URLs configuradas en las variables de entorno");
      } else {
        console.log("Total PDFs enviados a " + senderPhone + ": " + sentCount);
      }
    }
  } catch (error) {
    console.error("Error procesando mensaje:", error);
  }
}
 
// ============================================
// HANDLER PRINCIPAL (Vercel serverless)
// ============================================
 
module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
      console.log("Webhook verificado correctamente");
      return res.status(200).send(challenge);
    } else {
      return res.status(403).send("Forbidden");
    }
  }
 
  if (req.method === "POST") {
    const body = req.body;
    await processMessage(body);
    return res.status(200).send("EVENT_RECEIVED");
  }
 
  return res.status(405).send("Method Not Allowed");
};
 
// ============================================
// ENVIAR MENSAJE DE TEXTO POR WHATSAPP
// ============================================
 
async function sendWhatsAppMessage(to, text) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  const url = "https://graph.facebook.com/v21.0/" + phoneNumberId + "/messages";
 
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: to,
      type: "text",
      text: { body: text },
    }),
  });
 
  if (!response.ok) {
    const errorData = await response.text();
    console.error("Error enviando WhatsApp:", errorData);
    throw new Error("WhatsApp API error: " + response.status);
  }
 
  return response.json();
}
 
// ============================================
// ENVIAR DOCUMENTO PDF POR WHATSAPP
// ============================================
 
async function sendWhatsAppDocument(to, documentUrl, filename) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  const url = "https://graph.facebook.com/v21.0/" + phoneNumberId + "/messages";
 
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: to,
      type: "document",
      document: {
        link: documentUrl,
        filename: filename,
      },
    }),
  });
 
  if (!response.ok) {
    const errorData = await response.text();
    console.error("Error enviando documento:", errorData);
    throw new Error("WhatsApp Document API error: " + response.status);
  }
 
  return response.json();
}
 
