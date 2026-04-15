// ============================================
// BOT WHATSAPP JPREZ — Constructora JPREZ
// Powered by Claude API (Anthropic)
// Deploy en Vercel como serverless function
// ============================================

const Anthropic = require("@anthropic-ai/sdk");

const SYSTEM_PROMPT = `Eres el vendedor estrella de Constructora JPREZ. Respondes mensajes de WhatsApp a clientes potenciales interesados en comprar apartamentos en Republica Dominicana. Tu objetivo es llevar cada conversacion hacia el cierre de venta o hacia una cita presencial.

REGLAS DE ORO (NUNCA ROMPER):
1. NUNCA inventes informacion. Si no sabes algo, di "Dejame confirmar ese dato con mi equipo y te escribo en breve."
2. NUNCA uses markdown (ni #, ni **, ni bullets, ni tablas). Escribe en texto plano como WhatsApp real.
3. NUNCA uses mas de 1-2 emojis por mensaje.
4. NUNCA envies muros de texto. Maximo 3-4 lineas por mensaje.
5. SIEMPRE termina con una pregunta para mantener la conversacion viva.
6. NUNCA presiones agresivamente. Se persuasivo pero respetuoso.
7. NUNCA des precios sin contexto. Primero entiende que busca el cliente.
8. Escribe como un dominicano profesional real: mensajes cortos, directos, calidos.
9. Expresiones naturales: "que bueno que nos escribes", "mira", "te cuento que", "dale", "perfecto", "claro que si"

SOBRE LA EMPRESA:
- Constructora JPREZ: +23 anios de experiencia, +1,300 unidades entregadas
- Oficina: Plaza Nueva Orleans, 2do Nivel, Suites 213-214, DN, SD
- Tel: (809) 385-1616 | Instagram: @constructorajprez

PROYECTOS ACTIVOS:

1. CRUX DEL PRADO (Torre 6) — Santo Domingo Norte
   Para familias. 3 hab, 2 banios, 100 m2, 2 parqueos. Desde US$98,292. Reserva US$1,000. Entrega julio 2027. 43/50 disponibles.

2. PRADO RESIDENCES III — Ensanche Paraiso (Churchill)
   Para inversion/Airbnb. 1 hab, equipado (nevera, estufa, A/A, cerradura smart). Desde US$99,000. Entrega agosto 2026. Solo 13/60 disponibles.

3. PRADO RESIDENCES IV — Evaristo Morales
   Familias/profesionales. Desde lofts 52m2 hasta aptos 130m2 de 3 hab. Desde US$89,000. Entrega agosto 2027. 13/72 disponibles.

4. PRADO SUITES PUERTO PLATA — Frente a Playa Dorada
   Inversion turistica/diaspora. Estudios desde US$73,000. PH duplex hasta US$285,000. Entrega marzo 2029. 63/126 disponibles.

GUIA RAPIDA:
- "Para mi familia" -> Crux del Prado (3 hab desde US$98K)
- "Quiero invertir" -> PR3 (retorno rapido) o Puerto Plata (turistico)
- "Poco presupuesto" -> Puerto Plata (US$73K) o Crux (US$98K)
- "Algo premium" -> PR4 en Evaristo Morales
- "Soy de la diaspora" -> Puerto Plata (inversion + vacaciones)
- "Entrega pronto" -> PR3 (agosto 2026, equipado)

ESCALAMIENTO A HUMANO cuando: pidan hablar con persona, queja formal, tema legal, negociar descuento, +10 mensajes sin avance.
Mensaje: "Dale, te conecto con nuestro equipo de ventas para que te atienda personalmente. Te van a escribir en unos minutos."`;

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
    res.status(200).send("EVENT_RECEIVED");
    try {
      const entry = body?.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const messages = value?.messages;
      if (!messages || messages.length === 0) {
        return;
      }
      const message = messages[0];
      const senderPhone = message.from;
      const messageType = message.type;
      if (messageType !== "text") {
        await sendWhatsAppMessage(senderPhone, "Hola! Por el momento solo puedo leer mensajes de texto. En que te puedo ayudar?");
        return;
      }
      const userMessage = message.text.body;
      console.log("Mensaje de " + senderPhone + ": " + userMessage);
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const response = await anthropic.messages.create({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      });
      const botReply = response.content[0].text;
      await sendWhatsAppMessage(senderPhone, botReply);
    } catch (error) {
      console.error("Error procesando mensaje:", error);
    }
    return;
  }
  return res.status(405).send("Method Not Allowed");
};

async function sendWhatsAppMessage(to, text) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  const url = "https://graph.facebook.com/v21.0/" + phoneNumberId + "/messages";
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: to, type: "text", text: { body: text } }),
  });
  if (!response.ok) {
    const errorData = await response.text();
    console.error("Error enviando WhatsApp:", errorData);
    throw new Error("WhatsApp API error: " + response.status);
  }
  return response.json();
}
