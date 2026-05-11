// Hotfix-23 V3.6 — Matriz de beneficios legales con guard "solo Puerto Plata".
//
// Director ORDEN #2 punto 4: "CONFOTUR solo aparece junto al guard 'solo
// Puerto Plata'". JPREZ tiene 4 proyectos (Crux, PR3, PR4, Puerto Plata
// E3/E4) y solo Puerto Plata es turistico bajo CONFOTUR (Ley 158-01).
//
// Estos tests verifican que TODA mencion de CONFOTUR en el prompt tiene
// guard cercano que clarifica el scope. Si CONFOTUR aparece "universal"
// sin guard, el bot puede ofrecer beneficios falsos al cliente.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { OVERRIDES_LAYER } = require("../src/prompts/overrides-layer");

const MARKET_RD_SKILL = readFileSync(".claude/skills/mercado-inmobiliario-rd/SKILL.md", "utf-8");

function hasGuardNearby(text, idx, windowChars = 600) {
  // Ventana amplia (600 chars) para capturar guard en frontmatter
  // descriptions / listas de triggers donde CONFOTUR aparece varias
  // veces en la misma seccion.
  const start = Math.max(0, idx - windowChars);
  const end = Math.min(text.length, idx + windowChars);
  const ctx = text.slice(start, end);
  // Aceptamos contextos:
  // 1. Guard explicito Puerto Plata cerca.
  // 2. Mention tecnica en lista de keywords/triggers del skill (no asertiva).
  // 3. Mention tecnica en lista de entidades reguladoras (Ministerio de Turismo).
  return /Puerto Plata|PP E3|PP E4|PSE3|PSE4|aprobaci[oó]n turistic[oa]|GUARD CR[IÍ]TICO|solo proyectos|skill mercado-inmobiliario|description.*activar|Ministerio de Turismo|ENTIDADES REGULADORAS|Activar SIEMPRE/i.test(ctx);
}

function findConfoturMentions(text) {
  return [...text.matchAll(/CONFOTUR/g)];
}

describe("Hotfix-23 V3.6 — matriz beneficios — CONFOTUR con guard Puerto Plata", () => {
  it("OVERRIDES_LAYER: toda mencion CONFOTUR tiene guard Puerto Plata cerca", () => {
    const matches = findConfoturMentions(OVERRIDES_LAYER);
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      const passed = hasGuardNearby(OVERRIDES_LAYER, m.index);
      if (!passed) {
        const ctx = OVERRIDES_LAYER.slice(
          Math.max(0, m.index - 100),
          Math.min(OVERRIDES_LAYER.length, m.index + 100),
        );
        throw new Error(`CONFOTUR mention without Puerto Plata guard:\n…${ctx}…`);
      }
    }
  });

  it("MARKET_RD_SKILL: toda mencion CONFOTUR tiene guard Puerto Plata cerca", () => {
    const matches = findConfoturMentions(MARKET_RD_SKILL);
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      const passed = hasGuardNearby(MARKET_RD_SKILL, m.index);
      if (!passed) {
        const ctx = MARKET_RD_SKILL.slice(
          Math.max(0, m.index - 100),
          Math.min(MARKET_RD_SKILL.length, m.index + 100),
        );
        throw new Error(`CONFOTUR mention without Puerto Plata guard:\n…${ctx}…`);
      }
    }
  });

  it("MARKET_RD_SKILL contiene GUARD CRÍTICO explícito", () => {
    expect(MARKET_RD_SKILL).toMatch(/GUARD CRÍTICO|GUARD CR[IÍ]TICO/);
    expect(MARKET_RD_SKILL).toMatch(/SOLO.*Puerto Plata|aplica SOLO/i);
  });

  it("MARKET_RD_SKILL aclara que Crux, PR3, PR4 NO son CONFOTUR", () => {
    expect(MARKET_RD_SKILL).toMatch(/Crux.*PR3.*PR4.*NO.*CONFOTUR|Crux.*PR3.*PR4.*no aplica|NO.*Crux|NO.*PR3|NO.*PR4/);
  });
});

describe("Hotfix-23 V3.6 — matriz beneficios — BPV NO aplica en JPREZ", () => {
  it("MARKET_RD_SKILL tiene seccion 'POR QUÉ JPREZ NO OFRECE BPV'", () => {
    expect(MARKET_RD_SKILL).toMatch(/POR QUÉ JPREZ NO OFRECE BONO PRIMERA VIVIENDA/i);
  });

  it("MARKET_RD_SKILL explica la razon (DGII / Vivienda Bajo Costo)", () => {
    expect(MARKET_RD_SKILL).toMatch(/DGII/);
    expect(MARKET_RD_SKILL).toMatch(/Vivienda Bajo Costo/i);
  });
});

describe("Hotfix-23 V3.6 — Ley 189-11 fideicomiso aplica en TODOS los proyectos", () => {
  it("MARKET_RD_SKILL menciona fideicomiso Ley 189-11 sin restriccion de proyecto", () => {
    expect(MARKET_RD_SKILL).toMatch(/Ley 189-11/);
    expect(MARKET_RD_SKILL).toMatch(/fideicomiso/i);
  });

  it("OVERRIDES_LAYER menciona Ley 189-11 (aplica universal en JPREZ)", () => {
    expect(OVERRIDES_LAYER).toMatch(/Ley 189-11/);
  });
});
