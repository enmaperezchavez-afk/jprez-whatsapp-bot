// src/handlers/message.js — Orquestador principal de mensajes WhatsApp.
//
// RESPONSABILIDAD: procesa mensajes entrantes ya pre-validados por el
// handler en api/webhook.js (HMAC + idempotency + rate limit + body
// parse). Decide qué responder, qué documentos enviar, cuándo escalar
// a staff, cuándo notificar a Enmanuel.
//
// CONTRATO:
//   processMessage(body): Promise<void>
//     - body: payload de Meta ya parseado.
//     - Side effects: WhatsApp messages enviados, Redis updated,
//       posibles notifications a staff, posible escalation.
//     - Errors internos: atrapados + logueados; nunca propaga al handler.
//
// INTERNOS DEL MÓDULO (no exportados):
//   - Wrappers notifyWithMeta + notifyBookingWithMeta (DI sobre clientMeta)
//   - Constantes de dominio: PROJECT_DOCS, PROJECT_NAMES, PAYMENT_PLANS, etc.
//   - Helpers: calcularPlanPago, buildClientContext, sendProjectImages,
//     isEscalationActive, shouldRemindEnmanuel
//   - TOOLS schema para Anthropic tool use
//
// DEPENDENCIAS (requires):
//   - src/log, src/store/*, src/whatsapp, src/proxy, src/notify,
//     src/detect, src/prompts, src/claude, src/staff
//
// NO ES LEAF: orquestador con muchas dependencias por design.

const { botLog } = require("../log");
const { getHistory, addMessage } = require("../store/history");
const { saveClientMeta, getClientMeta, markDocSent } = require("../store/meta");
const { callClaudeWithTools } = require("../claude");
const {
  sendWhatsAppMessage,
  sendWhatsAppDocument,
  sendWhatsAppImage,
  transcribeWhatsAppAudio,
} = require("../whatsapp");
const { toProxyUrl, toImageProxyUrl } = require("../proxy");
const {
  ENMANUEL_PHONE,
  notifyEnmanuel,
  notifyEnmanuelBooking,
  notifyDescuentoOfrecido,
  notifyRecomendacionCompetencia,
  detectDiscountOffer,
} = require("../notify");
const { detectDocumentRequest, detectDocumentType, detectLeadSignals } = require("../detect");
const { buildSystemPrompt, SUPERVISOR_PROMPT } = require("../prompts");
const { STAFF_PHONES } = require("../staff");
const { getCustomerProfile, updateCustomerProfile } = require("../profile/storage");
const { extractProfileUpdate, validateProfileUpdate } = require("../profile/extractor");
const adminTesting = require("../admin-testing-mode");

// ============================================
// WRAPPERS (dependency injection sobre clientMeta)
// ============================================

async function notifyWithMeta(senderPhone, userMessage, botReply, signalType) {
  const clientMeta = await getClientMeta(senderPhone);
  return notifyEnmanuel(senderPhone, userMessage, botReply, signalType, clientMeta);
}

async function notifyBookingWithMeta(senderPhone, booking) {
  const clientMeta = await getClientMeta(senderPhone);
  const projectName = PROJECT_NAMES[booking.project] || booking.project;
  return notifyEnmanuelBooking(senderPhone, booking, clientMeta, projectName);
}

// ============================================
// CONSTANTES DE DOMINIO (PDFs, proyectos, nombres)
// ============================================

// Parsea env vars con URLs separadas por coma (IMG_CRUX="url1,url2,url3")
function parseImageUrls(envVar) {
  if (!envVar) return [];
  return envVar.split(",").map((s) => s.trim()).filter(Boolean);
}

