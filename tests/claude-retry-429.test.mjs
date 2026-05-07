// Hotfix-22 V3 r1 — Retry 429/529 header-aware (Bug #28).
//
// Smoke post-PR #31 detecto que el segundo turno conversacional disparaba
// "se me complico". Root cause: staticBlock 131K chars saturaba el rate
// limit Anthropic Tier 1 (30K tokens/min). API devolvia 429 sin retry.
//
// SDK Anthropic ya implementa retry header-aware (parsea retry-after-ms +
// retry-after, cap implicito 60s, fallback exponential backoff). Default
// maxRetries=2. Subimos a 3 para cubrir picos transitorios.
//
// Cobertura (4 tests):
//   1. maxRetries=3 LLEGA al cliente Anthropic al instanciar.
//   2. CLAUDE_MAX_RETRIES env var override (range check + valid path).
//   3. Si SDK propaga error tras retries exhausted, wrapper logea
//      "claude_retry_exhausted" con status + headers + propaga error.
//   4. Headers de rate limit en response exitosa se loggean a Axiom
//      ("claude_ratelimit_status") cuando el SDK los expone.

import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// === Mock botLog (require.cache patch) ===
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

// === Mock @anthropic-ai/sdk ===
// MockAnthropic captura el config (incluyendo maxRetries) y permite
// programar responses + errores en sucesion.
const constructorCalls = [];
const createCalls = [];
const nextResponses = [];
const nextErrors = [];

class MockAnthropic {
  constructor(opts) {
    constructorCalls.push(opts);
    this.opts = opts;
    this.messages = {
      create: async (args) => {
        createCalls.push(args);
        // FIFO: si hay error pendiente, lanzar; si no, retornar response.
        if (nextErrors.length > 0) {
          throw nextErrors.shift();
        }
        const resp = nextResponses.shift();
        if (!resp) {
          throw new Error("MockAnthropic: out of mocked responses (call #" + createCalls.length + ")");
        }
        return resp;
      },
    };
  }
}

{
  const id = require.resolve("@anthropic-ai/sdk");
  require.cache[id] = {
    id, filename: id, loaded: true,
    exports: MockAnthropic,
  };
}

// Limpiar env antes de cargar el modulo (test 2 lo restaura).
delete process.env.CLAUDE_MAX_RETRIES;

const { callClaudeWithTools } = require("../src/claude");
const { readFileSync } = require("fs");
const SRC = readFileSync("src/claude.js", "utf-8");

describe("Hotfix-22 V3 r1 — retry header-aware", () => {
  beforeEach(() => {
    constructorCalls.length = 0;
    createCalls.length = 0;
    nextResponses.length = 0;
    nextErrors.length = 0;
    botLogCalls.length = 0;
  });

  it("Test 1: maxRetries=3 (default) LLEGA al cliente Anthropic al instanciar", async () => {
    nextResponses.push({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 10, output_tokens: 2 },
    });

    await callClaudeWithTools({
      system: "test",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      phone: "1234567890",
      toolHandlers: {},
    });

    expect(constructorCalls.length).toBeGreaterThan(0);
    const anthropicConfig = constructorCalls[constructorCalls.length - 1];
    expect(anthropicConfig.maxRetries).toBe(3);
    // apiKey property se pasa al SDK (puede ser undefined en test env si
    // no esta seteado ANTHROPIC_API_KEY; lo importante es que la KEY
    // 'apiKey' este presente en el config para que el SDK la lea).
    expect("apiKey" in anthropicConfig).toBe(true);
  });

  it("Test 2: source-inspection — CLAUDE_MAX_RETRIES env var con default 3 + range guard", () => {
    // Hotfix-22 V3 r1: env var permite tunear sin redeploy. Default 3,
    // rango valido 0-5 (fuera de rango cae al default + warn log).
    expect(SRC).toMatch(/DEFAULT_MAX_RETRIES\s*=\s*3/);
    expect(SRC).toMatch(/process\.env\.CLAUDE_MAX_RETRIES/);
    expect(SRC).toMatch(/maxRetries:\s*MAX_RETRIES/);
    // Range check defensive.
    expect(SRC).toMatch(/parsed\s*<\s*0\s*\|\|\s*parsed\s*>\s*5/);
    // Header documenta historia + razon (case-insensitive: el comment
    // header usa "HOTFIX-22" all-caps por convencion del proyecto).
    const header = SRC.slice(0, SRC.indexOf("function getAnthropic"));
    expect(header.toLowerCase()).toContain("hotfix-22 v3 r1");
    expect(header).toContain("rate limit");
    expect(header).toContain("CLAUDE_MAX_RETRIES");
  });

  it("Test 3: si SDK propaga error tras retries exhausted, log claude_retry_exhausted + propaga", async () => {
    // Simular RateLimitError-like que el SDK propaga tras agotar retries.
    // En la realidad el SDK reintentaria 3 veces internamente y luego
    // throw. Aqui mockeamos el throw final directamente.
    const fakeError = new Error("rate_limit_exceeded after 3 retries");
    fakeError.status = 429;
    fakeError.headers = {
      "retry-after-ms": "5000",
      "retry-after": "5",
      "anthropic-ratelimit-input-tokens-remaining": "0",
      "anthropic-ratelimit-input-tokens-reset": "2026-05-07T18:30:00Z",
      "anthropic-ratelimit-requests-remaining": "10",
    };
    nextErrors.push(fakeError);

    let caught = null;
    try {
      await callClaudeWithTools({
        system: "test",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        phone: "5556667777",
        toolHandlers: {},
      });
    } catch (e) {
      caught = e;
    }

    // Error propagado al caller (no swallowed).
    expect(caught).toBeDefined();
    expect(caught).toBe(fakeError);

    // Log claude_retry_exhausted con context de rate limit.
    const exhaustedLog = botLogCalls.find((c) => c.message === "claude_retry_exhausted");
    expect(exhaustedLog).toBeDefined();
    expect(exhaustedLog.level).toBe("error");
    expect(exhaustedLog.data.status).toBe(429);
    expect(exhaustedLog.data.phone).toBe("5556667777");
    expect(exhaustedLog.data.retry_after_ms).toBe("5000");
    expect(exhaustedLog.data.retry_after).toBe("5");
    expect(exhaustedLog.data.ratelimit_input_tokens_remaining).toBe("0");
    expect(exhaustedLog.data.max_retries_configured).toBe(3);
  });

  it("Test 4: headers de rate limit en response exitosa se loggean (claude_ratelimit_status)", async () => {
    // Anthropic SDK devuelve los headers en response.headers cuando estan
    // disponibles. Mockeamos una response con headers de rate limit.
    nextResponses.push({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 100, output_tokens: 20 },
      headers: {
        "anthropic-ratelimit-input-tokens-remaining": "12500",
        "anthropic-ratelimit-input-tokens-reset": "2026-05-07T18:31:00Z",
        "anthropic-ratelimit-requests-remaining": "48",
      },
    });

    await callClaudeWithTools({
      system: "test",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      phone: "9998887777",
      toolHandlers: {},
    });

    const rateLog = botLogCalls.find((c) => c.message === "claude_ratelimit_status");
    expect(rateLog).toBeDefined();
    expect(rateLog.level).toBe("info");
    expect(rateLog.data.input_tokens_remaining).toBe("12500");
    expect(rateLog.data.input_tokens_reset).toBe("2026-05-07T18:31:00Z");
    expect(rateLog.data.requests_remaining).toBe("48");
  });
});
