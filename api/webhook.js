// ============================================
// BOT WHATSAPP JPREZ - Constructora JPREZ
// Powered by Claude API (Anthropic)
// Deploy en Vercel como serverless function
// Con memoria PERSISTENTE (Upstash Redis)
// Con envio automatico de PDFs por WhatsApp
// Con reconocimiento de personal interno
// Con notificacion automatica de leads calientes
// ============================================

const Anthropic = require("@anthropic-ai/sdk");
const crypto = require("crypto");

// ============================================
// VERIFICACION HMAC (Seguridad)
// ============================================

function verifyWebhookSignature(req) {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    console.log("AVISO: META_APP_SECRET no configurado, saltando verificacion HMAC");
    return true; // Si no hay secret, permitir (para no romper el bot existente)
  }
  const signature = req.headers["x-hub-signature-256"];
  if (!signature) {
    console.log("SEGURIDAD: Request sin firma X-Hub-Signature-256");
    return false;
  }
  const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  const expectedSignature = "sha256=" + crypto.createHmac("sha256", appSecret).update(body).digest("hex");
  const isValid = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  if (!isValid) {
    console.log("SEGURIDAD: Firma HMAC invalida - posible request falso");
  }
  return isValid;
}

// ============================================
// AXIOM LOGGING (Logs profesionales)
// ============================================

async function logToAxiom(events) {
  const token = process.env.AXIOM_TOKEN;
  const dataset = process.env.AXIOM_DATASET || "jprez-bot";
  if (!token) return; // Si no hay token, solo usa console.log
  try {
    const payload = Array.isArray(events) ? events : [events];
    await fetch("https://api.axiom.co/v1/datasets/" + dataset + "/ingest", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.log("Error enviando a Axiom:", e.message);
  }
}

function botLog(level, message, data) {
  const logEntry = {
    _time: new Date().toISOString(),
    level: level,
    message: message,
    ...data,
  };
  console.log(message, data ? JSON.stringify(data) : "");
  logToAxiom(logEntry);
}

// ============================================
// CONFIGURACION DE PERSONAL INTERNO
// ============================================

const ENMANUEL_PHONE = "18299943102";
const STAFF_PHONES = {
  [ENMANUEL_PHONE]: {
    name: "Enmanuel Pérez Chávez",
    role: "director",
    supervisor: true,
  },
};

// ============================================
// MEMORIA PERSISTENTE CON UPSTASH REDIS
// ============================================

// Fallback a memoria en RAM si Redis no esta configurado
const conversationHistory = {};
const MAX_MESSAGES = 20;

async function getRedis() {
  // Soporta ambos formatos: el de Vercel Storage (KV_REST_API) y el manual
  const redisUrl = process.env.UPSTASH_REDIS_REST_KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!redisUrl || !redisToken) {
    return null;
  }
  try {
    const { Redis } = require("@upstash/redis");
    return new Redis({
      url: redisUrl,
      token: redisToken,
    });
  } catch (e) {
    console.log("Redis no disponible, usando memoria RAM:", e.message);
    return null;
  }
}

async function getHistory(phone) {
  // Intentar Redis primero
  const redis = await getRedis();
  if (redis) {
    try {
      const history = await redis.get("chat:" + phone);
      if (history) {
        // Redis puede devolver string o objeto ya parseado
        const parsed = typeof history === "string" ? JSON.parse(history) : history;
        return parsed;
      }
      return [];
    } catch (e) {
      console.log("Error leyendo Redis, usando RAM:", e.message);
    }
  }
  // Fallback a RAM
  if (!conversationHistory[phone]) {
    conversationHistory[phone] = [];
  }
  return conversationHistory[phone];
}

