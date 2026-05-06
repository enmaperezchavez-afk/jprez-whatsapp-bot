// Hotfix-21 c3 — COMMERCIAL_LAYER + jerga RD + Crux 2-stage + recurring.
//
// Capa de inteligencia comercial composable. Resuelve Bug #23 a nivel de
// razonamiento: el bot interpreta jerga ("en planos" = construccion),
// diferencia Crux Listos vs Torre 6, reconoce contexto previo, y avanza
// la conversacion con valor nuevo en cada turno.
//
// Ademas:
//   - Slot PROJECT_DOCS.crux.preciosT6 + dispatcher rama Crux T6
//   - detectCruxStage(botReply, userMessage) → "T6"|"Listos"|null
//   - Re-export detectIntentRetransmit desde detect.js
//
// Cobertura (10 tests):
//   1. COMMERCIAL_LAYER exportado como string no vacio
//   2. COMMERCIAL_LAYER inyectado en buildSystemPromptBlocks().staticBlock
//      (entre GLOSSARY y STYLE — orden critico)
//   3. Regression guard: COMMERCIAL_LAYER NO contiene fechaHeader (cache OK)
//   4. COMMERCIAL_LAYER contiene markers Crux (Torre 6, Listos)
//   5. COMMERCIAL_LAYER contiene jerga RD + recurring buckets + avance comercial
//   6. detectCruxStage positivos T6 (frases varias con/sin tilde)
//   7. detectCruxStage positivos Listos
//   8. detectCruxStage null para ambiguo / vacio
//   9. detect.js re-exporta detectIntentRetransmit (mismo objeto que document-policy)
//   10. Source: handler tiene PROJECT_DOCS.crux.preciosT6 + rama dispatcher Crux T6

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { COMMERCIAL_LAYER } = require("../src/prompts/commercial-layer");
const { buildSystemPromptBlocks, MATEO_PROMPT_V5_2 } = require("../src/prompts");
const { detectCruxStage, detectIntentRetransmit: detectFromDetect } = require("../src/detect");
const { detectIntentRetransmit: detectFromPolicy } = require("../src/dispatch/document-policy");

describe("Hotfix-21 c3 — COMMERCIAL_LAYER export + composition", () => {
  it("Test 1: COMMERCIAL_LAYER exportado como string no vacio", () => {
    expect(typeof COMMERCIAL_LAYER).toBe("string");
    expect(COMMERCIAL_LAYER.length).toBeGreaterThan(500);
  });

  it("Test 2: COMMERCIAL_LAYER inyectado en staticBlock entre GLOSSARY y STYLE", () => {
    const { staticBlock } = buildSystemPromptBlocks();
    // Anchors de cada layer: usar fragmentos unicos de cada uno.
    const glossaryAnchor = "GLOSARIO DE ABREVIATURAS";          // glossary-layer
    const commercialAnchor = "INTELIGENCIA COMERCIAL";          // commercial-layer
    const styleAnchor = "RECORDATORIO FINAL DE TONO";           // style-layer
    const idxGlossary = staticBlock.indexOf(glossaryAnchor);
    const idxCommercial = staticBlock.indexOf(commercialAnchor);
    const idxStyle = staticBlock.indexOf(styleAnchor);
    expect(idxGlossary).toBeGreaterThan(-1);
    expect(idxCommercial).toBeGreaterThan(-1);
    expect(idxStyle).toBeGreaterThan(-1);
    // Orden: GLOSSARY < COMMERCIAL < STYLE
    expect(idxGlossary).toBeLessThan(idxCommercial);
    expect(idxCommercial).toBeLessThan(idxStyle);
  });

  it("Test 3: COMMERCIAL_LAYER NO contiene fechaHeader (cache breakpoint guard FASE 1)", () => {
    expect(COMMERCIAL_LAYER).not.toMatch(/Hoy es:\s*\d{4}-\d{2}-\d{2}/);
    expect(COMMERCIAL_LAYER).not.toContain("Hora actual:");
  });

  it("Test 4: COMMERCIAL_LAYER cubre Crux 2-stage (Listos vs Torre 6)", () => {
    expect(COMMERCIAL_LAYER).toContain("Torre 6");
    expect(COMMERCIAL_LAYER).toMatch(/Listos|Etapas 1, 2/);
    // Regla de ambiguedad: si Crux sin etapa, preguntar.
    expect(COMMERCIAL_LAYER).toContain("¿Cual te interesa?");
    // Fallback en texto si env var ausente — no escalar a Enmanuel.
    expect(COMMERCIAL_LAYER).toMatch(/lo coordino con Enmanuel/);
  });

  it("Test 5: COMMERCIAL_LAYER incluye jerga RD + recurring + avance comercial", () => {
    // Jerga RD core
    expect(COMMERCIAL_LAYER).toContain("en planos");
    expect(COMMERCIAL_LAYER).toContain("para mudarme");
    expect(COMMERCIAL_LAYER).toContain("regalo");
    expect(COMMERCIAL_LAYER).toContain("inversion");
    // Recurring: 3 buckets temporales
    expect(COMMERCIAL_LAYER).toMatch(/<\s*24/);
    expect(COMMERCIAL_LAYER).toMatch(/24\s*horas\s*-\s*7\s*dias/);
    expect(COMMERCIAL_LAYER).toMatch(/>\s*7\s*dias/);
    // Avance comercial
    expect(COMMERCIAL_LAYER).toMatch(/AVANCE COMERCIAL/i);
    expect(COMMERCIAL_LAYER).toContain("Dato comercial nuevo");
  });
});

