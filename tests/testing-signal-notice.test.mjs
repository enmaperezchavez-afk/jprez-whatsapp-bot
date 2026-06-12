// Sprint1.7 PR-4 — señales con prefijo [SUPERVISOR] en modo testing.
//
// Antes: en testing las notificaciones se suprimían en silencio y el
// Director no sabía qué señal habría disparado su prueba. Ahora cada
// supresión va acompañada de un aviso prefijado para distinguir la
// telemetría del sistema de lo que el cliente real vería.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

describe("PR-4 — avisos [SUPERVISOR] en testing", () => {
  const handler = readFileSync("src/handlers/message.js", "utf8");

  it("el helper existe, es best-effort y lleva el prefijo claro", () => {
    expect(handler).toMatch(/async function avisarSenalTesting/);
    expect(handler).toMatch(/\[SUPERVISOR\] \(testing\) Señal disparada/);
    expect(handler).toMatch(/El cliente NO ve este mensaje/);
    expect(handler).toMatch(/testing_signal_notice_failed/); // nunca rompe el turno
  });

  it("TODAS las supresiones de testing avisan (cero señales silenciosas)", () => {
    // Cada botLog de supresión debe ir seguido del aviso.
    const supresiones = handler.match(/notify_suppressed_testing/g) || [];
    const avisos = handler.match(/await avisarSenalTesting\(/g) || [];
    // -1: la mención en el comentario explicativo del bloque original
    const supresionesReales = supresiones.length - (handler.includes('"notify_suppressed_testing" a Axiom') ? 1 : 0);
    expect(avisos.length).toBe(supresionesReales);
    expect(avisos.length).toBeGreaterThanOrEqual(6);
  });

  it("las señales clave tienen nombre humano en el aviso", () => {
    expect(handler).toContain('"LEAD CALIENTE"');
    expect(handler).toContain('"ESCALACION A ENMANUEL"');
    expect(handler).toContain('"AGENDAMIENTO DE VISITA"');
    expect(handler).toContain('"DESCUENTO OFRECIDO"');
  });
});
