// Tests del extractor del bloque <perfil_update>.
//
// Modulo leaf: no requiere mocks de Redis ni de red.
// Cubre todos los edge cases documentados en src/profile/extractor.js.

import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const {
  extractProfileUpdate,
  validateProfileUpdate,
  cleanResponseForWhatsApp,
} = require("../src/profile/extractor");

const VALID_BLOCK = `<perfil_update>
{
  "nombre": "Juan",
  "intencion_compra": "calificando",
  "score_lead": "tibio",
  "tags_nuevos": ["diaspora"]
}
</perfil_update>`;

describe("extractProfileUpdate", () => {
  it("caso feliz: parsea JSON valido y retorna texto limpio", () => {
    const input = `Hola, que tal.

Te mando el brochure.

${VALID_BLOCK}`;
    const { json, cleanedText } = extractProfileUpdate(input);
    expect(json).toEqual({
      nombre: "Juan",
      intencion_compra: "calificando",
      score_lead: "tibio",
      tags_nuevos: ["diaspora"],
    });
    expect(cleanedText).toBe("Hola, que tal.\n\nTe mando el brochure.");
    expect(cleanedText).not.toContain("<perfil_update>");
  });

  it("sin bloque: json=null, texto trimmed", () => {
    const input = "Hola, respuesta sin bloque.  ";
    const { json, cleanedText } = extractProfileUpdate(input);
    expect(json).toBeNull();
    expect(cleanedText).toBe("Hola, respuesta sin bloque.");
  });

  it("bloque vacio: json=null, texto sin el bloque", () => {
    const input = "Hola\n<perfil_update></perfil_update>";
    const { json, cleanedText } = extractProfileUpdate(input);
    expect(json).toBeNull();
    expect(cleanedText).toBe("Hola");
  });

  it("JSON malformado: json=null PERO el bloque igual se strip-ea (defensa critica)", () => {
    const input = `Respuesta

<perfil_update>
{ "nombre": "Juan", broken: ]
</perfil_update>`;
    const { json, cleanedText } = extractProfileUpdate(input);
    expect(json).toBeNull();
    expect(cleanedText).toBe("Respuesta");
    expect(cleanedText).not.toContain("<perfil_update>");
    expect(cleanedText).not.toContain("broken");
  });

  it("doble bloque: toma el primero y strip todos", () => {
    const input = `Texto

<perfil_update>
{"nombre": "Primer"}
</perfil_update>

<perfil_update>
{"nombre": "Segundo"}
</perfil_update>`;
    const { json, cleanedText } = extractProfileUpdate(input);
    expect(json).toEqual({ nombre: "Primer" });
    expect(cleanedText).toBe("Texto");
    expect(cleanedText).not.toContain("<perfil_update>");
    expect(cleanedText).not.toContain("Segundo");
  });

  it("bloque en el medio (no al final): strip correcto", () => {
    const input = `Primera linea

<perfil_update>
{"nombre": "Juan"}
</perfil_update>

Segunda linea despues del bloque`;
    const { json, cleanedText } = extractProfileUpdate(input);
    expect(json).toEqual({ nombre: "Juan" });
    expect(cleanedText).toBe("Primera linea\n\nSegunda linea despues del bloque");
  });

  it("input no-string retorna shape seguro", () => {
    expect(extractProfileUpdate(null)).toEqual({ json: null, cleanedText: "" });
    expect(extractProfileUpdate(undefined)).toEqual({ json: null, cleanedText: "" });
    expect(extractProfileUpdate(42)).toEqual({ json: null, cleanedText: "" });
    expect(extractProfileUpdate("")).toEqual({ json: null, cleanedText: "" });
  });

  it("tags en mayusculas/mixtas: case-insensitive para la deteccion", () => {
    const input = `Respuesta
<PERFIL_UPDATE>
{"nombre": "X"}
</PERFIL_UPDATE>`;
    const { json, cleanedText } = extractProfileUpdate(input);
    expect(json).toEqual({ nombre: "X" });
    expect(cleanedText).toBe("Respuesta");
  });
});

