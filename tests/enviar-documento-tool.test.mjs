// Bloque 2 Componente 3 — Tests del handler del tool enviar_documento.
//
// Valida: listado_precios construye URL /api/price-list y manda documento;
// brochure resuelve el Drive ID correcto vía /api/pdf; registra sentDocs;
// proyecto inválido y fallo de envío se reportan como { sent: false } sin
// lanzar (Mateo debe poder ser honesto con el cliente).

import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// Mock log
{
  const id = require.resolve("../src/log");
  require.cache[id] = {
    id, filename: id, loaded: true,
    exports: { botLog: () => {}, logToAxiom: async () => {} },
  };
}

// Mock whatsapp-media.sendDocument — capturamos args.
const sendDocumentCalls = [];
let sendShouldThrow = false;
{
  const id = require.resolve("../src/whatsapp-media");
  require.cache[id] = {
    id, filename: id, loaded: true,
    exports: {
      sendDocument: async (phone, url, filename, caption) => {
        if (sendShouldThrow) throw new Error("simulated send failure");
        sendDocumentCalls.push({ phone, url, filename, caption });
        return { messages: [{ id: "wamid.X" }] };
      },
      sendImage: async () => ({}),
    },
  };
}

// Mock store/meta.markDocSent — capturamos.
const markDocSentCalls = [];
{
  const id = require.resolve("../src/store/meta");
  require.cache[id] = {
    id, filename: id, loaded: true,
    exports: {
      markDocSent: async (storageKey, docKey) => { markDocSentCalls.push({ storageKey, docKey }); },
      saveClientMeta: async () => {},
      getClientMeta: async () => null,
    },
  };
}

const { enviarDocumento, BROCHURE_DRIVE_IDS } = require("../src/handlers/message");

describe("Bloque 2 — enviar_documento handler", () => {
  beforeEach(() => {
    sendDocumentCalls.length = 0;
    markDocSentCalls.length = 0;
    sendShouldThrow = false;
  });

  it("listado_precios → URL /api/price-list?proyecto=pse3 + sent:true + sentDocs", async () => {
    const r = await enviarDocumento({ tipo: "listado_precios", proyecto: "pse3", phone: "1809", storageKey: "chat:1809" });
    expect(r.sent).toBe(true);
    expect(r.message).toContain("Listado de precios enviado");
    expect(sendDocumentCalls.length).toBe(1);
    expect(sendDocumentCalls[0].url).toContain("/api/price-list?proyecto=pse3");
    expect(sendDocumentCalls[0].phone).toBe("1809");
    expect(sendDocumentCalls[0].filename).toContain(".pdf");
    expect(markDocSentCalls).toContainEqual({ storageKey: "chat:1809", docKey: "pse3.listado_precios" });
  });

  it("brochure pse3 → URL /api/pdf con el Drive ID correcto + sent:true", async () => {
    const r = await enviarDocumento({ tipo: "brochure", proyecto: "pse3", phone: "1809", storageKey: "chat:1809" });
    expect(r.sent).toBe(true);
    expect(r.message).toContain("Brochure enviado");
    expect(sendDocumentCalls[0].url).toContain("/api/pdf?id=" + BROCHURE_DRIVE_IDS.pse3);
    expect(markDocSentCalls).toContainEqual({ storageKey: "chat:1809", docKey: "pse3.brochure" });
  });

  it("brochure crux_t6 y crux_listos comparten el mismo Drive ID", async () => {
    expect(BROCHURE_DRIVE_IDS.crux_t6).toBe(BROCHURE_DRIVE_IDS.crux_listos);
    const r = await enviarDocumento({ tipo: "brochure", proyecto: "crux_listos", phone: "1809", storageKey: "k" });
    expect(r.sent).toBe(true);
    expect(sendDocumentCalls[0].url).toContain(BROCHURE_DRIVE_IDS.crux_t6);
  });

  it("proyecto inválido → sent:false, NO envía", async () => {
    const r = await enviarDocumento({ tipo: "listado_precios", proyecto: "foo", phone: "1809", storageKey: "k" });
    expect(r.sent).toBe(false);
    expect(r.error).toBe("proyecto_invalido");
    expect(sendDocumentCalls.length).toBe(0);
  });

  it("fallo de envío → sent:false con mensaje honesto, NO lanza", async () => {
    sendShouldThrow = true;
    const r = await enviarDocumento({ tipo: "listado_precios", proyecto: "pse3", phone: "1809", storageKey: "k" });
    expect(r.sent).toBe(false);
    expect(r.error).toBe("envio_fallo");
    // No se registró como enviado si falló
    expect(markDocSentCalls.length).toBe(0);
  });

  it("los 6 proyectos tienen Drive ID de brochure", () => {
    for (const p of ["pr3", "pr4", "pse3", "pse4", "crux_t6", "crux_listos"]) {
      expect(typeof BROCHURE_DRIVE_IDS[p]).toBe("string");
      expect(BROCHURE_DRIVE_IDS[p].length).toBeGreaterThan(10);
    }
  });
});
