// ============================================
// BOT WHATSAPP JPREZ - Constructora JPREZ
// Powered by Claude API (Anthropic)
// Deploy en Vercel como serverless function
// Con memoria de conversacion por cliente
// ============================================

const Anthropic = require("@anthropic-ai/sdk");

// ============================================
// MEMORIA DE CONVERSACION
// Almacena los ultimos mensajes por telefono
// Nota: en Vercel serverless esto se reinicia
// entre cold starts, pero mantiene contexto
// durante la sesion activa (~5-15 min)
// ============================================
const conversationHistory = {};
const MAX_MESSAGES = 20; // Maximo de mensajes por conversacion

function getHistory(phone) {
  if (!conversationHistory[phone]) {
    conversationHistory[phone] = [];
  }
  return conversationHistory[phone];
}

function addMessage(phone, role, content) {
  const history = getHistory(phone);
  history.push({ role, content });
  // Mantener solo los ultimos MAX_MESSAGES
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

COMO MANEJAR EL FLUJO DE LA CONVERSACION:

- Si es el PRIMER mensaje del cliente: saluda brevemente y haz UNA pregunta para calificar (para vivir o invertir, zona, habitaciones).
- Si ya sabes que busca: recomienda EL proyecto ideal, da 2-3 beneficios clave, y pregunta si quiere saber el precio o ver planos.
- Si ya diste precio: ofrece el plan de pago y pregunta si quiere agendar una visita.
- Si tiene dudas u objeciones: responde con empatia y datos, luego redirige al cierre.
- Si ya esta interesado: cierra con cita presencial o envio de documentos.
- Si pide informacion, planos, brochure o PDF: ofrece enviarselo y di "te lo envio por aqui" o "te lo mando ahora mismo".

PROGRESION DE LA VENTA (sigue este orden naturalmente):
Saludo -> Calificacion -> Presentacion -> Precio -> Plan de pago -> Objeciones -> Cierre/Cita

TONO: Dominicano profesional. Cercano, directo, calido. Como un pana que sabe del tema. Frases cortas. Nada de lenguaje corporativo ni robotico. Usa "tu" a menos que el cliente use "usted".

Expresiones que puedes usar (pero NO repitas la misma): "mira", "te cuento", "dale", "perfecto", "claro que si", "excelente", "buenisimo", "te explico"

SOBRE LA EMPRESA:
- Constructora JPREZ: +23 anios, +1,300 unidades entregadas
- Oficina: Plaza Nueva Orleans, 2do Nivel, Suites 213-214, DN, SD
- Tel: (809) 385-1616 | Instagram: @constructorajprez

PROYECTOS ACTIVOS:

1. CRUX DEL PRADO (Torre 6) - Santo Domingo Norte
   Para familias. 3 hab, 2 banios, 100 m2, 2 parqueos. Desde US$98,292.
   Reserva US$1,000. 5% firma, 25% cuotas, 70% entrega. Julio 2027. 43/50 disponibles.
   13 pisos. Amenidades: salon multiuso, jacuzzi, gym, terraza, bar, ascensor.

2. PRADO RESIDENCES III (PR3) - Ensanche Paraiso (Churchill)
   Para inversion/Airbnb. 1 hab, EQUIPADO (nevera, estufa, A/A, cerradura smart).
   Desde US$99,000. 10% separacion, 30% inicial cuotas, 60% entrega. Agosto 2026.
   Solo 13/60 disponibles. Piscina, gym, co-working en piso 15.
3. PRADO RESIDENCES IV (PR4) - Evaristo Morales
   Variedad: lofts 52m2 hasta aptos 130m2 de 3 hab.
   Desde US$89,000. 10% separacion, 30% inicial, 60% entrega. Agosto 2027. 13/72 disponibles.

4. PRADO SUITES PUERTO PLATA - Frente a Playa Dorada
   Inversion turistica/diaspora. Estudios desde US$73,000 hasta PH duplex US$285,000.
   10% separacion, 20% inicial (plan feria), 70% entrega. Marzo 2029. 63/126 disponibles.

GUIA RAPIDA:
- "Para mi familia" -> Crux del Prado (3 hab desde US$98K)
- "Quiero invertir" -> PR3 (retorno rapido) o Puerto Plata (turistico)
- "Poco presupuesto" -> Puerto Plata (US$73K) o Crux (US$98K)
- "Algo premium" -> PR4 en Evaristo Morales
- "Soy de la diaspora" -> Puerto Plata (inversion + vacaciones)
- "Entrega pronto" -> PR3 (agosto 2026, equipado)

MANEJO DE OBJECIONES:
- "Muy caro" -> Compara precio por metro con la zona, destaca plan de pago accesible
- "Necesito pensarlo" -> Respeta, pero menciona disponibilidad limitada y reserva de US$1,000
- "No confio en planos" -> 23 anios, 1,300 unidades, ofrece visitar proyectos terminados
- "Financiamiento?" -> Cuotas directas durante construccion, banco para saldo contra entrega
- "Estoy fuera del pais" -> Todo digital, firma remota, pagos internacionales

ESCALAMIENTO A HUMANO cuando: pidan hablar con persona, queja formal, tema legal, negociar descuento, +10 mensajes sin avance, agendar cita con fecha especifica.
Mensaje: "Dale, te conecto con nuestro equipo de ventas para que te atienda personalmente. Te van a escribir en unos minutos."

CUANDO PIDAN PDFs, PLANOS O BROCHURES:
Responde que se lo envias y di algo como "te lo mando por aqui" o "dame un segundo que te lo envio". El sistema se encargara de enviarlo automaticamente.`;

// ============================================
// URLs de PDFs y documentos por proyecto
// (Aqui se configuran los links a los PDFs)
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

// Detectar si el bot menciona enviar documentos
function detectDocumentRequest(botReply, userMessage) {
  const combined = (botReply + " " + userMessage).toLowerCase();

  const keywords = {
    crux: ["crux", "crux del prado", "torre 6", "santo domingo norte", "colinas"],
    pr3: ["pr3", "prado 3", "prado residences 3", "prado residences iii", "churchill", "paraiso"],
    pr4: ["pr4", "prado 4", "prado residences 4", "prado residences iv", "evaristo"],
    puertoPlata: ["puerto plata", "playa dorada", "prado suites", "zona norte"],
  };

  const docKeywords = ["pdf", "brochure", "plano", "planos", "precio", "listado", "documento", "informacion", "info", "ficha", "catalogo", "enviar", "mandar", "manda"];

  const wantsDoc = docKeywords.some(k => combined.includes(k));
  if (!wantsDoc) return null;

  for (const [project, words] of Object.entries(keywords)) {
    if (words.some(w => combined.includes(w))) {
      return project;
    }
  }

  return null;
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

    // Solo procesar mensajes de texto por ahora
    if (messageType !== "text") {
      await sendWhatsAppMessage(
        senderPhone,
        "Hola! Por el momento solo puedo leer mensajes de texto. Escribeme tu consulta y con gusto te ayudo."
      );
      return;
    }

    const userMessage = message.text.body;
    console.log("Mensaje de " + senderPhone + ": " + userMessage);

    // Agregar mensaje del usuario al historial
    addMessage(senderPhone, "user", userMessage);

    // Obtener historial completo para enviar a Claude
    const messageHistory = getHistory(senderPhone);

    // Llamar a Claude con el historial completo
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

    // Agregar respuesta del bot al historial
    addMessage(senderPhone, "assistant", botReply);

    // Enviar respuesta de texto
    await sendWhatsAppMessage(senderPhone, botReply);
    console.log("Respuesta enviada a " + senderPhone);

    // Detectar si debe enviar un PDF
    const project = detectDocumentRequest(botReply, userMessage);
    if (project && PROJECT_DOCS[project]) {
      const docs = PROJECT_DOCS[project];
      // Enviar el primer documento disponible del proyecto
      const docUrl = docs.brochure || docs.precios || docs.planos;
      if (docUrl) {
        await sendWhatsAppDocument(senderPhone, docUrl, project);
        console.log("Documento enviado a " + senderPhone + " para " + project);
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
  // Verificacion del webhook (GET)
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

  // Mensajes entrantes (POST)
  if (req.method === "POST") {
    const body = req.body;
    // Procesar ANTES de responder (Meta permite hasta 20s)
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
async function sendWhatsAppDocument(to, documentUrl, projectName) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  const url = "https://graph.facebook.com/v21.0/" + phoneNumberId + "/messages";

  const projectNames = {
    crux: "Crux del Prado",
    pr3: "Prado Residences III",
    pr4: "Prado Residences IV",
    puertoPlata: "Prado Suites Puerto Plata",
  };

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
        filename: projectNames[projectName] + " - JPREZ.pdf",
      },
    }),
  });

  if (!response.ok) {
    const errorData = await response.text();
    console.error("Error enviando documento:", errorData);
  }
}

