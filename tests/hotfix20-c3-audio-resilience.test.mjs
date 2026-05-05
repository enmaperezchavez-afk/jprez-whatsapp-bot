// Hotfix-20 Commit 3 — Bug #1 audio cortos persistentes.
//
// Smoke real: audios de 3-4 segundos siguen recibiendo "no te capte" pese
// al threshold relajado de Hotfix-19. Causa raiz desconocida — sin log de
// que devuelve Whisper, no podiamos diagnosticar entre (a) "" silenciado,
// (b) hallucination tipo "Subtitulos por Amara.org" filtrada por longitud,
// (c) error transitorio de Whisper. Director autorizo:
//   - log audio_transcribe_raw_result (200 chars) pre-threshold
//   - retry 1 vez si null/empty
//   - prompt "audio en espanol" hint
//   - timeout 30s por intento
//   - threshold < 2 SE MANTIENE (no introducir mas ruido)

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// Aislar log via require.cache patching (mirror del patron hotfix19-c1).
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

// ===== Mock helper para fetch sequencial con captura de FormData =====

function setupFetch(audioId, whisperResponses) {
  const calls = { meta: 0, audio: 0, whisper: 0, whisperBodies: [] };
  globalThis.fetch = async (url, init) => {
    if (typeof url === "string" && url.includes("graph.facebook.com") && url.endsWith(audioId)) {
      calls.meta++;
      return {
        ok: true,
        async text() { return ""; },
        async json() {
          return { url: "https://meta-media.fake/audio-" + audioId + ".ogg", mime_type: "audio/ogg" };
        },
      };
    }
    if (typeof url === "string" && url.includes("meta-media.fake")) {
      calls.audio++;
      return {
        ok: true,
        async text() { return ""; },
        async arrayBuffer() { return new ArrayBuffer(64); },
      };
    }
    if (typeof url === "string" && url.includes("api.openai.com")) {
      calls.whisper++;
      // Capturar campos del FormData para verificar prompt + language.
      if (init && init.body && typeof init.body.entries === "function") {
        const fields = {};
        for (const [k, v] of init.body.entries()) {
          fields[k] = typeof v === "string" ? v : `[Blob ${v.size || "?"} bytes]`;
        }
        calls.whisperBodies.push(fields);
      }
      const resp = whisperResponses.shift();
      if (!resp) throw new Error("Whisper called more times than mocked. calls.whisper=" + calls.whisper);
      return resp;
    }
    throw new Error("Unmocked fetch URL: " + url);
  };
  return calls;
}

function whisperOk(text) {
  return {
    ok: true,
    async text() { return ""; },
    async json() { return { text }; },
  };
}

function whisperHttpError(status, body) {
  return {
    ok: false,
    status,
    async text() { return body || ""; },
    async json() { return {}; },
  };
}

// ===== Tests =====

