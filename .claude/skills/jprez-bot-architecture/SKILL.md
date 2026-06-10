---
name: jprez-bot-architecture
description: "Referencia de arquitectura del bot Mateo (WhatsApp, Constructora JPREZ). Usar SIEMPRE antes de tocar api/* o src/*. Cubre: flujo del webhook (HMAC → idempotencia → testing-mode → rate limit → processMessage), keys Redis (chat:, meta:, profile:, processed:, ratelimit:, admin:testing*, inventory:current, icdv:*), composición del system prompt por capas con prompt caching (MATEO_PROMPT_V5_2 congelado por hash + GLOSSARY/COMMERCIAL/SKILLS/OVERRIDES/STYLE), tool use (calcular_plan_pago, enviar_documento), strip chain anti-leak, inventario dinámico Google Sheets (Bloque 1), generador de PDFs de precios (Bloque 2), scraper ICDV (Bloque 3), crons (followup, icdv), dashboards (/api/health, /api/dashboard) y Axiom logging con waitUntil."
---

# Arquitectura del Bot JPREZ (WhatsApp) — actualizado jun 2026

Referencia técnica del bot. Léela antes de modificar `api/*` o `src/*`. Código en inglés por convención; documentación en español. La modularización (antes "objetivo Día 2") está COMPLETA: `api/webhook.js` orquesta (~230 líneas) y la lógica vive en `src/`.

## 1. Flujo del webhook (entrada → respuesta)

`POST /api/webhook` (`api/webhook.js`) es la puerta única de Meta. Orden exacto:

```
POST /api/webhook
  │
  ├─ 1. readRawBody(req)               ← bodyParser desactivado; stream crudo
  │     → 400 si falla la lectura
  ├─ 2. verifyWebhookSignature(...)    ← HMAC SHA256 sobre el body crudo exacto
  │     → 401 si firma inválida/ausente; fail-closed si falta META_APP_SECRET (Hotfix-31)
  ├─ 3. JSON.parse(rawBody)            ← parseo manual post-HMAC → 400 si inválido
  ├─ 4. Idempotencia                   ← SET NX EX 3600 "processed:<messageId>"
  │     → duplicado: log + 200 sin procesar; Redis caído: fail-open + log
  ├─ 5. Comandos admin testing         ← /test-on /test-off /test-status (solo STAFF_PHONES)
  ├─ 6. Rate limiting                  ← Upstash sliding 10/60s por phone
  │     → staff bypass SALVO en testing mode (fidelidad con cliente real)
  ├─ 7. processMessage(body)           ← src/handlers/message.js
  └─ 8. return 200 "EVENT_RECEIVED"
```

Invariantes: nunca 5xx por errores de negocio (Meta reintenta y amplifica); idempotencia ANTES que rate limit (retries de Meta no consumen cupo); logging vía `botLog` con `waitUntil` (§8).

## 2. Keys en Redis (Upstash) — fuente central `src/redis-keys.js`

| Key | TTL | Propósito |
|-----|-----|-----------|
| `chat:<phone>` | 30 días | Historial v2 `{v, promptHash, messages[]}`, máx 20 msgs. El `promptHash` ancla el historial a la versión del prompt (§5) |
| `meta:<phone>` | 90 días | Metadata cliente: `name`, `temperature`, `sentDocs`, `scheduledVisit`, `escalated`, `followUpCount`, `lastContact`… |
| `profile:<phone>` | (storage propio) | Perfil Mateo extraído de bloques `<perfil_update>` (namespace separado de meta:) |
| `processed:<messageId>` | 1h | Dedupe de webhooks |
| `ratelimit:<phone>` | 60s | Sliding window (`@upstash/ratelimit`) |
| `admin:testing-mode:<phone>` / `admin:testing-activations:<phone>` / `testing:<phone>` | 30 min / 1h | Modo testing admin (phone swap) |
| `inventory:current` | 5 min | Cache del inventario parseado del Google Sheet (Bloque 1) |
| `icdv:series:store` (sin TTL) / `icdv:series:cache` (24h) | — | Serie ICDV canónica + cache de respuesta (Bloque 3) |

NUNCA inventar namespace nuevo sin documentarlo en `src/redis-keys.js` y acá.

## 3. processMessage — el god-handler (`src/handlers/message.js`, ~1,600 líneas)

