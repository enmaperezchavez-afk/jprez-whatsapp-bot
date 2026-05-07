// src/prompts/overrides-layer.js — Hotfix-22 V3 r2.
//
// Layer composable inyectado entre MARKET_RD_SKILL y STYLE_LAYER. Resuelve
// conflictos entre MATEO_V5_2 (constante historica) y los skills/layers
// actuales. NO redefine formato ni identidad — solo explicita que gana
// cuando hay contradiccion.
//
// HISTORIA: smoke post-PR #31 detecto que el bot seguia copiando el
// stencil corto de MATEO_V5_2:613-614 sobre "extranjeros" en vez de usar
// el skill mercado-inmobiliario-rd (Bug #30). Tambien que la regla "max
// 1 asterisco" en MATEO_V5_2:675 contradice "cero asteriscos" del
// STYLE_LAYER:120. Y que en cambios de tema mid-flujo el bot a veces no
// pivotaba a la nueva intencion. Este layer cierra los 4 huecos.
//
// 3 TRADEOFFS DOCUMENTADOS:
//
// 1. NO entra en hash MATEO_V5_2.
//    Verificado en src/handlers/message.js:573 — el hash usa
//    MATEO_PROMPT_V5_2 (constante en src/prompts.js), NO el staticBlock
//    completo. Agregar este layer NO invalida historiales activos.
//
// 2. Eficacia esperada ~85% (soft override via prompt).
//    Los overrides via system prompt son persuasion, no hard-rule. Para
//    100% se necesita post-processing — deferred a R4.
//
// 3. Inyeccion post-MARKET_RD pre-STYLE preserva last-seen-wins.
//    STYLE_LAYER sigue siendo la autoridad de formato.
//
// LECCION: NO TOCAR MATEO_V5_2. Resolver conflictos via OVERRIDES.

const OVERRIDES_LAYER = `
---

# OVERRIDES CRÍTICOS — autoridad sobre stencils históricos

Resuelven conflictos entre MATEO_V5_2 y los skills actuales.

## 1. Skill mercado-inmobiliario-rd manda sobre stencil "Top 9"

El stencil corto de MATEO_V5_2 sobre extranjeros (objeción #7) es saludo inicial, no respuesta canónica. Para preguntas cubiertas por la "description" del skill mercado-inmobiliario-rd (banco, financiamiento, fideicomiso, extranjero, dominicano exterior, CONFOTUR, IPI, notario, Bono Primera Vivienda, Ley 189-11, 158-01, proceso compra, impuestos), USA el skill — NO el stencil.

## 2. Prioridad de intención actual

Si el cliente pregunta algo NUEVO en su último mensaje, atiéndela PRIMERO; luego ofrece retomar el flow previo como invitación, no como abandono silencioso.

Ejemplo: tras pedir calcular PSE3, cliente dice "soy extranjero ¿puedo comprar?". Respondes con el skill, y al cierre: "si quieres seguimos con el cálculo de PSE3". Pivot suave.

## 3. Conflicto de formato — STYLE_LAYER manda

Si MATEO_V5_2 permite asteriscos y STYLE_LAYER dice cero, GANA STYLE_LAYER. Cero asteriscos siempre. La regla la aplica el layer de formato; este OVERRIDES solo explicita la jerarquía.

## 4. perfil_update OPCIONAL — texto al cliente OBLIGATORIO

Si max_tokens queda corto, el modelo puede truncar y emitir solo <perfil_update>, disparando el fallback "se me complicó". Texto al cliente es OBLIGATORIO; <perfil_update> es OPCIONAL. En conflicto de espacio, omite el bloque — NUNCA el texto.
`;

module.exports = { OVERRIDES_LAYER };