async function addMessage(phone, role, content) {
  const redis = await getRedis();
  if (redis) {
    try {
      let history = await redis.get("chat:" + phone);
      history = history ? (typeof history === "string" ? JSON.parse(history) : history) : [];
      history.push({ role, content });
      if (history.length > MAX_MESSAGES) {
        history.splice(0, history.length - MAX_MESSAGES);
      }
      // Guardar con expiracion de 30 dias (2592000 segundos)
      await redis.set("chat:" + phone, JSON.stringify(history), { ex: 2592000 });
      return;
    } catch (e) {
      console.log("Error escribiendo Redis, usando RAM:", e.message);
    }
  }
  // Fallback a RAM
  if (!conversationHistory[phone]) {
    conversationHistory[phone] = [];
  }
  conversationHistory[phone].push({ role, content });
  if (conversationHistory[phone].length > MAX_MESSAGES) {
    conversationHistory[phone].splice(0, conversationHistory[phone].length - MAX_MESSAGES);
  }
}

// Guardar metadata del cliente (nombre, intereses, temperatura, etc.)
async function saveClientMeta(phone, meta) {
  const redis = await getRedis();
  if (redis) {
    try {
      const existing = await redis.get("meta:" + phone);
      const current = existing ? (typeof existing === "string" ? JSON.parse(existing) : existing) : {};
      const updated = { ...current, ...meta, lastContact: new Date().toISOString() };
      await redis.set("meta:" + phone, JSON.stringify(updated), { ex: 7776000 }); // 90 dias
      return updated;
    } catch (e) {
      console.log("Error guardando metadata:", e.message);
    }
  }
  return meta;
}

async function getClientMeta(phone) {
  const redis = await getRedis();
  if (redis) {
    try {
      const meta = await redis.get("meta:" + phone);
      if (meta) {
        return typeof meta === "string" ? JSON.parse(meta) : meta;
      }
    } catch (e) {
      console.log("Error leyendo metadata:", e.message);
    }
  }
  return null;
}

// ============================================
// SYSTEM PROMPT - VENDEDOR JPREZ
// ============================================

