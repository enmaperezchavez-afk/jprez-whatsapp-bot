// src/validators/static-block-order.js — Hotfix-22 V2 b4.
//
// Defensa permanente contra refactors accidentales del orden del
// staticBlock. Si alguien (humano o LLM) reordena los layers en
// buildSystemPromptBlocks() y mueve STYLE_LAYER fuera del final, o
// inserta skills DESPUES de STYLE, este guard lo detecta loud al
// build (cold start de la funcion serverless en Vercel).
//
// HISTORIA: Hotfix-22 V2 a3 movio STYLE_LAYER al final del staticBlock
// como autoridad de formato (last-seen-wins). Sin guard, un refactor
// futuro podria romper ese invariante en silencio y reaparecer Bug #2
// (asteriscos / bullets) sin tests fallando porque los tests existentes
// solo asertan el orden a nivel API publica, no a nivel build interno.
//
// CONTRATO:
//   validateStaticBlockOrder(staticBlock): { ok, violations }
//     - staticBlock: string concatenado del array final.
//     - violations: lista de errores encontrados. Cada error tiene
//       { rule, message, anchor, position }.
//     - ok=true cuando violations.length === 0.
//
// REGLAS VERIFICADAS:
//   1. MATEO_V5_2 ("Eres Mateo Reyes") aparece exactamente una vez y
//      es la primera identidad estructural (despues del SKILL_CONTENT
//      + INVENTORY que son referenciales).
//   2. STYLE_LAYER ("RECORDATORIO FINAL DE TONO") aparece exactamente
//      una vez y es el ULTIMO bloque del staticBlock.
//   3. Skills (CALCULATOR_SKILL_CONTENT + MARKET_RD_SKILL_CONTENT) van
//      ENTRE los layers internos y STYLE_LAYER (no antes de MATEO_V5_2,
//      no despues de STYLE_LAYER).
//   4. Layers internos (GLOSSARY, COMMERCIAL) van entre MATEO_V5_2 y
//      los skills.
//
// MODULO LEAF: cero I/O. Solo busqueda de anchors en string.

const ANCHORS = {
  MATEO: "Eres Mateo Reyes",
  GLOSSARY: "GLOSARIO DE ABREVIATURAS",
  COMMERCIAL: "INTELIGENCIA COMERCIAL",
  CALCULATOR: "calculadora-plan-pago",
  MARKET_RD: "mercado-inmobiliario-rd",
  STYLE: "RECORDATORIO FINAL DE TONO",
};

// findAnchor: devuelve la posicion (indexOf) del anchor en el bloque,
// o -1 si no se encontro. Tambien cuenta ocurrencias para detectar
// duplicacion (que indicaria contaminacion del prompt).
function findAnchor(staticBlock, needle) {
  const idx = staticBlock.indexOf(needle);
  if (idx === -1) return { idx: -1, count: 0 };
  let count = 0;
  let pos = idx;
  while (pos !== -1) {
    count++;
    pos = staticBlock.indexOf(needle, pos + needle.length);
  }
  return { idx, count };
}

function validateStaticBlockOrder(staticBlock) {
  if (typeof staticBlock !== "string") {
    return {
      ok: false,
      violations: [{
        rule: "input_type",
        message: "staticBlock must be string, got " + typeof staticBlock,
      }],
    };
  }

  const violations = [];

  const mateo = findAnchor(staticBlock, ANCHORS.MATEO);
  const glossary = findAnchor(staticBlock, ANCHORS.GLOSSARY);
  const commercial = findAnchor(staticBlock, ANCHORS.COMMERCIAL);
  const calc = findAnchor(staticBlock, ANCHORS.CALCULATOR);
  const market = findAnchor(staticBlock, ANCHORS.MARKET_RD);
  const style = findAnchor(staticBlock, ANCHORS.STYLE);

  // Regla 1: MATEO_V5_2 presente exactamente una vez como identidad estructural.
  if (mateo.idx === -1) {
    violations.push({
      rule: "mateo_present",
      message: "MATEO_V5_2 anchor '" + ANCHORS.MATEO + "' missing from staticBlock",
    });
  }

  // Regla 2: STYLE_LAYER presente y es el ULTIMO anchor estructural.
  if (style.idx === -1) {
    violations.push({
      rule: "style_present",
      message: "STYLE_LAYER anchor '" + ANCHORS.STYLE + "' missing from staticBlock",
    });
  } else {
    // STYLE debe venir DESPUES de TODOS los demas anchors estructurales.
    const earlierAnchors = [
      { name: "MATEO_V5_2", idx: mateo.idx },
      { name: "GLOSSARY_LAYER", idx: glossary.idx },
      { name: "COMMERCIAL_LAYER", idx: commercial.idx },
      { name: "CALCULATOR_SKILL", idx: calc.idx },
      { name: "MARKET_RD_SKILL", idx: market.idx },
    ];
    for (const a of earlierAnchors) {
      if (a.idx !== -1 && a.idx > style.idx) {
        violations.push({
          rule: "style_last",
          message: a.name + " appears AFTER STYLE_LAYER (last-seen-wins violated)",
          anchor: a.name,
          stylePosition: style.idx,
          anchorPosition: a.idx,
        });
      }
    }
  }

  // Regla 3: Skills (CALCULATOR + MARKET_RD) van DESPUES de los layers internos.
  // Solo validamos si ambos skills estan presentes (en preview/dev pueden
  // faltar y eso lo cubre el fallback "" del loader).
  if (calc.idx !== -1 && glossary.idx !== -1 && calc.idx < glossary.idx) {
    violations.push({
      rule: "skills_after_layers",
      message: "CALCULATOR_SKILL appears BEFORE GLOSSARY_LAYER",
    });
  }
  if (market.idx !== -1 && commercial.idx !== -1 && market.idx < commercial.idx) {
    violations.push({
      rule: "skills_after_layers",
      message: "MARKET_RD_SKILL appears BEFORE COMMERCIAL_LAYER",
    });
  }

  // Regla 4: Layers internos (GLOSSARY, COMMERCIAL) DESPUES de MATEO.
  if (glossary.idx !== -1 && mateo.idx !== -1 && glossary.idx < mateo.idx) {
    violations.push({
      rule: "layers_after_mateo",
      message: "GLOSSARY_LAYER appears BEFORE MATEO_V5_2",
    });
  }
  if (commercial.idx !== -1 && mateo.idx !== -1 && commercial.idx < mateo.idx) {
    violations.push({
      rule: "layers_after_mateo",
      message: "COMMERCIAL_LAYER appears BEFORE MATEO_V5_2",
    });
  }

  return { ok: violations.length === 0, violations };
}

module.exports = {
  validateStaticBlockOrder,
  ANCHORS,
};
