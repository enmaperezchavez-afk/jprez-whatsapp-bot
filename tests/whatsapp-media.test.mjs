// Bloque 2 Componente 2 — Tests de envío de media por WhatsApp.
//
// whatsapp-media.js delega en el driver canónico src/whatsapp.js. Validamos
// el payload exacto que se POSTea a la Graph API: tipo document/image, link,
// filename, y caption opcional (nuevo en Bloque 2).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

const { sendDocument, sendImage } = require("../src/whatsapp-media");

describe("Bloque 2 — whatsapp-media", () => {
  let fetchCalls;

  beforeEach(() => {
    fetchCalls = [];
    process.env.WHATSAPP_PHONE_NUMBER_ID = "PHONE123";
    process.env.WHATSAPP_TOKEN = "TOK456";
    global.fetch = vi.fn(async (url, opts) => {
      fetchCalls.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
      return { ok: true, json: async () => ({ messages: [{ id: "wamid.X" }] }) };
    });
  });

  it("sendDocument POSTea type=document con link + filename + caption", async () => {
    await sendDocument("18091234567", "https://host/api/price-list?proyecto=pse3", "JPREZ - Listado.pdf", "Precios de PSE3");
    expect(fetchCalls.length).toBe(1);
    const { url, body, headers } = fetchCalls[0];
    expect(url).toContain("/PHONE123/messages");
    expect(headers.Authorization).toBe("Bearer TOK456");
    expect(body).toMatchObject({
      messaging_product: "whatsapp",
      to: "18091234567",
      type: "document",
      document: {
        link: "https://host/api/price-list?proyecto=pse3",
        filename: "JPREZ - Listado.pdf",
        caption: "Precios de PSE3",
      },
    });
  });

  it("sendDocument sin caption → no incluye campo caption", async () => {
    await sendDocument("18091234567", "https://host/x.pdf", "x.pdf");
    const { body } = fetchCalls[0];
    expect(body.document.link).toBe("https://host/x.pdf");
    expect(body.document.caption).toBeUndefined();
  });

  it("sendImage POSTea type=image con link + caption", async () => {
    await sendImage("18091234567", "https://host/api/img?id=abc", "Vista del proyecto");
    const { body } = fetchCalls[0];
    expect(body).toMatchObject({
      type: "image",
      image: { link: "https://host/api/img?id=abc", caption: "Vista del proyecto" },
    });
  });

  it("propaga error si la Graph API responde no-ok", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 400, text: async () => "bad" }));
    await expect(sendDocument("1", "u", "f")).rejects.toThrow(/WhatsApp Document API error: 400/);
  });
});