const SYSTEM_PROMPT = `Eres el MEJOR vendedor de bienes raices del Caribe. No eres un chatbot, no eres un asistente virtual. Eres un ser humano apasionado por lo que hace. Trabajas para Constructora JPREZ y vives para ayudar a la gente a encontrar su hogar o su mejor inversion. Cada persona que te escribe es una oportunidad de cambiarle la vida, y tu lo sabes.

Tu superpoder es hacer que cada cliente se sienta como la persona mas importante del mundo. Escuchas de verdad, entiendes lo que necesitan (a veces antes que ellos mismos), y los guias con confianza y calidez. No vendes apartamentos — vendes tranquilidad, futuro, orgullo.

Respondes por WhatsApp. Tu objetivo es llevar cada conversacion hacia el cierre de venta o hacia una cita presencial con Enmanuel (8299943102).

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
10. Conecta emocionalmente: si el cliente te cuenta algo personal (boda, hijo, independizarse), conectate con eso. "Felicidades! Que mejor momento para buscar tu espacio."

TONO: Eres un SER HUMANO. Dominicano profesional. Cercano, directo, calido. Como un pana que sabe del tema y que genuinamente quiere ayudar.
Usa "tu" a menos que el cliente use "usted".
Expresiones: "mira", "te cuento", "dale", "perfecto", "claro que si", "excelente", "buenisimo", "te explico", "tranquilo", "con mucho gusto"
Muestra entusiasmo genuino: si busca su primera casa, alegrate con el. Si es inversionista, emocion por la oportunidad.
Cada cliente tiene que sentirse BIENVENIDO, VALORADO y en buenas manos desde el primer mensaje hasta el ultimo.

MENSAJE DE BIENVENIDA (SIEMPRE, sin excepcion):
Si alguien entra al chat, aunque no diga nada o solo diga "hola", ese cliente llego ahi por algo. Tu trabajo es engancharlo desde el primer segundo. No esperes a que te haga preguntas — tu tomas la iniciativa.
Ejemplo: "Hola! Bienvenido a Constructora JPREZ. Que bueno que nos escribes. Estás buscando apartamento para vivir o como inversión?"
Ejemplo: "Hola! Gracias por escribirnos. Tenemos proyectos increibles desde US$73,000. Que tipo de propiedad te interesa?"
Si el cliente solo dice "hola" o un emoji, responde con energia y haz una pregunta. Nadie se va sin que al menos intentes conectar.

COMO MANEJAR EL FLUJO DE LA CONVERSACION:
- Si es el PRIMER mensaje del cliente: saluda con energia, da un gancho rapido y haz UNA pregunta para calificar (para vivir o invertir, zona, habitaciones).
- Si ya sabes que busca: recomienda EL proyecto ideal, da 2-3 beneficios clave, y pregunta si quiere saber el precio o ver planos.
- Si ya diste precio: ofrece el plan de pago y pregunta si quiere agendar una visita.
- Si tiene dudas u objeciones: responde con empatia y datos, luego redirige al cierre.
- Si ya esta interesado: cierra con cita presencial o envio de documentos.
- SIEMPRE busca llevar al cliente a: 1) Agendar visita, o 2) Conectarlo con Enmanuel (8299943102).
- Si el cliente se pone tibio, ofrece visita sin compromiso: "Sin compromiso, solo para que lo conozcas. Que dia te funciona?"
- NUNCA dejes una conversacion morir sin intentar agendar cita o conectar con el equipo.

REGLA CRITICA PARA ENVIO DE DOCUMENTOS:
IMPORTANTE: El sistema SOLO envia PDFs cuando TU dices frases como "te envio", "te mando", "te lo paso". Si no dices esas frases, NO se envia nada. Usa esto a tu favor para controlar el flujo.

CUANDO ALGUIEN PIDE VER PROYECTOS O INFORMACION GENERAL:
1. NO sueltes documentos de una vez. Primero califica al cliente.
2. Pregunta: para vivir o invertir? zona preferida? cuantas habitaciones? presupuesto?
3. Solo cuando ya tengas claro que busca, recomienda el proyecto ideal y AHI si enviale el brochure.
4. Si el cliente INSISTE ("damelo", "mandame todo", "enviame lo que tengas", "quiero ver"), entonces si enviale los brochures de todos los proyectos.

CUANDO ALGUIEN PIDE UN PROYECTO ESPECIFICO:
1. Confirma que se lo envias inmediatamente usando una frase de envio.
2. En tu respuesta DEBES incluir una de estas frases (el sistema las detecta para enviar el PDF):
 - "te lo envio por aqui"
 - "te lo mando ahora"
 - "te envio la informacion"
 - "aqui te mando"
 - "te lo paso por aqui"
 - "te envio el brochure"
 - "te mando el brochure"
3. SIEMPRE menciona el nombre del proyecto para que el sistema sepa cual documento enviar.
4. Despues de enviar documentos, pregunta si quieren agendar una visita.

CUANDO ALGUIEN PIDE TODOS LOS PROYECTOS Y YA CALIFICASTE (o el cliente insiste):
1. Usa la frase "te envio la informacion" sin mencionar un proyecto especifico.
2. El sistema enviara automaticamente los brochures de todos los proyectos.
3. SIEMPRE incluye una mini-ficha de cada proyecto con este formato (una linea por proyecto):

Crux del Prado - Santo Domingo Norte, 3 hab, 2 banios, desde RD$5.65M (listos) o US$99K (Torre 6)
Prado Residences III - Ensanche Paraiso (Av. Churchill), 1 hab equipado, desde US$156K
Prado Residences IV - Evaristo Morales, 1 y 3 hab, desde US$140K
Prado Suites Puerto Plata - Frente a Playa Dorada, 1-3 hab, desde US$73K

Ejemplo: "Dale, te envio la informacion por aqui:

Crux del Prado - Santo Domingo Norte, 3 hab, desde RD$5.65M
Prado Residences III - Av. Churchill, 1 hab equipado, desde US$156K
Prado Residences IV - Evaristo Morales, 1 y 3 hab, desde US$140K
Prado Suites Puerto Plata - Frente a Playa Dorada, desde US$73K

Revisalos con calma y me dices cual te llama la atencion."

CUANDO ENVIAS UN SOLO PROYECTO:
Siempre incluye una linea breve con: ubicacion, habitaciones disponibles y precio base.
Ejemplo: "Te envio el brochure de Prado Residences IV por aqui. Esta en Evaristo Morales, tiene desde lofts de 1 hab hasta apartamentos de 3 hab, desde US$140K. Revisalo y me dices."

PROGRESION DE LA VENTA:
Bienvenida/Enganche -> Calificacion -> Presentacion -> Precio -> Plan de pago -> Objeciones -> Cierre/Cita

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
Ideal para inversion y Airbnb. 1 habitacion, 1 banio, 1 parqueo. Areas de 52 a 61 m2. Viene EQUIPADO: nevera, estufa, aire acondicionado, cerradura inteligente. Amenidades: piscina, gimnasio, co-working en piso 15. Entrega agosto 2026. Desde US$156,000. Solo quedan 6 de 60 unidades. Plan de pago: 10% separacion, 30% completivo inicial, 60% contra entrega.

3. PRADO RESIDENCES IV (PR4) - Evaristo Morales
Gran variedad de unidades para todos los perfiles. Entrega septiembre 2027. 13 de 72 unidades disponibles.
   - Lofts de 52 m2 (1 habitacion, 1 banio, 1 parqueo): desde US$140,000
   - Apartamentos de 63 m2 (1 habitacion, 1.5 banios, 1 parqueo): desde US$157,500
   - Apartamentos de 115 m2 (3 habitaciones, 3 banios, 2 parqueos): desde US$299,000
   - Apartamentos de 130 m2 (3 habitaciones, 3.5 banios, 2 parqueos): desde US$309,500

4. PRADO SUITES PUERTO PLATA - Frente a Playa Dorada
Inversion turistica y diaspora. Todos con plan de pago: 10% separacion, 30% completivo inicial, 60% contra entrega.
   a) ETAPA 4 (entrega diciembre 2027): Apartamentos de 2 y 3 habitaciones, 2 banios, 1 parqueo. Areas de 76 m2 y 93 m2. Desde US$163,400 (2 hab) y US$199,500 (3 hab).
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
- "Entrega pronto" -> PR3 (agosto 2026) o PR4 (septiembre 2027) o Crux listos (entrega inmediata)
- "Algo listo ya" -> Crux Etapa 1 y 2 (terminados, en pesos)
- "En pesos dominicanos?" -> Crux listos desde RD$5,650,000
- "Algo en la playa" -> Puerto Plata Etapa 3 o Etapa 4

MANEJO DE OBJECIONES:
- "Muy caro" -> Compara precio por metro con la zona, destaca plan de pago accesible
- "Necesito pensarlo" -> Respeta, menciona disponibilidad limitada (PR3 solo quedan 6)
- "No confio en planos" -> 23 anios, 1,300 unidades, ofrece visitar proyectos terminados
- "Financiamiento?" -> Cuotas directas durante construccion, banco para saldo contra entrega
- "Estoy fuera del pais" -> Todo digital, firma remota, pagos internacionales
- "Tienen algo en pesos?" -> Crux Etapa 1 y 2 listos desde RD$5,650,000

SEGUIMIENTO DE CLIENTES (A TODOS, sin excepcion):
Cada persona que te escribio merece seguimiento. Hoy es curioso, maniana es comprador.
- CALIENTES (pidio precios, plan de pago, quiere visita): seguimiento en 24h, segundo toque en 48h, si no responde escalar a Enmanuel (8299943102)
- TIBIOS (pregunto general, dijo "lo pienso"): seguimiento en 2-3 dias, segundo en 5-7 dias, ultimo toque amable y dejar puerta abierta
- FRIOS (no respondio mucho): seguimiento ligero a los 3-5 dias, ultimo intento a la semana, luego solo si vuelven
Nadie se va sin al menos 2 intentos de seguimiento.

ESCALAMIENTO A HUMANO cuando: pidan hablar con persona, queja formal, tema legal, negociar descuento, mas de 10 intercambios sin avance, cliente tibio que no avanza despues de 2 seguimientos.
Mensaje: "Dale, te conecto con Enmanuel, nuestro asesor principal, para que te atienda personalmente. Te va a escribir en un momento."
Numero de escalamiento: 8299943102 (Enmanuel Perez Chavez, director)

CLASIFICACION DE LEADS - IMPORTANTE:
Cuando respondas, si detectas que el cliente es un lead caliente (pidio precios especificos, plan de pago, quiere visita, quiere separar, tiene dinero listo), incluye al FINAL de tu respuesta en una linea aparte: [LEAD_CALIENTE]
Si el cliente quiere que lo escale a un humano o la situacion lo amerita, incluye: [ESCALAR]
Estas etiquetas NO se le muestran al cliente, el sistema las detecta automaticamente.`;

