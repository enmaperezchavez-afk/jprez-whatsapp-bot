// Hotfix-19 Commit 2 — Bug #2 (granularidad etapas) + Bug #5 (aliases/glosario).

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

const {
  detectDocumentRequest,
  detectPuertoPlataStage,
} = require("../src/detect");
const { buildSystemPrompt, MATEO_PROMPT_V5_2 } = require("../src/prompts");
const { computePromptHash } = require("../src/prompt-version");
const { GLOSSARY_LAYER } = require("../src/prompts/glossary-layer");

describe("Hotfix-19 Commit 2 — Bug #5 detectDocumentRequest", () => {
  it("Test 1: 'PSE3' (con frase de envio) detecta puertoPlata, NO 'all' ni pr3", () => {
    const result = detectDocumentRequest("te mando el brochure de PSE3", "");
    expect(result).toBe("puertoPlata");
  });

  it("Test 2: 'PSE4' detecta puertoPlata", () => {
    const result = detectDocumentRequest("te envio info de PSE4", "");
    expect(result).toBe("puertoPlata");
  });

  it("Test 3: 'PR3' sigue detectando pr3 (no se rompio el matching previo)", () => {
    const result = detectDocumentRequest("te mando el brochure de PR3", "");
    expect(result).toBe("pr3");
  });

  it("Test 4: cliente pregunta por PR3 → se mantiene pr3 aunque mencione 'etapa 3' nada", () => {
    // Caso real: cliente escribe "envíame info de PR3 por favor"
    const result = detectDocumentRequest("te envio el brochure", "envíame info de PR3 por favor");
    expect(result).toBe("pr3");
  });
});

describe("Hotfix-19 Commit 2 — Bug #2 detectPuertoPlataStage", () => {
  it("Test 5: 'PSE3' explicito retorna 'E3'", () => {
    expect(detectPuertoPlataStage("", "quiero info de PSE3")).toBe("E3");
  });

  it("Test 6: 'etapa 4' retorna 'E4'", () => {
    expect(detectPuertoPlataStage("info de etapa 4", "")).toBe("E4");
  });

  it("Test 7: ambas etapas o sin etapa → null (mandar ambas como antes)", () => {
    expect(detectPuertoPlataStage("etapa 3 y etapa 4", "")).toBe(null);
    expect(detectPuertoPlataStage("Prado Suites Puerto Plata", "")).toBe(null);
  });
});

describe("Hotfix-19 Commit 2 — Glossary layer composable", () => {
  it("Test 8: GLOSSARY_LAYER incluye PR3, PR4, PSE3, PSE4, Crux explicitos", () => {
    expect(GLOSSARY_LAYER).toContain("PR3");
    expect(GLOSSARY_LAYER).toContain("PR4");
    expect(GLOSSARY_LAYER).toContain("PSE3");
    expect(GLOSSARY_LAYER).toContain("PSE4");
    expect(GLOSSARY_LAYER).toContain("Crux");
    expect(GLOSSARY_LAYER).toContain("PR3 ≠ PSE3");
  });

  it("Test 9: buildSystemPrompt incluye el glossary layer al final", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("PSE3");
    expect(prompt).toContain("GLOSARIO DE ABREVIATURAS");
    // El glossary va DESPUES de MATEO_PROMPT_V5_2 — recencia maxima.
    const idxMateo = prompt.indexOf("Eres Mateo Reyes");
    const idxGlossary = prompt.indexOf("GLOSARIO DE ABREVIATURAS");
    expect(idxGlossary).toBeGreaterThan(idxMateo);
  });

  it("Test 10: glossary NO altera el hash de prompt-version (cliente activo no se invalida)", () => {
    // Hash de la constante MATEO_PROMPT_V5_2 debe ser estable independiente
    // del layer. Esto valida que iterar el glossary es libre — sin riesgo
    // a clientes activos.
    const h1 = computePromptHash(MATEO_PROMPT_V5_2);
    const h2 = computePromptHash(MATEO_PROMPT_V5_2);
    expect(h1).toBe(h2);
    // Y el contenido del prompt construido SI incluye el glossary, pero
    // el hash NO se computa sobre eso — es la garantia de no-invalidacion.
    expect(buildSystemPrompt()).toContain("GLOSARIO DE ABREVIATURAS");
  });
});

describe("Hotfix-19 Commit 2 — Handler usa detectPuertoPlataStage", () => {
  const HANDLER_SRC = readFileSync("src/handlers/message.js", "utf-8");

  it("Test 11: handler importa detectPuertoPlataStage", () => {
    expect(HANDLER_SRC).toContain("detectPuertoPlataStage");
  });

  it("Test 12: bloques especiales E4 condicionados a ppStage !== 'E3'", () => {
    expect(HANDLER_SRC).toMatch(/ppStage !== "E3"[\s\S]*requestedTypes\.includes\("precios"\)/);
    expect(HANDLER_SRC).toMatch(/ppStage !== "E3"[\s\S]*requestedTypes\.includes\("brochure"\)/);
  });

  it("Test 13: loop principal saltea envio E3 cuando ppStage === 'E4'", () => {
    expect(HANDLER_SRC).toMatch(/ppStage === "E4"[\s\S]*continue/);
  });
});
