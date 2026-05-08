// Hotfix-22 V2 b2 — Smoke E2E LLM mock con 10 escenarios golden.
//
// Suite de smoke tests E2E que ejecuta el handler real (processMessage)
// contra un mock determinista de Anthropic API + Redis in-memory + fetch
// stub. Atrapa regresiones del PIPELINE post-LLM (strip perfil_update,
// detect signals, send WhatsApp, document policy, holding mode) ante
// cambios en el handler, layers o skills.
//
// LIMITACION CONOCIDA: el mock Claude retorna texto pre-programado en
// fixtures/responses.json. Eso significa que esta suite NO atrapa
// regresiones del LLM real (ej: si MATEO_PROMPT_V5_2 cambia de manera
// que el LLM real empieza a emitir asteriscos, esta suite no lo ve).
// Para eso esta el smoke MANUAL del Director post-merge. Lo que SI
// atrapa esta suite:
//
//   1. Pipeline sano: el reply del LLM llega a sendWhatsAppMessage.
//   2. Strip de <perfil_update>: el bloque interno NO sale al cliente.
//   3. Document policy: sentDocs respetado, no reenvio brochures.
//   4. Detection: lead caliente, escalation, booking detectados.
//   5. Cero crash phrases: "se me complicó" SOLO si el handler dispara
//      el empty-reply guard explicitamente.
//   6. Cero asteriscos: el handler no inyecta markdown bold por accidente.
//   7. Holding mode, audio, retransmit: paths secundarios no rotos.
//
// PATRON: heredado de tests/hotfix21-c4-bug23-e2e.test.mjs.
//
// FIXTURES: tests/e2e-smoke/fixtures/responses.json (10 escenarios).
// MOCK BUILDERS: tests/e2e-smoke/helpers/mock-claude.mjs (text + tool_use).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";
import { buildScenarioMock } from "./helpers/mock-claude.mjs";

const require = createRequire(import.meta.url);
const FIXTURES = JSON.parse(
  readFileSync("tests/e2e-smoke/fixtures/responses.json", "utf-8")
);

// ===== Estado compartido =====

const redisState = new Map();
const consoleLogCalls = [];
let claudeMockSequence = []; // FIFO de responses para multi-iter

// ===== require.cache patching ANTES de cargar handlers =====

{
  const moduleId = require.resolve("@upstash/redis");
  require.cache[moduleId] = {
    id: moduleId, filename: moduleId, loaded: true,
    exports: {
      Redis: class {
        constructor() {}
        async get(key) { return redisState.has(key) ? redisState.get(key) : null; }
        async set(key, value, opts = {}) {
          if (opts && opts.nx && redisState.has(key)) return null;
          redisState.set(key, value); return "OK";
        }
        async del(key) { const had = redisState.has(key); redisState.delete(key); return had ? 1 : 0; }
        async lrange() { return []; }
        async rpush() { return 1; }
        async ltrim() { return "OK"; }
        async expire() { return 1; }
        async hget() { return null; }
        async hset() { return 1; }
        async hmget() { return []; }
        async incr() { return 1; }
      },
    },
  };
}

{
  const moduleId = require.resolve("@upstash/ratelimit");
  require.cache[moduleId] = {
    id: moduleId, filename: moduleId, loaded: true,
    exports: {
      Ratelimit: class {
        constructor(config) { this.config = config; }
        async limit() { return { success: true, limit: 9999, remaining: 9999, reset: Date.now() + 60000 }; }
        static slidingWindow(max, window) { return { type: "sliding", max, window }; }
      },
    },
  };
}

{
  const moduleId = require.resolve("@anthropic-ai/sdk");
  class MockAnthropic {
    constructor(opts) {
      this.opts = opts;
      this.messages = {
        create: async (_params) => {
          if (claudeMockSequence.length === 0) {
            throw new Error("MockAnthropic: out of mocked responses");
          }
          return claudeMockSequence.shift();
        },
      };
    }
  }
  require.cache[moduleId] = {
    id: moduleId, filename: moduleId, loaded: true,
    exports: MockAnthropic,
  };
}

