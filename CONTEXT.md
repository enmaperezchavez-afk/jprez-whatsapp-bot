# JPREZ OS WhatsApp Bot — Estado del Proyecto

## Última sesión: Martes 21 abril 2026

### Estado al cierre Día 2 (fecha: 2026-04-21, ~12:30 AM RD)
- **DÍA 2 CERRADO ✓**
- Merge commit: `6e324e3` (PR #5 `feature/day2-modularization` → `main`)
- 17 commits limpios pusheados a main vía PR mergeado
- Tests Vitest: 12/12 verdes sostenidos en cada uno de los 17 commits
- Branch: main
- Producción Vercel: bot modular vivo y respondiendo
- Variables de entorno activas: META_APP_SECRET, AXIOM_TOKEN, AXIOM_DATASET=jprez-bot, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, WHATSAPP_TOKEN, ANTHROPIC_API_KEY (rotada durante Día 2), OPENAI_API_KEY, WEBHOOK_VERIFY_TOKEN
- webhook.js: **1,475 → 126 líneas (−91%)**

### Día 2 COMPLETADO (100%)
Modularización completa de api/webhook.js via 17 extracciones atómicas:

**Estructura final `src/` (16 archivos):**
```
src/
├── claude.js               64   (callClaudeWithTools + registry pattern)
├── detect.js              121   (LEAF: pure detectors, mojibake preservado)
├── log.js                  50   (botLog + logToAxiom + waitUntil)
├── notify.js              101   (DI pattern: clientMeta inyectado)
├── prompts.js             224   (buildSystemPrompt + skill loader + SUPERVISOR_PROMPT)
├── proxy.js                49   (Drive proxy helpers + VERCEL_DOMAIN hardcoded decision)
├── staff.js                24   (STAFF_PHONES shared module)
├── whatsapp.js            157   (send* + transcribeWhatsAppAudio driver)
├── handlers/
│   └── message.js         524   (processMessage orquestador + constantes dominio)
├── security/
│   ├── hmac.js             61   (readRawBody + verifyWebhookSignature)
│   ├── idempotency.js      66   (checkIdempotency con 3-status discriminado)
│   └── ratelimit.js       104   (getRatelimit + enforceRateLimit)
└── store/
    ├── history.js          85   (getHistory + addMessage + RAM fallback)
    ├── meta.js             74   (saveClientMeta + getClientMeta + markDocSent)
    └── redis.js            32   (getRedis con lazy require para tests)
```
Total src/: 1,736 líneas. Webhook slim: 126 líneas. Monolito desaparecido.

### Patrones arquitectónicos consolidados en Día 2
- **Dependency Injection** (notify, idempotency) para cortar ciclos + testabilidad.
- **Leaf modules** (detect, hmac) documentados explícitamente.
- **Tests E2E del handler + require.cache patches**: validado 6+ commits consecutivos sin tocar archivos de test.
- **YAGNI aplicado**: idempotency 3-status (no 4), no `constants.js` prematuro.
- **sed para mojibake y template literals sensibles**: patrón estándar (Ext 7, 8, 9, 15b).
- **Documentar la decisión, no la deuda**: VERCEL_DOMAIN hardcoded, lastContact auto-pisado, etc.
- **Policy vs Mechanism** en security/*: las 3 funciones emiten `{ status }` discriminado, el handler decide UX.

### Flujo actual del webhook (126 líneas)
```
POST /api/webhook
  HMAC check (readRawBody + verifyWebhookSignature → 401 si inválido)
  JSON.parse (400 si falla)
  checkIdempotency (duplicate → 200 early, bypassed → continuar)
  enforceRateLimit (staff bypass + exceeded → mensaje amable + 200)
  processMessage (src/handlers/message.js)
  200 EVENT_RECEIVED
```

### Estado técnico
- api/webhook.js: 126 líneas (thin orchestrator)
- 16 módulos src/ organizados por responsabilidad
- Tests: tests/hmac.test.mjs, tests/ratelimit.test.mjs, tests/idempotency.test.mjs (12 tests, ~400ms)
- Smoke test manual: scripts/test-claude-tool-use.mjs (validado contra Anthropic API real)
- Husky pre-commit: `node --check` sobre api/*.js (pendiente ampliar a src/**)
- Backup tag: `pre-day2-backup` en `ed7ee2c` (botón de pánico)

### PENDIENTES PARA DÍA 3 (sin urgencia)
1. **Verificar bot vivo**: smoke test "hola" desde WhatsApp al bot en producción.
2. **Rotar 4 keys restantes**: META_APP_SECRET, WHATSAPP_TOKEN, AXIOM_TOKEN, UPSTASH_REDIS_REST_TOKEN (ANTHROPIC_API_KEY ya fue rotada en Día 2).
3. **Día 3 — features nuevas**:
   - Whisper integration mejorada (actualmente básica)
   - Claude Vision (analizar fotos de planos/inventario que mande el cliente)
   - Prompt humanizado (menos formal, más dominicano natural)
   - Obsidian arranque (sistema de notas/CRM interno)

### Deuda técnica documentada (para cleanup futuro, no urgente)
- Mojibake en strings (`informaciÃ³n`, `paraÃ­so`, `TrÃ¡talo`, `seÃ±ales`, `Enmanuel PÃ©rez ChÃ¡vez`) — preservado byte-exact en cada extracción, commit de normalización encoding pendiente.
- `console.log` directo en `store/history.js` + `store/meta.js` (no convertido a botLog, decisión consciente).
- Husky pre-commit solo cubre `api/*.js` — ampliar a `src/**/*.js` + `scripts/**/*.mjs`.
- `enforceHmac` extraction posible (webhook 126 → ~106 líneas).
- `VERCEL_DOMAIN` hardcoded en `src/proxy.js` por decisión explícita (mensajes viejos de WhatsApp con URLs de proxy necesitan dominio estable).

### Skills disponibles en `.claude/skills/`
- vendedor-whatsapp-jprez — conocimiento de venta (identidad, proyectos, precios, feria)
- jprez-bot-architecture — flujo, convenciones, patterns del bot
- jprez-security-patterns — HMAC, rate limit, idempotencia, testing

### Comando para retomar
"Buenos días Claude, lee CONTEXT.md y continuamos"

---

## Historia

### Día 1 (2026-04-20) — Endurecimiento de seguridad
- Commit de cierre: `5345bea` (Merge branch 'feature/idempotency')
- HMAC enforcement + raw body fix + 4 tests
- Rate limiting sliding window 10/60s + staff bypass + fail-open
- Idempotency SET NX EX 3600 por message.id + fail-open
- Axiom observability con logs estructurados
- 12 tests Vitest pasando

### Día 2 (2026-04-21, ~12:30 AM cierre) — Modularización completa
- Merge commit: `6e324e3` (PR #5)
- webhook.js 1,475 → 126 líneas
- 17 commits atómicos, 12/12 verde sostenido
- Estructura modular src/ con 16 archivos
