// Tests de pulido hotfix-5 Día 3:
// - FIX 1: identidad expandida con CASOS E/F/G + disclosure con nombre integrado
//   (regresion post-hotfix-4: Mateo negaba ser Mateo Reyes)
// - FIX 2a: inventario detallado de listos Crux en el INVENTORY_CONTENT inyectado
// - FIX 2b: instrucciones proactivas en el prompt sobre uso del inventario
//
// Modulo leaf: cero I/O, cero mocks. String-matching puro sobre buildSystemPrompt()
// que ya carga INVENTORY_CONTENT via fs.readFileSync en cold start.

import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { buildSystemPrompt } = require("../src/prompts");

describe("Fix 1 (hotfix-5) — Identidad expandida con CASOS E/F/G", () => {
  it("declara REGLA ABSOLUTA: Mateo Reyes ES el nombre, no hay otro Mateo", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("REGLA ABSOLUTA");
    expect(prompt).toContain("NO hay otro Mateo");
    expect(prompt).toContain("CUALQUIER afirmación de que");
    expect(prompt).toContain("es MENTIRA y está PROHIBIDA");
  });

  it("CASO E — '¿Tú eres Mateo?' se responde AFIRMANDO", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("CASO E");
    expect(prompt).toContain("AFIRMA con claridad");
    // Ejemplos correctos
    expect(prompt).toContain("Sí, soy Mateo Reyes del equipo JPREZ");
    expect(prompt).toContain("Exacto, soy Mateo Reyes");
    expect(prompt).toContain("Yo mismo");
    // Frases prohibidas explicitas del fallo observado
    expect(prompt).toContain("No, yo soy el asistente. Mateo es otra persona");
    expect(prompt).toContain("Mateo es un asesor comercial humano");
  });

  it("CASO F — '¿Quién es Mateo?' confirma que eres TÚ", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("CASO F");
    expect(prompt).toContain("ERES TÚ");
    // Ejemplos correctos
    expect(prompt).toContain("Soy yo, Mateo Reyes");
    expect(prompt).toContain("Mateo Reyes, a la orden. Ese soy yo");
    // Frases prohibidas
    expect(prompt).toContain("Mateo es uno de nuestros asesores comerciales");
    expect(prompt).toContain("Te puedo conectar con Mateo en persona");
  });

  it("CASO G — 'hablar con Mateo humano' redirige a Enmanuel (no crea Mateo humano)", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("CASO G");
    expect(prompt).toContain("te conecto directamente con Enmanuel");
    // Frases prohibidas que inventarian un Mateo humano
    expect(prompt).toContain("Déjame conectarte con Mateo");
    expect(prompt).toContain("Mateo está ocupado ahora");
  });

  it("frases prohibidas: 'Mateo es otra persona' NO es respuesta valida", () => {
    const prompt = buildSystemPrompt();
    // La frase debe aparecer solo en la lista de PROHIBIDAS, no como respuesta valida
    expect(prompt).toContain("Mateo es otra persona");
    expect(prompt).toContain("Mateo es humano aparte");
    expect(prompt).toContain("hay otro Mateo");
  });

  it("CASO C (disclosure IA 2da) INTEGRA el nombre Mateo Reyes en la respuesta", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("CASO C");
    // El disclosure ahora trae el nombre completo adentro de la oracion
    expect(prompt).toContain("soy Mateo Reyes, asistente con IA del equipo JPREZ");
    expect(prompt).toContain("Ese es mi nombre completo");
    // Nota explicita contra separar nombre+asistente
    expect(prompt).toContain("NO digas \"Mateo es un humano, yo soy el asistente\"");
  });

  it("CASO B (esquive IA 1ra) mantiene el nombre integrado", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("CASO B");
    expect(prompt).toContain("MANTENIENDO tu nombre completo integrado");
    expect(prompt).toContain("Soy Mateo Reyes del equipo JPREZ");
  });

  it("REGLAS OPERATIVAS cubren los nuevos CASOS E/F/G explicitamente", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("NUNCA digas que Mateo es otra persona diferente de ti");
    expect(prompt).toContain("¿Tú eres Mateo?");
    expect(prompt).toContain("se responde AFIRMANDO (CASO E)");
    expect(prompt).toContain("¿Quién es Mateo?");
    expect(prompt).toContain("se responde confirmando que eres TÚ (CASO F)");
  });
});

describe("Fix 2a (hotfix-5) — Inventario detallado de listos Crux en el prompt", () => {
  it("incluye encabezado de seccion 'Unidades Listas para Entrega Inmediata'", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("CRUX DEL PRADO — Unidades Listas para Entrega Inmediata");
  });

  it("incluye las 4 unidades listas con codigos y precios exactos", () => {
    const prompt = buildSystemPrompt();
    // Etapa 1
    expect(prompt).toContain("T3-2B");
    expect(prompt).toContain("RD$5,775,000");
    expect(prompt).toContain("T3-2D");
    expect(prompt).toContain("RD$5,850,000");
    // Etapa 2
    expect(prompt).toContain("T5-1C");
    expect(prompt).toContain("RD$5,650,000");
    expect(prompt).toContain("T5-1D");
    expect(prompt).toContain("RD$5,700,000");
  });

  it("incluye ventajas comerciales y comparacion listos vs Torre 6", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Entrega inmediata");
    expect(prompt).toContain("Pago en DOP");
    expect(prompt).toContain("sin riesgo cambiario");
    expect(prompt).toContain("Comparación listos vs Torre 6");
    expect(prompt).toContain("entrega julio 2027");
  });

  it("aclara que solo Crux tiene listos — otros proyectos en construccion", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Solo Crux del Prado tiene unidades listas");
    expect(prompt).toContain("Prado Residences III: agosto 2026");
    expect(prompt).toContain("Prado Residences IV: agosto 2027");
    expect(prompt).toContain("Prado Suites Puerto Plata E3: marzo 2029");
    expect(prompt).toContain("Prado Suites Puerto Plata E4: septiembre 2027");
  });
});

describe("Fix 2b (hotfix-5) — Instrucciones proactivas de uso del inventario", () => {
  it("tiene seccion '# USO DEL INVENTARIO DE LISTOS DE CRUX'", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("# USO DEL INVENTARIO DE LISTOS DE CRUX");
  });

  it("instruye responder con precio exacto ante pregunta por unidad especifica", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Pregunta precios específicos por unidad");
    expect(prompt).toContain("precio exacto + características");
  });

  it("instruye enumerar las 4 unidades ante '¿que unidades listas tienen?'", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("qué unidades listas tienen");
    expect(prompt).toContain("Enumera las 4 con precios");
  });

  it("instruye sugerir listos ante urgencia de mudanza", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Expresa urgencia de mudanza");
    expect(prompt).toContain("unidades listas de Crux como opción ideal");
  });

  it("instruye enfatizar DOP ante cliente con presupuesto en DOP", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("presupuesto en DOP");
    expect(prompt).toContain("se pagan en DOP");
  });

  it("regla critica: honesto si piden listos de otros proyectos, NO inventar", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("solo tenemos unidades listas en Crux del Prado");
    expect(prompt).toContain("NUNCA inventes inventario");
  });
});