describe("Hotfix-21 c3 — detectCruxStage()", () => {
  it("Test 6: positivos T6 (con y sin tilde)", () => {
    expect(detectCruxStage("", "en planos del Crux")).toBe("T6");
    expect(detectCruxStage("", "Quiero ver Torre 6")).toBe("T6");
    expect(detectCruxStage("", "estoy buscando algo en construcción")).toBe("T6");
    expect(detectCruxStage("", "obra gris, en preventa")).toBe("T6");
    // botReply con frase gatillo
    expect(detectCruxStage("Mira, la Torre 6 desde 99K", "info")).toBe("T6");
  });

  it("Test 7: positivos Listos", () => {
    expect(detectCruxStage("", "algo listo para entregar")).toBe("Listos");
    expect(detectCruxStage("", "para mudarme ya")).toBe("Listos");
    expect(detectCruxStage("", "etapa 1 o etapa 2")).toBe("Listos");
    expect(detectCruxStage("", "necesito algo inmediato")).toBe("Listos");
  });

  it("Test 8: null para ambiguo / vacio", () => {
    // Vacio
    expect(detectCruxStage("", "")).toBe(null);
    expect(detectCruxStage("", "info de Crux")).toBe(null);
    expect(detectCruxStage("", "dame info")).toBe(null);
    // Mixto: marcas de ambos lados → ambiguo
    expect(detectCruxStage("", "torre 6 listo")).toBe(null);
    expect(detectCruxStage("", "etapa 1 vs en planos")).toBe(null);
  });
});

describe("Hotfix-21 c3 — detect.js re-exports detectIntentRetransmit", () => {
  it("Test 9: detect.detectIntentRetransmit === document-policy.detectIntentRetransmit (mismo objeto)", () => {
    expect(typeof detectFromDetect).toBe("function");
    expect(detectFromDetect).toBe(detectFromPolicy);
    // Sanity comportamiento: misma funcion, mismas respuestas.
    expect(detectFromDetect("manda otra vez")).toBe(true);
    expect(detectFromDetect("ya me lo mandaste")).toBe(false);
  });
});

// === Source-inspection del handler ===

const HANDLER_SRC = readFileSync("src/handlers/message.js", "utf-8");

describe("Hotfix-21 c3 — handler Crux T6 dispatcher (source)", () => {
  it("Test 10: PROJECT_DOCS.crux.preciosT6 + rama dispatcher Crux T6 + skip ambiguous", () => {
    // Slot nuevo
    expect(HANDLER_SRC).toMatch(/preciosT6:\s*process\.env\.PDF_CRUX_PRECIOS_T6/);
    // Detector invocado
    expect(HANDLER_SRC).toContain("detectCruxStage");
    // Bloqueo ambiguedad (mismo patron PP)
    expect(HANDLER_SRC).toContain("pdf_skip_ambiguous_crux_stage");
    // Skip de "precios" general en loop principal cuando T6 explicito
    expect(HANDLER_SRC).toMatch(/cruxStage === "T6"\s*&&\s*docType === "precios"/);
    // Bloque especial T6 manda preciosT6 con policy guard
    expect(HANDLER_SRC).toMatch(/docKey:\s*project\s*\+\s*["']\.preciosT6["']/);
    expect(HANDLER_SRC).toMatch(/markDocSent\(storageKey,\s*project\s*\+\s*["']\.preciosT6["']/);
  });
});
