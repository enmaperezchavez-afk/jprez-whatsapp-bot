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
const { toProxyUrl, toImageProxyUrl, priceListUrl, brochureProxyUrl } = require("../proxy");
const { sendDocument } = require("../whatsapp-media");
const { VALID_PROJECTS: PRICE_LIST_PROJECTS, PROJECT_META: PRICE_LIST_META } = require("../documents/price-list-generator");
const {
  ENMANUEL_PHONE,
  notifyEnmanuel,
  notifyEnmanuelBooking,
  notifyDescuentoOfrecido,
  notifyRecomendacionCompetencia,
  detectDiscountOffer,
} = require("../notify");
const { detectDocumentRequest, detectDocumentType, detectLeadSignals, detectPuertoPlataStage, detectCruxStage } = require("../detect");
const { shouldSendDoc } = require("../dispatch/document-policy");
const { buildSystemPromptBlocks, buildSystemPromptBlocksAsync, SUPERVISOR_PROMPT, MATEO_PROMPT_V5_2 } = require("../prompts");
const { validateSystemPromptSize } = require("../validators/token-budget");
const { STAFF_PHONES } = require("../staff");
const { getCustomerProfile, updateCustomerProfile } = require("../profile/storage");
const { extractProfileUpdate, validateProfileUpdate } = require("../profile/extractor");
const { cleanFormat } = require("./format-postprocess");
const { stripParameterBlocks, stripInternalBlocks } = require("./parameter-block-cleaner");
const adminTesting = require("../admin-testing-mode");
const { computePromptHash, checkAndInvalidate } = require("../prompt-version");
const { TOOL_CONSULTAR_ICDV, consultarICDV } = require("../tools/icdv");
const { TOOL_CONSULTAR_TASA, consultarTasaDolar } = require("../tools/tasa");
const { TOOL_PROYECTAR_REAJUSTE, proyectarReajusteTool } = require("../tools/reajuste");
const { TOOL_GENERAR_PLAN_XLSX, generarPlanXlsxTool } = require("../tools/plan-xlsx");

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
    // Hotfix-21 c3: slot Torre 6 separado del brochure general. Cuando
    // detectCruxStage retorna "T6" y cliente pide precios, el dispatcher
    // manda preciosT6 en lugar de precios general. Si la env var no existe,
    // el commercial-layer instruye al modelo a dar los datos en texto sin
    // escalar.
    preciosT6: process.env.PDF_CRUX_PRECIOS_T6 || null,
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
  images: "Inventario JPG",
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
  // Sprint0-delta: E4 entrega DICIEMBRE 2027 (era 2027-09-01, que inflaba
  // la cuota mensual ~20% al calcular con 3 meses menos). Los PDFs y el
  // resto de la doctrina ya decían dic 2027.
  E4: "2027-12-01",
};

// Hotfix-30 Fix 1: infiere la etapa de Puerto Plata (E3/E4) del texto del
// cliente cuando el LLM invoca calcular_plan_pago sin etapa explícita.
// PSE3 / "etapa 3" / E3 → E3 ; PSE4 / "etapa 4" / E4 → E4.
// Si menciona ambas o ninguna → null (el handler pedirá aclaración con texto).
// Pura + exportada para test.
function inferEtapaFromContext(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  const t = text.toLowerCase();
  const isE3 = /\be3\b/.test(t) || /pse\s*3/.test(t) || /pse-?3/.test(t) ||
    /etapa\s*3\b/.test(t) || /etapa\s*iii\b/.test(t);
  const isE4 = /\be4\b/.test(t) || /pse\s*4/.test(t) || /pse-?4/.test(t) ||
    /etapa\s*4\b/.test(t) || /etapa\s*iv\b/.test(t);
  if (isE3 && !isE4) return "E3";
  if (isE4 && !isE3) return "E4";
  return null;
}

