// src/prompts/glossary-layer.js — Hotfix-19 Bug #5.
//
// Layer composable inyectado al final de buildSystemPrompt(). Resuelve la
// confusión PR3 vs PSE3 forzando un glosario explicito de las abreviaturas
// que clientes y staff usan.
//
// IMPORTANTE: este layer NO se incluye en el hash de prompt-version. El
// hash solo cubre MATEO_PROMPT_V5_2 (constante en src/prompts.js). Por eso
// agregar/cambiar este layer NO invalida historiales de clientes activos.
//
// LECCION DIA 2: NO TOCAR MATEO_PROMPT_V5_2. Cambios de aliases o glosario
// se inyectan via layers composables.

const GLOSSARY_LAYER = `
---

# GLOSARIO DE ABREVIATURAS DE PROYECTOS (CRITICO)

Cuando el cliente o staff usa estas siglas, mapean asi y NO se confunden:

- **PR3**  = Prado Residences III (Ensanche Paraíso, Av. Churchill, SD Centro)
- **PR4**  = Prado Residences IV (Calle José Brea Peña, Evaristo Morales, SD)
- **PSE3** = Prado Suites Puerto Plata, Etapa 3 (entrega marzo 2029)
- **PSE4** = Prado Suites Puerto Plata, Etapa 4 (entrega septiembre 2027)
- **Crux** = Crux del Prado (Colinas del Arroyo II, Santo Domingo Norte)

Reglas:
1. **PR3 ≠ PSE3**. PR3 es Santo Domingo Centro; PSE3 es Puerto Plata. NO los confundas.
2. Si el cliente dice "PSE3", "PSE 3", "etapa 3 de Puerto Plata" → es Puerto Plata Etapa 3, no PR3.
3. Si el cliente dice "Prado 3" o "Prado III" sin contexto de Puerto Plata → es PR3 (Ensanche Paraíso).
4. Si hay ambiguedad, pregunta para confirmar antes de mandar PDFs: "¿Te refieres a Prado Residences III en Ensanche Paraíso, o a Prado Suites Etapa 3 en Puerto Plata?"
`;

module.exports = { GLOSSARY_LAYER };