Orquestador de negocio (FASE 4 del Plan Maestro = partirlo, pendiente). Hace en orden: extraer mensaje/audio (Whisper si audio) → cargar meta + profile → detectar supervisor/staff → comandos supervisor de inventario (§7) → construir contexto dinámico → llamar Claude con tools (§6) → strip chain (§6b) → post-processor de formato → dispatch de documentos con policy anti-duplicado (`src/dispatch/document-policy.js`) → tags (`[LEAD_CALIENTE]`, `[ESCALAR]`, `[AGENDAR|proyecto|fecha|notas]`) → persistir historial + perfil → enviar por WhatsApp.

Guards clave (todos con tests):
- **Empty-reply guard** (4 niveles, Hotfix-22 r4) — nunca responder vacío.
- **Cold-start guard** `pickRawReply` (Hotfix-28) — texto sintético warm si el LLM agotó iteraciones sin texto en primer contacto.
- **Anti-loop intra-turno** (Hotfix-27b) — `toolSignature` + `Set` de firmas invocadas; tool_use duplicado recibe tool_result sintético `duplicate_tool_call_suppressed`.
- **Holding mode** — escalación activa (<4h) NO silencia a Mateo: genera holding messages.

## 4. Proxies de Drive y media (`/api/pdf`, `/api/img`)

Drive devuelve HTML wrapper; WhatsApp necesita el archivo real. El proxy baja de `drive.usercontent.google.com`, detecta HTML por content-type/magic bytes, reintenta con URL alternativa y sirve con Content-Type correcto (cache 1h pdf / 24h img). Tope de descarga 30MB/10MB (Hotfix-31). URLs se construyen con `src/proxy.js` (`toProxyUrl`, `toImageProxyUrl`, `brochureProxyUrl`, `priceListUrl`) sobre el dominio ESTABLE hardcodeado `v0-meta-whatsapp-webhook.vercel.app` (las URLs viven en mensajes ya enviados — no usar VERCEL_URL).

## 5. System prompt por capas + prompt caching (`src/prompts.js` + `src/prompts/`)

`buildSystemPromptBlocks()` / `buildSystemPromptBlocksAsync()` retornan `{staticBlock, dynamicHeader}`:
- **staticBlock** (cacheado por Anthropic, cache_control): MATEO_PROMPT_V5_2 + capas en orden GLOSSARY → COMMERCIAL → CALCULADORA_SKILL → MERCADO_RD_SKILL → OVERRIDES → STYLE + inventario.
- **dynamicHeader** (no cacheado): fecha por invocación + contexto del cliente.

**REGLA CARDINAL: `MATEO_PROMPT_V5_2` está CONGELADO (hash `0b18565e4eb3`).** `computePromptHash` lo hashea y `checkAndInvalidate` borra (con backup 7 días) el historial de un cliente si su `promptHash` no coincide. Tocar la constante invalida TODOS los historiales. Cambios de doctrina van en capas (`src/prompts/overrides-layer.js` etc.) o en skills `.md`. OVERRIDES tiene cap de 20,000 chars (test).

Los skills `.claude/skills/*.md` se leen del disco al cold start y se bundlean vía `includeFiles` en `vercel.json`. El inventario del prompt viene del loader async (Sheet live) con fallback al `.md` (§7). `SUPERVISOR_PROMPT` (modo Enmanuel) es constante aparte — cambiarla solo invalida el historial del supervisor.

## 6. Tool use (`src/claude.js`)

`callClaudeWithTools` — modelo `claude-sonnet-4-6` hardcodeado, retry header-aware para 429/529, `MAX_TOOL_ITERATIONS = 3`. Tools cableadas en `TOOLS[]` de message.js:
- `calcular_plan_pago(proyecto, precio_usd, etapa?, inicial_pct?, completivo_pct?, entrega_pct?)` — usa `DELIVERY_DATES` + `PUERTO_PLATA_DELIVERY` (E3 2029-03, E4 2027-12) para meses restantes; porcentajes custom validados suma=100; Puerto Plata sin etapa devuelve señal SOFT `needs_etapa` (no error duro).
- `enviar_documento` — dispatch de brochures/precios vía policy.

Skeletons NO cableados (activación = PR de 3 líneas): `src/tools/market.js` (`consultar_mercado_rd`) y `src/tools/icdv.js` (`consultar_icdv`).

### 6b. Strip chain anti-leak (orden importa)