describe("validateProfileUpdate", () => {
  it("objeto vacio es valido (caso inicial de bloque sin deltas)", () => {
    expect(validateProfileUpdate({})).toBe(true);
  });

  it("enums validos pasan", () => {
    expect(validateProfileUpdate({
      intencion_compra: "calificando",
      score_lead: "tibio",
      siguiente_accion_sugerida: "send_brochure",
    })).toBe(true);
  });

  it("intencion_compra desconocida falla", () => {
    expect(validateProfileUpdate({ intencion_compra: "inventado" })).toBe(false);
  });

  it("score_lead desconocido falla", () => {
    expect(validateProfileUpdate({ score_lead: "hirviendo" })).toBe(false);
  });

  it("siguiente_accion desconocida falla", () => {
    expect(validateProfileUpdate({ siguiente_accion_sugerida: "pedir_pizza" })).toBe(false);
  });

  it("siguiente_accion 'recomendar_competencia' es valido (Nivel 3)", () => {
    expect(validateProfileUpdate({ siguiente_accion_sugerida: "recomendar_competencia" })).toBe(true);
  });

  it("arrays con tipo incorrecto fallan", () => {
    expect(validateProfileUpdate({ tags_nuevos: "no-es-array" })).toBe(false);
    expect(validateProfileUpdate({ competencia_mencionada: 42 })).toBe(false);
  });

  it("objecion_nueva debe ser boolean", () => {
    expect(validateProfileUpdate({ objecion_nueva: true })).toBe(true);
    expect(validateProfileUpdate({ objecion_nueva: false })).toBe(true);
    expect(validateProfileUpdate({ objecion_nueva: "si" })).toBe(false);
    expect(validateProfileUpdate({ objecion_nueva: 1 })).toBe(false);
  });

  it("null / no-objeto / array fallan", () => {
    expect(validateProfileUpdate(null)).toBe(false);
    expect(validateProfileUpdate(undefined)).toBe(false);
    expect(validateProfileUpdate("string")).toBe(false);
    expect(validateProfileUpdate(42)).toBe(false);
    expect(validateProfileUpdate([])).toBe(false);
    expect(validateProfileUpdate(["array"])).toBe(false);
  });

  it("null en campos enum se tolera (campo no llenado = ok)", () => {
    expect(validateProfileUpdate({
      intencion_compra: null,
      score_lead: null,
      siguiente_accion_sugerida: null,
    })).toBe(true);
  });

  it("campos desconocidos no rompen validacion (forward compat)", () => {
    expect(validateProfileUpdate({
      nombre: "Juan",
      campo_del_futuro: "que sea",
      otro_campo_nuevo: 42,
    })).toBe(true);
  });
});

describe("cleanResponseForWhatsApp", () => {
  it("strip del bloque idempotente", () => {
    const input = `Hola ${VALID_BLOCK}`;
    const once = cleanResponseForWhatsApp(input);
    const twice = cleanResponseForWhatsApp(once);
    expect(once).toBe(twice);
    expect(once).not.toContain("<perfil_update>");
  });

  it("texto sin bloque pasa tal cual (trimmed)", () => {
    expect(cleanResponseForWhatsApp("  hola  ")).toBe("hola");
  });

  it("input no-string retorna string vacio", () => {
    expect(cleanResponseForWhatsApp(null)).toBe("");
    expect(cleanResponseForWhatsApp(undefined)).toBe("");
    expect(cleanResponseForWhatsApp(42)).toBe("");
  });

  it("GARANTIA CRITICA: el bloque NUNCA se filtra al cliente, aun con JSON roto", () => {
    const malformedWithBlock = `Algo\n<perfil_update>{broken json!}\n</perfil_update>\nFinal`;
    const cleaned = cleanResponseForWhatsApp(malformedWithBlock);
    expect(cleaned).not.toContain("<perfil_update>");
    expect(cleaned).not.toContain("</perfil_update>");
    expect(cleaned).not.toContain("broken json");
  });
});