// PROJECT_DOCS — env vars con URLs de PDFs/imagenes por proyecto.
// Las URLs de Drive se transforman a traves de src/proxy.js antes
// de enviarse a WhatsApp.
const PROJECT_DOCS = {
  crux: {
    brochure: process.env.PDF_CRUX_BROCHURE || null,
    precios: process.env.PDF_CRUX_PRECIOS || null,
    // Slot "planos" eliminado en hotfix-4 FIX 3a: PDF_CRUX_PLANOS apuntaba a
    // un archivo que contiene precios, no planos arquitectónicos. Se retira
    // hasta que Enmanuel provea el archivo real. La env var puede seguir
    // existiendo en Vercel sin efecto.
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
    // TODO [backlog]: PDF_PP_BROCHURE_E4 se consume en el bloque especial
    // "brochure Etapa 4" (ver loop principal más abajo). Verificar con
    // Enmanuel si la env var apunta a un archivo real en Drive/Blob o si
    // hay que eliminar la env var y el consumidor.
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
  precios: "Precios y Disponibilidad",
  planos: "Planos Arquitectónicos",
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

// Fechas aproximadas de entrega para calcular meses de cuota.
// Puerto Plata tiene DOS etapas con fechas distintas — el lookup de
// puertoPlata pasa por la rama especial en calcularPlanPago para pickear
// la fecha correcta segun `etapa`. Sin etapa explicita la llamada retorna
// error (obliga al modelo a desambiguar antes de calcular).
const DELIVERY_DATES = {
  crux: "2027-07-01",
  pr3: "2026-08-01",
  pr4: "2027-08-01",
};

const PUERTO_PLATA_DELIVERY = {
  E3: "2029-03-01",
  E4: "2027-09-01",
};

function calcularPlanPago(proyecto, precioUsd, etapa) {
  const plan = PAYMENT_PLANS[proyecto];
  if (!plan) {
    return { error: "Proyecto no reconocido: " + proyecto };
  }
  let delivery;
  if (proyecto === "puertoPlata") {
    if (!etapa || !PUERTO_PLATA_DELIVERY[etapa]) {
      return { error: "Para Puerto Plata debes especificar la etapa: 'E3' o 'E4'. Cada etapa tiene fecha de entrega distinta." };
    }
    delivery = PUERTO_PLATA_DELIVERY[etapa];
  } else {
    delivery = DELIVERY_DATES[proyecto];
    if (!delivery) {
      return { error: "Proyecto sin fecha de entrega configurada: " + proyecto };
    }
  }
  const now = new Date();
  const deliveryDate = new Date(delivery);
  const monthsRemaining = Math.max(1, Math.round((deliveryDate - now) / (30 * 86400 * 1000)));
  const separacion = Math.round(precioUsd * plan.separacion);
  const completivoTotal = Math.round(precioUsd * plan.completivo);
  const contraEntrega = Math.round(precioUsd * plan.entrega);
  const cuotaMensual = Math.round(completivoTotal / monthsRemaining);
  const proyectoLabel = proyecto === "puertoPlata"
    ? (PROJECT_NAMES[proyecto] || proyecto) + " Etapa " + etapa
    : (PROJECT_NAMES[proyecto] || proyecto);
  return {
    proyecto: proyectoLabel,
    etapa: proyecto === "puertoPlata" ? etapa : null,
    precio_total_usd: precioUsd,
    separacion_usd: separacion,
    separacion_pct: Math.round(plan.separacion * 100),
    completivo_total_usd: completivoTotal,
    completivo_pct: Math.round(plan.completivo * 100),
    meses_hasta_entrega: monthsRemaining,
    cuota_mensual_usd: cuotaMensual,
    contra_entrega_usd: contraEntrega,
    contra_entrega_pct: Math.round(plan.entrega * 100),
    entrega_fecha: delivery,
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
        etapa: {
          type: "string",
          enum: ["E3", "E4"],
          description: "SOLO para Puerto Plata: etapa del proyecto (E3 entrega marzo 2029, E4 entrega septiembre 2027). Afecta el calculo de cuotas porque los meses hasta entrega son distintos. OBLIGATORIO cuando proyecto = 'puertoPlata'. Ignorado en otros proyectos.",
        },
      },
      required: ["proyecto", "precio_usd"],
    },
  },
];