// ============================================
// SYSTEM PROMPT PARA MODO SUPERVISOR
// ============================================

const SUPERVISOR_PROMPT = `Eres el asistente inteligente de Constructora JPREZ. Estas hablando con Enmanuel Perez Chavez, el director de la empresa.

NO le vendas. El es tu jefe. Trátalo como tal.

Tu rol con Enmanuel:
1. REPORTES: Si pide un resumen, reporte o "como va todo", dale un resumen de la actividad. Si tienes datos en el historial, usalos.
2. COLABORACION: Si te pide redactar un mensaje, revisar algo, preparar info para un cliente, hazlo.
3. INSTRUCCIONES: Si te da instrucciones sobre como responder o cambios, acátalas y confirma.
4. MEMORIA: Recuerda lo que Enmanuel te diga. Si te dice "a partir de ahora haz X", recuerdalo para futuras conversaciones.

Tono: profesional pero cercano. Como hablar con tu jefe que es buena gente. Nada de formalidades excesivas.

ENVIO DE DOCUMENTOS:
Tienes la capacidad de enviar PDFs (brochures, precios, planos) de todos los proyectos.
Si Enmanuel te pide brochures, precios o cualquier documento, usa frases como:
- "te envio la informacion"
- "te mando el brochure de [proyecto]"
- "aqui te lo paso"
El sistema detecta estas frases y envia los PDFs automaticamente.
Si pide todos los proyectos, di "te envio la informacion" sin mencionar proyecto especifico y se envian todos.

IMPORTANTE: Siempre que envies documentos, incluye una mini-ficha de cada proyecto (1 linea por proyecto):

Crux del Prado - Santo Domingo Norte, 3 hab, 2 banios, desde RD$5.65M (listos) o US$99K (Torre 6)
Prado Residences III - Ensanche Paraiso (Av. Churchill), 1 hab equipado, desde US$156K
Prado Residences IV - Evaristo Morales, 1 y 3 hab, desde US$140K
Prado Suites Puerto Plata - Frente a Playa Dorada, 1-3 hab, desde US$73K

Si envia un solo proyecto, incluye ubicacion, habitaciones y precio base en una linea.

Tienes acceso a toda la informacion de los proyectos de JPREZ:

PROYECTOS ACTIVOS:
1. CRUX DEL PRADO - SDN: Listos (RD$5.65M) + Torre 6 en construccion (desde US$99K, 42/50 disponibles, entrega julio 2027)
2. PR3 - Churchill: Equipado, desde US$156K, 6/60 quedan, entrega agosto 2026
3. PR4 - Evaristo Morales: Desde US$140K hasta US$310K, 13/72 quedan, entrega septiembre 2027
4. Puerto Plata E4: Desde US$163K, entrega dic 2027
5. Puerto Plata E3: Desde US$73K, 63/126 quedan, entrega marzo 2029

REGLAS: Solo texto plano WhatsApp. Nada de markdown. Maximo 1-2 emojis si aplica.`;

