// Hotfix-22 c1 — Prosa natural + numeros exactos.
//
// Bug observado en producion (5-6 mayo 2026): bot responde con bullets,
// asteriscos markdown (** texto **), y numeros redondeados ($163K, $2K).
// 3 problemas raiz:
//
//   1. STYLE_LAYER §4 mal scopeado (solo aplicaba a tool calcular_plan_pago).
//      Cuando el bot responde sin tool (copia del skill) la regla no aplica.
//   2. STYLE_LAYER §4.111 ensenaba LO OPUESTO ("Redondeo amigable: $163K").
//      Director: numeros EXACTOS siempre en cuotas/totales (contratos legales).
//   3. COMMERCIAL_LAYER tenia bullets + ** bold en ejemplos al cliente.
//      LLM mimica esos formatos cuando responde a clientes.
//
// Fix:
//   - STYLE_LAYER §4 renombrado "FORMATO NUMEROS — siempre exactos", scope
//     universal (cualquier respuesta con numeros), regla 1 invertida
//     (exactos por default, redondeo solo marketing).
//   - COMMERCIAL_LAYER ejemplos AL CLIENTE convertidos a prosa sin bullets,
//     sin ** bold, con numeros exactos. Reglas internas mantienen bullets.
//   - SKILL calculadora-plan-pago tiene seccion "CÓMO PRESENTAR AL CLIENTE"
//     que aclara: bullets/code blocks son referencia INTERNA. Respuestas al
//     cliente siempre prosa con numeros exactos.
//
// Cobertura (6 tests):
//   1. STYLE_LAYER §4 dice "EXACTOS" no "amigables"
//   2. STYLE_LAYER §4 universal (no solo tool calcular_plan_pago)
//   3. STYLE_LAYER ejemplos "BIEN" usan numeros exactos ($163,000 no $163K)
//   4. COMMERCIAL_LAYER ejemplos al cliente sin ** bold markdown
//   5. SKILL calculadora tiene "CÓMO PRESENTAR AL CLIENTE" con caso prosa
//   6. Anti-test: STYLE_LAYER no tiene "Redondeo amigable" como recomendacion

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { STYLE_LAYER } = require("../src/prompts/style-layer");
const { COMMERCIAL_LAYER } = require("../src/prompts/commercial-layer");

const SKILL_PATH = ".claude/skills/calculadora-plan-pago/SKILL.md";

