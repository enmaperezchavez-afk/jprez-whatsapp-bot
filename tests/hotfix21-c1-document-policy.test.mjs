// Hotfix-21 c1 — Dispatcher policy guard (Bug #23).
//
// Bug #23: cliente recibio Crux brochure + IMG en mensaje 1. Mensaje 2
// dijo "en planos". Mateo prometio "te paso la informacion" y el dispatcher
// REENVIO el mismo brochure aunque sentDocs ya lo tenia. La regla "no
// re-enviar lo ya enviado" vivia solo en el prompt — el dispatcher era
// ciego a meta.sentDocs.
//
// Fix: nuevo modulo src/dispatch/document-policy.js con shouldSendDoc()
// puro. Dispatcher consulta antes de cada sendWhatsAppDocument.
//
// Cobertura (8 tests):
//   1-2. shouldSendDoc: first-send / already-sent
//   3.   shouldSendDoc: explicit-retransmit con frase autorizada
//   4.   shouldSendDoc: NOT-retransmit override (referencia, no pedido)
//   5.   detectIntentRetransmit: positivos batch (con y sin tilde)
//   6.   detectIntentRetransmit: negativos batch + edge cases (null, "")
//   7.   Source: handler importa shouldSendDoc + lo invoca antes de cada sendWhatsAppDocument
//   8.   Source: logs pdf_skip_already_sent + pdf_send_explicit_retransmit emitidos

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { shouldSendDoc, detectIntentRetransmit } = require("../src/dispatch/document-policy");

describe("Hotfix-21 c1 — shouldSendDoc()", () => {
  it("Test 1: docKey ausente en sentDocs → first-send", () => {
    const r = shouldSendDoc({
      sentDocs: {},
      docKey: "crux.brochure",
      userMessage: "en planos",
    });
    expect(r).toEqual({ send: true, reason: "first-send" });
  });

  it("Test 1b: sentDocs null/undefined → first-send (cliente nuevo)", () => {
    expect(shouldSendDoc({ sentDocs: null, docKey: "crux.brochure", userMessage: "hola" })).toEqual({ send: true, reason: "first-send" });
    expect(shouldSendDoc({ sentDocs: undefined, docKey: "crux.brochure", userMessage: "hola" })).toEqual({ send: true, reason: "first-send" });
  });

  it("Test 2: docKey ya en sentDocs + mensaje neutro → already-sent (BLOQUEADO)", () => {
    // Reproduce exacto Bug #23: cliente tiene crux.brochure en sentDocs, dice "en planos".
    const r = shouldSendDoc({
      sentDocs: { "crux.brochure": "2026-05-05T18:30:00Z" },
      docKey: "crux.brochure",
      userMessage: "en planos",
    });
    expect(r).toEqual({ send: false, reason: "already-sent" });
  });

  it("Test 3: docKey ya enviado + frase retransmit → explicit-retransmit (PERMITIDO)", () => {
    const phrasesSI = [
      "manda otra vez por favor",
      "mandalo otra vez",
      "mandame otra vez",
      "envialo otra vez",
      "reenvia el brochure",
      "reenvialo por favor",
      "no me llego el archivo",
      "no me lo mandaste",
      "no me lo enviaste",
      "se borro el pdf",
      "se me borro",
      "perdi el archivo",
      "perdi el pdf",
      "no lo veo",
      "no encontre el pdf",
      "no encuentro el pdf",
    ];
    for (const m of phrasesSI) {
      const r = shouldSendDoc({
        sentDocs: { "crux.brochure": "2026-05-05" },
        docKey: "crux.brochure",
        userMessage: m,
      });
      expect(r).toEqual({ send: true, reason: "explicit-retransmit" });
    }
  });

  it("Test 4: docKey ya enviado + frase de referencia (NO pedido) → already-sent (override)", () => {
    // Frases que MENCIONAN el doc anterior pero NO son pedido de reenvio.
    const phrasesNO = [
      "el ultimo que mandaste tenia un error",
      "como dijiste antes",
      "cuando me mandes el resto",
      "ya me lo mandaste, gracias",
    ];
    for (const m of phrasesNO) {
      const r = shouldSendDoc({
        sentDocs: { "crux.brochure": "2026-05-05" },
        docKey: "crux.brochure",
        userMessage: m,
      });
      expect(r).toEqual({ send: false, reason: "already-sent" });
    }
  });
});

describe("Hotfix-21 c1 — detectIntentRetransmit()", () => {
  it("Test 5: positivos con y sin tilde", () => {
    expect(detectIntentRetransmit("manda otra vez")).toBe(true);
    expect(detectIntentRetransmit("Reenvíalo por favor")).toBe(true);   // con tilde
    expect(detectIntentRetransmit("reenvialo por favor")).toBe(true);   // sin tilde
    expect(detectIntentRetransmit("no me llegó")).toBe(true);           // con tilde
    expect(detectIntentRetransmit("no me llego")).toBe(true);
    expect(detectIntentRetransmit("Se me borró el archivo")).toBe(true);
    expect(detectIntentRetransmit("perdí el PDF")).toBe(true);
  });

  it("Test 6: negativos + edge cases", () => {
    // Frases neutras
    expect(detectIntentRetransmit("hola")).toBe(false);
    expect(detectIntentRetransmit("en planos")).toBe(false);
    expect(detectIntentRetransmit("cuanto cuesta")).toBe(false);
    expect(detectIntentRetransmit("dame info de Crux")).toBe(false);
    // Frases NO_RETRANSMIT (override)
    expect(detectIntentRetransmit("ya me lo mandaste")).toBe(false);
    expect(detectIntentRetransmit("el ultimo que mandaste fue util")).toBe(false);
    expect(detectIntentRetransmit("como dijiste antes")).toBe(false);
    expect(detectIntentRetransmit("cuando me mandes")).toBe(false);
    // Edge cases
    expect(detectIntentRetransmit("")).toBe(false);
    expect(detectIntentRetransmit(null)).toBe(false);
    expect(detectIntentRetransmit(undefined)).toBe(false);
    expect(detectIntentRetransmit(123)).toBe(false);
  });
});

// === Source-inspection: handler integra policy guard ===

const HANDLER_SRC = readFileSync("src/handlers/message.js", "utf-8");

describe("Hotfix-21 c1 — handler integration (source)", () => {
  it("Test 7: handler importa shouldSendDoc desde document-policy", () => {
    expect(HANDLER_SRC).toMatch(/require\(["']\.\.\/dispatch\/document-policy["']\)/);
    expect(HANDLER_SRC).toContain("shouldSendDoc");
  });

  it("Test 7b: shouldSendDoc llamado en los 4 sites de envio (rama all + loop principal + 2 PP E4)", () => {
    // Cuento ocurrencias de shouldSendDoc en el flujo de envio.
    // Esperado: 4 invocaciones (una por cada site).
    const matches = HANDLER_SRC.match(/shouldSendDoc\(\{/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });

  it("Test 8: logs pdf_skip_already_sent + pdf_send_explicit_retransmit emitidos", () => {
    expect(HANDLER_SRC).toContain("pdf_skip_already_sent");
    expect(HANDLER_SRC).toContain("pdf_send_explicit_retransmit");
    // Cada log debe llevar reason cuando corresponda
    expect(HANDLER_SRC).toMatch(/pdf_skip_already_sent[^}]+reason:/);
  });
});
