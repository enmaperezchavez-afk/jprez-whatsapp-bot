// Hotfix-21 c2 — Image tracking + policy guard para JPG.
//
// Bug #23 followup: en C1 bloqueamos PDFs duplicados via shouldSendDoc.
// Imagenes (sendProjectImages) NO estaban trackeadas en sentDocs ni
// pasaban por policy guard — siempre se reenviaban como teaser pre-brochure
// o post-precios.
//
// Fix:
//   - markDocSent(storageKey, "<proj>.images") despues de cada sendProjectImages
//   - shouldSendDoc({ docKey: "<proj>.images" }) ANTES de cada sendProjectImages
//   - DOC_TYPE_NAMES.images = "Inventario JPG" para que buildClientContext
//     muestre las imagenes en el contexto del prompt
//
// Cobertura (5 tests):
//   1. DOC_TYPE_NAMES.images = "Inventario JPG"
//   2. buildClientContext lista images en "Documentos ya enviados antes"
//   3. buildClientContext combina varios docTypes (brochure + images del mismo proj)
//   4. Source: 3 sites de sendProjectImages envueltos con shouldSendDoc({docKey: ".images"})
//   5. Source: logs img_skip_already_sent + img_send_explicit_retransmit + markDocSent ".images"

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { DOC_TYPE_NAMES, buildClientContext } = require("../src/handlers/message");

describe("Hotfix-21 c2 — DOC_TYPE_NAMES extension", () => {
  it("Test 1: DOC_TYPE_NAMES.images mapeado a 'Inventario JPG'", () => {
    expect(DOC_TYPE_NAMES.images).toBe("Inventario JPG");
    // Sanity: las entradas existentes siguen intactas.
    expect(DOC_TYPE_NAMES.brochure).toBe("Brochure");
    expect(DOC_TYPE_NAMES.precios).toBe("Precios y Disponibilidad");
  });
});

describe("Hotfix-21 c2 — buildClientContext lista imagenes", () => {
  it("Test 2: sentDocs con .images aparece en el contexto", () => {
    const meta = {
      name: "Cliente Test",
      sentDocs: {
        "crux.images": "2026-05-05T18:30:00Z",
      },
    };
    const ctx = buildClientContext(meta);
    expect(ctx).toContain("Crux del Prado (Inventario JPG)");
    expect(ctx).toContain("Documentos ya enviados antes:");
  });

  it("Test 3: sentDocs con varios docTypes — brochure + images del mismo proyecto", () => {
    const meta = {
      sentDocs: {
        "crux.brochure": "2026-05-05T18:00:00Z",
        "crux.images": "2026-05-05T18:01:00Z",
        "puertoPlata.preciosE4": "2026-05-04T10:00:00Z",
      },
    };
    const ctx = buildClientContext(meta);
    expect(ctx).toContain("Crux del Prado (Brochure)");
    expect(ctx).toContain("Crux del Prado (Inventario JPG)");
    expect(ctx).toContain("Prado Suites Puerto Plata");
    // La regla "no re-envies" sigue presente para el LLM.
    expect(ctx).toContain("NO re-envies documentos que figuran como ya enviados");
  });
});

// === Source-inspection del handler ===

const HANDLER_SRC = readFileSync("src/handlers/message.js", "utf-8");

describe("Hotfix-21 c2 — handler image policy guard (source)", () => {
  it("Test 4: 3 sites de sendProjectImages envueltos con policy guard ('<proj>.images')", () => {
    // Esperado: 3 invocaciones de shouldSendDoc con docKey terminando en ".images"
    const matches = HANDLER_SRC.match(/docKey:\s*[a-zA-Z]+(?:Key)?\s*\+\s*["']\.images["']/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it("Test 5: logs img_skip_already_sent + img_send_explicit_retransmit + markDocSent('.images') emitidos", () => {
    // Cada uno de los 3 sites emite img_skip_already_sent cuando bloquea.
    const skipMatches = HANDLER_SRC.match(/img_skip_already_sent/g) || [];
    expect(skipMatches.length).toBeGreaterThanOrEqual(3);

    // Override log emitido cuando reason === "explicit-retransmit".
    const retxMatches = HANDLER_SRC.match(/img_send_explicit_retransmit/g) || [];
    expect(retxMatches.length).toBeGreaterThanOrEqual(3);

    // markDocSent con ".images" llamado en cada site post-envio.
    const markMatches = HANDLER_SRC.match(/markDocSent\(storageKey,\s*[a-zA-Z]+(?:Key)?\s*\+\s*["']\.images["']\)/g) || [];
    expect(markMatches.length).toBeGreaterThanOrEqual(3);
  });
});