Sobre el texto del LLM antes de enviar: `stripParameterBlocks` (bloques `<parameter>/<invoke>/<function_calls>` TRUNCADOS, Hotfix-24) → `stripInternalBlocks` (los CERRADOS, Hotfix-29) → extractor `<perfil_update>` (JSON → profile store) → post-processor formato HARD (`src/handlers/format-postprocess.js`: asteriscos/bullets/headers fuera).

## 7. Inventario dinámico — Google Sheets (Bloque 1)

```
Google Sheet (tabs META, PR3, PR4, PSE3, PSE4, CRUX_TORRE6, CRUX_LISTOS)
  → src/inventory/sheets-client.js  (read, detección DINÁMICA de headers: findHeaderRowIndex
     busca la fila con unidad_id/proyecto_id — el Sheet real tiene títulos en filas previas)
  → parser.js   (regla Director: disponible sin precio → SKIP + warn; toNumber locale-aware)
  → markdown-formatter.js → loader.js (cache Redis 5 min + fallback inventario-precios.md)
  → system prompt de Mateo (async) + /api/inventory (GET/POST, auth HEALTH_DASHBOARD_TOKEN)
```

Comandos supervisor (solo Enmanuel, clientes los ignoran en silencio): `/reservar /vender /liberar /precio /inventario` — regla PROYECTO PRIMERO. Escriben al Sheet vía `sheets-writer.js` (Service Account EDITOR; misma detección dinámica de headers) e invalidan `inventory:current`.

## 8. Axiom logging: `waitUntil` vs `await`

`botLog(level, message, data)` usa `waitUntil(logToAxiom(...))` (de `@vercel/functions`): la response sale ya, el container vive hasta que el log salga. `await` atrasaría el 200 a Meta; fire-and-forget pierde logs al morir el container. Dataset `jprez-bot` (env `AXIOM_DATASET`); sin `AXIOM_TOKEN` es no-op. Incluir `event_type` en payloads para filtrar.

## 9. Endpoints y crons

| Endpoint | Auth | Propósito |
|----------|------|-----------|
| `POST/GET /api/webhook` | HMAC Meta / verify token | Entrada WhatsApp |
| `/api/pdf`, `/api/img` | público (id Drive válido) | Proxy media |
| `/api/followup` | `CRON_SECRET` (fail-closed) | Cron 13 UTC: seguimientos por temperatura (hot 3/5/7d, warm 5/10/20, cold 7/15/30), ventana 9am-7pm SD, máx 3 |
| `/api/icdv` | GET público / cron `CRON_SECRET` | Serie ICDV (ONE). Cron `0 14 23-31 * *` scrapea boletín PDF (slug aleatorio) y persiste en Redis. Núcleo puro en `src/services/icdv-parser.js` |
| `/api/health` + `/health` | Bearer `HEALTH_DASHBOARD_TOKEN` (+`_PREV` rotación), rate limit 10/min | 8 métricas operacionales desde Axiom (prompt size, cache hit, costo, failures) |
| `/api/dashboard` + `/dashboard` | token | Métricas comerciales |
| `/api/inventory` | Bearer `HEALTH_DASHBOARD_TOKEN` | Inventario JSON; POST = force refresh |
| `/api/price-list` | público | PDF de precios on-the-fly (`src/documents/price-list-generator.js`, pdfkit + identidad visual por proyecto, logos en `public/logos/`) |
| `/api/market-data` | — | Data de mercado scrapeada |

## 10. Convenciones

- Funciones `camelCase` inglés (`get/save/send/detect/notify/build...`); constantes `SCREAMING_SNAKE`; keys Redis `<ns>:<id>`.
- CJS (`require`/`module.exports`) en producción; tests `.mjs` (Vitest, 700+).
- Pre-commit: `scripts/check-encoding.mjs` + skill-linter. CI: encoding-check + tests + smoke-e2e + skill-lint.
- Mensajes al cliente: español dominicano, prosa sin markdown, máx 3-4 líneas (post-processor lo fuerza).
- Commits atómicos, tests verde por commit, Director merguea (squash). Suite E2E real (`tests/e2e-suite/`, 20 escenarios) es on-demand con `ANTHROPIC_API_KEY` (~US$0.50/run).

## 11. Qué NO tocar sin leer primero

1. `MATEO_PROMPT_V5_2` (hash congelado — ver §5).
2. El orden idempotencia→ratelimit del webhook.
3. `VERCEL_DOMAIN` en `src/proxy.js` (rompe PDFs viejos en chats).
4. La regla "disponible sin precio = skip" del parser de inventario.
5. Strip chain: el orden truncados→cerrados→perfil_update.