function calcularPlanPago(proyecto, precioUsd, etapa, customInicialPct, customCompletivoPct, customEntregaPct) {
  const standardPlan = PAYMENT_PLANS[proyecto];
  if (!standardPlan) {
    return { error: "Proyecto no reconocido: " + proyecto };
  }
  // Hotfix-19 Bug #6: si vienen los 3 porcentajes custom, usarlos. Si vienen
  // parciales o ninguno, fallback al plan estandar del proyecto. Validacion:
  // suma debe estar a 100 +/- 0.5 (tolerancia minima por redondeos del modelo).
  let plan = standardPlan;
  const allCustom = [customInicialPct, customCompletivoPct, customEntregaPct]
    .every((v) => typeof v === "number" && isFinite(v));
  if (allCustom) {
    const sum = customInicialPct + customCompletivoPct + customEntregaPct;
    if (Math.abs(sum - 100) > 0.5) {
      return { error: "Los porcentajes custom deben sumar 100. Recibí inicial=" + customInicialPct + ", completivo=" + customCompletivoPct + ", entrega=" + customEntregaPct + " (suma=" + sum + ")." };
    }
    if (customInicialPct < 0 || customCompletivoPct < 0 || customEntregaPct < 0) {
      return { error: "Los porcentajes custom no pueden ser negativos." };
    }
    plan = {
      separacion: customInicialPct / 100,
      completivo: customCompletivoPct / 100,
      entrega: customEntregaPct / 100,
    };
  }
  let delivery;
  if (proyecto === "puertoPlata") {
    if (!etapa || !PUERTO_PLATA_DELIVERY[etapa]) {
      // Hotfix-30 Fix 1: NO devolver error duro. El error "debes especificar
      // la etapa" derailaba el turno — el LLM frecuentemente emitía solo un
      // bloque <perfil_update> sin texto al cliente tras recibirlo, y el
      // empty-reply guard disparaba "se me complicó algo" (P0 reproducido
      // 22 may, query "estudios disponibles en pse3"). En su lugar devolvemos
      // una señal SOFT: el LLM debe pedir al cliente que aclare la etapa con
      // texto, sin tratar esto como fallo. inferEtapaFromContext ya intenta
      // resolverla del mensaje ANTES de llegar acá.
      return {
        needs_etapa: true,
        ask_client: "Puerto Plata tiene dos etapas con fechas y planes distintos: Etapa 3 (entrega marzo 2029) y Etapa 4 (entrega diciembre 2027). Pregúntale al cliente cuál le interesa ANTES de dar números, con un texto natural. NO es un error.",
      };
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

// Bloque 2: mapeo proyecto → Drive ID del brochure estático (provisto por
// Director). Crux comparte un solo brochure para Torre 6 y Listos.
const BROCHURE_DRIVE_IDS = {
  pr3: "1-_Hfq5kJ5Z-qmK4noK75x69aoilgFUZr",
  pr4: "1Inj5vdhvRCVnHfAsorEdDeawFaQ1U0KJ",
  pse3: "1vbTbWInLe15Wn-w73Ak_WXuF8B0_sNl6",
  pse4: "1POq7pUxkVlqR7X_yVjSwB6qDUWazaNzi",
  crux_t6: "1Cvl6RA93inroHe7ixbO6tVyrRWNZo68B",
  crux_listos: "1Cvl6RA93inroHe7ixbO6tVyrRWNZo68B",
};

// Bloque 2: nombre de display por proyecto para filenames de WhatsApp.
function projectDisplayName(proyecto) {
  return (PRICE_LIST_META[proyecto] && PRICE_LIST_META[proyecto].name) || proyecto;
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
          description: "SOLO para Puerto Plata: etapa del proyecto (E3 entrega marzo 2029, E4 entrega diciembre 2027). Afecta el calculo de cuotas porque los meses hasta entrega son distintos. Si el cliente menciona PSE3/'etapa 3' usa E3; si menciona PSE4/'etapa 4' usa E4. Si NO sabes la etapa para Puerto Plata, NO llames esta herramienta: primero preguntale al cliente con texto cual etapa le interesa (Etapa 3 o Etapa 4). Ignorado en otros proyectos.",
        },
        inicial_pct: {
          type: "number",
          description: "OPCIONAL. Porcentaje inicial custom (0-100). Solo usar cuando el cliente pide explicitamente un esquema NO estandar (ej: 'quiero pagar 70% inicial', 'puedo dar 25% al firmar'). Si lo pasas, DEBES pasar tambien completivo_pct y entrega_pct sumando 100. Si no lo pasas, se usa el plan estandar del proyecto.",
        },
        completivo_pct: {
          type: "number",
          description: "OPCIONAL. Porcentaje completivo custom (cuotas mensuales hasta entrega). Solo si pasas inicial_pct y entrega_pct tambien.",
        },
        entrega_pct: {
          type: "number",
          description: "OPCIONAL. Porcentaje contra entrega custom (banco u otro). Solo si pasas inicial_pct y completivo_pct tambien. Los 3 deben sumar 100.",
        },
      },
      required: ["proyecto", "precio_usd"],
    },
  },
  {
    name: "enviar_documento",
    description:
      "Envía un documento al cliente por WhatsApp: el listado de precios actualizado (PDF generado al vuelo desde el inventario en vivo) o el brochure del proyecto. " +
      "Úsalo cuando el cliente pida 'el listado de precios', 'el brochure', 'la info del proyecto', 'mándame los precios', o similar. " +
      "Di al cliente 'te lo mando ahora mismo' y USA esta herramienta — NO prometas enviar algo sin invocarla. " +
      "Para Puerto Plata distingue etapa: pse3 (Etapa 3) vs pse4 (Etapa 4). Para Crux: crux_t6 (Torre 6 en construcción) vs crux_listos (entrega inmediata).",
    input_schema: {
      type: "object",
      properties: {
        tipo: {
          type: "string",
          enum: ["listado_precios", "brochure"],
          description: "listado_precios = PDF de precios actualizado generado desde el inventario en vivo. brochure = folleto comercial estático del proyecto.",
        },
        proyecto: {
          type: "string",
          enum: ["pr3", "pr4", "pse3", "pse4", "crux_t6", "crux_listos"],
          description: "Proyecto: pr3=Prado Residences III, pr4=Prado Residences IV, pse3=Prado Suites Puerto Plata Etapa 3, pse4=Prado Suites Puerto Plata Etapa 4, crux_t6=Crux del Prado Torre 6, crux_listos=Crux del Prado listos para entrega.",
        },
      },
      required: ["tipo", "proyecto"],
    },
  },
  // Sprint0 PR-D: Fase 2 del scraper ICDV — tool activada (era skeleton
  // drop-in desde Bloque 3). Cifras oficiales ONE para justificar el
  // reajuste de costos con datos exactos.
  TOOL_CONSULTAR_ICDV,
  // Sprint1 PR-2: Fase 2 del scraper de tasa — tool activada (era skeleton
  // drop-in de PR-1). Tasa USD/DOP oficial BCRD para conversiones a pesos
  // (regla 13 del vendedor: tasa del día, nunca de memoria).
  TOOL_CONSULTAR_TASA,
  // Sprint1 PR-3: motor de reajuste ICDV — proyección ESTIMADA de la
  // cláusula de reajuste sobre el insoluto (doctrina v1.1 sección 6).
  // Tool hermana de calcular_plan_pago, nunca garantía.
  TOOL_PROYECTAR_REAJUSTE,
  // Sprint1 PR-4: Excel del plan de pago por WhatsApp (URL firmada 7d,
  // generado al vuelo en /api/plan-xlsx, cero storage).
  TOOL_GENERAR_PLAN_XLSX,
];

// Bloque 2: handler del tool enviar_documento. Genera/resuelve la URL del
// documento y lo manda por WhatsApp. Retorna un objeto que el LLM usa para
// confirmar al cliente. NUNCA lanza — captura errores y los reporta como
// { sent: false } para que Mateo sea honesto ("no me llegó, lo coordino").
async function enviarDocumento({ tipo, proyecto, phone, storageKey }) {
  if (!PRICE_LIST_PROJECTS.includes(proyecto)) {
    return { sent: false, error: "proyecto_invalido", message: "Proyecto no reconocido: " + proyecto };
  }
  const displayName = projectDisplayName(proyecto);

  try {
    if (tipo === "listado_precios") {
      const url = priceListUrl(proyecto);
      const filename = "JPREZ - Listado de Precios - " + displayName + ".pdf";
      await sendDocument(phone, url, filename, "Listado de precios actualizado de " + displayName + ".");
      if (storageKey) await markDocSent(storageKey, proyecto + ".listado_precios");
      botLog("info", "documento_enviado", { phone, tipo, proyecto });
      return { sent: true, message: "Listado de precios enviado al cliente." };
    }

    if (tipo === "brochure") {
      const driveId = BROCHURE_DRIVE_IDS[proyecto];
      if (!driveId) {
        return { sent: false, error: "brochure_no_disponible", message: "No tengo brochure configurado para " + displayName + "." };
      }
      const url = brochureProxyUrl(driveId);
      const filename = "JPREZ - Brochure - " + displayName + ".pdf";
      await sendDocument(phone, url, filename, "Brochure de " + displayName + ".");
      if (storageKey) await markDocSent(storageKey, proyecto + ".brochure");
      botLog("info", "documento_enviado", { phone, tipo, proyecto });
      return { sent: true, message: "Brochure enviado al cliente." };
    }

    return { sent: false, error: "tipo_invalido", message: "Tipo de documento no reconocido: " + tipo };
  } catch (e) {
    botLog("error", "documento_envio_fallo", { phone, tipo, proyecto, error: e.message });
    return { sent: false, error: "envio_fallo", message: "No se pudo enviar el documento ahora mismo." };
  }
}

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

// Hotfix-28 Path B: pickRawReply — decide el rawReply cuando el LLM
// no generó text blocks (tool_use loop sin pivot a texto). Cold start
// recibe saludo contextual warm-first; clientes con historial y staff/
// supervisor reciben el fallback genérico anterior. Helper pura para
// que sea testeable sin mockear todo el handler.
const COLD_START_SYNTHETIC_REPLY = "¡Hola! Soy Mateo de Constructora JPREZ. Cuéntame, ¿cómo te llamas y qué proyecto te interesa?";
const GENERIC_HOLDING_REPLY = "Dejame un momento, te respondo en seguida.";

