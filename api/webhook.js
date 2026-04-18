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
const { waitUntil } = require("@vercel/functions");
const fs = require("fs");
const path = require("path");

// ============================================
// CARGA DEL SKILL (conocimiento de venta dinamico)
// ============================================
// Se lee una sola vez por cold start y se reutiliza en todas las invocaciones
// del container. Requiere que .claude/skills/** este incluido en el bundle
// serverless (ver vercel.json -> config.includeFiles).

let SKILL_CONTENT = "";
let INVENTORY_CONTENT = "";
try {
  const skillPath = path.join(__dirname, "..", ".claude", "skills", "vendedor-whatsapp-jprez", "SKILL.md");
  const inventoryPath = path.join(__dirname, "..", ".claude", "skills", "vendedor-whatsapp-jprez", "references", "inventario-precios.md");
  SKILL_CONTENT = fs.readFileSync(skillPath, "utf8");
  INVENTORY_CONTENT = fs.readFileSync(inventoryPath, "utf8");
  console.log("[prompt] skill loaded: " + SKILL_CONTENT.length + " chars, inventory: " + INVENTORY_CONTENT.length + " chars");
} catch (e) {
  console.error("[prompt] ERROR loading skill files:", e.message);
  // Fallback degradado: prompt minimo con instruccion de escalar todo.
  SKILL_CONTENT = "ERROR: skill no cargo. Se breve, no inventes, y escala todo a Enmanuel al 8299943102.";
  INVENTORY_CONTENT = "";
}

// ============================================
// VERIFICACION HMAC (Seguridad)
// ============================================

// Lee el body HTTP crudo (raw) como string UTF-8 directo del stream,
// ANTES de cualquier parseo. Requiere bodyParser desactivado via export config.
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Verifica la firma HMAC SHA256 sobre el body crudo exacto que envio Meta.
// Retorna { status, reason } donde status = "valid" | "invalid" | "missing_secret" | "missing_signature"
// Importante: la comparacion usa timingSafeEqual para evitar timing attacks.
function verifyWebhookSignature(rawBody, signatureHeader) {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    return { status: "missing_secret", reason: "META_APP_SECRET no configurado" };
  }
  if (!signatureHeader) {
    return { status: "missing_signature", reason: "Request sin header x-hub-signature-256" };
  }
  const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  // timingSafeEqual requiere que ambos buffers sean del mismo largo; si difieren
  // retornamos invalid sin comparar (evita throw).
  const sigBuf = Buffer.from(signatureHeader);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) {
    return { status: "invalid", reason: "Firma de largo inesperado" };
  }
  const isValid = crypto.timingSafeEqual(sigBuf, expBuf);
  return isValid
    ? { status: "valid" }
    : { status: "invalid", reason: "Firma HMAC no coincide con body crudo" };
}

// ============================================
// AXIOM LOGGING (Logs profesionales)
// ============================================