// ============================================
// CONTEXTO DINAMICO DEL CLIENTE + ESCALAMIENTO
// ============================================

const ESCALATION_SILENCE_HOURS = 4;
const REMINDER_THROTTLE_HOURS = 1;

// buildProfileContext: serializa el perfil Mateo (profile:<phone>) al bloque
// PERFIL_CLIENTE que se inyecta al system prompt. Convive con buildClientContext
// (que lee meta:<phone> histórico) — ambos se concatenan, el agente decide qué
// usar. Si el perfil es nuevo (is_new=true), retorna bloque vacío que
// explícitamente le dice a Mateo "cliente nuevo, presentate con un saludo".
function buildProfileContext(profile) {
  if (!profile) return "";
  if (profile.is_new) {
    return "\n\n---\nPERFIL_CLIENTE: cliente nuevo, primera conversacion. Saluda segun la hora, presentate como Mateo, haz UNA pregunta abierta para empezar a calificar.";
  }
  const parts = [];
  if (profile.nombre) parts.push("- Nombre: " + profile.nombre);
  if (profile.proyecto_interes) parts.push("- Proyecto de interes: " + profile.proyecto_interes);
  if (profile.tipologia_interes) parts.push("- Tipologia: " + profile.tipologia_interes);
  if (profile.presupuesto_mencionado) {
    const moneda = profile.moneda_presupuesto || "USD";
    parts.push("- Presupuesto mencionado: " + profile.presupuesto_mencionado + " " + moneda);
  }
  if (profile.ubicacion_cliente) parts.push("- Ubicacion del cliente: " + profile.ubicacion_cliente);
  if (profile.fecha_mudanza_objetivo) parts.push("- Fecha objetivo de mudanza: " + profile.fecha_mudanza_objetivo);
  if (profile.fuente_financiamiento) parts.push("- Fuente de financiamiento: " + profile.fuente_financiamiento);
  if (profile.intencion_compra) parts.push("- Intencion de compra: " + profile.intencion_compra);
  if (profile.score_lead) parts.push("- Score de lead: " + profile.score_lead);
  if (Array.isArray(profile.tags) && profile.tags.length > 0) {
    parts.push("- Tags: " + profile.tags.join(", "));
  }
  if (Array.isArray(profile.objeciones_historicas) && profile.objeciones_historicas.length > 0) {
    parts.push("- Objeciones previas: " + profile.objeciones_historicas.slice(-5).join(" | "));
  }
  if (Array.isArray(profile.documentos_enviados) && profile.documentos_enviados.length > 0) {
    parts.push("- Documentos ya enviados: " + profile.documentos_enviados.join(", "));
  }
  if (Array.isArray(profile.competencia_mencionada) && profile.competencia_mencionada.length > 0) {
    parts.push("- Competencia mencionada: " + profile.competencia_mencionada.join(", "));
  }
  if (profile.siguiente_accion_pendiente) {
    parts.push("- Accion pendiente de conversacion anterior: " + profile.siguiente_accion_pendiente);
  }
  if (profile.info_interna && typeof profile.info_interna === "object" && Object.keys(profile.info_interna).length > 0) {
    parts.push("- Info interna (NO revelar al cliente): " + JSON.stringify(profile.info_interna));
  }
  if (profile.conversaciones_count) {
    parts.push("- Conversaciones previas: " + profile.conversaciones_count);
  }
  if (parts.length === 0) return "";
  return "\n\n---\nPERFIL_CLIENTE (uso interno, NO lo menciones literalmente):\n" + parts.join("\n") +
    "\n\nUsa estos datos para NO preguntar de nuevo lo que ya sabes y personalizar la oferta.";
}

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