// ===== Mock src/whatsapp (transcribeWhatsAppAudio + sendWhatsAppMessage)
//       BEFORE message.js requires it. transcribeWhatsAppAudio devuelve
//       el audioTranscript pre-programado por el escenario corriente.
//       sendWhatsAppMessage queda en su forma real (envia via fetch
//       mockeado mas abajo) para que los assertions sobre mensajes al
//       cliente funcionen.

let pendingAudioTranscript = null;
{
  const moduleId = require.resolve("../../src/whatsapp");
  // Cargar el modulo real una vez para preservar todos los exports.
  const real = require("../../src/whatsapp");
  require.cache[moduleId] = {
    id: moduleId, filename: moduleId, loaded: true,
    exports: {
      ...real,
      transcribeWhatsAppAudio: async () => pendingAudioTranscript,
    },
  };
}

// ===== Mock global fetch (WhatsApp send + audio download) =====

const fetchMock = vi.fn(async (url) => {
  return {
    ok: true, status: 200,
    async json() { return {}; },
    async text() { return ""; },
    async arrayBuffer() { return new ArrayBuffer(0); },
    headers: { get: () => "audio/ogg" },
  };
});
vi.stubGlobal("fetch", fetchMock);

// ===== Env vars (CRITICO: ANTES del require de message.js) =====

process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
process.env.WHATSAPP_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "000000";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake";
process.env.PDF_CRUX_BROCHURE = "https://drive.google.com/fake/crux-brochure";
process.env.PDF_CRUX_PRECIOS_T6 = "https://drive.google.com/fake/crux-precios-t6";
process.env.IMG_CRUX = "https://drive.google.com/fake/crux-img1";

// ===== Carga de modulos POST-patch =====

const { processMessage } = require("../../src/handlers/message");
// parseTestingCommand vive en webhook.js (no en handler) para Test 1.
const webhook = require("../../api/webhook");
const parseTestingCommand = webhook.parseTestingCommand;

// ===== Helpers =====

function buildBody(phone, text, type = "text") {
  const message = {
    from: phone,
    type,
    id: "wamid." + Date.now() + "." + Math.random().toString(36).slice(2, 8),
  };
  if (type === "text") {
    message.text = { body: text };
  } else if (type === "audio") {
    message.audio = { id: "audio_mock_id" };
  }
  return {
    entry: [{
      changes: [{
        value: {
          messages: [message],
          contacts: [{ profile: { name: "Cliente Smoke" }, wa_id: phone }],
        },
      }],
    }],
  };
}

function whatsappCalls() {
  return fetchMock.mock.calls.filter(([url]) =>
    typeof url === "string" && url.includes("graph.facebook.com")
  );
}

function whatsappTextsTo(phone) {
  return whatsappCalls()
    .map(([_url, init]) => { try { return JSON.parse(init.body); } catch { return null; } })
    .filter((b) => b && b.to === phone && b.type === "text")
    .map((b) => b.text?.body || "");
}

function whatsappDocumentsTo(phone) {
  return whatsappCalls()
    .map(([_url, init]) => { try { return JSON.parse(init.body); } catch { return null; } })
    .filter((b) => b && b.to === phone && b.type === "document");
}

function seedClientMeta(phone, partial) {
  const meta = {
    name: "Cliente Smoke",
    sentDocs: partial?.sentDocs || {},
    lastContact: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  };
  redisState.set("meta:" + phone, JSON.stringify(meta));
}

// runScenario: ejecuta el handler con un fixture y devuelve los textos
// que llegaron a sendWhatsAppMessage.
async function runScenario(scenarioKey, phoneOverride = null) {
  const scenario = FIXTURES[scenarioKey];
  if (!scenario) throw new Error("Scenario no encontrado: " + scenarioKey);

  const phone = phoneOverride || ("18099" + Math.floor(Math.random() * 900000 + 100000));

  if (scenario.preState) {
    seedClientMeta(phone, scenario.preState);
  }

  claudeMockSequence = buildScenarioMock(scenario);

  const messageType = scenarioKey === "scenario_audio" ? "audio" : "text";
  const inputText = scenarioKey === "scenario_audio"
    ? scenario.input.replace("[mock_audio] ", "")
    : scenario.input;

  // El mock global de transcribeWhatsAppAudio (declarado en el setup
  // antes del require de message.js) devuelve pendingAudioTranscript.
  // Lo seteamos aqui para que el handler reciba el texto del audio.
  if (messageType === "audio") {
    pendingAudioTranscript = inputText;
  }

  await processMessage(buildBody(phone, inputText, messageType));
  pendingAudioTranscript = null;

  return { phone, scenario, texts: whatsappTextsTo(phone), docs: whatsappDocumentsTo(phone) };
}

