// tests/qa-simulador/helpers/cliente-fantasma.mjs — Sprint 1.5.
//
// El lado CLIENTE del simulador: un LLM que interpreta una persona
// (primerizo, inversionista, regateador, extranjero, difícil) y conversa
// con Mateo por turnos. Emite [FIN] cuando cumplió su objetivo — el
// driver corta ahí o en maxTurnos, lo que llegue primero.
//
// max_tokens corto (estilo WhatsApp + control de costo del brief).

export const CLIENTE_MAX_TOKENS = 300;
const CLIENTE_MODEL = "claude-sonnet-4-6";

const REGLAS_BASE = `
Estás simulando ser un CLIENTE real escribiendo por WhatsApp a Mateo, el
vendedor de la Constructora JPREZ (República Dominicana). Reglas duras:
- NUNCA reveles que eres una simulación ni rompas el personaje.
- Mensajes CORTOS de WhatsApp: 1 a 3 oraciones, lenguaje natural, sin formato.
- Reacciona a lo que Mateo te respondió (pregunta de seguimiento, objeción,
  duda) — no sueltes un guion fijo.
- Persigue tu OBJETIVO. Cuando lo hayas cumplido (o sea obvio que Mateo no
  puede dártelo y ya te dio la alternativa), responde con un cierre natural
  y agrega el token [FIN] al final del mensaje.
- No inventes datos de proyectos JPREZ que Mateo no haya dicho.
`;

// crearClienteFantasma: devuelve { abrir(), siguiente(transcript) }.
// `anthropic` inyectable (mock en unit tests, SDK real en el simulador).
export function crearClienteFantasma({ anthropic, persona, model = CLIENTE_MODEL, maxTokens = CLIENTE_MAX_TOKENS }) {
  if (!anthropic) throw new Error("cliente-fantasma: falta el cliente anthropic");
  if (!persona || !persona.perfil || !persona.objetivo || !persona.apertura) {
    throw new Error("cliente-fantasma: persona inválida (perfil/objetivo/apertura)");
  }

  const system =
    REGLAS_BASE +
    "\nTU PERSONAJE:\n" + persona.perfil +
    "\nTU OBJETIVO EN ESTA CONVERSACIÓN:\n" + persona.objetivo;

  return {
    // Primer mensaje fijo de la persona: reproducible entre corridas.
    abrir() {
      return persona.apertura;
    },

    // transcript: [{rol: "cliente"|"mateo", texto}]. Devuelve el próximo
    // mensaje del cliente (string, ya sin el token [FIN]) + done.
    async siguiente(transcript) {
      // Para el LLM-cliente la conversación va invertida: lo que dijo
      // Mateo es "user" y lo que dijo el cliente es "assistant".
      const messages = transcript.map((t) => ({
        role: t.rol === "mateo" ? "user" : "assistant",
        content: t.texto,
      }));
      const resp = await anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages,
      });
      const texto = resp.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();
      const done = /\[FIN\]/.test(texto);
      return { texto: texto.replace(/\s*\[FIN\]\s*/g, "").trim(), done };
    },
  };
}

// simularConversacion: driver del careo cliente-fantasma vs Mateo real.
// Devuelve { transcript, eventos, turnos, terminoNatural }.
export async function simularConversacion({ cliente, mateo, maxTurnos = 8 }) {
  const transcript = [];
  const eventos = [];

  let mensajeCliente = cliente.abrir();
  let terminoNatural = false;

  for (let turno = 0; turno < maxTurnos; turno++) {
    transcript.push({ rol: "cliente", texto: mensajeCliente });

    // Historial para Mateo: cliente = user, Mateo = assistant.
    const messages = transcript.map((t) => ({
      role: t.rol === "cliente" ? "user" : "assistant",
      content: t.texto,
    }));
    const respuesta = await mateo.responder(messages);
    transcript.push({ rol: "mateo", texto: respuesta.texto });
    eventos.push({
      turno,
      tools: respuesta.eventos,
      formatoCounts: respuesta.formatoCounts,
      textoCrudo: respuesta.textoCrudo,
    });

    if (turno === maxTurnos - 1) break;
    const next = await cliente.siguiente(transcript);
    if (next.done || !next.texto) {
      if (next.texto) transcript.push({ rol: "cliente", texto: next.texto });
      terminoNatural = true;
      break;
    }
    mensajeCliente = next.texto;
  }

  return { transcript, eventos, turnos: Math.ceil(transcript.length / 2), terminoNatural };
}
