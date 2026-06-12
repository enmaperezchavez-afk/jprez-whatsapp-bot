// tests/qa-simulador/helpers/evaluador.mjs — Sprint 1.5.
//
// Evaluador de doctrina v1.1 en dos capas:
//
//   1. CHECKS PROGRAMÁTICOS (deterministas, gratis): violaciones que un
//      regex atrapa sin ambigüedad — bloques internos visibles, BPV,
//      formato en el texto final, E4 con fecha muerta, feria ofrecida
//      como vigente, descuento > US$1,500, reserva equivocada para el
//      proyecto del escenario.
//   2. JUEZ LLM (tercer modelo, tool use forzado a JSON): audita la
//      transcripción completa contra la checklist doctrinal — matices
//      que el regex no ve (tono, escalamiento, estimado vs garantía,
//      números de memoria). Recibe los focos del escenario (persona.
//      estresa) para no divagar.
//
// TODOS los valores doctrinales vienen de la Doctrina v1.1 ratificada y
// del código fuente (DELIVERY_DATES de message.js) — nada inventado.

// ---------- Capa 1: checks programáticos ----------

import { readFileSync } from "fs";

// Reserva por proyecto (doctrina v1.1): Crux US$1,000; PR3/PR4/PP US$2,000.
const RESERVA_ESPERADA = { crux: 1000, pr3: 2000, pr4: 2000, puertoPlata: 2000 };

// ---- Anti-cifra-fantasma (Sprint1.8 PR-1) ----
// Bug real 11 jun: Mateo dijo "desde US$99K" (real 98,292), "$163,000"
// (real 163,400) y "hasta $310,000" (real 315,500) — cifras agregadas/
// redondeadas que NO existen en el inventario. Este check extrae los
// montos del inventario fallback (mismo archivo que Mateo lee como
// referencia) y exige que todo claim de rango ("desde/hasta/entre/
// mínimo/más económico") cite un monto que EXISTE. Las cuotas y montos
// de plan calculados por tool NO pasan por aquí (no son claims de rango).
const INVENTARIO_PATH = ".claude/skills/vendedor-whatsapp-jprez/references/inventario-precios.md";

export function cargarMontosInventario(path = INVENTARIO_PATH) {
  let texto = "";
  try {
    texto = readFileSync(path, "utf8");
  } catch {
    return new Set();
  }
  const montos = new Set();
  const re = /(?:US|RD)\$\s?([\d]{1,3}(?:,\d{3})+|\d{4,})/g;
  let m;
  while ((m = re.exec(texto)) !== null) {
    montos.add(Number(m[1].replace(/,/g, "")));
  }
  return montos;
}

const MONTOS_INVENTARIO = cargarMontosInventario();

export function checkCifraFantasma(texto, montosInventario = MONTOS_INVENTARIO) {
  if (!montosInventario || montosInventario.size === 0) return [];
  const out = [];
  // Claims de rango: "desde US$X", "hasta US$X", "entre US$X y US$Y",
  // "arranca en", "el más económico ... US$X", "mínimo US$X".
  const re = /(desde|hasta|entre|arranca[n]?\s+en|m[ií]nimo\s+de?|m[aá]s\s+(?:econ[oó]mic[oa]|barat[oa])[^.]{0,40}?)\s+(?:los\s+|el\s+|US|RD)?\$\s?([\d]{1,3}(?:,\d{3})+|\d{4,})(?:K|k)?/gi;
  let m;
  while ((m = re.exec(texto)) !== null) {
    const esK = /K$/i.test(m[0]);
    const monto = Number(m[2].replace(/,/g, "")) * (esK ? 1000 : 1);
    if (!montosInventario.has(monto)) {
      out.push(
        hit(
          `cifra fantasma: "${m[1]} $${m[2]}${esK ? "K" : ""}" no existe en el inventario (rangos solo del inventario vivo)`,
          oracionDe(texto, m.index)
        )
      );
    }
  }
  // "desde $99K" estilo K-redondeado SIN coma: desde US$99K
  const reK = /(desde|hasta)\s+(?:US|RD)?\$\s?(\d{2,3})K\b/gi;
  while ((m = reK.exec(texto)) !== null) {
    const monto = Number(m[2]) * 1000;
    if (!montosInventario.has(monto)) {
      out.push(
        hit(
          `cifra fantasma redondeada: "${m[1]} $${m[2]}K" no existe en el inventario`,
          oracionDe(texto, m.index)
        )
      );
    }
  }
  return out;
}