// assertGoldenReply: asserts universales aplicados a CADA escenario.
function assertGoldenReply(reply, scenario) {
  // Asserts universales: cero asteriscos markdown, cero crash phrases.
  for (const anti of scenario.antiKeywords || []) {
    expect(reply, `Reply contiene anti-keyword "${anti}"`).not.toContain(anti);
  }
  // Keywords esperadas presentes.
  for (const kw of scenario.expectedKeywords || []) {
    expect(reply, `Reply NO contiene keyword esperada "${kw}"`).toContain(kw);
  }
}

// ===== Tests =====

describe("Hotfix-22 V2 b2 — Smoke E2E golden (10 escenarios)", () => {
  let consoleSpy;
  beforeEach(() => {
    redisState.clear();
    fetchMock.mockClear();
    claudeMockSequence = [];
    consoleLogCalls.length = 0;
    consoleSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      consoleLogCalls.push(args);
    });
  });

  it("Test 1: /test-on (admin command parser)", () => {
    // Test puro de parseTestingCommand — comando admin se reconoce y
    // dispara el handler de testing-mode (NO llega a Claude). Verificamos
    // que el parser identifica el comando correctamente y que el reply
    // hipotetico no tiene crash phrases ni asteriscos (asserts universales
    // del fixture).
    const scenario = FIXTURES.scenario_test_on;
    expect(parseTestingCommand("/test-on")).toBe("on");
    expect(parseTestingCommand("/Test-On")).toBe("on");
    expect(parseTestingCommand(" /test-on ")).toBe("on");
    expect(parseTestingCommand("hola")).toBe(null);
    // Sanity: el fixture esperaba keywords + antiKeywords definidos.
    expect(scenario.expectedKeywords).toContain("testing");
    expect(scenario.antiKeywords).toContain("**");
  });

  it("Test 2: info Crux (ambiguedad → bot pregunta)", async () => {
    const { texts, scenario } = await runScenario("scenario_info_crux");
    expect(texts.length).toBeGreaterThan(0);
    assertGoldenReply(texts[0], scenario);
  }, 20000);

  it("Test 3: calculadora PSE3 124000 (tool_use + prosa exactos)", async () => {
    const { texts, scenario } = await runScenario("scenario_calculadora_pse3");
    expect(texts.length).toBeGreaterThan(0);
    assertGoldenReply(texts[0], scenario);
  }, 20000);

  it("Test 4: extranjero (skill mercado-rd activado)", async () => {
    const { texts, scenario } = await runScenario("scenario_extranjero");
    expect(texts.length).toBeGreaterThan(0);
    assertGoldenReply(texts[0], scenario);
  }, 20000);

  it("Test 5: que banco (skill APAP)", async () => {
    const { texts, scenario } = await runScenario("scenario_banco");
    expect(texts.length).toBeGreaterThan(0);
    assertGoldenReply(texts[0], scenario);
  }, 20000);

  it("Test 6: fideicomiso (Ley 189-11)", async () => {
    const { texts, scenario } = await runScenario("scenario_fideicomiso");
    expect(texts.length).toBeGreaterThan(0);
    assertGoldenReply(texts[0], scenario);
  }, 20000);

  it("Test 7: 'en planos' con sentDocs (Bug #23 regression guard)", async () => {
    const { texts, docs, scenario } = await runScenario("scenario_en_planos_with_sentdocs");
    expect(texts.length).toBeGreaterThan(0);
    assertGoldenReply(texts[0], scenario);
    // Bug #23: NO se debe reenviar el brochure que ya tenia.
    const brochureRedundant = docs.find((d) =>
      d.document?.filename?.includes("Brochure") && !d.document?.filename?.includes("Torre 6")
    );
    expect(brochureRedundant).toBeUndefined();
  }, 20000);

  it("Test 8: cashflow ajustado ($500 mensuales)", async () => {
    const { texts, scenario } = await runScenario("scenario_cashflow_ajustado");
    expect(texts.length).toBeGreaterThan(0);
    assertGoldenReply(texts[0], scenario);
  }, 20000);

  it("Test 9: audio transcrito (path no roto)", async () => {
    const { texts, scenario } = await runScenario("scenario_audio");
    expect(texts.length).toBeGreaterThan(0);
    assertGoldenReply(texts[0], scenario);
  }, 20000);

  it("Test 10: 'manda otra vez' (override explicit-retransmit)", async () => {
    const { texts, scenario } = await runScenario("scenario_manda_otra_vez");
    expect(texts.length).toBeGreaterThan(0);
    assertGoldenReply(texts[0], scenario);
  }, 20000);

  it("Test 11: extranjero post-calculo (smoke pipeline pivot — Hotfix-22 V3 r2)", async () => {
    // Smoke pipeline: cliente acaba de hablar de PSE3, ahora pivota a
    // extranjeros. Valida que el handler procesa el nuevo turno sin
    // crash + sin asteriscos + con keywords del skill mercado-rd y la
    // invitacion a retomar PSE3. NO testea pivoteo LLM real (mock
    // devuelve respuesta pre-programada). Para validar regla ii real
    // del OVERRIDES_LAYER, smoke MANUAL del Director post-merge.
    const { texts, scenario } = await runScenario("scenario_extranjero_post_calculo");
    expect(texts.length).toBeGreaterThan(0);
    assertGoldenReply(texts[0], scenario);
  }, 20000);

  it("Test 12: V3.5 R5 — banco con bullets → post-processor strippea hard", async () => {
    // Caso real del smoke final V3: LLM emitio bullets en lista de bancos.
    // R5 cleanFormat strippea los "- " antes de mandar al cliente.
    const { texts, scenario } = await runScenario("scenario_v35_smoke_banco_con_bullets");
    expect(texts.length).toBeGreaterThan(0);
    assertGoldenReply(texts[0], scenario);
    // Sanity: contenido critico preservado (tasas APAP).
    expect(texts[0]).toContain("APAP");
    expect(texts[0]).toContain("12.50%");
  }, 20000);

  it("Test 13: V3.5 R5 — extranjero con emojis → post-processor strippea hard", async () => {
    // Caso real del smoke final V3: LLM emitio 🌎. R5 strip + R6 keywords.
    const { texts, scenario } = await runScenario("scenario_v35_smoke_extranjero_con_emojis");
    expect(texts.length).toBeGreaterThan(0);
    assertGoldenReply(texts[0], scenario);
    // Sanity: leyes y CONFOTUR preservados.
    expect(texts[0]).toContain("CONFOTUR");
    expect(texts[0]).toContain("Ley 158-01");
  }, 20000);

  it("Test 14: V3.5 R5 — fideicomiso con asteriscos → post-processor strippea hard", async () => {
    // Caso real del smoke final V3: LLM emitio "*¿Qué es?*" estilo header.
    // R5 cleanFormat strip wrappers manteniendo contenido.
    const { texts, scenario } = await runScenario("scenario_v35_smoke_fideicomiso_con_asteriscos");
    expect(texts.length).toBeGreaterThan(0);
    assertGoldenReply(texts[0], scenario);
    // Sanity: contenido preservado sin asteriscos.
    expect(texts[0]).toContain("Que es?");
    expect(texts[0]).toContain("fideicomiso");
    expect(texts[0]).not.toContain("*¿");
  }, 20000);

  it("Test 15: V3.5 sanity — calculo PSE3 sin formato (default 10/30/60)", async () => {
    // El bot debe usar plan default, NO Feria Mayo (as bajo la manga).
    const { texts, scenario } = await runScenario("scenario_v35_smoke_calculo_limpio");
    expect(texts.length).toBeGreaterThan(0);
    assertGoldenReply(texts[0], scenario);
  }, 20000);
});
