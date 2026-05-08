// Hotfix-22 V3 r4 — Tests del fix de bug latente R1 + warning threshold.
//
// HALLAZGO BRUTAL R4: el log claude_ratelimit_status de R1 nunca
// disparaba en producción porque el SDK Anthropic NO expone
// response.headers en respuestas exitosas. R4 cambia a usar
// .withResponse() para acceder a Headers HTTP estándar.
//
// COBERTURA (3 tests):
//   1. claude_ratelimit_status DISPARA en respuesta exitosa via
//      withResponse() (FIX del bug R1).
//   2. claude_ratelimit_warning DISPARA cuando remaining bajo
//      threshold (default 5000, replace pre-flight).
//   3. CLAUDE_RATELIMIT_WARN_THRESHOLD env var con range guard
//      (rango válido 0-30000, fuera cae a default + warn log).

import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// Mock botLog
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

// Mock @anthropic-ai/sdk con headers configurables por test.
let nextHeadersData = null;
let nextResponse = null;
const constructorCalls = [];

class MockAnthropic {
  constructor(opts) {
    constructorCalls.push(opts);
    this.opts = opts;
    this.messages = {
      create: (_params) => {
        const promise = Promise.resolve(nextResponse);
        promise.withResponse = () => promise.then((data) => ({
          data,
          response: {
            // Simular Headers HTTP estándar con .get(name).
            headers: {
              get: (name) => nextHeadersData ? (nextHeadersData[name] || null) : null,
            },
          },
        }));
        return promise;
      },
    };
  }
}

{
  const id = require.resolve("@anthropic-ai/sdk");
  require.cache[id] = { id, filename: id, loaded: true, exports: MockAnthropic };
}

// Limpiar env antes de cargar el modulo.
delete process.env.CLAUDE_RATELIMIT_WARN_THRESHOLD;

const { callClaudeWithTools } = require("../src/claude");
const { readFileSync } = require("fs");
const SRC = readFileSync("src/claude.js", "utf-8");

describe("Hotfix-22 V3 r4 — claude_ratelimit headers fix", () => {
  beforeEach(() => {
    botLogCalls.length = 0;
    constructorCalls.length = 0;
    nextHeadersData = null;
    nextResponse = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 100, output_tokens: 20 },
    };
  });

  it("Test 1: claude_ratelimit_status dispara via withResponse() (FIX bug R1)", async () => {
    nextHeadersData = {
      "anthropic-ratelimit-input-tokens-remaining": "29500",
      "anthropic-ratelimit-input-tokens-reset": "2026-05-08T15:31:00Z",
      "anthropic-ratelimit-requests-remaining": "48",
      "anthropic-ratelimit-requests-reset": "2026-05-08T15:31:00Z",
    };

    await callClaudeWithTools({
      system: "test",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      phone: "1112223333",
      toolHandlers: {},
    });

    const statusLog = botLogCalls.find((c) => c.message === "claude_ratelimit_status");
    expect(statusLog, "claude_ratelimit_status DEBE disparar (R1 nunca lo hizo)").toBeDefined();
    expect(statusLog.level).toBe("info");
    expect(statusLog.data.input_tokens_remaining).toBe("29500");
    expect(statusLog.data.input_tokens_reset).toBe("2026-05-08T15:31:00Z");
    expect(statusLog.data.requests_remaining).toBe("48");
    expect(statusLog.data.requests_reset).toBe("2026-05-08T15:31:00Z");
    expect(statusLog.data.phone).toBe("1112223333");
  });

  it("Test 2: claude_ratelimit_warning dispara cuando remaining < threshold (default 5000)", async () => {
    nextHeadersData = {
      "anthropic-ratelimit-input-tokens-remaining": "3500",
      "anthropic-ratelimit-input-tokens-reset": "2026-05-08T15:31:00Z",
      "anthropic-ratelimit-requests-remaining": "20",
    };

    await callClaudeWithTools({
      system: "test",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      phone: "4445556666",
      toolHandlers: {},
    });

    // Status sigue disparando.
    const statusLog = botLogCalls.find((c) => c.message === "claude_ratelimit_status");
    expect(statusLog).toBeDefined();
    // Warning DEBE disparar porque 3500 < 5000.
    const warnLog = botLogCalls.find((c) => c.message === "claude_ratelimit_warning");
    expect(warnLog, "claude_ratelimit_warning DEBE disparar cuando remaining < threshold").toBeDefined();
    expect(warnLog.level).toBe("warn");
    expect(warnLog.data.input_tokens_remaining).toBe(3500);
    expect(warnLog.data.threshold).toBe(5000);
    expect(warnLog.data.phone).toBe("4445556666");
  });

  it("Test 3: source-inspection — CLAUDE_RATELIMIT_WARN_THRESHOLD env var + range guard 0-30000", () => {
    // Env var declarada con default + range guard estilo R1 maxRetries.
    expect(SRC).toMatch(/DEFAULT_RATELIMIT_WARN_THRESHOLD\s*=\s*5000/);
    expect(SRC).toMatch(/process\.env\.CLAUDE_RATELIMIT_WARN_THRESHOLD/);
    // Range check defensivo: 0-30000.
    expect(SRC).toMatch(/parsed\s*<\s*0\s*\|\|\s*parsed\s*>\s*30000/);
    // Header documenta historia + razon (R4 fix bug R1). Convención del
    // proyecto: comments header usan "HOTFIX-22" all-caps.
    const header = SRC.slice(0, SRC.indexOf("function getAnthropic"));
    expect(header.toLowerCase()).toContain("hotfix-22 v3 r4");
    expect(header.toLowerCase()).toContain("withresponse");
    expect(header).toContain("CLAUDE_RATELIMIT_WARN_THRESHOLD");
    // claude_config logea el threshold para auditoria al boot.
    expect(SRC).toMatch(/ratelimit_warn_threshold:\s*RATELIMIT_WARN_THRESHOLD/);
  });
});
