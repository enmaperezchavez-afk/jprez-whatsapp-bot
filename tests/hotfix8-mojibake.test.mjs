// Tests de hotfix-8 Día 4: encoding cleanup (UTF-8 → Latin-1 corruption).
//
// Reclasificación post-Fase-0: el mojibake en src/detect.js NO rompía
// detección porque stripAccents() ya normaliza inputs antes del match.
// Esta operación es cleanup honesto:
// - Quita dead-code mojibake en listas de detect.js (con stripAccents
//   estos strings nunca matcheaban inputs reales).
// - Arregla 2 emojis rotos en notify.js (UX visible al admin).
// - Corrige nombre del director en staff.js.
// - Reformula comentario histórico en prompts.js (citaba strings
//   corruptos como ejemplo, ya no es necesario).
//
// Test 1 (regression-guard ninja) escanea src/ recursivamente buscando
// patrones UTF-8 → Latin-1 corruption en CÓDIGO (no comentarios), para
// que documentación honesta de incidentes históricos siga siendo válida.

import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const SRC_DIR = join(PROJECT_ROOT, "src");

const require = createRequire(import.meta.url);
const { detectDocumentRequest, detectDocumentType } = require("../src/detect");
const { ENMANUEL_PHONE } = require("../src/notify");
const { STAFF_PHONES } = require("../src/staff");

describe("Hotfix-8 — Encoding integrity (UTF-8 → Latin-1 cleanup)", () => {
  it("no source file in src/ contains UTF-8→Latin-1 corruption in code (comments excluded)", async () => {
    const mojibakePattern = /[ÃÂ][©¡³­º±²§¦¬]/;
    const offenders = [];

    async function scan(dir) {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await scan(fullPath);
        } else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) {
          const content = await readFile(fullPath, "utf-8");
          // Quitar comentarios para que documentación de incidentes
          // históricos pueda citar strings corruptos sin gatillar el guard.
          const codeOnly = content
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/.*$/gm, "");
          if (mojibakePattern.test(codeOnly)) {
            offenders.push(fullPath);
          }
        }
      }
    }

    await scan(SRC_DIR);
    expect(offenders).toEqual([]);
  });

  it("detect normalizes accented input via stripAccents (intent matching survives tildes)", () => {
    // Si stripAccents se rompe, "catálogo"/"cuánto"/"distribución" no
    // matchearían las keywords sin tilde de las listas y types quedaría
    // vacío (fallback "brochure"). Estos asserts demuestran el contrato.
    expect(detectDocumentType("", "dame el catálogo")).toContain("brochure");
    expect(detectDocumentType("", "cuánto cuesta?")).toContain("precios");
    // Hotfix-19B: "distribución" → brochure (insight comercial: brochure ya
    // trae plantas tipo). Pre-Hotfix-19B mapeaba a "planos".
    expect(detectDocumentType("", "necesito la distribución")).toContain("brochure");
    // Mayúsculas + tildes (toLowerCase + stripAccents combinados).
    expect(detectDocumentType("", "CUÁNTO CUESTA")).toContain("precios");
  });

  it("detect returns identical result for accented vs unaccented client input", () => {
    // Mismo intent independientemente de si el cliente escribe con o sin tilde.
    const withAccent = detectDocumentRequest(
      "te mando el catálogo",
      "dame catálogo de crux"
    );
    const withoutAccent = detectDocumentRequest(
      "te mando el catalogo",
      "dame catalogo de crux"
    );
    expect(withAccent).toBe(withoutAccent);
    expect(withAccent).toBe("crux");

    // detectDocumentType también determinístico ante variaciones de tilde.
    const t1 = detectDocumentType("", "necesito información de precios");
    const t2 = detectDocumentType("", "necesito informacion de precios");
    expect(t1).toEqual(t2);
    expect(t1).toContain("precios");
  });

  it("notify.js notification templates contain correct UTF-8 emojis (not mojibake)", async () => {
    const notifyPath = join(SRC_DIR, "notify.js");
    const content = await readFile(notifyPath, "utf-8");
    // Emojis correctos presentes
    expect(content).toContain("🔥 LEAD CALIENTE");
    expect(content).toContain("⚠️ ESCALAMIENTO");
    // Mojibake de emoji ausente (ð¥ era 🔥 corrupto, â ï¸ era ⚠️ corrupto)
    expect(content).not.toContain("ð¥");
    expect(content).not.toContain("â ï");
    // Texto plano sin mojibake en bloques de notificación
    expect(content).toContain("Teléfono:");
    expect(content).toContain("Último mensaje");
    expect(content).toContain("Acción sugerida");
    expect(content).toContain("Razón:");
    expect(content).toContain("atención humana");
  });

  it("STAFF director name is verbatim 'Enmanuel Pérez Chávez'", () => {
    const director = STAFF_PHONES[ENMANUEL_PHONE];
    expect(director).toBeDefined();
    expect(director.name).toBe("Enmanuel Pérez Chávez");
    expect(director.role).toBe("director");
    expect(director.supervisor).toBe(true);
  });
});
