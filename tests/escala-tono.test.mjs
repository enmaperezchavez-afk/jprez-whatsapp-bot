// Hotfix-23 V3.6 — Voz Mateo (escala tono 4 niveles + 7 reglas duras + diccionario).
//
// Director veto explicito en doc V3.6 §0-3 + §7. Bug observado pre-V3.6:
// el bot a veces arrancaba con "viejo" en el primer mensaje o copiaba
// barrial del cliente (klk, manin). Estos tests validan que la doctrina
// completa de voz vive en OVERRIDES_LAYER:
//
//   - REGLA #0 scrapeo del cliente
//   - 4 niveles de tono (formal / neutral / popi / extranjero)
//   - 7 reglas duras (incluye "nunca arrancar primer mensaje con viejo")
//   - Diccionario palabras OK / vetadas

import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { OVERRIDES_LAYER } = require("../src/prompts/overrides-layer");

describe("Hotfix-23 V3.6 — Voz Mateo — REGLA #0 scrapeo del cliente", () => {
  it("OVERRIDES contiene REGLA #0 scrapeo de cliente", () => {
    expect(OVERRIDES_LAYER).toMatch(/REGLA #0.*Scrapeo de cliente/i);
  });

  it("REGLA #0 menciona los 3 ejes: cómo escribió, edad/perfil, momento comercial", () => {
    expect(OVERRIDES_LAYER).toMatch(/Cómo escribió el cliente/i);
    expect(OVERRIDES_LAYER).toMatch(/Edad\/perfil aproximado|perfil aproximado/i);
    expect(OVERRIDES_LAYER).toMatch(/Momento comercial/i);
  });
});

describe("Hotfix-23 V3.6 — Escala de tono 4 niveles", () => {
  it("OVERRIDES contiene los 4 niveles", () => {
    expect(OVERRIDES_LAYER).toMatch(/CLIENTE FORMAL.*MAYOR.*EJECUTIVO|FORMAL.*EJECUTIVO/i);
    expect(OVERRIDES_LAYER).toMatch(/CLIENTE NEUTRAL.*PRIMER CONTACTO|NEUTRAL.*PRIMER CONTACTO/i);
    expect(OVERRIDES_LAYER).toMatch(/CLIENTE SUELTO.*CONTEMPORÁNEO|SUELTO.*CONTEMPORÁNEO/i);
    expect(OVERRIDES_LAYER).toMatch(/CLIENTE EXTRANJERO.*INGLÉS.*SPANGLISH|EXTRANJERO.*SPANGLISH/i);
  });

  it("Nivel formal usa 'usted' + 'con gusto' + 'permítame'", () => {
    expect(OVERRIDES_LAYER).toMatch(/usted/i);
    expect(OVERRIDES_LAYER).toMatch(/con gusto/i);
    expect(OVERRIDES_LAYER).toMatch(/permítame/i);
  });

  it("Nivel popi usa 'viejo' + 'chilling' + 'tranquilo' + 'dale'", () => {
    expect(OVERRIDES_LAYER).toMatch(/viejo/);
    expect(OVERRIDES_LAYER).toMatch(/chilling/);
    expect(OVERRIDES_LAYER).toMatch(/tranquilo/);
    expect(OVERRIDES_LAYER).toMatch(/dale/);
  });

  it("Nivel extranjero pide español neutro profesional SIN modismos fuertes", () => {
    expect(OVERRIDES_LAYER).toMatch(/español neutro profesional|NO usa modismos/i);
  });
});

describe("Hotfix-23 V3.6 — 7 reglas duras del tono", () => {
  it("Regla 1: NUNCA arrancar con 'viejo' o 'chilling' en primer mensaje", () => {
    expect(OVERRIDES_LAYER).toMatch(/NUNCA arrancar con.*viejo.*chilling|nunca arrancar con.*viejo/i);
  });

  it("Regla 2: NUNCA copiar barrial duro del cliente", () => {
    expect(OVERRIDES_LAYER).toMatch(/NUNCA copiar el barrial duro|no copia.*barrial/i);
  });

  it("Regla 3: Si cliente usa 'usted' → Mateo usa 'usted' toda la conversación", () => {
    expect(OVERRIDES_LAYER).toMatch(/cliente usa.*usted.*Mateo usa.*usted/i);
  });

  it("Regla 5: Extranjero → español neutro profesional sin modismos fuertes", () => {
    expect(OVERRIDES_LAYER).toMatch(/extranjero.*español neutro|Cliente extranjero.*neutro profesional/i);
  });

  it("Regla 7: Números SIEMPRE exactos (cero redondeo en plata)", () => {
    expect(OVERRIDES_LAYER).toMatch(/Números SIEMPRE exactos|exactos.*Cero redondeo|Cero redondeo en plata/i);
  });
});

describe("Hotfix-23 V3.6 — Diccionario de palabras", () => {
  it("Diccionario contiene OK + vetadas", () => {
    expect(OVERRIDES_LAYER).toMatch(/OK siempre/i);
    expect(OVERRIDES_LAYER).toMatch(/OK con confianza ganada/i);
    expect(OVERRIDES_LAYER).toMatch(/OK con clientes mayores.*formales/i);
    expect(OVERRIDES_LAYER).toMatch(/VETADAS siempre/i);
  });

  it("Palabras OK siempre incluyen: mira, te tengo, tranquilo, dale", () => {
    // Estas estan en el diccionario en el listado especifico.
    const dicIdx = OVERRIDES_LAYER.indexOf("OK siempre");
    expect(dicIdx).toBeGreaterThan(-1);
    const dicSection = OVERRIDES_LAYER.slice(dicIdx, dicIdx + 400);
    expect(dicSection).toMatch(/mira/i);
    expect(dicSection).toMatch(/te tengo/i);
    expect(dicSection).toMatch(/tranquilo/i);
    expect(dicSection).toMatch(/dale/i);
  });

  it("Palabras VETADAS incluyen: tigre, manín, klk, vaina, 'bajas $X'", () => {
    const vetadasIdx = OVERRIDES_LAYER.indexOf("VETADAS siempre");
    expect(vetadasIdx).toBeGreaterThan(-1);
    const vetadasSection = OVERRIDES_LAYER.slice(vetadasIdx);
    expect(vetadasSection).toMatch(/tigre/i);
    expect(vetadasSection).toMatch(/man[ií]n/i);
    expect(vetadasSection).toMatch(/klk/i);
    expect(vetadasSection).toMatch(/bajas/i); // referencia al lexico vetado
  });
});

describe("Hotfix-23 V3.6 — 3 ejemplos canonicos verbatim", () => {
  it("OVERRIDES contiene Caso A (formal/mayor/ejecutivo)", () => {
    expect(OVERRIDES_LAYER).toMatch(/Caso A.*Cliente formal|Caso A.*formal.*mayor.*ejecutivo/i);
    expect(OVERRIDES_LAYER).toMatch(/Buenas tardes\. Con gusto le doy toda la información/);
  });

  it("OVERRIDES contiene Caso B (neutral/primer contacto)", () => {
    expect(OVERRIDES_LAYER).toMatch(/Caso B.*Cliente neutral|Caso B.*primer contacto/i);
    expect(OVERRIDES_LAYER).toMatch(/Hola, te tengo\. Para el PSE3 a \$124,000/);
  });

  it("OVERRIDES contiene Caso C (popi) con 2 sub-versiones (primer mensaje vs post 4-5)", () => {
    expect(OVERRIDES_LAYER).toMatch(/Caso C.*Cliente suelto|Caso C.*popi/i);
    expect(OVERRIDES_LAYER).toMatch(/primer mensaje.*todavía cordial sin.*viejo/i);
    expect(OVERRIDES_LAYER).toMatch(/después de 4-5 mensajes.*ya con confianza/i);
  });

  it("Caso B usa numeros exactos del doc V3.6 (12,400 / 1,094 / 74,400)", () => {
    expect(OVERRIDES_LAYER).toMatch(/\$12,400/);
    expect(OVERRIDES_LAYER).toMatch(/\$1,094/);
    expect(OVERRIDES_LAYER).toMatch(/\$74,400/);
  });
});
