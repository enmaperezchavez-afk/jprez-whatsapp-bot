// Hotfix-23 V3.6 — Proceso comercial 5 pasos + reserva US$1K/$2K.
//
// El Director veto el bug "Mateo salta directo al 10% sin presentar
// reserva" (doc V3.6 §4 + §7). Estos tests validan que OVERRIDES_LAYER
// contiene la doctrina canonica del proceso comercial:
//
//   - 5 pasos: reserva → KYC → recopilacion → vinculacion → contrato
//   - Reserva: Crux $1K / PR3/PR4/PP $2K
//   - Excepcion comercial: $1K aceptado pero no ofrecido de entrada
//   - Contrato no llega hasta 10% completo
//   - "Mateo NO salta directo al 10%"

import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { OVERRIDES_LAYER } = require("../src/prompts/overrides-layer");

describe("Hotfix-23 V3.6 — proceso comercial 5 pasos", () => {
  it("OVERRIDES contiene anchor 'PROCESO COMERCIAL JPREZ'", () => {
    expect(OVERRIDES_LAYER).toMatch(/PROCESO COMERCIAL JPREZ/i);
  });

  it("OVERRIDES contiene los 5 pasos con sus labels", () => {
    expect(OVERRIDES_LAYER).toMatch(/PASO 1 — RESERVA/i);
    expect(OVERRIDES_LAYER).toMatch(/PASO 2 — INICIO DE VINCULACIÓN/i);
    expect(OVERRIDES_LAYER).toMatch(/PASO 3 — RECOPILACIÓN Y DEPURACIÓN/i);
    expect(OVERRIDES_LAYER).toMatch(/PASO 4 — VINCULACIÓN A LA UNIDAD/i);
    expect(OVERRIDES_LAYER).toMatch(/PASO 5 — FIRMA DEL CONTRATO/i);
  });

  it("OVERRIDES especifica reserva US$1,000 Crux + US$2,000 PR3/PR4/PP", () => {
    expect(OVERRIDES_LAYER).toMatch(/Crux del Prado.*US\$1,000/i);
    expect(OVERRIDES_LAYER).toMatch(/PR3.*PR4.*Puerto Plata.*US\$2,000|US\$2,000.*PR3.*PR4|US\$2,000.*Puerto Plata/i);
  });

  it("OVERRIDES contiene excepcion comercial $1K aceptado pero no ofrecido", () => {
    expect(OVERRIDES_LAYER).toMatch(/Excepción comercial|excepción comercial/);
    // El cliente que llega con $1K se acepta, pero Mateo NO lo ofrece de entrada.
    expect(OVERRIDES_LAYER).toMatch(/NO lo ofrece de entrada|empuja al US\$2,000/i);
  });

  it("OVERRIDES contiene regla dura: contrato NO llega hasta 10% completo", () => {
    expect(OVERRIDES_LAYER).toMatch(/contrato.*NO llega.*10%|10%.*completo.*contrato|regla dura/i);
  });

  it("OVERRIDES tiene regla 'Mateo NO salta directo al 10%'", () => {
    expect(OVERRIDES_LAYER).toMatch(/Mateo NUNCA salta directo al 10%|NO salta directo|SIEMPRE empieza por la reserva/i);
  });

  it("OVERRIDES describe KYC fiduciaria como parte del paso 2", () => {
    expect(OVERRIDES_LAYER).toMatch(/formulario de la fiduciaria.*KYC|KYC.*fiduciaria/i);
  });
});

describe("Hotfix-23 V3.6 — documentos por perfil 3 listas", () => {
  it("OVERRIDES contiene anchor DOCUMENTOS POR PERFIL", () => {
    expect(OVERRIDES_LAYER).toMatch(/DOCUMENTOS POR PERFIL/);
  });

  it("OVERRIDES contiene los 3 perfiles canonicos", () => {
    expect(OVERRIDES_LAYER).toMatch(/Dominicano asalariado/i);
    expect(OVERRIDES_LAYER).toMatch(/Dominicano no asalariado.*negocio propio/i);
    expect(OVERRIDES_LAYER).toMatch(/^### Extranjero/m);
  });

  it("Asalariado pide carta de trabajo (no IR-2)", () => {
    // Verificamos que en la seccion asalariado aparece "carta de trabajo".
    const asalariadoIdx = OVERRIDES_LAYER.indexOf("Dominicano asalariado");
    const noAsalariadoIdx = OVERRIDES_LAYER.indexOf("Dominicano no asalariado");
    expect(asalariadoIdx).toBeGreaterThan(-1);
    expect(noAsalariadoIdx).toBeGreaterThan(asalariadoIdx);
    const seccion = OVERRIDES_LAYER.slice(asalariadoIdx, noAsalariadoIdx);
    expect(seccion).toMatch(/Carta de trabajo/i);
  });

  it("No-asalariado pide IR-2", () => {
    expect(OVERRIDES_LAYER).toMatch(/IR-2/);
  });

  it("Extranjero pide pasaporte vigente + ID adicional", () => {
    expect(OVERRIDES_LAYER).toMatch(/Pasaporte vigente.*ID adicional/i);
  });

  it("Los 3 perfiles piden KYC fiduciaria + 3m estados de cuenta", () => {
    expect(OVERRIDES_LAYER).toMatch(/Formulario fiduciaria \(KYC\)/);
    expect(OVERRIDES_LAYER).toMatch(/Estados de cuenta últimos 3 meses/i);
  });
});