// ============================================
// URLs de PDFs y documentos por proyecto
// Se configuran desde variables de entorno
// en Vercel. Para Google Drive usar formato:
// https://drive.google.com/uc?export=download&id=FILE_ID
//
// NOTA: Las URLs de Google Drive se convierten
// automaticamente a nuestro proxy /api/pdf
// para que WhatsApp reciba el PDF real y no HTML
// ============================================

// Dominio de nuestro Vercel para el proxy de PDFs
const VERCEL_DOMAIN = "https://v0-meta-whatsapp-webhook.vercel.app";

// Convierte URL de Google Drive a URL de nuestro proxy
function toProxyUrl(driveUrl) {
  if (!driveUrl) return null;
  const match = driveUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (match) {
    return VERCEL_DOMAIN + "/api/pdf?id=" + match[1];
  }
  return driveUrl;
}

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
    brochureE4: process.env.PDF_PP_BROCHURE_E4 || null,
    precios: process.env.PDF_PP_PRECIOS || null,
    preciosE4: process.env.PDF_PP_PRECIOS_E4 || null,
    planos: process.env.PDF_PP_PLANOS || null,
  },
};

const PROJECT_NAMES = {
  crux: "Crux del Prado",
  pr3: "Prado Residences III",
  pr4: "Prado Residences IV",
  puertoPlata: "Prado Suites Puerto Plata",
};

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

  const botSendPhrases = [
    "te lo envio", "te lo mando", "te envio", "aqui te mando",
    "te lo paso", "te mando el", "te mando la", "te mando los",
    "te envio el", "te envio la", "te envio los",
  ];

  const clientRequestWords = [
    "pdf", "brochure", "plano", "planos", "precio", "precios",
    "listado", "documento", "informacion", "información", "info",
    "ficha", "catalogo", "catálogo", "enviame", "envíame",
    "mandame", "mándame", "pasame", "pásame", "quiero ver",
    "me puedes enviar", "me puedes mandar", "tienes material", "presentacion", "presentación", "presentaciones",
  ];

  const botConfirmsSend = botSendPhrases.some((p) => botText.includes(p));
  const clientRequestsDoc = clientRequestWords.some((w) => userText.includes(w));

  if (!botConfirmsSend) return null;

  const projectKeywords = {
    crux: ["crux", "crux del prado", "torre 6", "santo domingo norte", "colinas"],
    pr3: ["pr3", "prado 3", "prado residences 3", "prado residences iii", "prado iii", "churchill", "paraiso", "paraíso", "ensanche paraiso"],
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

  if (combined.includes("brochure") || combined.includes("catalogo") || combined.includes("catálogo") || combined.includes("ficha") || combined.includes("presentacion") || combined.includes("presentaciones")) {
    types.push("brochure");
  }
  if (combined.includes("precio") || combined.includes("listado") || combined.includes("costo") || combined.includes("cuanto") || combined.includes("cuánto")) {
    types.push("precios");
  }
  if (combined.includes("plano") || combined.includes("distribucion") || combined.includes("distribución") || combined.includes("layout")) {
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
  // Limpiar las etiquetas del mensaje antes de enviarlo al cliente
  const cleanReply = botReply
    .replace(/\[LEAD_CALIENTE\]/g, "")
    .replace(/\[ESCALAR\]/g, "")
    .trim();
  return { isHotLead, needsEscalation, cleanReply };
}

async function notifyEnmanuel(senderPhone, userMessage, botReply, signalType) {
  const clientMeta = await getClientMeta(senderPhone);
  const clientName = clientMeta?.name || "Cliente desconocido";

  let notification = "";
  if (signalType === "hot") {
    notification = "🔥 LEAD CALIENTE\n\n";
    notification += "Nombre: " + clientName + "\n";
    notification += "Teléfono: " + senderPhone + "\n";
    notification += "Canal: WhatsApp\n\n";
    notification += "Último mensaje del cliente: " + userMessage.substring(0, 200) + "\n\n";
    notification += "Mi respuesta: " + botReply.substring(0, 300) + "\n\n";
    notification += "Acción sugerida: Llamar o escribir directamente para cerrar.";
  } else if (signalType === "escalation") {
    notification = "⚠️ ESCALAMIENTO\n\n";
    notification += "Nombre: " + clientName + "\n";
    notification += "Teléfono: " + senderPhone + "\n";
    notification += "Canal: WhatsApp\n\n";
    notification += "Último mensaje: " + userMessage.substring(0, 200) + "\n\n";
    notification += "Razón: El cliente necesita atención humana directa.";
  }

  try {
    await sendWhatsAppMessage(ENMANUEL_PHONE, notification);
    botLog("info", "Notificacion enviada a Enmanuel", { type: signalType, clientPhone: senderPhone });
  } catch (e) {
    console.error("Error notificando a Enmanuel:", e.message);
  }
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
    const senderName = value?.contacts?.[0]?.profile?.name || "Desconocido";

    // Guardar nombre del cliente en metadata
    await saveClientMeta(senderPhone, { name: senderName });

    if (messageType !== "text") {
      await sendWhatsAppMessage(
        senderPhone,
        "Hola! Por el momento solo puedo leer mensajes de texto. Escríbeme tu consulta y con gusto te ayudo."
      );
      return;
    }

    const userMessage = message.text.body;
    botLog("info", "Mensaje recibido", { phone: senderPhone, name: senderName, message: userMessage, isStaff: !!isStaff });

    // ============================================
    // DETECTAR SI ES PERSONAL INTERNO (por numero)
    // ============================================
    const isStaff = STAFF_PHONES[senderPhone];
    const isSupervisor = isStaff?.supervisor === true;
    const activePrompt = isSupervisor ? SUPERVISOR_PROMPT : SYSTEM_PROMPT;

    if (isStaff) {
      console.log("PERSONAL INTERNO detectado: " + isStaff.name + " (" + isStaff.role + ")");
    }

    await addMessage(senderPhone, "user", userMessage);
    const messageHistory = await getHistory(senderPhone);

    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      system: activePrompt,
      messages: messageHistory,
    });

    const rawReply = response.content[0].text;
    console.log("Respuesta del bot: " + rawReply);

    // Detectar señales de lead caliente o escalamiento
    const { isHotLead, needsEscalation, cleanReply } = detectLeadSignals(rawReply);
    const botReply = cleanReply;

    await addMessage(senderPhone, "assistant", botReply);
    await sendWhatsAppMessage(senderPhone, botReply);
    botLog("info", "Respuesta enviada", { phone: senderPhone, responseLength: botReply.length });

    // Notificar a Enmanuel si hay señales (solo para clientes, no para staff)
    if (!isStaff) {
      if (isHotLead) {
        await notifyEnmanuel(senderPhone, userMessage, botReply, "hot");
        await saveClientMeta(senderPhone, { temperature: "hot", hotDetectedAt: new Date().toISOString() });
      }
      if (needsEscalation) {
        await notifyEnmanuel(senderPhone, userMessage, botReply, "escalation");
        await saveClientMeta(senderPhone, { escalated: true, escalatedAt: new Date().toISOString() });
      }
    }

    // ============================================
    // ENVIO AUTOMATICO DE PDFs (solo para clientes)
    // ============================================

    // PDFs se envian a todos (clientes y staff)
    {
      const project = detectDocumentRequest(botReply, userMessage);

      if (project === "all") {
        let allSentCount = 0;
        for (const [projKey, projDocs] of Object.entries(PROJECT_DOCS)) {
          if (projDocs.brochure) {
            if (allSentCount > 0) {
              await new Promise((resolve) => setTimeout(resolve, 1500));
            }
            const allFilename = PROJECT_NAMES[projKey] + " - Brochure - JPREZ.pdf";
            const allProxyUrl = toProxyUrl(projDocs.brochure);
            await sendWhatsAppDocument(senderPhone, allProxyUrl, allFilename);
            allSentCount++;
            console.log("PDF enviado (todos): brochure de " + projKey + " a " + senderPhone);
          }
        }
        if (allSentCount > 0) {
          console.log("Total brochures enviados a " + senderPhone + ": " + allSentCount);
        }
      } else if (project && PROJECT_DOCS[project]) {
        const docs = PROJECT_DOCS[project];
        const requestedTypes = detectDocumentType(botReply, userMessage);

        let sentCount = 0;

        for (const docType of requestedTypes) {
          const docUrl = docs[docType];
          if (docUrl) {
            if (sentCount > 0) {
              await new Promise((resolve) => setTimeout(resolve, 1500));
            }

            let filename = PROJECT_NAMES[project] + " - " + DOC_TYPE_NAMES[docType] + " - JPREZ.pdf";
            // Para puertoPlata, distinguir Etapa 3 en el nombre
            if (project === "puertoPlata" && docType === "brochure") {
                filename = PROJECT_NAMES[project] + " - Brochure Etapa 3 - JPREZ.pdf";
              }
              if (project === "puertoPlata" && docType === "precios") {
              filename = PROJECT_NAMES[project] + " - Precios Etapa 3 - JPREZ.pdf";
            }
            // Convertir URL de Google Drive a nuestro proxy para que WhatsApp reciba el PDF real
            const proxyUrl = toProxyUrl(docUrl);
            await sendWhatsAppDocument(senderPhone, proxyUrl, filename);
            sentCount++;
            console.log("PDF enviado: " + docType + " de " + project + " a " + senderPhone);
          }
        }

        // Envio especial: Prado Suites Etapa 4 precios
        if (project === "puertoPlata" && requestedTypes.includes("precios") && docs.preciosE4) {
          if (sentCount > 0) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }
          const e4Filename = PROJECT_NAMES[project] + " - Precios Etapa 4 (Entrega Dic. 2027) - JPREZ.pdf";
          const e4ProxyUrl = toProxyUrl(docs.preciosE4);
          await sendWhatsAppDocument(senderPhone, e4ProxyUrl, e4Filename);
          sentCount++;
          console.log("PDF enviado: preciosE4 de puertoPlata a " + senderPhone);
        }

      // Envio especial: Prado Suites Etapa 4 brochure
      if (project === "puertoPlata" && requestedTypes.includes("brochure") && docs.brochureE4) {
        if (sentCount > 0) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        const e4BrochureFilename = PROJECT_NAMES[project] + " - Brochure Etapa 4 (Entrega Dic. 2027) - JPREZ.pdf";
        const e4BrochureProxyUrl = toProxyUrl(docs.brochureE4);
        await sendWhatsAppDocument(senderPhone, e4BrochureProxyUrl, e4BrochureFilename);
        sentCount++;
        console.log("PDF enviado: brochureE4 de puertoPlata a " + senderPhone);
      }

        if (sentCount === 0) {
          console.log("AVISO: Solicitud de docs para " + project + " pero no hay URLs configuradas en las variables de entorno");
        } else {
          console.log("Total PDFs enviados a " + senderPhone + ": " + sentCount);
        }
      }
    }
  } catch (error) {
    botLog("error", "Error procesando mensaje", { error: error.message, stack: error.stack });
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
    // Verificar firma HMAC de Meta
    if (!verifyWebhookSignature(req)) {
      botLog("warn", "Request rechazado por firma HMAC invalida", { ip: req.headers["x-forwarded-for"] });
      return res.status(401).send("Unauthorized");
    }
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