function pickRawReply({ rawReplyJoined, customerProfile, isStaff, isSupervisor }) {
  if (
    rawReplyJoined === "" &&
    !isStaff &&
    !isSupervisor &&
    customerProfile &&
    customerProfile.is_new === true
  ) {
    return {
      reply: COLD_START_SYNTHETIC_REPLY,
      coldStartSyntheticUsed: true,
    };
  }
  return {
    reply: rawReplyJoined || GENERIC_HOLDING_REPLY,
    coldStartSyntheticUsed: false,
  };
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
      // Hotfix-32: renovación deslizante — la sesión vive mientras se usa,
      // con tope duro de 2h desde la activación.
      await adminTesting.renewIfActive(senderPhone);
    } else if (adminTesting.isAdmin(senderPhone)) {
      // Hotfix-32 "expiración anunciada": si el testing expiró por TTL
      // (no por /test-off), el PRÓXIMO mensaje del admin recibe PRIMERO
      // el aviso y LUEGO se procesa normal en modo supervisor. Cero
      // flips silenciosos (bug Director 11 jun: "amnesia" 1:25 PM).
      const expiro = await adminTesting.consumeExpiredFlag(senderPhone);
      if (expiro) {
        try {
          await sendWhatsAppMessage(senderPhone, adminTesting.TESTING_EXPIRED_ANNOUNCEMENT);
        } catch (e) {
          botLog("warn", "admin_testing_expiry_announce_failed", {
            admin: senderPhone,
            error: e.message,
          });
        }
      }
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
      // Hotfix-19 Bug #1: threshold relajado de 3 a 2 — palabras validas
      // como "ok", "si", "no" tienen 2 chars y eran descartadas como ruido.
      // El audio vacio/null sigue cayendo al fallback (no procesar ruido).
      if (!trimmed || trimmed.length < 2) {
        await sendWhatsAppMessage(
          senderPhone,
          "Mira, no te capté bien el audio. ¿Me lo puedes repetir o escribir el mensaje?"
        );
        botLog("warn", "Audio descartado (transcripcion vacia o muy corta)", {
          phone: senderPhone,
          audioId,
          transcribedLength: trimmed.length,
          // null distingue "Whisper fallo" de "Whisper devolvio algo corto".
          transcribeReturnedNull: transcribed === null,
        });
        return;
      }
      userMessage = "[audio transcrito] " + trimmed;
      botLog("info", "Audio transcrito", { phone: senderPhone, audioId, length: trimmed.length });
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
    const isSupervisor = isStaff?.supervisor === true;
    botLog("info", "Mensaje recibido", { phone: senderPhone, name: senderName, message: userMessage, isStaff: !!isStaff, isSupervisor, storageKey, activePrompt: isSupervisor ? "SUPERVISOR_PROMPT" : "CLIENT_PROMPT", testing: inTesting });

    if (isStaff) {
      console.log("PERSONAL INTERNO detectado: " + isStaff.name + " (" + isStaff.role + ")");
    }

    // Bloque 1 Fase 3.5: comandos admin de inventario (solo supervisor).
    // /reservar /vender /liberar /precio /inventario — escritura/lectura
    // directa al Sheet vía sheets-writer + loader.
    // Cliente que mande estos comandos = cae al flow normal del LLM
    // (ignorado silenciosamente, NO revelar que el comando existe).
    if (isSupervisor) {
      const { parseAdminCommand, executeAdminCommand } = require("../inventory/admin-commands");
      const parsedCmd = parseAdminCommand(userMessage);
      if (parsedCmd) {
        try {
          const { getRedis } = require("../store/redis");
          const redis = await getRedis();
          const cmdResult = await executeAdminCommand(parsedCmd, {
            supervisorPhone: senderPhone,
            redis,
          });
          if (cmdResult.reply) {
            await sendWhatsAppMessage(senderPhone, cmdResult.reply);
            botLog("info", "admin_command_handled", {
              supervisor: senderPhone,
              command: parsedCmd.command,
              project: parsedCmd.project,
              unit: parsedCmd.unit,
              didWrite: cmdResult.didWrite,
            });
            return;
          }
        } catch (e) {
          botLog("error", "admin_command_error", {
            supervisor: senderPhone,
            command: parsedCmd.command,
            error: e.message,
          });
          await sendWhatsAppMessage(senderPhone, "Error procesando comando: " + e.message);
          return;
        }
      }

      // Sprint1.8 PR-2 — ADMIN NATURAL: escrituras de inventario en
      // lenguaje natural (texto o audio) SOLO para ADMIN_PHONES.
      // Confirmación obligatoria antes de escribir; mismo executor que
      // los slash commands (cero bypass del motor seguro).
      const { ADMIN_PHONES } = require("../staff");
      if (ADMIN_PHONES.includes(senderPhone)) {
        const natural = require("../inventory/natural-admin");
        const { getRedis } = require("../store/redis");
        const redis = await getRedis();

        // 0. Guard de eco (Sprint1.8 PR-3): si el mensaje parece una
        // confirmación del propio bot reenviada, NUNCA confirmar una
        // acción no ejecutada.
        if (natural.esEcoConfirmacion(userMessage)) {
          await sendWhatsAppMessage(senderPhone, natural.ECO_CONFIRMACION_REPLY);
          botLog("info", "admin_echo_guard", { admin: senderPhone });
          return;
        }

        // 1. ¿Hay una escritura PENDIENTE de confirmación?
        const pending = await natural.getPendingWrite(redis, senderPhone);
        if (pending) {
          const respuesta = natural.esRespuestaConfirmacion(userMessage);
          if (respuesta === "si") {
            await natural.clearPendingWrite(redis, senderPhone);
            try {
              const cmdResult = await executeAdminCommand(pending.parsed, {
                supervisorPhone: senderPhone,
                redis,
              });
              const revert = natural.buildRevertCommand(pending.parsed, pending.snapshot);
              const antes = pending.snapshot
                ? (pending.snapshot.estado || "?") +
                  (pending.snapshot.precio
                    ? " · " + natural.formatMonto(Number(String(pending.snapshot.precio).replace(/[^\d.]/g, "")), pending.snapshot.moneda)
                    : "")
                : "desconocido";
              botLog("info", "admin_natural_write", {
                admin: senderPhone,
                command: pending.parsed.command,
                project: pending.parsed.project,
                unit: pending.parsed.unit,
                price: pending.parsed.price,
                antes,
                didWrite: cmdResult.didWrite,
              });
              let reply = cmdResult.reply || "Hecho.";
              if (cmdResult.didWrite) {
                reply += "\nAntes: " + antes + ".";
                if (revert) reply += " Para revertir: " + revert;
              }
              await sendWhatsAppMessage(senderPhone, reply);
            } catch (e) {
              botLog("error", "admin_natural_write_error", {
                admin: senderPhone,
                error: e.message,
              });
              await sendWhatsAppMessage(senderPhone, "Error ejecutando la operación: " + e.message);
            }
            return;
          }
          if (respuesta === "no") {
            await natural.clearPendingWrite(redis, senderPhone);
            await sendWhatsAppMessage(senderPhone, "Cancelado — no toqué nada.");
            return;
          }
          // Cualquier otro mensaje: NUNCA escribir sin sí explícito.
          await natural.clearPendingWrite(redis, senderPhone);
          await sendWhatsAppMessage(
            senderPhone,
            "↩️ Cancelé la operación pendiente (" + pending.parsed.command + " " +
              (pending.parsed.unit || "") + ") porque no la confirmaste. Sigo con tu mensaje."
          );
          // cae al flujo normal con el mensaje actual
        }

        // 2. ¿El mensaje es un intent de escritura en lenguaje natural?
        const intent = natural.parseNaturalAdminIntent(userMessage);
        if (intent) {
          if (intent.error) {
            // Mensajes guía del MISMO executor (faltó proyecto/unidad/precio).
            const guide = await executeAdminCommand(intent, { supervisorPhone: senderPhone, redis });
            await sendWhatsAppMessage(
              senderPhone,
              (guide.reply || "Me falta un dato.") +
                "\n(También sirve el modo clásico: /" + intent.command + " [proyecto] [unidad]" +
                (intent.command === "precio" || intent.command === "liberar" ? " [monto]" : "") + ")"
            );
            return;
          }
          // Snapshot ANTES de escribir, para el preview honesto.
          let snapshot = null;
          try {
            const { resolveProjectTab } = require("../inventory/admin-commands");
            const resolved = resolveProjectTab(intent.project);
            const { readUnitSnapshot } = require("../inventory/sheets-writer");
            const snap = await readUnitSnapshot({ tabName: resolved.tab, unitId: intent.unit });
            if (snap.ok) snapshot = snap;
            else if (snap.reason === "unit_not_found") {
              await sendWhatsAppMessage(
                senderPhone,
                "No encontré " + intent.unit + " en " + intent.project + ". Verifica el ID."
              );
              return;
            }
          } catch (e) {
            botLog("warn", "admin_natural_snapshot_failed", { admin: senderPhone, error: e.message });
          }
          await natural.savePendingWrite(redis, senderPhone, { parsed: intent, snapshot });
          await sendWhatsAppMessage(senderPhone, natural.buildConfirmPrompt(intent, snapshot));
          botLog("info", "admin_natural_intent", {
            admin: senderPhone,
            command: intent.command,
            project: intent.project,
            unit: intent.unit,
            price: intent.price,
          });
          return;
        }
      }
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

    // Pendiente-4 fix (Hotfix prompt-hash-static): el hash debe representar
    // la "versión" del prompt, NO su contenido completo. activePrompt incluye
    // fechaHeader (cambia cada minuto vía new Date()) + SKILL_CONTENT +
    // INVENTORY_CONTENT — hashearlo todo invalida el historial en cada turno.
    // Decisión: hashear solo la parte ESTÁTICA que define identidad/reglas
    // del agente:
    //   - cliente   → MATEO_PROMPT_V5_2 (constante en src/prompts.js)
    //   - supervisor → SUPERVISOR_PROMPT (constante, ya estable)
    // Cambios en SKILL/INVENTORY (precios, unidades) NO disparan invalidación
    // — llegan a TODOS los clientes activos, que es lo correcto.
    const promptForHash = isSupervisor ? SUPERVISOR_PROMPT : MATEO_PROMPT_V5_2;
    const currentPromptHash = computePromptHash(promptForHash);
    await checkAndInvalidate(storageKey, currentPromptHash);

    await addMessage(storageKey, "user", userMessage, currentPromptHash);
    const messageHistory = await getHistory(storageKey);

    // Sprint1.8 PR-4: handoff cubeta B DETERMINISTA. Cliente pide hablar
    // con una persona → escalar INMEDIATO con el mensaje doctrinal, sin
    // pasar por el LLM (cero chance de "a ver si te lo resuelvo yo").
    // Si ya está escalado (holding), el flujo holding lo maneja.
    if (!isStaff) {
      const { detectHumanHandoffRequest, HUMAN_HANDOFF_REPLY_ES, HUMAN_HANDOFF_REPLY_EN } = require("../detect");
      const yaEscalado = clientMeta?.escalated === true && isEscalationActive(clientMeta);
      const idiomaHandoff = yaEscalado ? null : detectHumanHandoffRequest(userMessage);
      if (idiomaHandoff) {
        const reply = idiomaHandoff === "en" ? HUMAN_HANDOFF_REPLY_EN : HUMAN_HANDOFF_REPLY_ES;
        await sendWhatsAppMessage(senderPhone, reply);
        await addMessage(storageKey, "assistant", reply, currentPromptHash);
        if (!inTesting) {
          await notifyWithMeta(senderPhone, userMessage, reply, "escalation");
        } else {
          botLog("info", "notify_suppressed_testing", { admin: senderPhone, signalType: "escalation" });
        }
        await saveClientMeta(storageKey, { escalated: true, escalatedAt: new Date().toISOString() });
        botLog("info", "human_handoff_guard", { phone: senderPhone, idioma: idiomaHandoff });
        return;
      }
    }

    // Inyectar contexto dinamico del cliente al system prompt (solo flujo de cliente).
    // clientContext viene de meta:<phone> (historico), profileContext viene de
    // profile:<phone> (perfil Mateo v5.2). Ambos coexisten hasta unificarse en Día 6.
    // holdingContext se inyecta solo si el caso esta escalado activo — fuerza
    // a Mateo a generar mensajes de espera activa (hotfix 2).
    const clientContext = !isSupervisor ? buildClientContext(clientMeta) : "";
    const profileContext = (!isStaff && !isSupervisor) ? buildProfileContext(customerProfile) : "";
    const holdingContext = inHoldingMode ? buildHoldingModeContext() : "";

    // FASE 1: system prompt como array de bloques con cache_control.
    // - Supervisor: 1 bloque sin cache (volumen bajo, no justifica caching).
    // - Cliente: 2 bloques. Bloque 1 = staticBlock (SKILL+INVENTORY+MATEO+
    //   GLOSSARY+STYLE) con cache_control ephemeral → cache hit en turnos
    //   subsecuentes ahorra ~70-90% input tokens en historiales largos.
    //   Bloque 2 = dynamicHeader (fecha/hora) + contextos por-cliente
    //   (clientContext/profileContext/holdingContext). Cualquier cambio aca
    //   NO invalida la cache porque queda DESPUES del breakpoint.
    let systemBlocks;
    if (isSupervisor) {
      systemBlocks = [{ type: "text", text: SUPERVISOR_PROMPT }];
    } else {
      // Bloque 1 Fase 3: usar versión async que carga inventario via loader
      // (Redis cache → Sheets → fallback hardcoded). Fallback al INVENTORY_CONTENT
      // del cold start si todo lo demás falla — el bot nunca queda sin inventario.
      const { staticBlock, dynamicHeader } = await buildSystemPromptBlocksAsync();
      systemBlocks = [
        { type: "text", text: staticBlock, cache_control: { type: "ephemeral" } },
        { type: "text", text: dynamicHeader + clientContext + profileContext + holdingContext },
      ];
    }

    // Hotfix-22 V2 b1: pre-flight token budget check. Detecta prompts
    // gigantes ANTES de llegar a Anthropic API. NO bloquea — solo loguea
    // a Axiom estructurado para alarma temprana del Director si un skill
    // nuevo crece el prompt mas alla del threshold de warning. Previene
    // Bug #14/#26 (max_tokens regression) silencioso.
    const sizeCheck = validateSystemPromptSize(systemBlocks);
    if (sizeCheck.status === "red") {
      botLog("error", "system_prompt_too_large", {
        phone: senderPhone,
        estimatedTokens: sizeCheck.estimatedTokens,
        chars: sizeCheck.chars,
        message: sizeCheck.message,
      });
    } else if (sizeCheck.status === "yellow") {
      botLog("warn", "system_prompt_size_warning", {
        phone: senderPhone,
        estimatedTokens: sizeCheck.estimatedTokens,
        chars: sizeCheck.chars,
        message: sizeCheck.message,
      });
    } else {
      botLog("info", "system_prompt_size", {
        phone: senderPhone,
        estimatedTokens: sizeCheck.estimatedTokens,
        chars: sizeCheck.chars,
        status: sizeCheck.status,
      });
    }

    const response = await callClaudeWithTools({
      system: systemBlocks,
      messages: messageHistory,
      tools: TOOLS,
      phone: senderPhone,
      toolHandlers: {
        calcular_plan_pago: (input) => {
          // Hotfix-30 Fix 1: si es Puerto Plata sin etapa explícita, intenta
          // inferirla del mensaje del cliente (PSE3→E3, PSE4→E4) antes de
          // calcular. Si no se puede inferir, calcularPlanPago devuelve la
          // señal soft needs_etapa (no error) y el LLM pide aclaración.
          let etapa = input.etapa;
          if (input.proyecto === "puertoPlata" && !etapa) {
            etapa = inferEtapaFromContext(userMessage);
          }
          return calcularPlanPago(
            input.proyecto,
            input.precio_usd,
            etapa,
            input.inicial_pct,
            input.completivo_pct,
            input.entrega_pct
          );
        },
        // Bloque 2: Mateo envía brochure / listado de precios al cliente.
        // Es la vía ÚNICA de envío de estos documentos (el dispatcher regex
        // legacy quedó desactivado para brochure/precios).
        enviar_documento: (input) => enviarDocumento({
          tipo: input.tipo,
          proyecto: input.proyecto,
          phone: senderPhone,
          storageKey,
        }),
        // Sprint0 PR-D: índice de costos ONE (serie viva Redis → seed disco).
        consultar_icdv: (input) => consultarICDV(input),
        // Sprint1 PR-2: tasa USD/DOP oficial BCRD (store del cron en Redis;
        // sin dato degrada con ok:false y Mateo escala, nunca inventa tasa).
        consultar_tasa_dolar: (input) => consultarTasaDolar(input),
        // Sprint1 PR-3: proyección ESTIMADA del reajuste ICDV. La misma
        // inferencia de etapa que calcular_plan_pago (Hotfix-30) y la
        // calculadora se inyecta por DI (evita ciclo handler <-> tool).
        proyectar_reajuste: (input) => {
          let etapa = input.etapa;
          if (input.proyecto === "puertoPlata" && !etapa) {
            etapa = inferEtapaFromContext(userMessage);
          }
          return proyectarReajusteTool({ ...input, etapa }, { calcularPlanPago });
        },
        // Sprint1 PR-4: Excel del plan al cliente. Misma inferencia de
        // etapa; reusa la calculadora y el motor de reajuste por DI.
        generar_plan_pago_xlsx: (input) => {
          let etapa = input.etapa;
          if (input.proyecto === "puertoPlata" && !etapa) {
            etapa = inferEtapaFromContext(userMessage);
          }
          return generarPlanXlsxTool(
            { ...input, etapa },
            {
              calcularPlanPago,
              proyectarReajuste: (i) => proyectarReajusteTool(i, { calcularPlanPago }),
              sendDocument,
              phone: senderPhone,
              // Sprint1.7 PR-3 (Adendum B2): el nombre del cliente sale
              // impreso en el documento.
              clienteNombre: senderName,
            }
          );
        },
      },
    });

    // Extraer el texto final (ignorando bloques tool_use residuales)
    const textBlocks = response.content.filter((b) => b.type === "text");
    const rawReplyJoined = textBlocks.map((b) => b.text).join("\n").trim();

    // Hotfix-28 Path B: cold-start guard. Si el LLM agotó iteraciones sin
    // generar texto Y es cliente nuevo, devolvemos un saludo contextual
    // en vez del fallback genérico. Reproduce el bug Director 18 may
    // 14:51Z: cold start + "soy extranjero puedo comprar?" → tool_use
    // loop sin texto → "Dejame un momento" → safety net genérico.
    const { reply: rawReply, coldStartSyntheticUsed } = pickRawReply({
      rawReplyJoined,
      customerProfile,
      isStaff,
      isSupervisor,
    });
    if (coldStartSyntheticUsed) {
      botLog("warn", "cold_start_synthetic_reply", {
        phone: senderPhone,
        stop_reason: response.stop_reason,
        tool_use_blocks: response.content.filter((b) => b.type === "tool_use").length,
      });
    }
    console.log("Respuesta del bot: " + rawReply);

    // Hotfix-22 V3 r4: empty-reply guard de 4 niveles. Detecta:
    //   1. Bloque cerrado normal — strip via extractProfileUpdate
    //      (el que ya funciona desde hotfix-2). Caso default.
    //   2. stop_reason="max_tokens" con bloque <perfil_update>
    //      truncado SIN cierre — el regex de extractProfileUpdate
    //      requiere </perfil_update> y NO match → JSON crudo
    //      leakeaba al cliente. Recovery: regex fallback que strip
    //      todo desde "<perfil_update>" al final, preserva texto
    //      previo si existe. Log claude_truncated_with_recovery.
    //   3. stop_reason="max_tokens" SIN bloque (texto puro
    //      truncado) — mandar texto parcial al cliente, log
    //      claude_truncated_no_block.
    //   4. Empty post-strip (Mateo emitio SOLO metadata) — fallback
    //      generico (caso original hotfix-2).
    //
    // Aplicamos la deteccion ANTES de extractProfileUpdate para
    // capturar el caso 2: si hay bloque sin cierre, NO podemos
    // confiar en el extractor — strip manual primero.
    const stopReason = response.stop_reason;
    let preStripReply = rawReply;
    let truncatedRecoveryApplied = false;
    if (stopReason === "max_tokens") {
      const openTag = preStripReply.indexOf("<perfil_update>");
      const closeTag = preStripReply.indexOf("</perfil_update>");
      if (openTag !== -1 && closeTag === -1) {
        // Caso 2: bloque truncado sin cierre. Strip todo desde el
        // open tag al final y preservar texto previo (si lo hay).
        const beforeBlock = preStripReply.slice(0, openTag).trim();
        botLog("warn", "claude_truncated_with_recovery", {
          phone: senderPhone,
          beforeBlockChars: beforeBlock.length,
          rawReplyChars: preStripReply.length,
          stop_reason: stopReason,
        });
        preStripReply = beforeBlock;
        truncatedRecoveryApplied = true;
      } else if (openTag === -1) {
        // Caso 3: max_tokens sin bloque, texto parcial al cliente.
        botLog("warn", "claude_truncated_no_block", {
          phone: senderPhone,
          rawReplyChars: preStripReply.length,
          stop_reason: stopReason,
        });
      }
      // Si openTag !== -1 && closeTag !== -1, el bloque cerro a
      // tiempo aunque max_tokens hizo stop — extractor lo limpia.
    }

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
    let textWithoutProfile = preStripReply;
    if (!isStaff && !isSupervisor) {
      const { json, cleanedText } = extractProfileUpdate(preStripReply);
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

    // Hotfix-22 V3.5 (R5): post-processor HARD del formato. Smoke final
    // V3 mostro que el LLM ignora STYLE_LAYER y emite bullets, asteriscos
    // markdown y emojis con frecuencia. Strippear hard antes de mandar
    // a WhatsApp garantiza que el cliente NUNCA ve formato malo (eficacia
    // 100% vs 85% del soft override R2). Si counters > 0, log para que
    // Director vea en Axiom si el LLM sigue emitiendo formato malo.
    //
    // ORDEN: aplicar DESPUES de detectLeadSignals (cleanReply ya sin
    // tags [LEAD_CALIENTE]/[ESCALAR]/[AGENDAR|...]) y ANTES del empty-
    // reply guard caso 4. Asi si el strip vacia el texto (caso edge:
    // bot solo emitio "*X*"), el guard atrapa con fallback. Encadena
    // R4+R5 brutal.
    const formatResult = cleanFormat(botReply);
    botReply = formatResult.text;
    if (
      formatResult.counts.bullets > 0 ||
      formatResult.counts.bolds > 0 ||
      formatResult.counts.italics > 0 ||
      formatResult.counts.emojis > 0
    ) {
      botLog("info", "format_postprocessed", {
        phone: senderPhone,
        bullets_stripped: formatResult.counts.bullets,
        bolds_stripped: formatResult.counts.bolds,
        italics_stripped: formatResult.counts.italics,
        emojis_stripped: formatResult.counts.emojis,
      });
    }

    // Hotfix-24 (R4 caso 5): strip de bloques <parameter>/<invoke>/
    // <function_calls> truncados al final por max_tokens hit. El R4
    // existente (Hotfix-22 V3 r4) solo cubre <perfil_update> truncado,
    // pero el LLM también puede emitir tool-use XML como texto en
    // content[].text — si max_tokens corta a mitad de un <parameter
    // name="..."> sin </parameter> cerrante, leakea al cliente.
    // EVIDENCIA: 11 mayo 2026 14:33:04, Caso A formal PR4, Director vio
    // <parameter name="..."> crudo en el reply.
    //
    // Orden: aplicar DESPUES de cleanFormat (R5 post-processor strippea
    // markdown, no XML — orden preservado) y ANTES del empty-reply guard
    // caso 4. Si después del strip queda vacío, el guard caso 4 captura
    // con el fallback amable. Si queda texto válido, pasa intacto.
    const parameterStripResult = stripParameterBlocks(botReply);
    if (parameterStripResult.stripped) {
      botLog("warn", "perfil_update_truncated_stripped", {
        phone: senderPhone,
        strippedChars: parameterStripResult.strippedChars,
        beforeStripLength: botReply.length,
        stop_reason: stopReason,
      });
      botReply = parameterStripResult.text;
      truncatedRecoveryApplied = true;
    }

    // Hotfix-29 Bug 2 P0 (19 may 2026): strip bloques internos CERRADOS
    // que leakeaban al cliente. El LLM empezó a emitir
    // <parameter name="perfil_update">{JSON}</parameter> bien cerrado
    // que stripParameterBlocks NO removía (solo cubría truncados) y
    // extractProfileUpdate NO match (busca <perfil_update> directo).
    // Defensa final antes del send: elimina <parameter>, <invoke>,
    // <function_calls>, <perfil_update> cerrados.
    const internalBlocksResult = stripInternalBlocks(botReply);
    if (internalBlocksResult.stripped) {
      botLog("warn", "internal_blocks_leaked_stripped", {
        phone: senderPhone,
        strippedChars: internalBlocksResult.strippedChars,
        beforeStripLength: botReply.length,
      });
      botReply = internalBlocksResult.text;
      truncatedRecoveryApplied = true;
    }

    // Empty-reply guard caso 4 (hotfix-2 Día 3, extendido R4 + R5 + Hotfix-24):
    // si despues del strip de bloque perfil_update + tags + post-processor
    // de formato + strip de parameter-blocks truncados el texto quedo
    // vacio o solo whitespace, Mateo emitio solo metadata/formato sin
    // contenido visible. Reemplazamos por fallback amable en lugar de
    // mandar vacio que WhatsApp rechazaria con error 4xx (que ademas
    // seria atrapado por el catch top-level y dejaria al cliente en
    // visto). Regla universal de Enmanuel: Mateo SIEMPRE responde.
    if (!botReply || botReply.trim().length === 0) {
      botLog("warn", "empty_reply_after_strip", {
        phone: senderPhone,
        rawReplyLength: rawReply.length,
        rawReplyPreview: rawReply.slice(0, 200),
        stop_reason: stopReason,
        truncated_recovery_applied: truncatedRecoveryApplied,
        tool_invocation_count: response.toolInvocationCount || 0,
        format_stripped_to_empty: formatResult.counts.bullets + formatResult.counts.bolds + formatResult.counts.italics + formatResult.counts.emojis > 0,
      });

      // Hotfix-30 Fix 2: si el reply quedó vacío PERO hubo tool calls este
      // turno, el modelo casi siempre emitió solo metadata (<perfil_update>)
      // tras un tool_result y no produjo texto al cliente — root cause del
      // P0 "se me complicó algo" reproducido 22 may (calcular_plan_pago →
      // error etapa → turno final sin texto). En vez del genérico,
      // reintentamos UNA vez SIN tools: el modelo es forzado a responder con
      // texto usando el inventario que YA está en el prompt. Extiende
      // Hotfix-28 al caso "reply = solo metadata sin texto".
      let recovered = false;
      if ((response.toolInvocationCount || 0) > 0) {
        try {
          const retryResp = await callClaudeWithTools({
            system: systemBlocks,
            messages: messageHistory,
            tools: [],
            phone: senderPhone,
            toolHandlers: {},
          });
          let retryText = retryResp.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n")
            .trim();
          retryText = stripParameterBlocks(retryText).text;
          retryText = stripInternalBlocks(retryText).text;
          if (retryText && retryText.trim().length > 0) {
            botReply = retryText.trim();
            recovered = true;
            botLog("info", "empty_reply_tool_retry_recovered", {
              phone: senderPhone,
              recoveredLength: botReply.length,
            });
          }
        } catch (e) {
          botLog("warn", "empty_reply_tool_retry_failed", {
            phone: senderPhone,
            error: e.message,
          });
        }
      }

      if (!recovered) {
        botReply = "Dame un segundo, se me complicó algo. ¿Me repites tu mensaje en un momentito?";
      }
    }

    await addMessage(storageKey, "assistant", botReply, currentPromptHash);
    await sendWhatsAppMessage(senderPhone, botReply);
    botLog("info", "Respuesta enviada", { phone: senderPhone, responseLength: botReply.length, isSupervisor, activePrompt: isSupervisor ? "SUPERVISOR_PROMPT" : "CLIENT_PROMPT" });

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
    //
    // Bloque 2: este dispatcher regex (detecta intent en el reply + envía
    // brochure/precios/imágenes) quedó DESACTIVADO. La vía única de envío de
    // brochure y listado de precios es ahora el tool enviar_documento, que
    // Mateo invoca explícitamente — una sola fuente de verdad, sin doble-envío.
    // Kill-switch reversible: poner LEGACY_REGEX_DOC_DISPATCH=true reactiva el
    // camino viejo (no recomendado; coexistiría con el tool → doble-envío).
    const LEGACY_REGEX_DOC_DISPATCH = false;

    // PDFs se envian a todos (clientes y staff)
    {
      const project = LEGACY_REGEX_DOC_DISPATCH ? detectDocumentRequest(botReply, userMessage) : null;

      if (project === "all") {
        let allSentCount = 0;
        for (const [projKey, projDocs] of Object.entries(PROJECT_DOCS)) {
          if (projDocs.brochure) {
            // Hotfix-21 c1: policy guard. Si el brochure ya fue enviado y el
            // cliente no esta pidiendo retransmision explicita, skip.
            const decision = shouldSendDoc({
              sentDocs: clientMeta?.sentDocs,
              docKey: projKey + ".brochure",
              userMessage,
            });
            if (!decision.send) {
              botLog("info", "pdf_skip_already_sent", {
                phone: senderPhone, project: projKey, docType: "brochure", scope: "todos", reason: decision.reason,
              });
              continue;
            }
            if (decision.reason === "explicit-retransmit") {
              botLog("info", "pdf_send_explicit_retransmit", {
                phone: senderPhone, project: projKey, docType: "brochure", scope: "todos",
              });
            }
            if (allSentCount > 0) {
              await new Promise((resolve) => setTimeout(resolve, 1500));
            }
            // Enviar imagenes teaser antes del brochure (si estan configuradas).
            // Hotfix-21 c2: policy guard + tracking de imagenes. sentDocs[<proj>.images]
            // se trata como cualquier otro doc — first-send | already-sent | explicit-retransmit.
            const imgDecisionAll = shouldSendDoc({
              sentDocs: clientMeta?.sentDocs,
              docKey: projKey + ".images",
              userMessage,
            });
            if (imgDecisionAll.send) {
              if (imgDecisionAll.reason === "explicit-retransmit") {
                botLog("info", "img_send_explicit_retransmit", { phone: senderPhone, project: projKey, scope: "todos" });
              }
              await sendProjectImages(senderPhone, projKey);
              await markDocSent(storageKey, projKey + ".images");
            } else {
              botLog("info", "img_skip_already_sent", { phone: senderPhone, project: projKey, scope: "todos", reason: imgDecisionAll.reason });
            }
            const allFilename = PROJECT_NAMES[projKey] + " - Brochure - JPREZ.pdf";
            const allProxyUrl = toProxyUrl(projDocs.brochure);
            await sendWhatsAppDocument(senderPhone, allProxyUrl, allFilename);
            allSentCount++;
            await markDocSent(storageKey, projKey + ".brochure");
            botLog("info", "pdf_sent", { phone: senderPhone, project: projKey, docType: "brochure", scope: "todos" });
          }
        }
        if (allSentCount > 0) {
          botLog("info", "pdf_batch_complete", { phone: senderPhone, totalSent: allSentCount, scope: "all_projects" });
        }
      } else if (project && PROJECT_DOCS[project]) {
        const docs = PROJECT_DOCS[project];
        const requestedTypes = detectDocumentType(botReply, userMessage);
        // Hotfix-19 Bug #2: si project es puertoPlata, detectar si el cliente
        // pidio etapa especifica. null = ambiguo → mandar ambas (E3 y E4)
        // como antes. "E3"/"E4" = solo esa etapa. Se aplica a los bloques
        // especiales E4 mas abajo y al filename de los bloques E3 estandar.
        const ppStage = project === "puertoPlata"
          ? detectPuertoPlataStage(botReply, userMessage)
          : null;

        // Hotfix-19B Bug #2 followup: JUICIO COMERCIAL. Si Mateo prometio
        // "te mando Puerto Plata" sin que ni el cliente ni Mateo especificaran
        // etapa (ppStage === null), NO bombardeamos con E3+E4. La regla
        // JUICIO COMERCIAL del glossary-layer ensena al prompt a preguntar
        // "¿E3 o E4?" antes de prometer envio. Si llegamos aqui con ambiguedad,
        // preferimos dejar que la siguiente vuelta del prompt aclare en lugar
        // de mandar 2-4 PDFs sin contexto. return; sale de processMessage —
        // el bloque PDF es lo ultimo del flujo, no se omite logica posterior.
        if (project === "puertoPlata" && ppStage === null) {
          botLog("info", "pdf_skip_ambiguous_pp_stage", {
            phone: senderPhone,
            requestedTypes,
          });
          return;
        }

        // Hotfix-21 c3 (Bug #23): Crux tiene 2 sub-mundos (Listos vs Torre 6).
        // Mismo patron que Puerto Plata. Si el cliente menciona "Crux" sin
        // clarificar etapa, NO mandamos archivos — el commercial-layer fuerza
        // al modelo a preguntar "¿Listos o Torre 6 en construccion?".
        const cruxStage = project === "crux"
          ? detectCruxStage(botReply, userMessage)
          : null;
        if (project === "crux" && cruxStage === null) {
          botLog("info", "pdf_skip_ambiguous_crux_stage", {
            phone: senderPhone,
            requestedTypes,
          });
          return;
        }

        let sentCount = 0;
        // Track si las imagenes del proyecto ya fueron enviadas como teaser del
        // brochure, para evitar duplicar envio despues del PDF de precios cuando
        // el cliente pide brochure + precios juntos.
        let imagesSentAsTeaser = false;

        // Si el primer doc que se va a mandar es el brochure, enviar imagenes teaser antes.
        // Hotfix-21 c2: policy guard + tracking. Si las imagenes ya fueron enviadas
        // y NO hay retransmit explicit, skip pero marcamos imagesSentAsTeaser=true
        // para evitar reintento post-precios (semantica: "ya estan en el chat del cliente").
        if (requestedTypes[0] === "brochure" && docs.images && docs.images.length > 0) {
          const imgDecisionTeaser = shouldSendDoc({
            sentDocs: clientMeta?.sentDocs,
            docKey: project + ".images",
            userMessage,
          });
          if (imgDecisionTeaser.send) {
            if (imgDecisionTeaser.reason === "explicit-retransmit") {
              botLog("info", "img_send_explicit_retransmit", { phone: senderPhone, project });
            }
            await sendProjectImages(senderPhone, project);
            await markDocSent(storageKey, project + ".images");
          } else {
            botLog("info", "img_skip_already_sent", { phone: senderPhone, project, reason: imgDecisionTeaser.reason });
          }
          imagesSentAsTeaser = true;
        }

        // Hotfix-19 Bug #3: tracker granular de docTypes faltantes.
        // El bug original: bot promete "te mando brochure y planos" pero solo
        // llega el brochure. Causa: docs.planos = null (env var ausente) y
        // el loop saltaba silenciosamente. Ahora loguea pdf_doc_missing por
        // cada docType sin URL y mas abajo notifica al cliente.
        const missingDocTypes = [];
        for (const docType of requestedTypes) {
          const docUrl = docs[docType];
          // Hotfix-19 Bug #2: si cliente pidio puertoPlata E4 explicito, saltarse
          // el envio E3 estandar de este loop. El bloque especial E4 mas abajo
          // se encarga del documento E4. Inverso: si pidio E3 explicito, dejar
          // pasar este loop y mas abajo skipear los bloques E4.
          if (project === "puertoPlata" && ppStage === "E4") {
            // No envio del archivo E3 cuando cliente pidio E4 especifico.
            continue;
          }
          // Hotfix-21 c3: si cliente pidio Crux Torre 6 explicito y docType es
          // "precios", saltarse el precios general — el bloque especial T6
          // mas abajo manda preciosT6 (Drive ID propio). Si la env var T6 no
          // existe, el commercial-layer da los datos en texto y NO escalamos.
          if (project === "crux" && cruxStage === "T6" && docType === "precios") {
            continue;
          }
          if (docUrl) {
            // Hotfix-21 c1: policy guard. Bloqueamos reenvio si docKey ya
            // esta en sentDocs y el cliente NO esta pidiendo retransmision
            // explicita ("manda otra vez", "no me llego", etc).
            const decision = shouldSendDoc({
              sentDocs: clientMeta?.sentDocs,
              docKey: project + "." + docType,
              userMessage,
            });
            if (!decision.send) {
              botLog("info", "pdf_skip_already_sent", {
                phone: senderPhone, project: project, docType: docType, reason: decision.reason,
              });
              continue;
            }
            if (decision.reason === "explicit-retransmit") {
              botLog("info", "pdf_send_explicit_retransmit", {
                phone: senderPhone, project: project, docType: docType,
              });
            }
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
            botLog("info", "pdf_sent", { phone: senderPhone, project: project, docType: docType });
          } else {
            missingDocTypes.push(docType);
            botLog("warn", "pdf_doc_missing", {
              phone: senderPhone, project: project, docType: docType,
            });
          }
        }

        // Si Mateo prometio docs que no se pudieron mandar (env var sin URL),
        // notificar al cliente — regla "Mateo nunca deja al cliente en visto":
        // mejor ser honestos que prometer y no entregar.
        // Hotfix-19B Bug #3 followup: pre-fix exigia sentCount>0; cuando
        // cliente pedia "solo planos" y planos no existia, sentCount=0 y el
        // fallback no disparaba — bot prometia y cliente quedaba en visto.
        // Ahora el fallback dispara siempre que haya algo prometido y faltante.
        if (missingDocTypes.length > 0) {
          const labels = missingDocTypes
            .map((t) => DOC_TYPE_NAMES[t] || t)
            .join(" y ");
          await new Promise((resolve) => setTimeout(resolve, 1500));
          await sendWhatsAppMessage(
            senderPhone,
            "Te mando lo que tengo a mano. " + labels + " lo coordino con Enmanuel y te lo paso al toque."
          );
        }

        // Envio especial: Prado Suites Etapa 4 precios
        // Hotfix-19 Bug #2: si cliente pidio E3 explicito, no mandar E4.
        if (project === "puertoPlata" && ppStage !== "E3" && requestedTypes.includes("precios") && docs.preciosE4) {
          // Hotfix-21 c1: policy guard.
          const decisionE4P = shouldSendDoc({
            sentDocs: clientMeta?.sentDocs,
            docKey: project + ".preciosE4",
            userMessage,
          });
          if (!decisionE4P.send) {
            botLog("info", "pdf_skip_already_sent", {
              phone: senderPhone, project: "puertoPlata", docType: "preciosE4", reason: decisionE4P.reason,
            });
          } else {
            if (decisionE4P.reason === "explicit-retransmit") {
              botLog("info", "pdf_send_explicit_retransmit", {
                phone: senderPhone, project: "puertoPlata", docType: "preciosE4",
              });
            }
            if (sentCount > 0) {
              await new Promise((resolve) => setTimeout(resolve, 1500));
            }
            const e4Filename = PROJECT_NAMES[project] + " - Precios Etapa 4 (Entrega Dic. 2027) - JPREZ.pdf";
            const e4ProxyUrl = toProxyUrl(docs.preciosE4);
            await sendWhatsAppDocument(senderPhone, e4ProxyUrl, e4Filename);
            sentCount++;
            await markDocSent(storageKey, project + ".preciosE4");
            botLog("info", "pdf_sent", { phone: senderPhone, project: "puertoPlata", docType: "preciosE4" });
          }
        }

      // Envio especial: Prado Suites Etapa 4 brochure
      // Hotfix-19 Bug #2: si cliente pidio E3 explicito, no mandar E4.
      if (project === "puertoPlata" && ppStage !== "E3" && requestedTypes.includes("brochure") && docs.brochureE4) {
        // Hotfix-21 c1: policy guard.
        const decisionE4B = shouldSendDoc({
          sentDocs: clientMeta?.sentDocs,
          docKey: project + ".brochureE4",
          userMessage,
        });
        if (!decisionE4B.send) {
          botLog("info", "pdf_skip_already_sent", {
            phone: senderPhone, project: "puertoPlata", docType: "brochureE4", reason: decisionE4B.reason,
          });
        } else {
          if (decisionE4B.reason === "explicit-retransmit") {
            botLog("info", "pdf_send_explicit_retransmit", {
              phone: senderPhone, project: "puertoPlata", docType: "brochureE4",
            });
          }
          if (sentCount > 0) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }
          const e4BrochureFilename = PROJECT_NAMES[project] + " - Brochure Etapa 4 (Entrega Dic. 2027) - JPREZ.pdf";
          const e4BrochureProxyUrl = toProxyUrl(docs.brochureE4);
          await sendWhatsAppDocument(senderPhone, e4BrochureProxyUrl, e4BrochureFilename);
          sentCount++;
          await markDocSent(storageKey, project + ".brochureE4");
          botLog("info", "pdf_sent", { phone: senderPhone, project: "puertoPlata", docType: "brochureE4" });
        }
      }

      // Envio especial: Crux Torre 6 precios.
      // Hotfix-21 c3 (Bug #23): patron espejo de PP E4. Solo dispara si el
      // cliente menciono Torre 6 / "en planos" / construccion (cruxStage)
      // y pidio precios. Si docs.preciosT6 es null (env var ausente), el
      // commercial-layer instruye al modelo a dar los datos en texto sin
      // escalar a Enmanuel — la info esta en el layer.
      if (project === "crux" && cruxStage === "T6" && requestedTypes.includes("precios") && docs.preciosT6) {
        const decisionT6 = shouldSendDoc({
          sentDocs: clientMeta?.sentDocs,
          docKey: project + ".preciosT6",
          userMessage,
        });
        if (!decisionT6.send) {
          botLog("info", "pdf_skip_already_sent", {
            phone: senderPhone, project: "crux", docType: "preciosT6", reason: decisionT6.reason,
          });
        } else {
          if (decisionT6.reason === "explicit-retransmit") {
            botLog("info", "pdf_send_explicit_retransmit", {
              phone: senderPhone, project: "crux", docType: "preciosT6",
            });
          }
          if (sentCount > 0) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }
          const t6Filename = PROJECT_NAMES[project] + " - Precios Torre 6 (Entrega Jul 2027) - JPREZ.pdf";
          const t6ProxyUrl = toProxyUrl(docs.preciosT6);
          await sendWhatsAppDocument(senderPhone, t6ProxyUrl, t6Filename);
          sentCount++;
          await markDocSent(storageKey, project + ".preciosT6");
          botLog("info", "pdf_sent", { phone: senderPhone, project: "crux", docType: "preciosT6" });
        }
      }

        // Si el cliente pidio precios y el proyecto tiene imagenes Y no fueron
        // enviadas ya como teaser del brochure, mandarlas DESPUES del PDF de
        // precios. Caso de uso: Crux tiene IMG_CRUX con JPG de listos para
        // entrega inmediata que complementa el PDF "Precios y Disponibilidad"
        // (el PDF tiene todo el inventario, el JPG destaca listos ya).
        // Hotfix-21 c2: policy guard + tracking.
        if (
          requestedTypes.includes("precios") &&
          docs.images &&
          docs.images.length > 0 &&
          !imagesSentAsTeaser
        ) {
          const imgDecisionPost = shouldSendDoc({
            sentDocs: clientMeta?.sentDocs,
            docKey: project + ".images",
            userMessage,
          });
          if (imgDecisionPost.send) {
            if (imgDecisionPost.reason === "explicit-retransmit") {
              botLog("info", "img_send_explicit_retransmit", { phone: senderPhone, project });
            }
            if (sentCount > 0) {
              await new Promise((resolve) => setTimeout(resolve, 1500));
            }
            await sendProjectImages(senderPhone, project);
            await markDocSent(storageKey, project + ".images");
          } else {
            botLog("info", "img_skip_already_sent", { phone: senderPhone, project, reason: imgDecisionPost.reason });
          }
        }

        if (sentCount === 0) {
          botLog("warn", "pdf_no_urls", { phone: senderPhone, project: project, requestedTypes: requestedTypes });
        } else {
          botLog("info", "pdf_batch_complete", { phone: senderPhone, totalSent: sentCount, scope: "single_project" });
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

module.exports = {
  processMessage,
  DOC_TYPE_NAMES,
  // Sprint1.5: TOOLS exportado para el simulador QA (tests/qa-simulador
  // arma sus propios handlers con stubs y un guard de drift verifica que
  // cubra cada tool de este array).
  TOOLS,
  calcularPlanPago,
  inferEtapaFromContext,
  buildClientContext,
  pickRawReply,
  enviarDocumento,
  BROCHURE_DRIVE_IDS,
  COLD_START_SYNTHETIC_REPLY,
  GENERIC_HOLDING_REPLY,
};
