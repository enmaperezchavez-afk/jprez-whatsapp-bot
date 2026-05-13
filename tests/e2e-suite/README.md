# Suite E2E V3.6 — 20 escenarios JPREZ

Esta suite valida el comportamiento real de Mateo contra los **20 escenarios canónicos** del Director (Drive `1Tuaw6otd9MccWCXsb3kOmP-YJabaBcM97U4WQuf9Oe4`).

## Diferencia con el resto de tests

| Suite | Qué mide | Cuándo corre | Costo |
|---|---|---|---|
| `tests/*.test.mjs` (508 unit/integration) | Lógica del handler, defensas R4, post-processor, source-inspection | Cada `npm test` y CI | Cero |
| `tests/e2e-smoke/golden-smoke.test.mjs` | Pipeline post-LLM con mocks (idempotency, document policy, etc.) | Cada `npm test` y CI | Cero |
| **`tests/e2e-suite/escenarios.test.mjs`** | **Comportamiento REAL del LLM contra el prompt actual** | **On-demand** | **~$0.50 USD por run** |

## Cómo correr

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run test:e2e-suite
```

Para generar baseline JSON:

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run test:e2e-suite:report
```

Si no hay `ANTHROPIC_API_KEY`, la suite skipea todos los tests sin fallar (útil para que `npm test` no rompa).

## Output

- `baselines/baseline-YYYY-MM-DD.json` — snapshot histórico
- `baselines/baseline-latest.json` — siempre el último run

Cada result trae el reply completo + qué assertion falló (keywords missing / anti-keywords found / tone mismatch).

## Estructura

```
tests/e2e-suite/
├── escenarios.test.mjs           ← suite vitest con 20 it()
├── fixtures/
│   └── escenarios-20.json        ← input + expected/anti keywords por escenario
├── helpers/
│   ├── real-llm-client.mjs       ← Anthropic SDK + buildSystemPromptBlocks
│   └── matchers.mjs              ← validateKeywords / Any / AntiKeywords / Tone
├── baselines/                     ← (gitignored generado por la suite)
└── README.md                     ← este archivo
```

## Qué valida cada escenario

1. **Keywords requeridos** — todos deben aparecer en el reply
2. **Keywords-any** — al menos uno de cada grupo OR debe aparecer
3. **Anti-keywords** — ninguno puede aparecer (incluye universales: "Bono Primera Vivienda", "bajas $", "$X K", barrial)
4. **Tone signals** — al menos 1 expected tone signal + cero anti-tone

## Baseline esperado (12 mayo 2026)

Según el doc maestro:
- Producción actual V3.6 + Hotfix-24: **10-14 de 20** pasando
- Después de Día 3 (reducción prompt): 14-16/20
- Después de Día 4 (fix tool-looping): 16-18/20
- Día 5 smoke final: 18+/20 → MVP ESTABLE

Si el baseline real está **por debajo de 10**, hay deuda de implementación de V3.6 / V3.6.5 / V3.6.6 que no llegó al prompt en producción.
