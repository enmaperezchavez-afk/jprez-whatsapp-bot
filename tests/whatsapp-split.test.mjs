// ============================================
// Tests Hotfix-31 — split de mensajes >4096 chars
// ============================================
// WhatsApp Cloud API rechaza text bodies >4096 con 400 y el cliente no
// recibe nada. splitMessageForWhatsApp parte en límites naturales;
// sendWhatsAppMessage envía cada chunk en orden.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  splitMessageForWhatsApp,
  sendWhatsAppMessage,
  WHATSAPP_MAX_CHARS,
} from "../src/whatsapp.js";

describe("splitMessageForWhatsApp", () => {
  it("texto corto → 1 chunk intacto", () => {
    expect(splitMessageForWhatsApp("hola")).toEqual(["hola"]);
    const exact = "x".repeat(WHATSAPP_MAX_CHARS);
    expect(splitMessageForWhatsApp(exact)).toEqual([exact]);
  });

  it("texto largo con párrafos → corta en \\n\\n, todos los chunks ≤4096", () => {
    const para = "Lorem ipsum dolor sit amet. ".repeat(50).trim(); // ~1400 chars
    const text = [para, para, para, para, para].join("\n\n"); // ~7000 chars
    const chunks = splitMessageForWhatsApp(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(WHATSAPP_MAX_CHARS);
      expect(c.length).toBeGreaterThan(0);
    }
    // No se pierde contenido (modulo whitespace de los cortes)
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
  });

  it("texto sin espacios ni saltos → corte duro a 4096", () => {
    const text = "a".repeat(9000);
    const chunks = splitMessageForWhatsApp(text);
    expect(chunks.map((c) => c.length)).toEqual([4096, 4096, 808]);
    expect(chunks.join("")).toBe(text);
  });

  it("null/undefined no lanza", () => {
    expect(splitMessageForWhatsApp(null)).toEqual([""]);
    expect(splitMessageForWhatsApp(undefined)).toEqual([""]);
  });
});

describe("sendWhatsAppMessage con chunks", () => {
  let fetchMock;
  beforeEach(() => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = "12345";
    process.env.WHATSAPP_TOKEN = "tok";
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ messages: [{ id: "wamid.X" }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mensaje corto → 1 llamada a la API", async () => {
    await sendWhatsAppMessage("18095551234", "hola");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text.body).toBe("hola");
  });

  it("mensaje de 9000 chars → 3 llamadas en orden, cada body ≤4096", async () => {
    const text = "palabra ".repeat(1125).trim(); // ~9000 chars
    await sendWhatsAppMessage("18095551234", text);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse(call[1].body);
      expect(body.text.body.length).toBeLessThanOrEqual(WHATSAPP_MAX_CHARS);
    }
  });

  it("si la API falla en un chunk, propaga el error (comportamiento previo)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, text: async () => "bad" });
    await expect(sendWhatsAppMessage("18095551234", "hola")).rejects.toThrow(
      "WhatsApp API error: 400"
    );
  });
});
