# JPREZ OS WhatsApp Bot — Estado del Proyecto

## Última sesión: Lunes 20 abril 2026

### Día 1 COMPLETADO (100%)
- HMAC enforcement + raw body fix + 4 tests
- Rate limiting sliding window 10/60s + staff bypass + fail-open
- Idempotency SET NX EX 3600 por message.id + fail-open
- Axiom observability con logs estructurados
- 12 tests Vitest pasando en ~540ms
- Cero deuda técnica, ramas limpias

### Flujo actual del webhook
POST /api/webhook
  HMAC check (401 si falla)
  JSON parse (400 si falla)
  Idempotency (skip duplicado, fail-open si Redis null)
  Rate limit (skip staff, fail-open si Redis null)
  processMessage (Claude + tools + WhatsApp)
  200 OK

### Estado técnico
- api/webhook.js: 1,259+ líneas (pendiente modularizar)
- Tests: tests/hmac.test.mjs, tests/ratelimit.test.mjs, tests/idempotency.test.mjs
- Redis mocks: require.cache pattern + stateful Map
- Log verification: vi.spyOn console.log síncrono
- Env vars: UPSTASH_REDIS_*, AXIOM_*, META_APP_SECRET (configuradas)

### PRÓXIMO PASO — Día 2
Modularización api/webhook.js en src/:
- src/security/hmac.js, idempotency.js, ratelimit.js
- src/prompts.js, redis.js, whatsapp.js, claude.js
- src/handlers/message.js
- Handler queda orquestador (< 100 líneas)
Después: Whisper + Claude Vision + prompt humanizado.

### Comando para retomar
"Buenos días Claude, lee CONTEXT.md y continuamos"
