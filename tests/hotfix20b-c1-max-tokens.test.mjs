// Hotfix-20B Commit 1 — Bug #14 max_tokens (actualizado por Hotfix-22 V2 c1).
//
// Smoke test revelo que max_tokens=500 era insuficiente cuando la iter
// final post-tool-use debe emitir <perfil_update> + tags + reply en una
// sola respuesta (suma realista 400-1100 tokens). Cuando el cap cortaba
// mid-respuesta justo despues del bloque perfil_update, cleanedText
// quedaba vacio, empty-reply guard disparaba "se me complico". Bug #14
// del audit HIGH risk se manifesto en produccion.
//
// HOTFIX-22 V2 c1 (7 mayo 2026): Bug regreso post-PR #30 al sumar el
// skill mercado-inmobiliario-rd 22.5KB. El prompt creció ~25-30%, los
// outputs tendian a truncarse de nuevo. Cap subido de 2048 -> 4096 da
// margen 2x. Estos tests fueron actualizados para reflejar el nuevo
// valor preservando la intencion original (anti-pattern 500 + behavioral
// SDK capture + stop_reason logging).
//
// Cobertura:
//   1-3. Source-inspection (max_tokens 4096, regresion guard 500/2048
//        ausentes en codigo activo, header comment con "Hotfix-22 V2"
//        + "4096" + "Bug #14").
//   4. Behavioral: max_tokens=4096 LLEGA al API en cada llamada (mock
//      @anthropic-ai/sdk capturando args).
//   5. Behavioral: stop_reason loggeado por iteracion, incluso multi-tool.

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// === Mock botLog (require.cache patch — patron hotfix19-c1-audio) ===
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
// El SDK exporta una clase que se instancia con `new Anthropic({apiKey})`.
// Nuestro mock captura todos los args de messages.create() y devuelve
// respuestas pre-encoladas (FIFO).
const createCalls = [];
const nextResponses = [];

class MockAnthropic {
  constructor(opts) {
    this.opts = opts;
    this.messages = {
      create: async (args) => {
        createCalls.push(args);
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

const { callClaudeWithTools } = require("../src/claude");
const SRC = readFileSync("src/claude.js", "utf-8");

// === Source-inspection tests ===

describe("Hotfix-22 V2 c1 + c3 — Source: max_tokens via env var with 4096 default", () => {
  it("Test 1: API call usa la constante MAX_TOKENS (no literal hardcoded)", () => {
    // Hotfix-22 V2 c3: el literal `max_tokens: 4096` se reemplazo por
    // referencia a constante MAX_TOKENS que parsea CLAUDE_MAX_TOKENS env
    // var con default 4096. Source-inspection adaptada: buscamos el
    // patron del .create con la constante referenciada.
    expect(SRC).toMatch(/max_tokens:\s*MAX_TOKENS/);
    // El default sigue siendo 4096 (cero env var = mismo comportamiento).
    expect(SRC).toMatch(/DEFAULT_MAX_TOKENS\s*=\s*4096/);
  });

  it("Test 2: regresion guard — max_tokens 500 y 2048 ya no existen en codigo activo", () => {
    // Permitimos mencion en comments historicos (ej. "pre-fix era 2048"),
    // pero NO en codigo activo. Buscamos la forma del literal en config
    // de API o en defaults.
    expect(SRC).not.toMatch(/^\s*max_tokens:\s*500\s*,/m);
    expect(SRC).not.toMatch(/^\s*max_tokens:\s*2048\s*,/m);
    expect(SRC).not.toMatch(/DEFAULT_MAX_TOKENS\s*=\s*500/);
    expect(SRC).not.toMatch(/DEFAULT_MAX_TOKENS\s*=\s*2048/);
  });

  it("Test 3: header comment refleja Hotfix-22 V2 + nuevo valor 4096 + env var + Bug #14 historia", () => {
    // Las primeras lineas (header) deben mencionar la causa raiz para
    // auditoria futura — alguien que llegue a este archivo entiende el
    // "por que" sin tener que ir al PR.
    const header = SRC.slice(0, SRC.indexOf("function getAnthropic"));
    expect(header).toContain("4096");
    expect(header).toContain("Hotfix-22 V2");
    expect(header).toContain("Bug #14");
    // C3: env var CLAUDE_MAX_TOKENS documentada en header.
    expect(header).toContain("CLAUDE_MAX_TOKENS");
  });
});

// === Behavioral tests con SDK mockeado ===

describe("Hotfix-22 V2 c1 — Behavioral: SDK capture args + log stop_reason", () => {
  beforeEach(() => {
    createCalls.length = 0;
    nextResponses.length = 0;
    botLogCalls.length = 0;
  });

  it("Test 4: max_tokens=4096 LLEGA al API en cada llamada (no solo en source)", async () => {
    nextResponses.push({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "respuesta corta de prueba" }],
      usage: { input_tokens: 100, output_tokens: 5 },
    });

    await callClaudeWithTools({
      system: "test prompt",
      messages: [{ role: "user", content: "hola" }],
      tools: [],
      phone: "1234567890",
      toolHandlers: {},
    });

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].max_tokens).toBe(4096);
    // Sanity: otros params siguen llegando intactos.
    expect(createCalls[0].model).toBe("claude-sonnet-4-6");
    expect(createCalls[0].system).toBe("test prompt");
  });

  it("Test 5: stop_reason loggeado por iteracion (incluso multi-iter con tool)", async () => {
    // Iter 0: tool_use → continua loop
    nextResponses.push({
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "tu_1", name: "fake_tool", input: { x: 1 } },
      ],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    // Iter 1: end_turn → break
    nextResponses.push({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "respuesta final" }],
      usage: { input_tokens: 200, output_tokens: 30 },
    });

    await callClaudeWithTools({
      system: "test",
      messages: [{ role: "user", content: "calcula" }],
      tools: [{ name: "fake_tool", description: "fake", input_schema: { type: "object" } }],
      phone: "9876543210",
      toolHandlers: {
        fake_tool: () => ({ result: "ok" }),
      },
    });

    // Filtrar solo los logs nuevos de claude_response (excluye "Tool use" log).
    const claudeLogs = botLogCalls.filter((c) => c.message === "claude_response");
    expect(claudeLogs).toHaveLength(2);

    // Iteracion 0 — tool_use.
    expect(claudeLogs[0].data.iteration).toBe(0);
    expect(claudeLogs[0].data.stop_reason).toBe("tool_use");
    expect(claudeLogs[0].data.input_tokens).toBe(100);
    expect(claudeLogs[0].data.output_tokens).toBe(50);
    expect(claudeLogs[0].data.phone).toBe("9876543210");

    // Iteracion 1 — end_turn.
    expect(claudeLogs[1].data.iteration).toBe(1);
    expect(claudeLogs[1].data.stop_reason).toBe("end_turn");
    expect(claudeLogs[1].data.input_tokens).toBe(200);
    expect(claudeLogs[1].data.output_tokens).toBe(30);

    // Sanity: ambas llamadas usaron max_tokens=4096.
    expect(createCalls).toHaveLength(2);
    expect(createCalls.every((c) => c.max_tokens === 4096)).toBe(true);
  });
});
