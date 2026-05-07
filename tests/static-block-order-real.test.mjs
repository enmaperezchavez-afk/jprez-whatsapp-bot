// Hotfix-22 V2 c5 — Test E2E del orden real del staticBlock en produccion.
//
// El test unit tests/static-block-order.test.mjs (B4) valida la LOGICA
// del validador con inputs sinteticos (mock anchors). Eso es suficiente
// para garantizar que validateStaticBlockOrder() responde correcto, pero
// NO garantiza que el staticBlock REAL (el que se inyecta a Anthropic
// en cada request de cliente) cumpla las reglas.
//
// Caso brutal: alguien refactoriza buildSystemPromptBlocks() y mueve
// STYLE_LAYER al medio. Los unit tests de B4 SIGUEN pasando porque
// validan la logica del validator, no el output real. Solo este test
// E2E cierra la brecha: ejecuta buildSystemPromptBlocks() (production
// build) y assertea que el staticBlock retornado pasa el validador.
//
// CI bloquea el merge si falla. Sin este test, el bug podria llegar a
// produccion en silencio (porque src/prompts.js c1 solo logea, NO
// crashea — fail-open por diseno para no dejar al cliente sin respuesta).
//
// Cobertura (3 tests):
//   1. staticBlock REAL pasa validateStaticBlockOrder (ok=true).
//   2. Anchors estructurales presentes en el orden esperado:
//      MATEO < GLOSSARY < COMMERCIAL < CALCULATOR < MARKET < STYLE.
//   3. Skills cargados (no fallaron al cold start) — staticBlock
//      contiene los markers de los 3 skills productivos.

import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { buildSystemPromptBlocks } = require("../src/prompts");
const { validateStaticBlockOrder, ANCHORS } = require("../src/validators/static-block-order");

describe("Hotfix-22 V2 c5 — staticBlock REAL en build de produccion", () => {
  it("Test 1: staticBlock real pasa el order validator (ok=true, sin violations)", () => {
    const { staticBlock } = buildSystemPromptBlocks();
    const result = validateStaticBlockOrder(staticBlock);
    if (!result.ok) {
      // Reporte util al developer si el test falla — incluye violations
      // detalladas para que el commit que rompe el orden sea facil de
      // debuggear.
      console.error("STATIC BLOCK ORDER VIOLATIONS:", JSON.stringify(result.violations, null, 2));
    }
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("Test 2: anchors aparecen en el orden esperado (MATEO < GLOSSARY < COMMERCIAL < CALCULATOR < MARKET < STYLE)", () => {
    const { staticBlock } = buildSystemPromptBlocks();

    const idxMateo = staticBlock.indexOf(ANCHORS.MATEO);
    const idxGlossary = staticBlock.indexOf(ANCHORS.GLOSSARY);
    const idxCommercial = staticBlock.indexOf(ANCHORS.COMMERCIAL);
    const idxCalc = staticBlock.indexOf(ANCHORS.CALCULATOR);
    const idxMarket = staticBlock.indexOf(ANCHORS.MARKET_RD);
    const idxStyle = staticBlock.indexOf(ANCHORS.STYLE);

    // Todos presentes.
    expect(idxMateo, "MATEO_V5_2 anchor").toBeGreaterThan(-1);
    expect(idxGlossary, "GLOSSARY anchor").toBeGreaterThan(-1);
    expect(idxCommercial, "COMMERCIAL anchor").toBeGreaterThan(-1);
    expect(idxCalc, "CALCULATOR_SKILL anchor").toBeGreaterThan(-1);
    expect(idxMarket, "MARKET_RD_SKILL anchor").toBeGreaterThan(-1);
    expect(idxStyle, "STYLE_LAYER anchor").toBeGreaterThan(-1);

    // Orden: MATEO < GLOSSARY < COMMERCIAL < CALCULATOR < MARKET < STYLE.
    // Si alguien reordena el staticBlock, este test falla loud con el
    // par exacto que se rompio.
    expect(idxGlossary, "GLOSSARY despues de MATEO").toBeGreaterThan(idxMateo);
    expect(idxCommercial, "COMMERCIAL despues de GLOSSARY").toBeGreaterThan(idxGlossary);
    expect(idxCalc, "CALCULATOR despues de COMMERCIAL").toBeGreaterThan(idxCommercial);
    expect(idxMarket, "MARKET despues de CALCULATOR").toBeGreaterThan(idxCalc);
    expect(idxStyle, "STYLE como ultimo (despues de MARKET)").toBeGreaterThan(idxMarket);
  });

  it("Test 3: skills productivos cargados al cold start (cero fallback degradado)", () => {
    const { staticBlock } = buildSystemPromptBlocks();
    // Si el cold start fallo en cargar algun skill, el contenido del
    // skill no estaria en el staticBlock — solo un string vacio. Esto
    // detecta deploy con bundle roto antes de que el cliente lo note.
    expect(staticBlock).toContain("calculadora-plan-pago");
    expect(staticBlock).toContain("mercado-inmobiliario-rd");
    expect(staticBlock).toContain("vendedor-whatsapp-jprez");
    // Sanity: el fallback "ERROR: skill no cargo" del SKILL principal
    // NO debe aparecer (eso indicaria que el load fallo).
    expect(staticBlock).not.toContain("ERROR: skill no cargo");
  });
});
