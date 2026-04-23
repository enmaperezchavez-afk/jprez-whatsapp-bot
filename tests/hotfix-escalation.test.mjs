// Tests del hotfix Día 3 #1: refuerzo del trigger de brochure en el prompt
// Tests del hotfix Día 3 #2: modo escalado con holding messages (no silencio)
//
// Nota: no probamos el flujo completo con Claude real — eso requiere mocks
// de red complejos y valor marginal. Tests apuntan a los invariantes
// verificables estáticamente: texto del prompt presente y helpers exportados.

import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { buildSystemPrompt } = require("../src/prompts");

describe("Hotfix #1: trigger de brochure obligatorio", () => {
  it("buildSystemPrompt incluye instruccion OBLIGATORIA de frase gatillo", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("OBLIGATORIAS");
  });

  it("buildSystemPrompt lista las frases gatillo exactas que el detector reconoce", () => {
    const prompt = buildSystemPrompt();
    // Subset clave del set de gatillos documentado.
    expect(prompt).toContain("te lo mando ahora");
    expect(prompt).toContain("te lo paso");
    expect(prompt).toContain("te envío el brochure");
    expect(prompt).toContain("te mando el brochure");
  });

  it("buildSystemPrompt aclara que el brochure COMPLEMENTA el texto", () => {
    const prompt = buildSystemPrompt();
    expect(prompt.toLowerCase()).toContain("complementa");
  });

  it("buildSystemPrompt incluye ejemplo concreto del patrón (precio + gatillo + pregunta)", () => {
    const prompt = buildSystemPrompt();
    // El ejemplo muestra la respuesta esperada para "3 hab en Crux"
    expect(prompt).toContain("Crux del Prado");
    expect(prompt).toContain("US$98K");
  });

  it("buildSystemPrompt respeta regla: si el brochure ya fue enviado, NO re-enviar", () => {
    const prompt = buildSystemPrompt();
    expect(prompt.toLowerCase()).toContain("documentos_enviados");
  });
});

describe("Hotfix #2: detector de gatillos sigue reconociendo las frases documentadas", () => {
  // Validamos que el prompt y src/detect.js siguen hablando el mismo idioma:
  // cada frase que el prompt le enseña a Mateo, detect.js debe poder detectarla.
  const { detectDocumentRequest } = require("../src/detect");

  it("detecta 'te lo mando ahora' + nombre de proyecto", () => {
    const reply = "Mira, arranca desde US$98K. Te lo mando ahora para Crux del Prado.";
    const user = "cuanto cuesta crux";
    expect(detectDocumentRequest(reply, user)).toBe("crux");
  });

  it("detecta 'te mando el brochure' con nombre de proyecto", () => {
    const reply = "Te mando el brochure de Prado Residences 3 para que veas el detalle.";
    const user = "info del pr3";
    expect(detectDocumentRequest(reply, user)).toBe("pr3");
  });

  it("detecta 'te lo paso' + proyecto", () => {
    const reply = "Claro, te lo paso ahora mismo para que veas Prado Residences 4.";
    const user = "quiero info de pr4";
    expect(detectDocumentRequest(reply, user)).toBe("pr4");
  });

  it("detecta gatillo con Puerto Plata", () => {
    const reply = "Te envío el brochure de Prado Suites Puerto Plata.";
    const user = "quiero ver puerto plata";
    expect(detectDocumentRequest(reply, user)).toBe("puertoPlata");
  });

  it("sin frase gatillo: no dispara envio aunque haya nombre de proyecto", () => {
    const reply = "En Crux arranca desde US$98K. ¿Quieres piso alto?";
    const user = "precio crux";
    expect(detectDocumentRequest(reply, user)).toBeNull();
  });
});

describe("Hotfix #2: HOLDING_MODE_CONTEXT tiene las reglas operativas clave", () => {
  // El HOLDING_MODE_CONTEXT vive dentro de src/handlers/message.js (no se
  // exporta — es consumido como string constant). Probamos via una importación
  // indirecta: construir el contexto via buildHoldingModeContext si estuviera
  // exportado, o leer el archivo y validar que las reglas estan.

  it("src/handlers/message.js contiene las 3 reglas NO del modo holding", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/handlers/message.js"),
      "utf8"
    );
    // Regla 1: no descuentos nuevos
    expect(source).toContain("NO ofrezcas descuentos nuevos");
    // Regla 2: no cerrar ventas sin Enmanuel
    expect(source).toContain("NO cierres ventas");
    // Regla 3: no prometer fechas
    expect(source).toContain("NO prometas fechas");
  });

  it("src/handlers/message.js contiene las 3 reglas SI del modo holding", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/handlers/message.js"),
      "utf8"
    );
    expect(source).toContain("SI manten al cliente calido");
    expect(source).toContain("SI responde preguntas generales");
    expect(source).toContain("SI ofrece informacion adicional util");
  });

  it("src/handlers/message.js instruye a NO emitir [ESCALAR] en holding", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/handlers/message.js"),
      "utf8"
    );
    expect(source).toContain("NO emitas [ESCALAR] en modo holding");
  });

  it("src/handlers/message.js skipea notify hot/escalation cuando inHoldingMode=true", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/handlers/message.js"),
      "utf8"
    );
    expect(source).toContain("isHotLead && !inHoldingMode");
    expect(source).toContain("needsEscalation && !inHoldingMode");
  });

  it("src/handlers/message.js conserva el recordatorio throttleado a Enmanuel", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/handlers/message.js"),
      "utf8"
    );
    // La notificacion sigue existiendo dentro del branch inHoldingMode
    expect(source).toContain("shouldRemindEnmanuel");
    expect(source).toContain("Mateo lo mantiene en holding");
  });

  it("src/handlers/message.js elimina el return temprano del branch escalado", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/handlers/message.js"),
      "utf8"
    );
    // El comentario viejo "Bot silenciado" ya no debe aparecer como estado actual.
    // El nuevo dice "responde en holding mode".
    expect(source).toContain("Mateo responde en holding mode");
    expect(source).not.toContain("Bot silenciado: escalamiento activo");
  });
});