async function logToAxiom(events) {
  const token = process.env.AXIOM_TOKEN;
  const dataset = process.env.AXIOM_DATASET || "jprez-bot";
  if (!token) {
    console.log("[axiom] AXIOM_TOKEN no configurado, saltando");
    return;
  }
  try {
    const payload = Array.isArray(events) ? events : [events];
    const res = await fetch("https://api.axiom.co/v1/datasets/" + dataset + "/ingest", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text();
      console.log("[axiom] Ingest fallo status=" + res.status + " dataset=" + dataset + " body=" + body.slice(0, 500));
    } else {
      console.log("[axiom] Ingest OK dataset=" + dataset + " count=" + payload.length);
    }
  } catch (e) {
    console.log("[axiom] Error enviando a Axiom:", e.message);
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
  waitUntil(logToAxiom(logEntry));
}

// ============================================
// CONFIGURACION DE PERSONAL INTERNO
// ============================================

const ENMANUEL_PHONE = "18299943102";
const STAFF_PHONES = {
  [ENMANUEL_PHONE]: {
    name: "Enmanuel PÃ©rez ChÃ¡vez",
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
// SYSTEM PROMPT - VENDEDOR JPREZ (dinamico desde skill)
// ============================================
// El conocimiento de venta (identidad, proyectos, precios, objeciones, Feria de
// Mayo, etc.) vive en .claude/skills/vendedor-whatsapp-jprez/*. Aca solo
// preservamos reglas OPERATIVAS del bot: contrato con el codigo via tags
// ([LEAD_CALIENTE], [ESCALAR], [AGENDAR|...]), frases gatillo de PDFs,
// herramienta calcular_plan_pago, telefono de escalamiento, reglas WhatsApp.
// La fecha de HOY se inyecta por invocacion (no al cold start) para que el
// bot calcule meses, verifique vigencia de feria, etc.

function buildSystemPrompt() {
  const now = new Date();
  const iso = now.toISOString().slice(0, 10);
  const legible = now.toLocaleDateString("es-DO", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
    timeZone: "America/Santo_Domingo",
  });
  const fechaHeader = "Hoy es: " + iso + " (" + legible + ")";

  const operationalRules =
    "REGLAS OPERATIVAS DEL BOT DE WHATSAPP (contrato con el codigo, preservar exacto):\n" +
    "\n" +
    "Respondes por WhatsApp. Tu objetivo es llevar cada conversacion hacia el cierre de venta o hacia una cita presencial con Enmanuel (8299943102).\n" +
    "\n" +
    "REGLAS CRITICAS DE COMPORTAMIENTO WHATSAPP:\n" +
    "1. NUNCA te presentes dos veces. Si ya saludaste, NO vuelvas a saludar. Lee el historial y continua donde quedaste.\n" +
    "2. NUNCA repitas la misma frase. Si ya dijiste \"que bueno que nos escribes\", NO lo digas de nuevo. Varia siempre.\n" +
    "3. NUNCA reinicies la conversacion. Si el cliente ya te dijo que busca, NO le vuelvas a preguntar lo mismo.\n" +
    "4. Cada mensaje debe AVANZAR la conversacion hacia el cierre. Nunca retrocedas a preguntas ya respondidas.\n" +
    "5. Maximo 3-4 lineas por mensaje. Nada de muros de texto.\n" +
    "6. NUNCA uses markdown, hashtags, asteriscos, bullets ni tablas. Solo texto plano de WhatsApp.\n" +
    "7. Maximo 1-2 emojis por mensaje, y solo si es natural.\n" +
    "\n" +
    "MENSAJE DE BIENVENIDA (SIEMPRE, sin excepcion):\n" +
    "Si alguien entra al chat, aunque no diga nada o solo diga \"hola\", ese cliente llego ahi por algo. Tu trabajo es engancharlo desde el primer segundo. No esperes a que te haga preguntas - tu tomas la iniciativa.\n" +
    "Si el cliente solo dice \"hola\" o un emoji, responde con energia y haz una pregunta. Nadie se va sin que al menos intentes conectar.\n" +
    "\n" +
    "REGLA CRITICA PARA ENVIO DE DOCUMENTOS:\n" +
    "IMPORTANTE: El sistema SOLO envia PDFs cuando TU dices frases como \"te envio\", \"te mando\", \"te lo paso\". Si no dices esas frases, NO se envia nada. Usa esto a tu favor para controlar el flujo.\n" +
    "\n" +
    "CUANDO ALGUIEN PIDE VER PROYECTOS O INFORMACION GENERAL:\n" +
    "1. NO sueltes documentos de una vez. Primero califica al cliente.\n" +
    "2. Pregunta: para vivir o invertir? zona preferida? cuantas habitaciones? presupuesto?\n" +
    "3. Solo cuando ya tengas claro que busca, recomienda el proyecto ideal y AHI si enviale el brochure.\n" +
    "4. Si el cliente INSISTE (\"damelo\", \"mandame todo\", \"enviame lo que tengas\", \"quiero ver\"), entonces si enviale los brochures de todos los proyectos.\n" +
    "\n" +
    "CUANDO ALGUIEN PIDE UN PROYECTO ESPECIFICO:\n" +
    "1. Confirma que se lo envias inmediatamente usando una frase de envio.\n" +
    "2. En tu respuesta DEBES incluir una de estas frases (el sistema las detecta para enviar el PDF):\n" +
    " - \"te lo envio por aqui\"\n" +
    " - \"te lo mando ahora\"\n" +
    " - \"te envio la informacion\"\n" +
    " - \"aqui te mando\"\n" +
    " - \"te lo paso por aqui\"\n" +
    " - \"te envio el brochure\"\n" +
    " - \"te mando el brochure\"\n" +
    "3. SIEMPRE menciona el nombre del proyecto para que el sistema sepa cual documento enviar.\n" +
    "4. Despues de enviar documentos, pregunta si quieren agendar una visita.\n" +
    "\n" +
    "CUANDO ALGUIEN PIDE TODOS LOS PROYECTOS Y YA CALIFICASTE (o el cliente insiste):\n" +
    "1. Usa la frase \"te envio la informacion\" sin mencionar un proyecto especifico.\n" +
    "2. El sistema enviara automaticamente los brochures de todos los proyectos.\n" +
    "3. SIEMPRE incluye una mini-ficha de cada proyecto (una linea por proyecto, con ubicacion + unidades disponibles + precio base - tomalos del INVENTARIO Y PRECIOS de arriba, NUNCA de memoria).\n" +
    "4. Despues de enviar documentos, pregunta si quieren agendar una visita.\n" +
    "\n" +
    "CUANDO ENVIAS UN SOLO PROYECTO:\n" +
    "Siempre incluye una linea breve con: ubicacion, habitaciones disponibles y precio base tomado del inventario.\n" +
    "\n" +
    "ESCALAMIENTO A HUMANO cuando: pidan hablar con persona, queja formal, tema legal, negociar descuento fuera de feria, mas de 10 intercambios sin avance, unidad especifica que no aparece en inventario.\n" +
    "Mensaje exacto: \"Dale, te conecto con Enmanuel, nuestro asesor principal, para que te atienda personalmente. Te va a escribir en un momento.\"\n" +
    "Numero de escalamiento: 8299943102 (Enmanuel Perez Chavez, director)\n" +
    "\n" +
    "CLASIFICACION DE LEADS - IMPORTANTE:\n" +
    "Cuando respondas, si detectas que el cliente es un lead caliente (pidio precios especificos, plan de pago, quiere visita, quiere separar, tiene dinero listo), incluye al FINAL de tu respuesta en una linea aparte: [LEAD_CALIENTE]\n" +
    "Si el cliente quiere que lo escale a un humano o la situacion lo amerita, incluye: [ESCALAR]\n" +
    "Estas etiquetas NO se le muestran al cliente, el sistema las detecta automaticamente.\n" +
    "\n" +
    "AGENDAR VISITA PRESENCIAL (IMPORTANTE: flujo de cierre real):\n" +
    "Tu mision numero uno es convertir conversaciones en visitas. Cuando el cliente muestre intencion de visitar:\n" +
    "1. Pregunta que dia le va bien (hoy, manana, sabado, etc.) y hora aproximada.\n" +
    "2. Confirma cual proyecto quiere ver.\n" +
    "3. Cuando ya tengas dia + hora + proyecto, incluye al FINAL de tu respuesta en linea aparte:\n" +
    "   [AGENDAR|proyecto|fecha_iso|notas]\n" +
    "   proyecto: uno de crux, pr3, pr4, puertoPlata\n" +
    "   fecha_iso: formato ISO 8601 con zona horaria Santo Domingo (UTC-4), ejemplo 2026-04-19T10:00:00-04:00\n" +
    "   notas: cualquier detalle util (opcional)\n" +
    "   Ejemplo: [AGENDAR|pr3|2026-04-19T10:00:00-04:00|cliente quiere ver unidad piso alto]\n" +
    "4. En tu mensaje al cliente, confirma de forma natural: \"Dale, listo, agendado para el sabado 10am en PR3. Enmanuel te escribe manana para confirmar detalles.\"\n" +
    "5. Esta etiqueta NO se le muestra al cliente, el sistema la detecta y le avisa a Enmanuel con los datos estructurados.\n" +
    "6. Si el cliente no te da dia/hora claro aun, NO pongas la etiqueta. Sigue conversando para obtener los datos.\n" +
    "\n" +
    "CALCULADORA DE CUOTAS (herramienta disponible):\n" +
    "Tienes una herramienta llamada calcular_plan_pago. USALA cuando el cliente pregunte:\n" +
    "- \"cuanto pago al mes\"\n" +
    "- \"cuotas\", \"mensualidad\", \"financiamiento\"\n" +
    "- \"cuanto es la inicial\"\n" +
    "- Cualquier variante donde pida numeros concretos de pago\n" +
    "Le pasas proyecto + precio_usd, te devuelve el desglose exacto. Luego explicaselo al cliente en lenguaje natural, tipo:\n" +
    "\"Para PR3 a US$156K: separacion 10% = US$15,600. Durante la construccion pagas como US$X al mes. Contra entrega 60% = US$93,600 (con banco o directo).\"\n" +
    "NO inventes numeros. Si no tienes la herramienta, di \"dejame calcularte los numeros\" y usa la herramienta.";

  return [
    fechaHeader,
    "",
    SKILL_CONTENT,
    "",
    "---",
    "",
    "INVENTARIO Y PRECIOS DETALLADOS (consulta siempre antes de cotizar):",
    "",
    INVENTORY_CONTENT,
    "",
    "---",
    "",
    operationalRules,
  ].join("\n");
}

// ============================================
// SYSTEM PROMPT PARA MODO SUPERVISOR
// ============================================

const SUPERVISOR_PROMPT = `Eres el asistente inteligente de Constructora JPREZ. Estas hablando con Enmanuel Perez Chavez, el director de la empresa.

NO le vendas. El es tu jefe. TrÃ¡talo como tal.

Tu rol con Enmanuel:
1. REPORTES: Si pide un resumen, reporte o "como va todo", dale un resumen de la actividad. Si tienes datos en el historial, usalos.
2. COLABORACION: Si te pide redactar un mensaje, revisar algo, preparar info para un cliente, hazlo.
3. INSTRUCCIONES: Si te da instrucciones sobre como responder o cambios, acÃ¡talas y confirma.
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

// Extrae el ID de una URL de Google Drive en cualquier formato comun
// (?id=XXX, /file/d/XXX/, /open?id=XXX, etc.)
function extractDriveId(url) {
  if (!url) return null;
  const queryMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (queryMatch) return queryMatch[1];
  const pathMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (pathMatch) return pathMatch[1];
  return null;
}

// Convierte URL de Google Drive a URL de nuestro proxy de PDFs
function toProxyUrl(driveUrl) {
  if (!driveUrl) return null;
  const id = extractDriveId(driveUrl);
  if (id) return VERCEL_DOMAIN + "/api/pdf?id=" + id;
  return driveUrl;
}

// Convierte URL de Google Drive a URL de nuestro proxy de imagenes
function toImageProxyUrl(url) {
  if (!url) return null;
  const id = extractDriveId(url);
  if (id) return VERCEL_DOMAIN + "/api/img?id=" + id;
  return url;
}

// Parsea env vars con URLs separadas por coma (IMG_CRUX="url1,url2,url3")
function parseImageUrls(envVar) {
  if (!envVar) return [];
  return envVar.split(",").map((s) => s.trim()).filter(Boolean);
}

const PROJECT_DOCS = {
  crux: {
    brochure: process.env.PDF_CRUX_BROCHURE || null,
    precios: process.env.PDF_CRUX_PRECIOS || null,
    planos: process.env.PDF_CRUX_PLANOS || null,
    images: parseImageUrls(process.env.IMG_CRUX),
  },
  pr3: {
    brochure: process.env.PDF_PR3_BROCHURE || null,
    precios: process.env.PDF_PR3_PRECIOS || null,
    planos: process.env.PDF_PR3_PLANOS || null,
    images: parseImageUrls(process.env.IMG_PR3),
  },
  pr4: {
    brochure: process.env.PDF_PR4_BROCHURE || null,
    precios: process.env.PDF_PR4_PRECIOS || null,
    planos: process.env.PDF_PR4_PLANOS || null,
    images: parseImageUrls(process.env.IMG_PR4),
  },
  puertoPlata: {
    brochure: process.env.PDF_PP_BROCHURE || null,
    brochureE4: process.env.PDF_PP_BROCHURE_E4 || null,
    precios: process.env.PDF_PP_PRECIOS || null,
    preciosE4: process.env.PDF_PP_PRECIOS_E4 || null,
    planos: process.env.PDF_PP_PLANOS || null,
    images: parseImageUrls(process.env.IMG_PP),
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
// CALCULADORA DE PLAN DE PAGO (Tool use)
// ============================================

// Planes de pago por proyecto (porcentajes)
const PAYMENT_PLANS = {
  crux: { separacion: 0.10, completivo: 0.20, entrega: 0.70 }, // Torre 6
  pr3: { separacion: 0.10, completivo: 0.30, entrega: 0.60 },
  pr4: { separacion: 0.10, completivo: 0.30, entrega: 0.60 },
  puertoPlata: { separacion: 0.10, completivo: 0.30, entrega: 0.60 },
};

// Fechas aproximadas de entrega para calcular meses de cuota
const DELIVERY_DATES = {
  crux: "2027-07-01",
  pr3: "2026-08-01",
  pr4: "2027-09-01",
  puertoPlata: "2027-12-01",
};

function calcularPlanPago(proyecto, precioUsd) {
  const plan = PAYMENT_PLANS[proyecto];
  const delivery = DELIVERY_DATES[proyecto];
  if (!plan || !delivery) {
    return { error: "Proyecto no reconocido: " + proyecto };
  }
  const now = new Date();
  const deliveryDate = new Date(delivery);
  const monthsRemaining = Math.max(1, Math.round((deliveryDate - now) / (30 * 86400 * 1000)));
  const separacion = Math.round(precioUsd * plan.separacion);
  const completivoTotal = Math.round(precioUsd * plan.completivo);
  const contraEntrega = Math.round(precioUsd * plan.entrega);
  const cuotaMensual = Math.round(completivoTotal / monthsRemaining);
  return {
    proyecto: PROJECT_NAMES[proyecto] || proyecto,
    precio_total_usd: precioUsd,
    separacion_usd: separacion,
    separacion_pct: Math.round(plan.separacion * 100),
    completivo_total_usd: completivoTotal,
    completivo_pct: Math.round(plan.completivo * 100),
    meses_hasta_entrega: monthsRemaining,
    cuota_mensual_usd: cuotaMensual,
    contra_entrega_usd: contraEntrega,
    contra_entrega_pct: Math.round(plan.entrega * 100),
    nota: "Cuota mensual = completivo total / meses hasta entrega. Contra entrega se cubre con banco o pago directo.",
  };
}

const TOOLS = [
  {
    name: "calcular_plan_pago",
    description:
      "Calcula el plan de pago desglosado de una unidad JPREZ: separacion, cuota mensual durante construccion, y monto contra entrega. " +
      "Usalo SIEMPRE que el cliente pregunte 'cuanto pago al mes', 'cuotas', 'financiamiento', 'inicial', 'mensualidad', o pida numeros concretos de pago. " +
      "Devuelve JSON con los montos exactos para que puedas mostrarlos al cliente.",
    input_schema: {
      type: "object",
      properties: {
        proyecto: {
          type: "string",
          enum: ["crux", "pr3", "pr4", "puertoPlata"],
          description: "Codigo del proyecto: crux=Crux del Prado Torre 6, pr3=Prado Residences III, pr4=Prado Residences IV, puertoPlata=Prado Suites Puerto Plata",
        },
        precio_usd: {
          type: "number",
          description: "Precio total de la unidad en USD. Usa el precio base del proyecto si no sabes uno especifico.",
        },
      },
      required: ["proyecto", "precio_usd"],
    },
  },
];

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

async function notifyEnmanuel(senderPhone, userMessage, botReply, signalType) {
  const clientMeta = await getClientMeta(senderPhone);
  const clientName = clientMeta?.name || "Cliente desconocido";

  let notification = "";
  if (signalType === "hot") {
    notification = "ð¥ LEAD CALIENTE\n\n";
    notification += "Nombre: " + clientName + "\n";
    notification += "TelÃ©fono: " + senderPhone + "\n";
    notification += "Canal: WhatsApp\n\n";
    notification += "Ãltimo mensaje del cliente: " + userMessage.substring(0, 200) + "\n\n";
    notification += "Mi respuesta: " + botReply.substring(0, 300) + "\n\n";
    notification += "AcciÃ³n sugerida: Llamar o escribir directamente para cerrar.";
  } else if (signalType === "escalation") {
    notification = "â ï¸ ESCALAMIENTO\n\n";
    notification += "Nombre: " + clientName + "\n";
    notification += "TelÃ©fono: " + senderPhone + "\n";
    notification += "Canal: WhatsApp\n\n";
    notification += "Ãltimo mensaje: " + userMessage.substring(0, 200) + "\n\n";
    notification += "RazÃ³n: El cliente necesita atenciÃ³n humana directa.";
  }

  try {
    await sendWhatsAppMessage(ENMANUEL_PHONE, notification);
    botLog("info", "Notificacion enviada a Enmanuel", { type: signalType, clientPhone: senderPhone });
  } catch (e) {
    console.error("Error notificando a Enmanuel:", e.message);
  }
}

async function notifyEnmanuelBooking(senderPhone, booking) {
  const clientMeta = await getClientMeta(senderPhone);
  const clientName = clientMeta?.name && clientMeta.name !== "Desconocido" ? clientMeta.name : "Cliente";
  const projectName = PROJECT_NAMES[booking.project] || booking.project;

  let fechaLegible = booking.atRaw;
  if (booking.at) {
    try {
      fechaLegible = new Date(booking.at).toLocaleString("es-DO", {
        timeZone: "America/Santo_Domingo",
        weekday: "long",
        day: "numeric",
        month: "long",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
    } catch (e) {
      fechaLegible = booking.atRaw;
    }
  }

  // wa.me link para que Enmanuel abra el chat con un tap
  const waLink = "https://wa.me/" + senderPhone;

  let notif = "NUEVA VISITA AGENDADA\n\n";
  notif += "Cliente: " + clientName + "\n";
  notif += "Telefono: " + senderPhone + "\n";
  notif += "Proyecto: " + projectName + "\n";
  notif += "Cuando: " + fechaLegible + "\n";
  if (booking.notas) notif += "Notas: " + booking.notas + "\n";
  notif += "\nAbrir chat: " + waLink + "\n\n";
  notif += "Accion sugerida: confirmar manana con el cliente y preparar la visita.";

  try {
    await sendWhatsAppMessage(ENMANUEL_PHONE, notif);
    botLog("info", "Visita agendada notificada", { phone: senderPhone, project: booking.project, at: booking.at });
  } catch (e) {
    console.error("Error notificando visita:", e.message);
  }
}

// ============================================
// CONTEXTO DINAMICO DEL CLIENTE + ESCALAMIENTO
// ============================================

const ESCALATION_SILENCE_HOURS = 4;
const REMINDER_THROTTLE_HOURS = 1;

function buildClientContext(meta) {
  if (!meta) return "";
  const parts = [];
  if (meta.name && meta.name !== "Desconocido") {
    parts.push("- Nombre: " + meta.name);
  }
  if (meta.temperature) {
    parts.push("- Temperatura del lead: " + meta.temperature);
  }
  if (meta.sentDocs && Object.keys(meta.sentDocs).length > 0) {
    const labels = Object.keys(meta.sentDocs).map((k) => {
      const [proj, type] = k.split(".");
      const projName = PROJECT_NAMES[proj] || proj;
      const typeName = DOC_TYPE_NAMES[type] || type;
      return projName + " (" + typeName + ")";
    });
    parts.push("- Documentos ya enviados antes: " + labels.join(", "));
  }
  if (meta.lastContact) {
    const hoursAgo = (Date.now() - new Date(meta.lastContact).getTime()) / 3600000;
    if (hoursAgo > 1) {
      const label = hoursAgo < 24
        ? Math.round(hoursAgo) + " horas"
        : Math.round(hoursAgo / 24) + " dias";
      parts.push("- Ultimo contacto previo: hace " + label);
    }
  }
  if (meta.escalated === false && meta.escalatedAt) {
    parts.push("- Nota: fue escalado a Enmanuel antes. Retoma de forma natural, sin saludar de nuevo.");
  }
  if (parts.length === 0) return "";
  return "\n\n---\nCONTEXTO DEL CLIENTE (uso interno, NO menciones estos datos literalmente al cliente):\n" +
    parts.join("\n") +
    "\n\nReglas segun este contexto:\n" +
    "- Si hay historial previo, NO saludes como primera vez. Continua la conversacion.\n" +
    "- NO re-envies documentos que figuran como ya enviados, salvo que el cliente lo pida de forma explicita.\n" +
    "- Usa el nombre si lo conoces, pero sin abusar (no en cada mensaje).";
}

function isEscalationActive(meta) {
  if (!meta || meta.escalated !== true || !meta.escalatedAt) return false;
  const ageMs = Date.now() - new Date(meta.escalatedAt).getTime();
  return ageMs < ESCALATION_SILENCE_HOURS * 3600000;
}

function shouldRemindEnmanuel(meta) {
  const last = meta?.lastReminderAt;
  if (!last) return true;
  const ageMs = Date.now() - new Date(last).getTime();
  return ageMs > REMINDER_THROTTLE_HOURS * 3600000;
}

async function markDocSent(phone, docKey) {
  const meta = (await getClientMeta(phone)) || {};
  const sentDocs = { ...(meta.sentDocs || {}), [docKey]: new Date().toISOString() };
  await saveClientMeta(phone, { sentDocs });
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

    // Soporte de audio (notas de voz) via Whisper
    let userMessage;
    if (messageType === "text") {
      userMessage = message.text.body;
    } else if (messageType === "audio" || messageType === "voice") {
      const audioId = message.audio?.id || message.voice?.id;
      botLog("info", "Audio recibido, intentando transcribir", { phone: senderPhone, audioId });
      const transcribed = audioId ? await transcribeWhatsAppAudio(audioId) : null;
      if (!transcribed) {
        await sendWhatsAppMessage(
          senderPhone,
          "Escuche tu audio pero tuve problemas procesandolo. Me lo puedes escribir por texto y te ayudo al instante?"
        );
        return;
      }
      userMessage = transcribed;
      botLog("info", "Audio transcrito", { phone: senderPhone, length: transcribed.length });
    } else {
      await sendWhatsAppMessage(
        senderPhone,
        "Hola! Por el momento solo puedo leer texto y notas de voz. Escribeme tu consulta y con gusto te ayudo."
      );
      return;
    }

    // ============================================
    // DETECTAR SI ES PERSONAL INTERNO (por numero)
    // ============================================
    const isStaff = STAFF_PHONES[senderPhone];
    botLog("info", "Mensaje recibido", { phone: senderPhone, name: senderName, message: userMessage, isStaff: !!isStaff });
    const isSupervisor = isStaff?.supervisor === true;
    const activePrompt = isSupervisor ? SUPERVISOR_PROMPT : buildSystemPrompt();

    if (isStaff) {
      console.log("PERSONAL INTERNO detectado: " + isStaff.name + " (" + isStaff.role + ")");
    }

    // Cargar metadata del cliente (para contexto dinamico + gestion de escalamiento)
    const clientMeta = !isStaff ? await getClientMeta(senderPhone) : null;

    // Si hay un escalamiento activo (< 4h), el bot se silencia.
    // Guarda el mensaje en historial y avisa a Enmanuel (con throttle de 1h).
    if (!isStaff && isEscalationActive(clientMeta)) {
      await addMessage(senderPhone, "user", userMessage);
      botLog("info", "Bot silenciado: escalamiento activo", {
        phone: senderPhone,
        escalatedAt: clientMeta.escalatedAt,
      });
      if (shouldRemindEnmanuel(clientMeta)) {
        try {
          const clientLabel = clientMeta.name && clientMeta.name !== "Desconocido"
            ? clientMeta.name
            : senderPhone;
          await sendWhatsAppMessage(
            ENMANUEL_PHONE,
            "Recordatorio: " + clientLabel + " (" + senderPhone + ") sigue escribiendo. Sigue en modo escalado."
          );
          await saveClientMeta(senderPhone, { lastReminderAt: new Date().toISOString() });
        } catch (e) {
          console.log("Error recordando a Enmanuel:", e.message);
        }
      }
      return;
    }

    // Si el escalamiento ya vencio (> 4h), limpiar flag y seguir flujo normal
    if (!isStaff && clientMeta?.escalated === true && !isEscalationActive(clientMeta)) {
      await saveClientMeta(senderPhone, { escalated: false });
    }

    await addMessage(senderPhone, "user", userMessage);
    const messageHistory = await getHistory(senderPhone);

    // Inyectar contexto dinamico del cliente al system prompt (solo flujo de cliente)
    const clientContext = !isSupervisor ? buildClientContext(clientMeta) : "";
    const finalPrompt = activePrompt + clientContext;

    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    // Loop de tool use: Claude puede pedir la calculadora hasta MAX_TOOL_ITERATIONS veces.
    // Cada iteracion es una llamada a la API. En la mayoria de casos solo hay 1 o 2.
    const MAX_TOOL_ITERATIONS = 3;
    let workingMessages = [...messageHistory];
    let response;
    let iteration = 0;
    while (iteration < MAX_TOOL_ITERATIONS) {
      response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 500,
        system: finalPrompt,
        tools: TOOLS,
        messages: workingMessages,
      });
      if (response.stop_reason !== "tool_use") break;

      const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
      workingMessages.push({ role: "assistant", content: response.content });
      const toolResults = toolUseBlocks.map((block) => {
        let result;
        if (block.name === "calcular_plan_pago") {
          result = calcularPlanPago(block.input.proyecto, block.input.precio_usd);
        } else {
          result = { error: "Herramienta desconocida: " + block.name };
        }
        botLog("info", "Tool use", { phone: senderPhone, tool: block.name, input: block.input, result });
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        };
      });
      workingMessages.push({ role: "user", content: toolResults });
      iteration++;
    }

    // Extraer el texto final (ignorando bloques tool_use residuales)
    const textBlocks = response.content.filter((b) => b.type === "text");
    const rawReply = textBlocks.map((b) => b.text).join("\n").trim() || "Dejame un momento, te respondo en seguida.";
    console.log("Respuesta del bot: " + rawReply);

    // Detectar senales de lead caliente, escalamiento y agendamiento
    const { isHotLead, needsEscalation, booking, cleanReply } = detectLeadSignals(rawReply);
    const botReply = cleanReply;

    await addMessage(senderPhone, "assistant", botReply);
    await sendWhatsAppMessage(senderPhone, botReply);
    botLog("info", "Respuesta enviada", { phone: senderPhone, responseLength: botReply.length });

    // Notificar a Enmanuel si hay seÃ±ales (solo para clientes, no para staff)
    if (!isStaff) {
      if (isHotLead) {
        await notifyEnmanuel(senderPhone, userMessage, botReply, "hot");
        await saveClientMeta(senderPhone, { temperature: "hot", hotDetectedAt: new Date().toISOString() });
      }
      if (needsEscalation) {
        await notifyEnmanuel(senderPhone, userMessage, botReply, "escalation");
        await saveClientMeta(senderPhone, { escalated: true, escalatedAt: new Date().toISOString() });
      }

      // Agendamiento de visita: guardar + notificar con tarjeta estructurada
      if (booking) {
        await notifyEnmanuelBooking(senderPhone, booking);
        await saveClientMeta(senderPhone, {
          scheduledVisit: booking,
          temperature: "hot", // quien agenda visita es lead caliente por definicion
        });
        // Al agendar, suspendemos el followup automatico:
        // la siguiente interaccion sera con Enmanuel cara a cara.
      }

      // Cliente respondio -> resetear contador de followups.
      // El calendario del cron se dispara a partir de lastContact + dias segun
      // temperatura, asi que no hace falta programar un timestamp especifico.
      if (!needsEscalation) {
        await saveClientMeta(senderPhone, {
          followUpCount: 0,
          followUpStage: 0,
        });
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
            // Enviar imagenes teaser antes del brochure (si estan configuradas)
            await sendProjectImages(senderPhone, projKey);
            const allFilename = PROJECT_NAMES[projKey] + " - Brochure - JPREZ.pdf";
            const allProxyUrl = toProxyUrl(projDocs.brochure);
            await sendWhatsAppDocument(senderPhone, allProxyUrl, allFilename);
            allSentCount++;
            await markDocSent(senderPhone, projKey + ".brochure");
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

        // Si el primer doc que se va a mandar es el brochure, enviar imagenes teaser antes
        if (requestedTypes[0] === "brochure" && docs.images && docs.images.length > 0) {
          await sendProjectImages(senderPhone, project);
        }

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
            await markDocSent(senderPhone, project + "." + docType);
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
          await markDocSent(senderPhone, project + ".preciosE4");
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
        await markDocSent(senderPhone, project + ".brochureE4");
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

async function handler(req, res) {
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
    // 1. Leer el body crudo ANTES de cualquier parseo (bodyParser desactivado via config)
    let rawBody;
    try {
      rawBody = await readRawBody(req);
    } catch (e) {
      botLog("error", "No se pudo leer raw body", { error: e.message });
      return res.status(400).json({ error: "Could not read body" });
    }

    // 2. Validar firma HMAC sobre el body crudo exacto
    const signatureHeader = req.headers["x-hub-signature-256"];
    const hmac = verifyWebhookSignature(rawBody, signatureHeader);
    const clientIp = req.headers["x-forwarded-for"] || null;

    if (hmac.status === "valid") {
      botLog("info", "HMAC valido", { ip: clientIp });
    } else if (hmac.status === "missing_secret") {
      botLog("warn", "HMAC no validado (META_APP_SECRET ausente)", { ip: clientIp });
    } else {
      // Fase 2: enforcement activo. Firma invalida o ausente = rechazar con 401.
      // Solo requests firmados correctamente por Meta pueden pasar.
      botLog("warn", "Request rechazado por HMAC invalido", {
        status: hmac.status,
        reason: hmac.reason,
        ip: clientIp,
      });
      return res.status(401).json({ error: "Unauthorized: invalid webhook signature" });
    }

    // 3. Parsear JSON manualmente DESPUES de la verificacion HMAC.
    // Si el body no es JSON valido respondemos 400 antes de procesar.
    let body;
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch (e) {
      botLog("error", "Body no es JSON valido", { error: e.message, preview: rawBody.slice(0, 120) });
      return res.status(400).json({ error: "Invalid JSON body" });
    }

    await processMessage(body);
    return res.status(200).send("EVENT_RECEIVED");
  }

  return res.status(405).send("Method Not Allowed");
}

// Desactiva el bodyParser de Vercel para que podamos leer el stream crudo y
// calcular HMAC sobre los bytes exactos que firmo Meta.
handler.config = {
  api: {
    bodyParser: false,
  },
};

module.exports = handler;

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

// ============================================
// ENVIAR IMAGEN POR WHATSAPP
// ============================================

async function sendWhatsAppImage(to, imageUrl, caption) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  const url = "https://graph.facebook.com/v21.0/" + phoneNumberId + "/messages";

  const imagePayload = { link: imageUrl };
  if (caption) imagePayload.caption = caption;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: to,
      type: "image",
      image: imagePayload,
    }),
  });

  if (!response.ok) {
    const errorData = await response.text();
    console.error("Error enviando imagen:", errorData);
    throw new Error("WhatsApp Image API error: " + response.status);
  }

  return response.json();
}

// Envia todas las imagenes configuradas de un proyecto. Se usa como teaser antes
// del brochure. Degrada a no-op si no hay imagenes en env vars.
async function sendProjectImages(phone, project) {
  const docs = PROJECT_DOCS[project];
  if (!docs?.images || docs.images.length === 0) return 0;
  let sent = 0;
  for (const imgUrl of docs.images) {
    if (sent > 0) await new Promise((r) => setTimeout(r, 1000));
    try {
      // Si es link de Drive, lo pasamos por nuestro proxy de imagenes
      const finalUrl = toImageProxyUrl(imgUrl);
      await sendWhatsAppImage(phone, finalUrl);
      sent++;
    } catch (e) {
      console.log("Error enviando imagen de " + project + ":", e.message);
    }
  }
  return sent;
}

// ============================================
// TRANSCRIPCION DE AUDIO (Whisper / OpenAI)
// ============================================

// Descarga el audio desde Meta y lo transcribe con Whisper.
// Retorna el texto transcrito, o null si falla o no hay API key configurada.
async function transcribeWhatsAppAudio(audioId) {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    console.log("OPENAI_API_KEY no configurado, no se puede transcribir audio");
    return null;
  }
  const waToken = process.env.WHATSAPP_TOKEN;

  // 1. Obtener URL del media desde Meta
  const mediaMetaResp = await fetch("https://graph.facebook.com/v21.0/" + audioId, {
    headers: { Authorization: "Bearer " + waToken },
  });
  if (!mediaMetaResp.ok) {
    console.error("Error obteniendo metadata del audio:", await mediaMetaResp.text());
    return null;
  }
  const mediaMeta = await mediaMetaResp.json();
  const mediaUrl = mediaMeta.url;
  const mimeType = mediaMeta.mime_type || "audio/ogg";

  // 2. Descargar el audio (requiere el token de WA)
  const audioResp = await fetch(mediaUrl, {
    headers: { Authorization: "Bearer " + waToken },
  });
  if (!audioResp.ok) {
    console.error("Error descargando audio:", audioResp.status);
    return null;
  }
  const audioBuffer = await audioResp.arrayBuffer();

  // 3. Enviar a Whisper
  const form = new FormData();
  const ext = mimeType.includes("mpeg") ? "mp3" : mimeType.includes("mp4") ? "mp4" : "ogg";
  form.append("file", new Blob([audioBuffer], { type: mimeType }), "audio." + ext);
  form.append("model", "whisper-1");
  form.append("language", "es");

  const whisperResp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: "Bearer " + openaiKey },
    body: form,
  });
  if (!whisperResp.ok) {
    console.error("Error de Whisper:", await whisperResp.text());
    return null;
  }
  const whisperData = await whisperResp.json();
  return (whisperData.text || "").trim();
}
