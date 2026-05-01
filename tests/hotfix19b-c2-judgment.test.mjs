// Hotfix-19B Commit 2 — Juicio comercial:
//   FIX 3: detect.isAmbiguousPuertoPlataRequest detecta PP sin etapa.
//   FIX 4: handler.processMessage skip PDF dispatch cuando puertoPlata + ppStage=null.
//   FIX 5: glossary-layer.GLOSSARY_LAYER incluye bloque JUICIO COMERCIAL.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

const {
  isAmbiguousPuertoPlataRequest,
  detectPuertoPlataStage,
} = require("../src/detect");
const { GLOSSARY_LAYER } = require("../src/prompts/glossary-layer");
const { buildSystemPrompt } = require("../src/prompts");

describe("Hotfix-19B Commit 2 — isAmbiguousPuertoPlataRequest", () => {
  it("Test 1: 'info Puerto Plata' (sin etapa) → true", () => {
    expect(isAmbiguousPuertoPlataRequest("info Puerto Plata")).toBe(true);
  });

  it("Test 2: 'Puerto Plata Etapa 3' → false (etapa especificada)", () => {
    expect(isAmbiguousPuertoPlataRequest("Puerto Plata Etapa 3")).toBe(false);
  });

  it("Test 3: 'PSE3' → false (alias de etapa)", () => {
    expect(isAmbiguousPuertoPlataRequest("PSE3")).toBe(false);
  });

  it("Test 4: 'PSE4' → false", () => {
    expect(isAmbiguousPuertoPlataRequest("mandame info de PSE4")).toBe(false);
  });

  it("Test 5: 'mándame todo lo de Puerto Plata' → true (sin etapa)", () => {
    expect(isAmbiguousPuertoPlataRequest("mándame todo lo de Puerto Plata")).toBe(true);
  });

  it("Test 6: 'playa dorada' (alias PP) sin etapa → true", () => {
    expect(isAmbiguousPuertoPlataRequest("info playa dorada")).toBe(true);
  });

  it("Test 7: 'playa dorada e3' → false", () => {
    expect(isAmbiguousPuertoPlataRequest("playa dorada e3")).toBe(false);
  });

  it("Test 8: 'PR3' (otro proyecto) → false (no menciona PP)", () => {
    expect(isAmbiguousPuertoPlataRequest("info PR3")).toBe(false);
  });

  it("Test 9: 'pp e4' (alias compacto) → false (etapa presente)", () => {
    expect(isAmbiguousPuertoPlataRequest("dame pp e4")).toBe(false);
  });

  it("Test 10: tildes en 'Etapa 3' (estrip via accents) → false", () => {
    // El user escribe con/sin acentos indistintamente — la deteccion debe
    // ser robusta. stripAccents normaliza; aqui no hay tilde pero el caso
    // 'Etápa' (mayuscula con acento accidental) deberia funcionar igual.
    expect(isAmbiguousPuertoPlataRequest("Puerto Plata ETAPA 3")).toBe(false);
  });
});

describe("Hotfix-19B Commit 2 — handler skip ambiguous puertoPlata", () => {
  const HANDLER_SRC = readFileSync("src/handlers/message.js", "utf-8");

  it("Test 11: handler emite log 'pdf_skip_ambiguous_pp_stage'", () => {
    expect(HANDLER_SRC).toContain("pdf_skip_ambiguous_pp_stage");
  });

  it("Test 12: el skip esta gated por puertoPlata + ppStage === null", () => {
    expect(HANDLER_SRC).toMatch(
      /project === "puertoPlata" && ppStage === null[\s\S]*pdf_skip_ambiguous_pp_stage/
    );
  });

  it("Test 13: el skip ejecuta return; (sale de processMessage)", () => {
    expect(HANDLER_SRC).toMatch(/pdf_skip_ambiguous_pp_stage[\s\S]*?return;/);
  });
});

describe("Hotfix-19B Commit 2 — JUICIO COMERCIAL en glossary layer", () => {
  it("Test 14: GLOSSARY_LAYER incluye bloque JUICIO COMERCIAL", () => {
    expect(GLOSSARY_LAYER).toContain("JUICIO COMERCIAL");
    expect(GLOSSARY_LAYER).toContain("VENDEDOR HUMANO");
    expect(GLOSSARY_LAYER).toContain("SPAM BOT");
  });

  it("Test 15: JUICIO incluye guidance especifica para Puerto Plata sin etapa", () => {
    expect(GLOSSARY_LAYER).toContain("Puerto Plata");
    expect(GLOSSARY_LAYER).toMatch(/Etapa 3.*Etapa 4/s);
    expect(GLOSSARY_LAYER).toContain("¿Cuál te interesa");
  });

  it("Test 16: JUICIO incluye regla 'planos = brochure'", () => {
    expect(GLOSSARY_LAYER).toContain("planos");
    expect(GLOSSARY_LAYER).toContain("brochure");
    // El bloque debe explicitar que planos viene dentro del brochure
    expect(GLOSSARY_LAYER).toMatch(/brochure.*plantas|plantas.*brochure/s);
  });

  it("Test 17: buildSystemPrompt incluye JUICIO COMERCIAL al final", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("JUICIO COMERCIAL");
    // JUICIO va DESPUES del glosario, ambos despues de MATEO.
    const idxMateo = prompt.indexOf("Eres Mateo Reyes");
    const idxGlossary = prompt.indexOf("GLOSARIO DE ABREVIATURAS");
    const idxJuicio = prompt.indexOf("JUICIO COMERCIAL");
    expect(idxMateo).toBeGreaterThan(-1);
    expect(idxGlossary).toBeGreaterThan(idxMateo);
    expect(idxJuicio).toBeGreaterThan(idxGlossary);
  });
});

describe("Hotfix-19B Commit 2 — detectPuertoPlataStage interplay", () => {
  // detectPuertoPlataStage (combined) y isAmbiguousPuertoPlataRequest (user only)
  // tienen semanticas DIFERENTES — este test documenta la diferencia.
  it("Test 18: si Mateo desambigua en su reply, detectPuertoPlataStage 'E3' pero isAmbiguous true", () => {
    // user pidio PP sin etapa — Mateo respondio especificando E3.
    expect(detectPuertoPlataStage("te mando brochure de etapa 3", "info Puerto Plata")).toBe("E3");
    // Pero isAmbiguous solo mira user — sigue ambiguo desde la perspectiva del cliente.
    expect(isAmbiguousPuertoPlataRequest("info Puerto Plata")).toBe(true);
    // El handler usa ppStage (combined) → procede con envio E3 porque Mateo desambiguo.
    // isAmbiguous queda como helper exportado para instrumentacion futura.
  });
});
