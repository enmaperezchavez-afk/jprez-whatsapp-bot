// Tests de hotfix-10 Día 4: observabilidad de logs Axiom.
//
// MOTIVACIÓN: el viernes 24-abr Bug #4 (admin no identificado como
// supervisor por flag testing-mode stuck) tomó ~5 hrs de diagnosis
// porque los logs Axiom no incluían `isSupervisor`, `storageKey` ni
// `activePrompt`. Sin esos 3 campos no se podía distinguir, mirando un
// log, si el bot estaba cargando SUPERVISOR_PROMPT o MATEO_PROMPT_V5_2
// para Enmanuel.
//
// Cambios mínimos en src/handlers/message.js:
//  - Log "Mensaje recibido" (línea 471): + isSupervisor, storageKey,
//    activePrompt (nombre del prompt, NO el texto completo de ~4000 chars).
//  - Log "Respuesta enviada" (línea 592): + isSupervisor, activePrompt.
//  - Reorden mínimo: const isSupervisor sube 1 línea para evitar TDZ
//    al usarse en el log "Mensaje recibido".
//
// Patrón de tests: string-matching estático sobre el código fuente
// (consistente con hotfix3-polish, hotfix5-identity-inventory,
// hotfix7-supervisor-identity, hotfix8-mojibake). Verifica el
// CONTRATO de los logs sin necesidad de mockear todo el pipeline
// (Redis + Anthropic + WhatsApp + Axiom).

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const HANDLER_PATH = join(PROJECT_ROOT, "src", "handlers", "message.js");

describe("Hotfix-10 — Observabilidad: 3 campos críticos en logs Axiom", () => {
  it("log 'Mensaje recibido' incluye isSupervisor, storageKey y activePrompt (ternario, NO texto)", async () => {
    const content = await readFile(HANDLER_PATH, "utf-8");
    // Aislar el botLog "Mensaje recibido" (puede ser multilinea pero
    // hoy es 1 línea). Toma desde botLog( hasta el primer ); inclusive.
    const m = content.match(/botLog\([^)]*"Mensaje recibido"[^;]*\);/);
    expect(m, "no se encontró botLog('Mensaje recibido')").not.toBeNull();
    const logCall = m[0];
    expect(logCall).toContain("isSupervisor");
    expect(logCall).toContain("storageKey");
    expect(logCall).toContain("activePrompt");
    // El valor de activePrompt en el log DEBE ser el ternario con los
    // nombres como string corto, NO la variable `activePrompt` (que
    // contiene el texto completo del prompt, ~4000 chars).
    expect(logCall).toMatch(
      /activePrompt:\s*isSupervisor\s*\?\s*"SUPERVISOR_PROMPT"\s*:\s*"CLIENT_PROMPT"/
    );
    // Sigue conservando los campos previos
    expect(logCall).toContain("phone");
    expect(logCall).toContain("isStaff");
    expect(logCall).toContain("testing");
  });

  it("log 'Respuesta enviada' incluye isSupervisor y activePrompt (ternario)", async () => {
    const content = await readFile(HANDLER_PATH, "utf-8");
    const m = content.match(/botLog\([^)]*"Respuesta enviada"[^;]*\);/);
    expect(m, "no se encontró botLog('Respuesta enviada')").not.toBeNull();
    const logCall = m[0];
    expect(logCall).toContain("isSupervisor");
    expect(logCall).toContain("activePrompt");
    expect(logCall).toMatch(
      /activePrompt:\s*isSupervisor\s*\?\s*"SUPERVISOR_PROMPT"\s*:\s*"CLIENT_PROMPT"/
    );
    // Sigue conservando los campos previos
    expect(logCall).toContain("phone");
    expect(logCall).toContain("responseLength");
  });

  it("anti-TDZ: 'const isSupervisor' aparece antes del log 'Mensaje recibido'", async () => {
    const content = await readFile(HANDLER_PATH, "utf-8");
    const declIdx = content.indexOf("const isSupervisor");
    const logIdx = content.indexOf('"Mensaje recibido"');
    expect(declIdx).toBeGreaterThan(-1);
    expect(logIdx).toBeGreaterThan(-1);
    // Si la declaración cae DESPUÉS del log → ReferenceError en runtime
    // por temporal dead zone (TDZ). Este test bloquea esa regresión.
    expect(declIdx).toBeLessThan(logIdx);
  });
});