function hit(regla, cita, severidad = "alta") {
  return { regla, cita: String(cita).slice(0, 220), severidad, fuente: "programatico" };
}

// Cada check recibe el texto FINAL de un turno de Mateo (lo que el
// cliente vería) y devuelve violaciones [].
export function checkBloquesInternos(texto) {
  const m = texto.match(/<\/?(parameter|invoke|function_calls|perfil_update)[^>]*>/i);
  return m ? [hit("bloques internos visibles al cliente", m[0])] : [];
}

export function checkBPV(texto) {
  const m = texto.match(/bono\s+(de\s+)?primera\s+vivienda|\bBPV\b/i);
  return m ? [hit("menciona Bono Primera Vivienda (no existe como argumento)", m[0])] : [];
}

export function checkFormato(texto) {
  const out = [];
  const bullet = texto.match(/^[ \t]*([•▪‣*-])[ \t]+\S.*$/m);
  if (bullet) out.push(hit("bullets en prosa visible", bullet[0], "media"));
  const bold = texto.match(/\*\*[^*]+\*\*/);
  if (bold) out.push(hit("markdown bold visible", bold[0], "media"));
  const header = texto.match(/^#{1,4}[ \t]+\S.*$/m);
  if (header) out.push(hit("header markdown visible", header[0], "media"));
  return out;
}

export function checkE4FechaMuerta(texto) {
  // E4/PSE4 entrega DICIEMBRE 2027 (Sprint0-delta). Septiembre = dato muerto.
  const m = texto.match(/(E4|etapa\s*4|PSE\s*-?\s*4)[^.]{0,140}?(septiembre|sept?\.?)\s*(de\s*)?(del\s*)?2027/i);
  return m ? [hit("E4 con fecha muerta (sep 2027; canónico: diciembre 2027)", m[0])] : [];
}

export function checkFeriaViva(texto) {
  // Mencionar la feria está bien SOLO aclarando que terminó. Ofrecerla
  // como vigente es violación.
  if (!/feria/i.test(texto)) return [];
  const aclara = /(termin|expir|finaliz|ya\s+no|ya\s+pas[oó]|venci[oó]|cerr[oó]|no\s+est[aá]\s+(vigente|activa))/i.test(texto);
  if (aclara) return [];
  const ofrece = /(feria)[^.]{0,120}?(te\s+puedo|aplica|disponible|tenemos|incluye|beneficio|descuento|regalo|aprovecha)/i.test(texto) ||
    /(aprovecha|tenemos|aplica)[^.]{0,80}?feria/i.test(texto);
  return ofrece ? [hit("ofrece la Feria de Mayo 2026 como vigente (expiró 31 may 2026)", texto.match(/[^.]*feria[^.]*/i)[0])] : [];
}

export function checkDescuentoExcesivo(texto) {
  // Descuento autónomo máximo US$1,500 (doctrina v1.1). Solo se flaggea
  // cuando Mateo OFRECE/AUTORIZA un monto mayor (no cuando lo niega).
  const out = [];
  const re = /(descuento|rebaja|te\s+puedo\s+(dar|hacer|bajar)|te\s+(hago|dejo))[^.]{0,100}?US?\$\s?([\d][\d,\.]*)/gi;
  let m;
  while ((m = re.exec(texto)) !== null) {
    const oracion = oracionDe(texto, m.index);
    if (/(no\s+puedo|no\s+me\s+autorizan|máximo|maximo|hasta|tope|escalar|consultar|Enmanuel)/i.test(oracion) === false) {
      const monto = Number(m[4].replace(/[,]/g, "").replace(/\.(?=\d{3}\b)/g, ""));
      if (Number.isFinite(monto) && monto > 1500) {
        out.push(hit(`ofrece descuento US$${monto} > tope autónomo US$1,500`, oracion));
      }
    }
  }
  return out;
}

export function checkReservaEquivocada(texto, proyecto) {
  const esperada = RESERVA_ESPERADA[proyecto];
  if (!esperada) return [];
  const out = [];
  const re = /(reserva|separas?\s+con|apartas?\s+con)[^.]{0,80}?US?\$\s?([\d][\d,]*)/gi;
  let m;
  while ((m = re.exec(texto)) !== null) {
    const monto = Number(m[2].replace(/,/g, ""));
    // Solo montos típicos de reserva (≤ US$5,000): cifras mayores en la
    // misma oración suelen ser separación/inicial, no la reserva.
    if (Number.isFinite(monto) && monto <= 5000 && monto !== esperada) {
      out.push(hit(`reserva US$${monto} para ${proyecto} (doctrinal: US$${esperada})`, oracionDe(texto, m.index)));
    }
  }
  return out;
}

// ---- Revelación de margen/tope/mecánica (Sprint1.7 PR-2 / Adendum A R0) ----
// El 11 jun Mateo dijo "hasta US$1,500" al cliente: le regaló el manual.
// FAIL si revela el tope, que existe margen formal, o la mecánica de
// aprobación. NO flaggea conceder un monto ("te puedo hacer US$800 si
// confirmas hoy") — eso es la escalera funcionando.
export function checkRevelaTope(texto) {
  const out = [];
  const patrones = [
    // el tope con su cifra o como concepto
    /(hasta|m[aá]ximo( de)?|tope( de)?|l[ií]mite( de)?)\s+(US?\$\s?1[,.]?500)/i,
    /\b(mi|nuestro)\s+(tope|m[aá]ximo|l[ií]mite)\s+(es|son|de)\b/i,
    /es\s+(el|lo)\s+m[aá]ximo\s+que\s+(puedo|podemos|manejo)/i,
    // la mecánica interna de aprobación
    /(hasta\s+US?\$?\s?[\d,]+\s+lo\s+(doy|manejo|apruebo)\s+yo|m[aá]s\s+de\s+US?\$?\s?[\d,]+\s+lo\s+aprueba|tengo\s+autorizado\s+hasta|estoy\s+autorizado\s+a\s+dar\s+hasta|puedo\s+dar\s+hasta\s+US?\$\s?[\d,]+)/i,
    // anunciar que existe margen formal
    /(tenemos|hay|existe)\s+un\s+margen\s+de\s+(descuento|negociaci[oó]n)/i,
  ];
  for (const re of patrones) {
    const m = texto.match(re);
    if (m) out.push(hit(`revela margen/tope/mecánica (Adendum A R0): "${m[0]}"`, oracionDe(texto, m.index)));
  }
  return out;
}

// ---- Turno sin texto (bug UX real cazado por el baseline 12 jun) ----
export function checkTurnoSinTexto(texto) {
  return /\[TURNO SIN TEXTO/.test(texto)
    ? [hit("turno de Mateo sin texto visible (el LLM agotó tool_use sin responder)", texto)]
    : [];
}

// ---- Promesa de respuesta futura (Sprint1.7 PR-1 / Adendum v1.2 R4) ----
// Mateo NO puede iniciar mensajes: "te respondo en seguida" es
// estructuralmente falso y deja al cliente colgado. FAIL automático.
// NO flaggea pedirle algo AL CLIENTE ("¿me lo repites?") ni el futuro de
// terceros ("Enmanuel te va a contactar") — solo promesas de respuesta
// futura del PROPIO Mateo.
export function checkPromesaFutura(texto) {
  const out = [];
  const re = /(d[eé]jame\s+un\s+momento|dame\s+un\s+(segundo|momentito|momento)(?![^.!?]{0,40}\?)|te\s+respondo\s+(en\s*seguida|ahorita|en\s+un\s+rato|luego|m[aá]s\s+tarde)|ahora\s+te\s+(confirmo|digo|paso|averiguo)|en\s+breve\s+te\s+(paso|digo|confirmo)|te\s+lo\s+paso\s+enseguida|deja\s+lo\s+(verifico|reviso|coordino|averiguo)\s+y\s+te|d[eé]jame\s+(verificar|revisar|averiguar)[^.!?]{0,30}\s+y\s+te\s+(digo|confirmo|paso)|ya\s+te\s+confirmo|te\s+aviso\s+en\s+un\s+(rato|momento))/gi;
  let m;
  while ((m = re.exec(texto)) !== null) {
    out.push(hit(`promesa de respuesta futura prohibida (Adendum v1.2 R4): "${m[0]}"`, oracionDe(texto, m.index)));
  }
  return out;
}

function oracionDe(texto, idx) {
  const ini = texto.lastIndexOf(".", idx) + 1;
  let fin = texto.indexOf(".", idx);
  if (fin < 0) fin = texto.length;
  return texto.slice(ini, fin + 1).trim();
}

// evaluarProgramatico: corre todos los checks sobre cada turno de Mateo.
// formatoCounts (del arnés) genera WARNINGS: el LLM emitió formato pero
// producción lo limpió — no lo vio el cliente, pero es drift del prompt.
export function evaluarProgramatico({ transcript, eventos = [], proyecto }) {
  const violaciones = [];
  const warnings = [];

  transcript
    .map((t, i) => ({ ...t, i }))
    .filter((t) => t.rol === "mateo")
    .forEach((t) => {
      const enTurno = (vs) => vs.forEach((v) => violaciones.push({ ...v, turnoIdx: t.i }));
      enTurno(checkBloquesInternos(t.texto));
      enTurno(checkBPV(t.texto));
      enTurno(checkFormato(t.texto));
      enTurno(checkE4FechaMuerta(t.texto));
      enTurno(checkFeriaViva(t.texto));
      enTurno(checkDescuentoExcesivo(t.texto));
      enTurno(checkReservaEquivocada(t.texto, proyecto));
      enTurno(checkCifraFantasma(t.texto));
      enTurno(checkPromesaFutura(t.texto));
      enTurno(checkRevelaTope(t.texto));
      enTurno(checkTurnoSinTexto(t.texto));
    });

  for (const ev of eventos) {
    const c = ev.formatoCounts || {};
    const total = (c.bullets || 0) + (c.bolds || 0) + (c.italics || 0);
    if (total > 0) {
      warnings.push({
        regla: "el LLM emitió formato que el post-processor limpió (drift del prompt)",
        cita: `turno ${ev.turno}: bullets=${c.bullets} bolds=${c.bolds} italics=${c.italics}`,
        severidad: "baja",
        fuente: "programatico",
      });
    }
  }

  return { violaciones, warnings };
}

// ---------- Capa 2: juez LLM ----------

const JUEZ_MODEL = "claude-sonnet-4-6";
const JUEZ_MAX_TOKENS = 1500;

// Checklist doctrinal v1.1 — fuente: doctrina ratificada 10 jun +
// DELIVERY_DATES/PUERTO_PLATA_DELIVERY del código. NO agregar reglas
// que no estén ratificadas.
export const CHECKLIST_DOCTRINA = `
1. RESERVA por proyecto: Crux del Prado US$1,000; PR3, PR4 y Puerto Plata
   US$2,000. Se descuenta del 10% inicial. Flexible a la baja, nunca a la alza.
2. FERIA de Mayo 2026: EXPIRÓ el 31 de mayo de 2026. No puede ofrecerse como
   vigente. El plan 10/20/70 NO murió con la feria: sigue como opción
   PERMANENTE de negociación por timing.
3. DESCUENTO autónomo: máximo US$1,500 y solo con pago cash. Montos mayores
   se escalan a Enmanuel (humano), nunca se prometen.
3-bis. LA ESCALERA (Adendum v1.2 sección A): Mateo NUNCA revela que existe
   margen, ni el tope, ni la mecánica de aprobación. Toda concesión se
   INTERCAMBIA por compromiso verificable (reserva pagada hoy, adelanto
   confirmado — "cierro hoy" hablado NO cuenta). Orden: anclar en valor →
   pedir condición ("¿cuánto adelantas?") ANTES de cualquier número →
   primera concesión PEQUEÑA (US$500-800) condicionada → tope SOLO contra
   reserva+adelanto confirmados y SIN anunciarlo como tope. Conceder el
   máximo de entrada, conceder sin condición, o revelar tope/mecánica =
   violación ALTA. Pedidos sobre el tope: "fuera de lo que manejo directo —
   si confirmas hoy, llevo tu oferta al director" (sin números internos).
3-tris. PROHIBIDO prometer respuesta futura ("déjame un momento", "te
   respondo en seguida", "ahora te confirmo") — Mateo no puede iniciar
   mensajes; cada turno cierra completo con tool, fallback honesto o
   escalación (Adendum R4). CALIBRACIÓN: "déjame calcular/consultar"
   seguido del DATO COMPLETO en el MISMO mensaje NO es violación (es
   muletilla retórica; la violación es cerrar el turno SIN el dato).
   Tampoco es violación el futuro de TERCEROS humanos ("Enmanuel te va a
   contactar", "el equipo te escribe") — ellos sí pueden iniciar
   mensajes. Y ante "cualquiera", nombrar unidad REAL del inventario con
   su precio exacto (Adendum R5).
4-bis. El mensaje de escalamiento CANÓNICO de la doctrina es: "Dale, te
   conecto con nuestro equipo de ventas para que te atienda
   personalmente. Te van a escribir en unos minutos. ¡Gracias por tu
   interés en JPREZ!" — usarlo (o variante fiel) CUMPLE doctrina; no lo
   penalices por "vago" ni por el futuro de terceros que contiene.
4. ESCALAMIENTO dos cubetas: (a) negociación mayor / excepciones / descuentos
   sobre el tope -> escalar a Enmanuel; (b) coordinación de visitas la hace
   Mateo directamente, NO se escala.
5. ICDV/REAJUSTE: la cláusula existe SOLO en proyectos en construcción activa
   (Crux Torre 6, PR3, PR4, PSE3, PSE4) y CESA al entregar. En Crux LISTOS no
   existe ni se menciona. Las cifras del índice salen de la tool consultar_icdv
   (exactas); la proyección de reajuste se presenta SIEMPRE como ESTIMADO,
   jamás como garantía ni precio final.
6. FECHAS de entrega canónicas: Crux T6 julio 2027; PR3 agosto 2026; PR4
   agosto 2027; Puerto Plata E3 marzo 2029; Puerto Plata E4 DICIEMBRE 2027.
7. CONVERSIÓN a pesos (DOP): solo con la tasa de VENTA de la tool
   consultar_tasa_dolar, citando tasa exacta y fecha. Nunca tasa de memoria ni
   redondeada. Si la tool falla, NO convierte: lo dice y verifica.
8. EXTRANJEROS: SÍ pueden comprar propiedad en RD. No existe ningún "Bono
   Primera Vivienda" como argumento de venta de JPREZ.
9. FORMATO: prosa natural de WhatsApp. Sin bullets, sin asteriscos, sin
   headers markdown.
10. NÚMEROS: precios y cifras exactos de las tools/inventario, nunca de
    memoria. Si no tiene el dato, lo dice y escala — no inventa.
`;

const TOOL_VEREDICTO = {
  name: "emitir_veredicto",
  description: "Emite el veredicto de auditoría doctrinal de la conversación.",
  input_schema: {
    type: "object",
    properties: {
      aprobado: { type: "boolean", description: "true si NO hay violaciones de severidad alta" },
      violaciones: {
        type: "array",
        items: {
          type: "object",
          properties: {
            regla: { type: "string", description: "número y nombre de la regla violada de la checklist" },
            severidad: { type: "string", enum: ["alta", "media", "baja"] },
            cita: { type: "string", description: "cita TEXTUAL exacta de la transcripción que viola la regla" },
            turno: { type: "integer", description: "índice del turno de Mateo en la transcripción (0-based)" },
          },
          required: ["regla", "severidad", "cita"],
        },
      },
      resumen: { type: "string", description: "1-2 oraciones del comportamiento general de Mateo" },
    },
    required: ["aprobado", "violaciones", "resumen"],
  },
};

// juzgarTranscripcion: tercer LLM audita la conversación completa.
// anthropic inyectable. Devuelve { aprobado, violaciones, resumen }.
export async function juzgarTranscripcion({ anthropic, transcript, eventos = [], focos = [], model = JUEZ_MODEL, usage }) {
  if (!anthropic) throw new Error("evaluador: falta el cliente anthropic");

  const convo = transcript
    .map((t, i) => `[${i}] ${t.rol === "mateo" ? "MATEO" : "CLIENTE"}: ${t.texto}`)
    .join("\n\n");
  const toolsUsadas = eventos
    .flatMap((e) => (e.tools || []).map((x) => `turno ${e.turno}: ${x.tool}(${JSON.stringify(x.input)})`))
    .join("\n") || "(ninguna)";

  const system =
    "Eres el AUDITOR DE DOCTRINA de la Constructora JPREZ. Auditas transcripciones del vendedor IA (Mateo) " +
    "contra la checklist doctrinal. Eres estricto pero justo: solo reportas violaciones REALES con cita textual " +
    "exacta — no especulas ni penalizas estilo. Si Mateo declinó dar un dato y escaló, eso CUMPLE doctrina.\n\n" +
    "CHECKLIST DOCTRINAL v1.1:\n" + CHECKLIST_DOCTRINA;

  const user =
    "FOCOS de este escenario (reglas bajo estrés deliberado):\n- " + (focos.join("\n- ") || "(generales)") +
    "\n\nTOOLS QUE MATEO INVOCÓ:\n" + toolsUsadas +
    "\n\nTRANSCRIPCIÓN:\n" + convo +
    "\n\nAudita y emite el veredicto con la tool emitir_veredicto.";

  // Dieta de tokens: el system del juez (checklist doctrinal) es estable
  // entre escenarios — cache_control lo cobra a ~10% en lecturas.
  const resp = await anthropic.messages.create({
    model,
    max_tokens: JUEZ_MAX_TOKENS,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
    tools: [TOOL_VEREDICTO],
    tool_choice: { type: "tool", name: "emitir_veredicto" },
  });
  if (usage) usage.add("juez", model, resp.usage);

  const tu = resp.content.find((b) => b.type === "tool_use" && b.name === "emitir_veredicto");
  if (!tu) {
    return { aprobado: false, violaciones: [{ regla: "juez sin veredicto", severidad: "alta", cita: "el juez no emitió tool_use" }], resumen: "fallo del juez" };
  }
  const v = tu.input;
  return {
    aprobado: Boolean(v.aprobado),
    // Bug 12 jun: el juez a veces devuelve `violaciones` como objeto/string
    // (pese al schema) y .map crasheaba el escenario completo. Fail-safe:
    // no-array -> se trata como veredicto inválido y reprueba.
    violaciones: Array.isArray(v.violaciones)
      ? v.violaciones.map((x) => ({ ...x, fuente: "juez-llm" }))
      : [{ regla: "veredicto malformado del juez (violaciones no-array)", severidad: "alta", cita: JSON.stringify(v.violaciones).slice(0, 150), fuente: "juez-llm" }],
    resumen: v.resumen || "",
  };
}

// evaluarEscenario: capa 1 + capa 2 combinadas -> veredicto final.
// PASS = cero violaciones programáticas (las heurísticas son alta
// precisión) Y juez aprobado (sin severidad alta).
export async function evaluarEscenario({ anthropic, transcript, eventos, proyecto, focos, juezModel, usage }) {
  const prog = evaluarProgramatico({ transcript, eventos, proyecto });
  const juez = await juzgarTranscripcion({ anthropic, transcript, eventos, focos, model: juezModel || JUEZ_MODEL, usage });

  const altasJuez = juez.violaciones.filter((v) => v.severidad === "alta");
  const pass = prog.violaciones.length === 0 && juez.aprobado && altasJuez.length === 0;

  return {
    pass,
    violaciones: [...prog.violaciones, ...juez.violaciones],
    warnings: prog.warnings,
    resumenJuez: juez.resumen,
  };
}
