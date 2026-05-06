// FASE 1 c1 — Prompt caching refactor + telemetria de cache.
//
// Objetivo: separar el system prompt en bloque estatico (cacheable) y
// dinamico (fecha + contextos por-cliente), pasar system como array de
// bloques con cache_control: ephemeral en el estatico, y extender el log
// claude_response con cache_creation_input_tokens / cache_read_input_tokens.
//
// Cobertura (7 tests):
//   1. buildSystemPromptBlocks() retorna shape {staticBlock, dynamicHeader}
//   2. staticBlock contiene SKILL + INVENTORY + MATEO + GLOSSARY + STYLE
//   3. staticBlock NO contiene fechaHeader (regression guard — fecha solo
//      en dynamicHeader, sino la cache se invalidaria por minuto)
//   4. dynamicHeader incluye fecha ISO (regex YYYY-MM-DD)
//   5. Source-inspection: handler construye systemBlocks como array
//      de 2 bloques con cache_control ephemeral en el primer bloque
//      (cliente flow)
//   6. Source-inspection: supervisor flow usa 1 bloque sin cache_control
//   7. Behavioral: log claude_response incluye cache_creation_input_tokens
//      y cache_read_input_tokens cuando usage los reporta

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
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

const { buildSystemPromptBlocks, MATEO_PROMPT_V5_2 } = require("../src/prompts");
const { GLOSSARY_LAYER } = require("../src/prompts/glossary-layer");
const { STYLE_LAYER } = require("../src/prompts/style-layer");
const { callClaudeWithTools } = require("../src/claude");

const HANDLER_SRC = readFileSync("src/handlers/message.js", "utf-8");

// === Tests 1-4: buildSystemPromptBlocks shape + content ===

describe("FASE 1 c1 — buildSystemPromptBlocks() structure", () => {
  it("Test 1: retorna shape {staticBlock, dynamicHeader} (ambos strings)", () => {
    const blocks = buildSystemPromptBlocks();
    expect(blocks).toHaveProperty("staticBlock");
    expect(blocks).toHaveProperty("dynamicHeader");
    expect(typeof blocks.staticBlock).toBe("string");
    expect(typeof blocks.dynamicHeader).toBe("string");
    expect(blocks.staticBlock.length).toBeGreaterThan(0);
    expect(blocks.dynamicHeader.length).toBeGreaterThan(0);
  });

  it("Test 2: staticBlock contiene SKILL + INVENTORY + MATEO + GLOSSARY + STYLE", () => {
    const { staticBlock } = buildSystemPromptBlocks();
    // MATEO_PROMPT_V5_2 es la constante de identidad — busco un fragmento
    // suficientemente unico (primera linea del prompt) para anclar.
    const mateoFirstLine = MATEO_PROMPT_V5_2.split("\n")[0];
    expect(staticBlock).toContain(mateoFirstLine);
    // GLOSSARY y STYLE son layers composables — busco markers conocidos.
    expect(staticBlock).toContain(GLOSSARY_LAYER.split("\n")[0]);
    expect(staticBlock).toContain(STYLE_LAYER.split("\n")[0]);
    // INVENTARIO marker (label que precede a INVENTORY_CONTENT).
    expect(staticBlock).toContain("INVENTARIO Y PRECIOS DETALLADOS");
  });

  it("Test 3: staticBlock NO contiene fechaHeader (regression guard cache breakpoint)", () => {
    // Fecha movida a dynamicHeader. Si vuelve al static, la cache se
    // invalida cada minuto — caches efimeras inutiles.
    const { staticBlock } = buildSystemPromptBlocks();
    expect(staticBlock).not.toMatch(/Hoy es:\s*\d{4}-\d{2}-\d{2}/);
    expect(staticBlock).not.toContain("Hora actual:");
  });

  it("Test 4: dynamicHeader incluye fecha ISO (YYYY-MM-DD) y hora SD", () => {
    const { dynamicHeader } = buildSystemPromptBlocks();
    expect(dynamicHeader).toMatch(/Hoy es:\s*\d{4}-\d{2}-\d{2}/);
    expect(dynamicHeader).toContain("Hora actual:");
    expect(dynamicHeader).toContain("(Santo Domingo)");
  });
});

// === Tests 5-6: Source-inspection del handler ===

describe("FASE 1 c1 — handler systemBlocks construction (source)", () => {
  it("Test 5: cliente flow construye systemBlocks 2-bloques con cache_control ephemeral", () => {
    // Verifica que el handler:
    //   1) llama buildSystemPromptBlocks() (no buildSystemPrompt() viejo)
    //   2) construye un array de 2 elementos
    //   3) el primer bloque tiene cache_control: { type: "ephemeral" }
    //   4) pasa systemBlocks al callClaudeWithTools
    expect(HANDLER_SRC).toContain("buildSystemPromptBlocks()");
    expect(HANDLER_SRC).toContain('cache_control: { type: "ephemeral" }');
    expect(HANDLER_SRC).toMatch(/system:\s*systemBlocks/);
    // Estructura: 2 elementos, staticBlock primero (con cache), dynamicHeader+contextos despues.
    expect(HANDLER_SRC).toMatch(/text:\s*staticBlock,\s*cache_control/);
    expect(HANDLER_SRC).toMatch(/text:\s*dynamicHeader\s*\+\s*clientContext\s*\+\s*profileContext\s*\+\s*holdingContext/);
  });

  it("Test 6: supervisor flow usa 1 bloque sin cache_control", () => {
    // Volumen supervisor es bajo (solo Director), no justifica cache.
    // Patron en source: if (isSupervisor) { systemBlocks = [{ type: "text", text: SUPERVISOR_PROMPT }]; }
    expect(HANDLER_SRC).toMatch(/if\s*\(\s*isSupervisor\s*\)\s*\{\s*systemBlocks\s*=\s*\[\s*\{\s*type:\s*"text",\s*text:\s*SUPERVISOR_PROMPT\s*\}\s*\]/);
  });
});

// === Test 7: Behavioral — claude_response loguea cache tokens ===

describe("FASE 1 c1 — claude_response log incluye cache tokens", () => {
  beforeEach(() => {
    createCalls.length = 0;
    nextResponses.length = 0;
    botLogCalls.length = 0;
  });

  it("Test 7: cache_creation_input_tokens y cache_read_input_tokens propagados a Axiom", async () => {
    // Mock: usage reporta cache hit (cache_read > 0, cache_creation = 0).
    nextResponses.push({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: 50,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 4500,
      },
    });

    await callClaudeWithTools({
      system: [{ type: "text", text: "static", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hola" }],
      tools: [],
      phone: "1234567890",
      toolHandlers: {},
    });

    const log = botLogCalls.find((c) => c.message === "claude_response");
    expect(log).toBeDefined();
    expect(log.data.cache_creation_input_tokens).toBe(0);
    expect(log.data.cache_read_input_tokens).toBe(4500);
    // Sanity: campos legacy de Hotfix-20B siguen presentes.
    expect(log.data.input_tokens).toBe(50);
    expect(log.data.output_tokens).toBe(5);
    expect(log.data.stop_reason).toBe("end_turn");
    expect(log.data.iteration).toBe(0);
    expect(log.data.phone).toBe("1234567890");
  });
});
