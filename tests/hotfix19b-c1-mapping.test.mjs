// Hotfix-19B Commit 1 — Mapping inteligente:
//   FIX 1: detectDocumentType mapea aliases planos/distribucion/plantas/etc
//          a ["brochure"] porque el brochure ya contiene plantas tipo.
//   FIX 2: handler relaja fallback condition: mensaje honesto al cliente
//          dispara siempre que falte un docType prometido (sentCount=0 ok).

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { detectDocumentType } = require("../src/detect");

describe("Hotfix-19B Commit 1 — detectDocumentType aliases planos→brochure", () => {
  it("Test 1: 'mandame planos PR4' → ['brochure']", () => {
    const result = detectDocumentType("te mando los planos", "mandame planos pr4");
    expect(result).toEqual(["brochure"]);
  });

  it("Test 2: 'distribución apto' → ['brochure'] (tilde via stripAccents)", () => {
    const result = detectDocumentType("te paso distribución del apto", "info distribución apartamento");
    expect(result).toEqual(["brochure"]);
  });

  it("Test 3: 'plantas tipo' → ['brochure']", () => {
    const result = detectDocumentType("te envio las plantas tipo", "mandame plantas tipo");
    expect(result).toEqual(["brochure"]);
  });

  it("Test 4: 'layout 1 hab' → ['brochure']", () => {
    const result = detectDocumentType("te paso el layout", "layout 1 hab");
    expect(result).toEqual(["brochure"]);
  });

  it("Test 5: 'como es por dentro PR3' → ['brochure']", () => {
    const result = detectDocumentType("te mando el brochure", "como es por dentro pr3");
    expect(result).toEqual(["brochure"]);
  });

  it("Test 6: 'brochure y planos' NO duplica (dedupe)", () => {
    // Pre-fix sin dedupe esto retornaria ["brochure","brochure"] y el handler
    // mandaria el PDF dos veces con 1.5s de delay. Con dedupe → ["brochure"].
    const result = detectDocumentType("te mando brochure y planos", "");
    expect(result).toEqual(["brochure"]);
  });

  it("Test 7: 'precios y planos' → ['precios','brochure'] (mantiene precios)", () => {
    const result = detectDocumentType("te mando precios y planos PR4", "");
    expect(result).toEqual(["precios", "brochure"]);
  });

  it("Test 8: precios solo sigue funcionando (no afectado)", () => {
    expect(detectDocumentType("te paso el listado de precios", "")).toEqual(["precios"]);
  });

  it("Test 9: brochure solo sigue funcionando (no afectado)", () => {
    expect(detectDocumentType("te mando el brochure", "")).toEqual(["brochure"]);
  });

  it("Test 10: sin keywords → default ['brochure']", () => {
    expect(detectDocumentType("hola que tal", "")).toEqual(["brochure"]);
  });
});

describe("Hotfix-19B Commit 1 — handler fallback relajado", () => {
  const HANDLER_SRC = readFileSync("src/handlers/message.js", "utf-8");

  it("Test 11: condicion vieja '&& sentCount > 0' fue removida", () => {
    expect(HANDLER_SRC).not.toMatch(/missingDocTypes\.length > 0 && sentCount > 0/);
  });

  it("Test 12: condicion nueva 'if (missingDocTypes.length > 0)' presente", () => {
    expect(HANDLER_SRC).toMatch(/if \(missingDocTypes\.length > 0\) \{/);
  });
});
