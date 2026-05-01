// Hotfix-19 Commit 1 — Bug #1 (audio) + Bug #3 (pdf doc missing).
//
// COBERTURA:
//   1. Threshold relajado: trimmed con length=2 NO se descarta.
//   2. transcribeWhatsAppAudio nunca propaga: ante fetch que tira,
//      retorna null + emite log estructurado en lugar de throw.
//   3. Loop de envio loguea `pdf_doc_missing` cuando docUrl es null
//      (verificacion estatica del codigo, sin invocar el handler).

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// Aislar log y fetch via require.cache patching.
const botLogCalls = [];
{
  const id = require.resolve("../src/log");
  require.cache[id] = {
    id, filename: id, loaded: true,
    exports: {
      botLog: (level, message, data) => botLogCalls.push({ level, message, data }),
      logToAxiom: async () => {},
    },
  };
}

const { transcribeWhatsAppAudio } = require("../src/whatsapp");

const HANDLER_PATH = "src/handlers/message.js";
const HANDLER_SRC = readFileSync(HANDLER_PATH, "utf-8");

describe("Hotfix-19 Commit 1 — Bug #1 audio threshold", () => {
  it("Test 1: handler usa threshold < 2 (no < 3) — palabra 'ok' (2 chars) ya no se descarta", () => {
    expect(HANDLER_SRC).toContain("trimmed.length < 2");
    expect(HANDLER_SRC).not.toContain("trimmed.length < 3");
  });

  it("Test 2: log de audio descartado incluye transcribeReturnedNull (distingue causa)", () => {
    expect(HANDLER_SRC).toContain("transcribeReturnedNull");
  });
});

describe("Hotfix-19 Commit 1 — Bug #1 try/catch en transcribeWhatsAppAudio", () => {
  it("Test 3: ante fetch que tira excepcion, retorna null sin propagar", async () => {
    const realFetch = globalThis.fetch;
    botLogCalls.length = 0;
    process.env.OPENAI_API_KEY = "fake-key";
    process.env.WHATSAPP_TOKEN = "fake-token";
    try {
      globalThis.fetch = async () => {
        throw new Error("network down");
      };
      const result = await transcribeWhatsAppAudio("audio-id-123");
      expect(result).toBe(null);

      // Y emite log estructurado — no se traga el error.
      const exception = botLogCalls.find((c) => c.message === "audio_transcribe_exception");
      expect(exception).toBeDefined();
      expect(exception.data.audioId).toBe("audio-id-123");
      expect(exception.data.error).toBe("network down");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("Test 4: si OPENAI_API_KEY ausente, loguea audio_transcribe_skip_no_key + null", async () => {
    botLogCalls.length = 0;
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const result = await transcribeWhatsAppAudio("audio-id-X");
      expect(result).toBe(null);
      const skip = botLogCalls.find((c) => c.message === "audio_transcribe_skip_no_key");
      expect(skip).toBeDefined();
      expect(skip.data.audioId).toBe("audio-id-X");
    } finally {
      if (saved) process.env.OPENAI_API_KEY = saved;
    }
  });
});

describe("Hotfix-19 Commit 1 — Bug #3 pdf_doc_missing log granular", () => {
  it("Test 5: handler emite botLog warn 'pdf_doc_missing' cuando docUrl es null", () => {
    // Verificacion estatica: el handler debe contener el patron de log.
    expect(HANDLER_SRC).toContain('"pdf_doc_missing"');
    // Y debe estar dentro de un branch else (cuando docUrl es falsy).
    expect(HANDLER_SRC).toMatch(/} else \{[\s\S]*missingDocTypes\.push/);
  });

  it("Test 6: handler notifica al cliente cuando hay docs missing y sentCount>0", () => {
    expect(HANDLER_SRC).toContain("missingDocTypes.length > 0");
    expect(HANDLER_SRC).toContain("lo coordino con Enmanuel");
  });
});