// buildHoldingModeContext: cuando el caso esta escalado a Enmanuel, Mateo
// NO se silencia (el cliente nunca queda en visto). En lugar de eso,
// genera mensajes de "holding" (espera activa) con restricciones estrictas:
// no descuentos nuevos, no cerrar ventas, no prometer fechas. SI responde
// preguntas generales y ofrece info util para mantener al cliente calido.
//
// Se appenda al system prompt SOLO cuando inHoldingMode=true. Convive con
// PERFIL_CLIENTE + buildClientContext existentes.
const HOLDING_MODE_CONTEXT = `\n\n---\nCONTEXTO ESCALADO — MODO HOLDING:\nEste caso esta escalado a Enmanuel. Tu rol en este estado es mantener la conversacion VIVA con mensajes de "holding" (espera activa). Reglas estrictas en modo escalado:\n\n- NO ofrezcas descuentos nuevos (ninguno)\n- NO cierres ventas ni firmes nada sin Enmanuel\n- NO prometas fechas especificas de resolucion\n- SI manten al cliente calido y atendido\n- SI responde preguntas generales del proyecto\n- SI ofrece informacion adicional util\n\nMensajes tipo:\n- "Enmanuel esta revisando tu caso, pendiente que te confirma pronto. Mientras tanto, ¿hay algo mas del proyecto en que te pueda ayudar?"\n- "Enmanuel tomo tu solicitud personalmente, te respondera pronto. ¿Alguna otra duda que pueda aclararte?"\n\nNO emitas [ESCALAR] en modo holding (el cliente ya esta escalado). NO re-ofrezcas lo que disparo la escalacion original. Mantene el tono Mateo C+ dominicano de siempre.`;