describe("Hotfix-20 c3 — Audio retry + raw log + Whisper prompt", () => {
  let savedFetch;

  beforeEach(() => {
    botLogCalls.length = 0;
    process.env.OPENAI_API_KEY = "fake-openai-key";
    process.env.WHATSAPP_TOKEN = "fake-wa-token";
    savedFetch = globalThis.fetch;
  });

  it("Test 1: Whisper devuelve texto valido en primer intento → no retry, raw_result logged attempt=1", async () => {
    const calls = setupFetch("aud-c3-1", [whisperOk("  hola mateo, como estas  ")]);
    try {
      const result = await transcribeWhatsAppAudio("aud-c3-1");
      expect(result).toBe("hola mateo, como estas");
      expect(calls.whisper).toBe(1);

      const raw = botLogCalls.find((c) => c.message === "audio_transcribe_raw_result");
      expect(raw).toBeDefined();
      expect(raw.data.attemptNum).toBe(1);
      expect(raw.data.rawText).toBe("hola mateo, como estas");
      expect(raw.data.rawLength).toBe("hola mateo, como estas".length);

      // No retry log porque primer intento fue exitoso.
      expect(botLogCalls.find((c) => c.message === "audio_transcribe_retry")).toBeUndefined();
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("Test 2: Whisper devuelve '' primero → retry → texto valido segundo → returns texto del retry", async () => {
    const calls = setupFetch("aud-c3-2", [whisperOk(""), whisperOk("ok dale gracias")]);
    try {
      const result = await transcribeWhatsAppAudio("aud-c3-2");
      expect(result).toBe("ok dale gracias");
      expect(calls.whisper).toBe(2);

      // Retry log emitido con razon.
      const retry = botLogCalls.find((c) => c.message === "audio_transcribe_retry");
      expect(retry).toBeDefined();
      expect(retry.data.firstResult).toBe("empty");

      // Dos raw_result logged con attemptNum 1 y 2.
      const rawLogs = botLogCalls.filter((c) => c.message === "audio_transcribe_raw_result");
      expect(rawLogs).toHaveLength(2);
      expect(rawLogs[0].data.attemptNum).toBe(1);
      expect(rawLogs[0].data.rawLength).toBe(0);
      expect(rawLogs[1].data.attemptNum).toBe(2);
      expect(rawLogs[1].data.rawText).toBe("ok dale gracias");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("Test 3: Whisper devuelve '' en AMBOS intentos → returns '' (NO null), retry ejecutado", async () => {
    const calls = setupFetch("aud-c3-3", [whisperOk(""), whisperOk("")]);
    try {
      const result = await transcribeWhatsAppAudio("aud-c3-3");
      // Despues del retry, sigue ""; el handler aplicara threshold y mandara
      // fallback "no te capte". Distinto de null (que indicaria fallo total).
      expect(result).toBe("");
      expect(calls.whisper).toBe(2);

      const retry = botLogCalls.find((c) => c.message === "audio_transcribe_retry");
      expect(retry).toBeDefined();
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("Test 4: FormData incluye language='es' Y prompt='audio en español' en CADA intento", async () => {
    const calls = setupFetch("aud-c3-4", [whisperOk(""), whisperOk("hola")]);
    try {
      await transcribeWhatsAppAudio("aud-c3-4");
      expect(calls.whisperBodies).toHaveLength(2);
      // Ambos intentos deben llevar el hint de idioma + prompt.
      for (const body of calls.whisperBodies) {
        expect(body.language).toBe("es");
        expect(body.prompt).toBe("audio en español");
        expect(body.model).toBe("whisper-1");
      }
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("Test 5: HTTP error primero → retry → success → returns texto retry + whisper_failed loggeado para intento 1", async () => {
    const calls = setupFetch("aud-c3-5", [
      whisperHttpError(503, "service unavailable"),
      whisperOk("perfecto gracias"),
    ]);
    try {
      const result = await transcribeWhatsAppAudio("aud-c3-5");
      expect(result).toBe("perfecto gracias");
      expect(calls.whisper).toBe(2);

      // whisper_failed para intento 1 con attemptNum y status.
      const failed = botLogCalls.find((c) => c.message === "audio_transcribe_whisper_failed");
      expect(failed).toBeDefined();
      expect(failed.data.attemptNum).toBe(1);
      expect(failed.data.status).toBe(503);

      // Retry log con firstResult='null' (HTTP error → returnNull).
      const retry = botLogCalls.find((c) => c.message === "audio_transcribe_retry");
      expect(retry).toBeDefined();
      expect(retry.data.firstResult).toBe("null");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

describe("Hotfix-20 c3 — Source inspection: AbortController + timeout", () => {
  // El timeout via AbortController es dificil de testear con fetch mock simple
  // (requiere fetch que cuelgue indefinidamente y luego abort). Verificamos
  // staticamente que la implementacion contiene el patron correcto.
  const SRC = readFileSync("src/whatsapp.js", "utf-8");

  it("Test 6 (source): WHISPER_TIMEOUT_MS=30000 + AbortController + AbortError handling presentes", () => {
    expect(SRC).toContain("WHISPER_TIMEOUT_MS = 30000");
    expect(SRC).toContain("new AbortController()");
    expect(SRC).toContain("controller.abort()");
    expect(SRC).toContain('e.name === "AbortError"');
    expect(SRC).toContain("audio_transcribe_whisper_timeout");
  });
});