describe("Hotfix-22 c1 — STYLE_LAYER §4 numeros exactos + universal", () => {
  it("Test 1: §4 renombrado a FORMATO NUMEROS y dice 'siempre exactos'", () => {
    expect(STYLE_LAYER).toContain("FORMATO NÚMEROS");
    expect(STYLE_LAYER).toContain("siempre exactos");
    // Regression guard: titulo viejo eliminado.
    expect(STYLE_LAYER).not.toContain("FORMATO CALCULADORA — habla, no listes");
  });

  it("Test 2: §4 scope universal — aplica a cualquier respuesta con numeros, no solo tool", () => {
    // Buscamos confirmacion explicita que el scope es universal.
    expect(STYLE_LAYER).toMatch(/aplica a CUALQUIER respuesta con n[uú]meros/i);
    // Sanity: la regla nueva NO se restringe solo a la tool calcular_plan_pago.
    expect(STYLE_LAYER).toMatch(/no solo a la tool/i);
  });

  it("Test 3: ejemplos 'BIEN' didacticos declarados + cero redondeo de marketing (Sprint1.8 PR-1)", () => {
    // Sprint1.8 PR-1: los ejemplos usan cifras DIDACTICAS (120,000 redondo
    // declarado) para que el LLM no las recite como precios reales — el
    // $163,000 de los ejemplos viejos salio DOS veces a clientes reales.
    expect(STYLE_LAYER).toContain("$120,000");
    expect(STYLE_LAYER).toContain("$12,000");
    expect(STYLE_LAYER).toContain("$1,500");
    expect(STYLE_LAYER).toContain("$84,000");
    expect(STYLE_LAYER).toMatch(/DIDACTICAS/);
    expect(STYLE_LAYER).toMatch(/JAMAS recites una cifra de estos ejemplos/);
    // Regla 1: exactos siempre.
    expect(STYLE_LAYER).toMatch(/N[uú]meros EXACTOS siempre/);
    // Regla 2 NUEVA: el redondeo de marketing esta MUERTO — desde/hasta
    // exactos del inventario vivo, con anulacion del 99K del frozen.
    expect(STYLE_LAYER).not.toMatch(/Redondeo permitido SOLO en precio base de marketing/);
    expect(STYLE_LAYER).toMatch(/desde\/hasta" tambien exactos y del INVENTARIO VIVO/);
    expect(STYLE_LAYER).toMatch(/ANULA cualquier ejemplo con "desde US\$99K/);
    // Razon legal: contratos firma con exactos.
    expect(STYLE_LAYER).toMatch(/Inmobiliaria firma contratos con n[uú]meros exactos/);
  });
});

describe("Hotfix-22 c1 — COMMERCIAL_LAYER ejemplos al cliente sin bullets/bold", () => {
  it("Test 4: ejemplos al cliente NO tienen ** markdown bold", () => {
    // Extraer solo los blockquotes (lineas que empiezan con > " — ejemplos al cliente).
    const lineasEjemplo = COMMERCIAL_LAYER.split("\n").filter(l => l.startsWith("> \""));
    // Ningun ejemplo al cliente debe tener ** (bold markdown).
    for (const linea of lineasEjemplo) {
      expect(linea, `Ejemplo al cliente con ** markdown: ${linea}`).not.toMatch(/\*\*/);
    }
    // Sanity: hay al menos algunos ejemplos al cliente extraidos.
    expect(lineasEjemplo.length).toBeGreaterThan(0);
  });

  it("Test 5: ejemplos al cliente SIN cifras de inventario — placeholders del vivo (Sprint1.8 PR-1)", () => {
    // Sprint1.8 PR-1: las cifras literales de los ejemplos (99,000 / 9,900 /
    // 19,850 / 69,500 / 5,650,000 / "42 de 50") drifteaban y el LLM las
    // recitaba. Ahora los ejemplos son estructura con placeholders y los
    // montos salen EXACTOS del inventario vivo.
    expect(COMMERCIAL_LAYER).not.toContain("US$99,000");
    expect(COMMERCIAL_LAYER).not.toContain("US$9,900");
    expect(COMMERCIAL_LAYER).not.toContain("US$19,850");
    expect(COMMERCIAL_LAYER).not.toContain("US$69,500");
    expect(COMMERCIAL_LAYER).not.toContain("RD$5,650,000");
    expect(COMMERCIAL_LAYER).not.toMatch(/42 de 50/);
    expect(COMMERCIAL_LAYER).toMatch(/\[precio exacto[^\]]*INVENTARIO\]/);
    expect(COMMERCIAL_LAYER).toMatch(/jamas de memoria|jamas cifras de memoria/i);
  });
});

describe("Hotfix-22 c1 — SKILL calculadora tiene seccion 'CÓMO PRESENTAR AL CLIENTE'", () => {
  it("Test 6: skill tiene la nueva seccion + caso 16-412 reescrito en prosa", () => {
    const skill = readFileSync(SKILL_PATH, "utf-8");
    // Anchor de la nueva seccion (post-Hotfix-22 c1).
    expect(skill).toMatch(/CÓMO PRESENTAR AL CLIENTE/);
    expect(skill).toContain("siempre prosa");
    // Caso 16-412 referencia interna (code block) Y respuesta al cliente (prosa).
    // El skill debe mostrar AMBAS para que Mateo aprenda la diferencia.
    expect(skill).toContain("Apartas con $2,000");
    expect(skill).toContain("$3,308.57 mensuales");
    expect(skill).toContain("$708.57 mensuales");
    // Regla explicita: bullets/code blocks son referencia interna, no copy al cliente.
    expect(skill).toMatch(/referencia INTERNA/i);
    // Anti-ejemplo presente para ensenar contraste.
    expect(skill).toMatch(/MAL.*Plan 16-412/s);
  });
});