function buildHoldingModeContext() {
  return HOLDING_MODE_CONTEXT;
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
// PROCESAR MENSAJE
// ============================================

async function processMessage(body) {
  // senderPhone declarado fuera del try para que el catch top-level (safety net
  // hotfix-2) tenga acceso a el y pueda enviar el mensaje de fallback al
  // cliente correcto cuando algo falla aguas abajo (ej: Claude API tira,
  // sendWhatsAppMessage tira, exception inesperada en el pipeline).
  let senderPhone = null;

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
    senderPhone = message.from;
    const messageType = message.type;
    const senderName = value?.contacts?.[0]?.profile?.name || "Desconocido";

    // Admin testing mode (hotfix-6): el admin puede activar /test-on para que
    // su phone se "swappee" a testing:<phone> en todos los stores, haciendo
    // que el pipeline lo trate como cliente nuevo. senderPhone SIGUE siendo
    // el real (para I/O con Meta WhatsApp); storageKey es el efectivo para
    // Redis (chat/meta/profile/lookup de STAFF_PHONES).
    const inTesting = await adminTesting.isActive(senderPhone);
    const storageKey = adminTesting.getStorageKey(senderPhone, inTesting);
    if (inTesting) {
      botLog("info", "admin_testing_active", {
        admin: senderPhone,
        storageKey,
      });
    }

    // Guardar nombre del cliente en metadata
    await saveClientMeta(storageKey, { name: senderName });

    // Soporte de audio (notas de voz) via Whisper.
    //
    // MARKER "[audio transcrito] ": se prepende al texto que entra al history
    // conversacional para que Mateo sepa que el cliente envio nota de voz sin
    // que el cliente lo lea. El prompt v5.2 tiene la seccion ENTRADA DE AUDIO
    // que le indica:
    //   1) No mencionar al cliente que fue audio
    //   2) Si la transcripcion se ve confusa, pedir repetir o escribir
    //   3) Para el resto, responder normal
    // El marker NO se envia al cliente (va solo al history y al system prompt).
    let userMessage;
    if (messageType === "text") {
      userMessage = message.text.body;
    } else if (messageType === "audio" || messageType === "voice") {
      const audioId = message.audio?.id || message.voice?.id;
      botLog("info", "Audio recibido, intentando transcribir", { phone: senderPhone, audioId });
      const transcribed = audioId ? await transcribeWhatsAppAudio(audioId) : null;
      const trimmed = (transcribed || "").trim();
      // Fallback: si la transcripcion fallo (null) o devolvio algo inutil
      // (string vacio o < 3 caracteres que suele ser ruido), pedimos repetir.
      // No procesamos mensaje vacio para evitar que Claude responda a ruido.
      if (!trimmed || trimmed.length < 3) {
        await sendWhatsAppMessage(
          senderPhone,
          "Mira, no te capté bien el audio. ¿Me lo puedes repetir o escribir el mensaje?"
        );
        botLog("warn", "Audio descartado (transcripcion vacia o muy corta)", {
          phone: senderPhone,
          audioId,
          transcribedLength: trimmed.length,
        });
        return;
      }
      userMessage = "[audio transcrito] " + trimmed;
      botLog("info", "Audio transcrito", { phone: senderPhone, length: trimmed.length });
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
    // storageKey viene del phone-swap B3: si admin está en testing, vale
    // "testing:<phone>" (no aparece en STAFF_PHONES → isStaff falsy →
    // pipeline lo trata como cliente). Si no está en testing, vale
    // igual a senderPhone y el comportamiento es idéntico al pre-hotfix-6.
    const isStaff = STAFF_PHONES[storageKey];
    botLog("info", "Mensaje recibido", { phone: senderPhone, name: senderName, message: userMessage, isStaff: !!isStaff, testing: inTesting });
    const isSupervisor = isStaff?.supervisor === true;
    const activePrompt = isSupervisor ? SUPERVISOR_PROMPT : buildSystemPrompt();

    if (isStaff) {
      console.log("PERSONAL INTERNO detectado: " + isStaff.name + " (" + isStaff.role + ")");
    }

    // Cargar metadata del cliente (para contexto dinamico + gestion de escalamiento)
    const clientMeta = !isStaff ? await getClientMeta(storageKey) : null;

    // Cargar perfil Mateo (profile:<phone>, Día 3). Namespace separado de
    // meta:<phone> para no interferir con followups/escalation. Solo para
    // flujo cliente (staff y Enmanuel/supervisor no tienen perfil).
    const customerProfile = (!isStaff && !isSupervisor) ? await getCustomerProfile(storageKey) : null;

    // Si hay un escalamiento activo (< 4h), Mateo NO se silencia — genera
    // holding messages para mantener al cliente calido mientras Enmanuel
    // toma el caso. Decision comercial (hotfix 2): Mateo nunca deja al
    // cliente en visto. Hotfix reemplaza el return temprano por una flag
    // que inyecta HOLDING_MODE_CONTEXT al system prompt mas abajo.
    const inHoldingMode = !isStaff && isEscalationActive(clientMeta);

    if (inHoldingMode) {
      botLog("info", "Caso escalado activo: Mateo responde en holding mode", {
        phone: senderPhone,
        escalatedAt: clientMeta.escalatedAt,
      });
      // Recordatorio a Enmanuel con throttle de 1h. Mismo mecanismo que
      // antes del hotfix — sigue notificando que el caso escalado tiene
      // actividad, ahora aclarando que Mateo lo sostiene.
      if (shouldRemindEnmanuel(clientMeta)) {
        try {
          const clientLabel = clientMeta.name && clientMeta.name !== "Desconocido"
            ? clientMeta.name
            : senderPhone;
          await sendWhatsAppMessage(
            ENMANUEL_PHONE,
            "Recordatorio: " + clientLabel + " (" + senderPhone + ") sigue escribiendo. Caso escalado; Mateo lo mantiene en holding."
          );
          await saveClientMeta(storageKey, { lastReminderAt: new Date().toISOString() });
        } catch (e) {
          console.log("Error recordando a Enmanuel:", e.message);
        }
      }
    } else if (!isStaff && clientMeta?.escalated === true && !isEscalationActive(clientMeta)) {
      // Escalamiento expirado (> 4h). Limpiar flag y seguir flujo normal.
      await saveClientMeta(storageKey, { escalated: false });
    }

    await addMessage(storageKey, "user", userMessage);
    const messageHistory = await getHistory(storageKey);

    // Inyectar contexto dinamico del cliente al system prompt (solo flujo de cliente).
    // clientContext viene de meta:<phone> (historico), profileContext viene de
    // profile:<phone> (perfil Mateo v5.2). Ambos coexisten hasta unificarse en Día 6.
    // holdingContext se inyecta solo si el caso esta escalado activo — fuerza
    // a Mateo a generar mensajes de espera activa (hotfix 2).
    const clientContext = !isSupervisor ? buildClientContext(clientMeta) : "";
    const profileContext = (!isStaff && !isSupervisor) ? buildProfileContext(customerProfile) : "";
    const holdingContext = inHoldingMode ? buildHoldingModeContext() : "";
    const finalPrompt = activePrompt + clientContext + profileContext + holdingContext;

    const response = await callClaudeWithTools({
      system: finalPrompt,
      messages: messageHistory,
      tools: TOOLS,
      phone: senderPhone,
      toolHandlers: {
        calcular_plan_pago: (input) => calcularPlanPago(input.proyecto, input.precio_usd, input.etapa),
      },
    });

    // Extraer el texto final (ignorando bloques tool_use residuales)
    const textBlocks = response.content.filter((b) => b.type === "text");
    const rawReply = textBlocks.map((b) => b.text).join("\n").trim() || "Dejame un momento, te respondo en seguida.";
    console.log("Respuesta del bot: " + rawReply);

    // Extraer bloque <perfil_update> ANTES que cualquier otro detect. El bloque
    // puede contener JSON con mentions de proyectos/tags que confundirian a
    // detectLeadSignals (que opera por regex sobre el texto). Strip primero,
    // despues corremos el resto sobre texto limpio.
    //
    // CRITICO (hotfix-2): si Mateo emite SOLO el bloque sin texto al cliente,
    // cleanedText queda vacio. NO caemos a rawReply en ese caso porque
    // contiene el bloque crudo y se filtraria al cliente. Dejamos
    // textWithoutProfile vacio y el empty-reply guard mas abajo lo cubre con
    // un fallback amable.
    let profileDeltas = null;
    let textWithoutProfile = rawReply;
    if (!isStaff && !isSupervisor) {
      const { json, cleanedText } = extractProfileUpdate(rawReply);
      textWithoutProfile = cleanedText;
      if (json && validateProfileUpdate(json)) {
        profileDeltas = json;
      } else if (json) {
        botLog("warn", "Bloque <perfil_update> invalido", { phone: senderPhone, json });
      }
    }

    // Detectar senales de lead caliente, escalamiento y agendamiento
    const { isHotLead, needsEscalation, booking, cleanReply } = detectLeadSignals(textWithoutProfile);
    let botReply = cleanReply;

    // Empty-reply guard (hotfix-2 Día 3): si despues del strip de bloque
    // perfil_update + tags [LEAD_CALIENTE]/[ESCALAR]/[AGENDAR|...] el texto
    // quedo vacio o solo whitespace, Mateo emitio solo metadata sin contenido
    // visible. Reemplazamos por fallback amable en lugar de mandar vacio que
    // WhatsApp rechazaria con error 4xx (que ademas seria atrapado por el
    // catch top-level y dejaria al cliente en visto). Regla universal de
    // Enmanuel: Mateo SIEMPRE responde.
    if (!botReply || botReply.trim().length === 0) {
      botLog("warn", "Reply vacio post-strip", {
        phone: senderPhone,
        rawReplyLength: rawReply.length,
        rawReplyPreview: rawReply.slice(0, 200),
      });
      botReply = "Dame un segundo, se me complicó algo. ¿Me repites tu mensaje en un momentito?";
    }

    await addMessage(storageKey, "assistant", botReply);
    await sendWhatsAppMessage(senderPhone, botReply);
    botLog("info", "Respuesta enviada", { phone: senderPhone, responseLength: botReply.length });

    // Notificar a Enmanuel si hay señales (solo para clientes, no para staff).
    // En holding mode skipeamos las notificaciones hot/escalation: el caso YA
    // esta escalado a Enmanuel, el recordatorio throttleado se maneja arriba
    // y no queremos duplicar avisos cada vez que el cliente escribe.
    //
    // Durante admin testing (hotfix-6): isStaff es falsy (el admin entra como
    // cliente), pero las notificaciones a ENMANUEL_PHONE harian que el admin
    // se notifique a si mismo → spam. Filtramos con `!inTesting` y logueamos
    // "notify_suppressed_testing" a Axiom para visibilidad sin WhatsApp.
    if (!isStaff) {
      if (isHotLead && !inHoldingMode) {
        if (!inTesting) {
          await notifyWithMeta(senderPhone, userMessage, botReply, "hot");
        } else {
          botLog("info", "notify_suppressed_testing", { admin: senderPhone, signalType: "hot" });
        }
        await saveClientMeta(storageKey, { temperature: "hot", hotDetectedAt: new Date().toISOString() });
      }
      if (needsEscalation && !inHoldingMode) {
        if (!inTesting) {
          await notifyWithMeta(senderPhone, userMessage, botReply, "escalation");
        } else {
          botLog("info", "notify_suppressed_testing", { admin: senderPhone, signalType: "escalation" });
        }
        await saveClientMeta(storageKey, { escalated: true, escalatedAt: new Date().toISOString() });
      }

      // Agendamiento de visita: guardar + notificar con tarjeta estructurada
      if (booking) {
        if (!inTesting) {
          await notifyBookingWithMeta(senderPhone, booking);
        } else {
          botLog("info", "notify_suppressed_testing", { admin: senderPhone, signalType: "booking" });
        }
        await saveClientMeta(storageKey, {
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
        await saveClientMeta(storageKey, {
          followUpCount: 0,
          followUpStage: 0,
        });
      }

      // ============================================
      // PIPELINE PERFIL (Día 3)
      // ============================================
      // Persistir deltas del bloque <perfil_update> + disparar notificaciones
      // condicionales (descuento, recomendacion de competencia). Guard:
      // solo flujo cliente (ya dentro de !isStaff, y isSupervisor chequeado
      // al extraer profileDeltas).
      if (!isSupervisor) {
        // 1. Persistir deltas si el bloque vino valido.
        if (profileDeltas) {
          try {
            await updateCustomerProfile(storageKey, profileDeltas);
          } catch (e) {
            botLog("error", "Error actualizando perfil", { phone: senderPhone, error: e.message });
          }
        }

        // 2. Detectar descuento ofrecido por Mateo en el texto limpio y
        //    notificar a Enmanuel. Independiente del bloque — el regex puede
        //    detectar descuentos aunque Mateo olvide marcarlo en el perfil.
        try {
          const discount = detectDiscountOffer(botReply);
          if (discount) {
            if (!inTesting) {
              await notifyDescuentoOfrecido(senderPhone, discount.monto, discount.contexto, clientMeta);
            } else {
              botLog("info", "notify_suppressed_testing", { admin: senderPhone, signalType: "descuento", monto: discount.monto });
            }
            botLog("info", "Descuento detectado y notificado", {
              phone: senderPhone,
              monto: discount.monto,
            });
          }
        } catch (e) {
          botLog("error", "Error procesando descuento", { phone: senderPhone, error: e.message });
        }

        // 3. Si Mateo indico siguiente_accion_sugerida = "recomendar_competencia"
        //    (Trusted Advisor Nivel 3), notificar a Enmanuel con el contexto.
        if (profileDeltas?.siguiente_accion_sugerida === "recomendar_competencia") {
          try {
            const motivo = userMessage.slice(0, 300);
            if (!inTesting) {
              await notifyRecomendacionCompetencia(senderPhone, motivo, clientMeta);
            } else {
              botLog("info", "notify_suppressed_testing", { admin: senderPhone, signalType: "recomendar_competencia" });
            }
            botLog("info", "Recomendacion de competencia detectada", {
              phone: senderPhone,
              tags: profileDeltas.tags_nuevos || [],
            });
          } catch (e) {
            botLog("error", "Error notificando recomendacion competencia", {
              phone: senderPhone,
              error: e.message,
            });
          }
        }

        // 4. Log Axiom si Mateo detecto una objecion nueva (no en las 9 cargadas).
        if (profileDeltas?.objecion_nueva === true && profileDeltas.objecion_nueva_texto) {
          botLog("info", "OBJECION_NUEVA detectada", {
            phone: senderPhone,
            objecion: profileDeltas.objecion_nueva_texto,
          });
        }
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
            await markDocSent(storageKey, projKey + ".brochure");
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
        // Track si las imagenes del proyecto ya fueron enviadas como teaser del
        // brochure, para evitar duplicar envio despues del PDF de precios cuando
        // el cliente pide brochure + precios juntos.
        let imagesSentAsTeaser = false;

        // Si el primer doc que se va a mandar es el brochure, enviar imagenes teaser antes
        if (requestedTypes[0] === "brochure" && docs.images && docs.images.length > 0) {
          await sendProjectImages(senderPhone, project);
          imagesSentAsTeaser = true;
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
            await markDocSent(storageKey, project + "." + docType);
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
          await markDocSent(storageKey, project + ".preciosE4");
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
        await markDocSent(storageKey, project + ".brochureE4");
        console.log("PDF enviado: brochureE4 de puertoPlata a " + senderPhone);
      }

        // Si el cliente pidio precios y el proyecto tiene imagenes Y no fueron
        // enviadas ya como teaser del brochure, mandarlas DESPUES del PDF de
        // precios. Caso de uso: Crux tiene IMG_CRUX con JPG de listos para
        // entrega inmediata que complementa el PDF "Precios y Disponibilidad"
        // (el PDF tiene todo el inventario, el JPG destaca listos ya).
        if (
          requestedTypes.includes("precios") &&
          docs.images &&
          docs.images.length > 0 &&
          !imagesSentAsTeaser
        ) {
          if (sentCount > 0) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }
          await sendProjectImages(senderPhone, project);
        }

        if (sentCount === 0) {
          console.log("AVISO: Solicitud de docs para " + project + " pero no hay URLs configuradas en las variables de entorno");
        } else {
          console.log("Total PDFs enviados a " + senderPhone + ": " + sentCount);
        }
      }
    }
  } catch (error) {
    botLog("error", "Error procesando mensaje", {
      phone: senderPhone,
      error: error.message,
      stack: error.stack,
    });
    // Safety net universal (hotfix-2 Día 3): regla comercial de Enmanuel:
    // Mateo SIEMPRE responde, nunca deja al cliente en visto. Si el flujo
    // tiro excepcion antes de mandar respuesta (Claude API down, send
    // fallido, etc), intentamos best-effort enviar fallback minimo. Si el
    // safety net tambien falla, no hay mas que loguear — al menos quedo
    // registro estructurado del fallo doble.
    if (senderPhone) {
      try {
        await sendWhatsAppMessage(
          senderPhone,
          "Dame un segundo, se me complicó algo. ¿Me repites tu mensaje en un momentito?"
        );
      } catch (e2) {
        botLog("error", "Safety net tambien fallo", {
          phone: senderPhone,
          error: e2.message,
        });
      }
    }
  }
}

module.exports = { processMessage, DOC_TYPE_NAMES };
