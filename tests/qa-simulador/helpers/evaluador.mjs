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

// Reserva por proyecto (doctrina v1.1): Crux US$1,000; PR3/PR4/PP US$2,000.
const RESERVA_ESPERADA = { crux: 1000, pr3: 2000, pr4: 2000, puertoPlata: 2000 };

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
export async function juzgarTranscripcion({ anthropic, transcript, eventos = [], focos = [], model = JUEZ_MODEL }) {
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

  const resp = await anthropic.messages.create({
    model,
    max_tokens: JUEZ_MAX_TOKENS,
    system,
    messages: [{ role: "user", content: user }],
    tools: [TOOL_VEREDICTO],
    tool_choice: { type: "tool", name: "emitir_veredicto" },
  });

  const tu = resp.content.find((b) => b.type === "tool_use" && b.name === "emitir_veredicto");
  if (!tu) {
    return { aprobado: false, violaciones: [{ regla: "juez sin veredicto", severidad: "alta", cita: "el juez no emitió tool_use" }], resumen: "fallo del juez" };
  }
  const v = tu.input;
  return {
    aprobado: Boolean(v.aprobado),
    violaciones: (v.violaciones || []).map((x) => ({ ...x, fuente: "juez-llm" })),
    resumen: v.resumen || "",
  };
}

// evaluarEscenario: capa 1 + capa 2 combinadas -> veredicto final.
// PASS = cero violaciones programáticas (las heurísticas son alta
// precisión) Y juez aprobado (sin severidad alta).
export async function evaluarEscenario({ anthropic, transcript, eventos, proyecto, focos }) {
  const prog = evaluarProgramatico({ transcript, eventos, proyecto });
  const juez = await juzgarTranscripcion({ anthropic, transcript, eventos, focos });

  const altasJuez = juez.violaciones.filter((v) => v.severidad === "alta");
  const pass = prog.violaciones.length === 0 && juez.aprobado && altasJuez.length === 0;

  return {
    pass,
    violaciones: [...prog.violaciones, ...juez.violaciones],
    warnings: prog.warnings,
    resumenJuez: juez.resumen,
  };
}
