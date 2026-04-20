---
name: jprez-bot-architecture
description: "Referencia de arquitectura del bot de WhatsApp de Constructora JPREZ. Usar SIEMPRE antes de tocar api/webhook.js, api/followup.js, api/pdf.js, api/img.js o módulos relacionados. Cubre el flujo end-to-end del webhook (HMAC → idempotencia → rate limit → processMessage), las convenciones de keys en Redis (chat:, meta:, ratelimit:, processed:), la memoria conversacional, metadata de cliente, envío de PDFs via proxy de Google Drive, skills cargados dinámicamente en el system prompt, tool use de la calculadora de cuotas, agendamiento via tag [AGENDAR|...], logging a Axiom con waitUntil, y el mapa entre la estructura actual (todo en api/webhook.js monolítico) y el objetivo post-modularización (src/ en módulos pequeños)."
---

# Arquitectura del Bot JPREZ (WhatsApp)

Referencia técnica del bot. Léela antes de modificar el webhook o sus dependencias. Código en inglés por convención; documentación en español.

## 1. Flujo del webhook (entrada → respuesta)

El endpoint `POST /api/webhook` en `api/webhook.js` es la puerta única por donde Meta entrega eventos. Orden exacto de procesamiento:

```
POST /api/webhook
  │
  ├─ 1. readRawBody(req)              ← bodyParser desactivado; leemos el stream crudo
  │     → 400 si falla la lectura
  │
  ├─ 2. verifyWebhookSignature(...)    ← HMAC SHA256 sobre el body crudo exacto
  │     → 401 si firma inválida o ausente (enforcement activo)
  │     → log [info] "HMAC valido" si pasa
  │
  ├─ 3. JSON.parse(rawBody)           ← parseo manual post-HMAC
  │     → 400 si no es JSON válido
  │
  ├─ 4. Idempotencia                   ← SET NX EX 3600 sobre "processed:<messageId>"
  │     → status updates sin messageId saltan el check
  │     → aplica a TODOS (incluido staff: dedupe contra doble-tap)
  │     → duplicado: log "duplicate_message_ignored" + return 200 (no procesa)
  │     → Redis null/error: fail-open + log "idempotency_bypassed_redis_unavailable"
  │
  ├─ 5. Rate limiting                  ← Upstash Ratelimit, sliding 10/60s por phone
  │     → staff bypass (STAFF_PHONES[phone])
  │     → status updates sin phone saltan
  │     → excedido: log "rate_limit_exceeded" + sendWhatsAppMessage amable + return 200
  │     → Redis null: fail-open + log "rate_limit_bypassed_redis_unavailable"
  │
  ├─ 6. processMessage(body)           ← lógica de negocio: contexto, Claude, tools, PDFs
  │
  └─ 7. return 200 "EVENT_RECEIVED"    ← siempre, salvo los early returns arriba
```

**Reglas invariantes del handler:**
- Nunca devolver 5xx desde errores de negocio: Meta reintentaría el webhook y amplifica el problema. Errores se loguean y respondemos 200. Única excepción: 400 (body ilegible) y 401 (HMAC inválido) — esos sí rechazan.
- Toda operación de logging va via `botLog(level, message, data)`, que usa `waitUntil(logToAxiom(...))` (ver §8).
- El orden **idempotencia antes que rate limit** es intencional: retries de Meta por glitch de red NO deben consumir cupo del cliente.

## 2. Convenciones de keys en Redis (Upstash)

Todas las keys siguen el patrón `<namespace>:<id>`. **NUNCA inventar namespace nuevo sin documentar acá primero.**

| Key | TTL | Propósito | Estructura |
|-----|-----|-----------|------------|
| `chat:<phone>` | 30 días (2592000s) | Historial conversacional para Claude | `[{role:"user"\|"assistant", content:"..."}]`, máx `MAX_MESSAGES=20` |
| `meta:<phone>` | 90 días (7776000s) | Metadata del cliente | objeto JS con `name`, `temperature`, `sentDocs`, `scheduledVisit`, `escalated`, `followUpCount`, `lastContact`, etc. |
| `ratelimit:<phone>` | 60s (gestionado por `@upstash/ratelimit`) | Sliding window counter | interno del paquete |
| `processed:<messageId>` | 1h (3600s) | Dedupe de webhooks | valor `"1"`, presencia = ya procesado |

**No hay en uso actualmente:** cualquier otro namespace. Si añadís uno, documentalo acá en el mismo PR.

## 3. Memoria conversacional y metadata

### Historial (`chat:<phone>`)

- Leído con `getHistory(phone)`, escrito con `addMessage(phone, role, content)`.
- Se inyecta completo como `messages[]` al llamar Anthropic en `processMessage`.
- Truncado a `MAX_MESSAGES` (20) en FIFO cuando crece.
- Fallback a memoria RAM (`conversationHistory[phone]`) si Redis cae. Se pierde al cold start, pero el bot no muere.

### Metadata (`meta:<phone>`)

Objeto acumulativo merge-on-write via `saveClientMeta(phone, patch)`. Campos típicos:

| Campo | Quién lo escribe | Propósito |
|-------|------------------|-----------|
| `name` | `processMessage` desde `contacts[0].profile.name` | Greet personalizado |
| `temperature` | `"hot"` cuando Claude marca `[LEAD_CALIENTE]` | Priorización en followup cron |
| `hotDetectedAt` | ídem | Auditoría |
| `sentDocs` | `markDocSent(phone, docKey)` | Evita re-enviar el mismo brochure |
| `scheduledVisit` | tag `[AGENDAR\|...]` detectado | Recordatorio 24h antes + bloqueo de followup |
| `escalated` / `escalatedAt` | `[ESCALAR]` | Silencia el bot 4h para handoff humano |
| `followUpCount`, `followUpStage`, `lastFollowUpAt` | `api/followup.js` cron | Anti-rebote de seguimientos |
| `lastContact` | seteado en cada `saveClientMeta` desde webhook | Usado por cron para "días sin responder" |

**Regla crítica**: `api/followup.js` usa una variante de `saveClientMeta` que **NO pisa `lastContact`** (porque el cron no es una interacción del cliente). El webhook sí lo pisa (cada mensaje entrante actualiza la marca).

### Contexto dinámico inyectado al prompt

`buildClientContext(meta)` produce un bloque que se **concatena al system prompt por request**: nombre, temperatura, docs ya enviados, último contacto. Con eso Claude evita "reiniciar" la conversación, no re-envía docs, no saluda dos veces.

## 4. PDFs vía proxy de Google Drive (`/api/pdf`, `/api/img`)

Los brochures/precios/planos viven como PDFs en Google Drive. Problema: Drive responde HTML ("Open with Docs") cuando WhatsApp intenta bajar la URL directa. Solución: **proxy interno**.

```
WhatsApp API expects: link a un PDF real (content-type: application/pdf)
Google Drive returns: HTML wrapper
→ Nuestro proxy /api/pdf?id=<FILE_ID>:
    - fetch a drive.usercontent.google.com/download?id=...&confirm=t
    - si content-type/magic bytes es HTML, retry con drive.google.com/uc?...
    - devuelve el buffer con Content-Type correcto + Cache-Control max-age=3600
```

Variantes:
- `/api/pdf` — default content-type `application/pdf`
- `/api/img` — mismo flujo, default content-type `image/jpeg`, cache 24h

URLs en env vars (`PDF_CRUX_BROCHURE`, `PDF_PR3_PRECIOS`, etc.) se reescriben con `toProxyUrl(driveUrl)` o `toImageProxyUrl(url)` antes de pasarse a WhatsApp. `extractDriveId()` soporta los dos formatos comunes (`?id=XXX` y `/file/d/XXX/`).

Detección de envío: `detectDocumentRequest(botReply, userMessage)` busca frases gatillo ("te lo envio por aqui", "te mando el brochure", etc.) en la respuesta del bot. **El LLM decide cuándo enviar** via esas frases; el código las parsea. Ver `jprez-security-patterns` para el contrato con el prompt.

## 5. Skills cargados dinámicamente en el system prompt

`buildSystemPrompt()` (en webhook.js) compone el prompt del sistema **en cada invocación**:

```js
function buildSystemPrompt() {
  return [
    fechaHeader,                        // "Hoy es: 2026-04-20 (lunes, 20 de abril de 2026)"
    SKILL_CONTENT,                      // .claude/skills/vendedor-whatsapp-jprez/SKILL.md
    "---",
    "INVENTARIO Y PRECIOS DETALLADOS (consulta siempre antes de cotizar):",
    INVENTORY_CONTENT,                  // .claude/skills/vendedor-whatsapp-jprez/references/inventario-precios.md
    "---",
    operationalRules,                   // reglas del bot (frases gatillo, tags, calculadora)
  ].join("\n");
}
```

**`SKILL_CONTENT` e `INVENTORY_CONTENT` se leen del disco una vez por cold start** (con try/catch + fallback). Vercel los bundlea gracias a `config.includeFiles: ".claude/skills/**/*.md"` en `vercel.json`. Esto permite actualizar el skill sin redeploy de código: sólo cambiar el .md y redeployar.

Fecha: se inyecta **por invocación** (no al cold start), para que Claude calcule meses restantes reales y sepa si una promoción como "Feria de Mayo" sigue vigente.

El `SUPERVISOR_PROMPT` (cuando Enmanuel — staff — habla con el bot) **no** carga el skill: es un prompt más corto para modo colaborador, no vendedor.

## 6. Calculadora de cuotas via tool use

`TOOLS = [{ name: "calcular_plan_pago", input_schema: { proyecto, precio_usd }, ... }]` se pasa a `anthropic.messages.create({ tools: TOOLS, ... })`.

Loop implementado en el handler (máximo 3 iteraciones):

```js
while (iteration < MAX_TOOL_ITERATIONS) {
  response = await anthropic.messages.create({ ..., tools: TOOLS, messages: workingMessages });
  if (response.stop_reason !== "tool_use") break;

  const toolUseBlocks = response.content.filter(b => b.type === "tool_use");
  workingMessages.push({ role: "assistant", content: response.content });
  const toolResults = toolUseBlocks.map(block => {
    const result = calcularPlanPago(block.input.proyecto, block.input.precio_usd);
    return { type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) };
  });
  workingMessages.push({ role: "user", content: toolResults });
  iteration++;
}
```

`calcularPlanPago(proyecto, precioUsd)` usa `PAYMENT_PLANS[proyecto]` (% de separación/completivo/entrega) y `DELIVERY_DATES[proyecto]` para computar meses restantes desde hoy hasta entrega, y devuelve el desglose.

**No persistimos el tool-use loop en `chat:<phone>`**: solo el texto final de Claude. El roundtrip de tool es efímero dentro del request.

## 7. Agendamiento via tag `[AGENDAR|proyecto|fecha_iso|notas]`

El prompt instruye a Claude a emitir `[AGENDAR|pr3|2026-04-22T10:00:00-04:00|cliente quiere ver piso alto]` cuando tenga los 3 datos (día, hora, proyecto). `detectLeadSignals(botReply)` lo parsea con regex:

```js
const bookingMatch = botReply.match(/\[AGENDAR\|([^|\]]+)\|([^|\]]+)\|([^\]]*)\]/);
```

Si matchea:
- El tag se elimina del texto antes de enviarlo al cliente (se limpian también `[LEAD_CALIENTE]` y `[ESCALAR]`).
- `notifyEnmanuelBooking(senderPhone, booking)` envía tarjeta a Enmanuel con proyecto, hora legible en `es-DO`, link `wa.me/<phone>` para abrir chat.
- `saveClientMeta(senderPhone, { scheduledVisit: booking, temperature: "hot" })`.
- Followup automático se suspende (`nextFollowupAt: null`) porque Enmanuel ya toma la conversación.

Los tres tags en total que el código parsea:
- `[LEAD_CALIENTE]` → notifica + marca `temperature: "hot"`
- `[ESCALAR]` → notifica + silencia bot 4h
- `[AGENDAR|...|...|...]` → crea booking estructurado

**No inventar tags nuevos sin agregarlos a `detectLeadSignals`**: cualquier tag sin parser quedará visible para el cliente.

## 8. Axiom logging: `waitUntil` vs `await`

`botLog(level, message, data)` **no** hace `await logToAxiom(...)`. Hace `waitUntil(logToAxiom(...))`.

**Por qué waitUntil (de `@vercel/functions`):**
- En Vercel Functions, un request termina cuando retornás la response. Si hicieras `await logToAxiom`, atrasás el 200 a Meta hasta que Axiom conteste → latencia perceptible y riesgo de timeout.
- Si hicieras fire-and-forget (`logToAxiom(...)` sin await ni waitUntil), Vercel puede matar el container apenas mandás el response, abortando el fetch a Axiom antes de que salga. Resultado: logs perdidos.
- `waitUntil` le dice al runtime de Vercel: "mandá la respuesta pero mantené el container vivo hasta que esta promesa termine". Resuelve ambos problemas.

Dataset por defecto: `jprez-bot` (override con `AXIOM_DATASET`). Si `AXIOM_TOKEN` no está seteado, `logToAxiom` hace no-op silencioso. Los errores de ingesta se loguean a `console.log` (visible en Vercel runtime logs).

**Convención de payloads**: cuando emites logs de eventos de seguridad/operación, incluí `event_type` como campo para filtrar en Axiom. Ejemplos ya en uso: `"rate_limit_exceeded"`, `"rate_limit_bypassed_redis_unavailable"`, `"duplicate_message_ignored"`, `"idempotency_bypassed_redis_unavailable"`.

## 9. Convenciones de naming

- **Funciones**: `camelCase` en inglés. Prefijos comunes: `get...` (lectura), `save...` (escritura), `send...` (salida HTTP), `detect...` (parseo de señales), `notify...` (outbound a Enmanuel), `build...` (compositor de strings/objetos).
- **Constantes de módulo**: `SCREAMING_SNAKE_CASE`. Ejemplo: `RATELIMIT_MAX`, `ESCALATION_SILENCE_HOURS`, `PAYMENT_PLANS`.
- **Archivos en `api/`**: cada archivo es un endpoint de Vercel (`webhook.js`, `pdf.js`, `img.js`, `followup.js`). Kebab-case si alguna vez hace falta (no usado hoy).
- **Keys de Redis**: `<namespace>:<id>` en minúsculas, como en §2.
- **Mensajes al cliente**: español dominicano natural (ver skill `vendedor-whatsapp-jprez`). Nunca markdown, máximo 3-4 líneas.
- **Logs internos**: `console.log` para mensajes legibles, `botLog` para eventos estructurados a Axiom.

## 10. Estructura actual vs objetivo post-modularización (Día 2)

**Estado hoy (monolítico):** `api/webhook.js` = 1,259+ líneas. Contiene:
- HMAC (readRawBody, verifyWebhookSignature)
- Redis factory + helpers (getRedis, getHistory, addMessage, saveClientMeta, getClientMeta, markDocSent)
- Rate limit + idempotencia inline en el handler
- Axiom (logToAxiom, botLog)
- Constantes (STAFF_PHONES, PROJECT_DOCS, PAYMENT_PLANS, DELIVERY_DATES, TOOLS)
- Skill loading + buildSystemPrompt + SUPERVISOR_PROMPT
- Detección (detectDocumentRequest, detectDocumentType, detectLeadSignals)
- Notificaciones (notifyEnmanuel, notifyEnmanuelBooking)
- Contexto + escalamiento helpers (buildClientContext, isEscalationActive, shouldRemindEnmanuel)
- WhatsApp API (sendWhatsAppMessage, sendWhatsAppDocument, sendWhatsAppImage, sendProjectImages)
- Whisper (transcribeWhatsAppAudio)
- processMessage (orquestador de negocio)
- handler (orquestador HTTP)

**Objetivo Día 2 (modular, `src/`):**

```
src/
├── security/
│   ├── hmac.js           (readRawBody, verifyWebhookSignature)
│   ├── ratelimit.js      (getRatelimit memoizada + helpers)
│   └── idempotency.js    (check con SET NX EX)
├── store/
│   ├── redis.js          (getRedis factory)
│   ├── history.js        (getHistory, addMessage)
│   └── meta.js           (saveClientMeta, getClientMeta, markDocSent)
├── whatsapp.js           (send* + Whisper transcription)
├── proxy.js              (toProxyUrl, toImageProxyUrl, extractDriveId)
├── prompts.js            (skill loader, buildSystemPrompt, SUPERVISOR_PROMPT, operational rules)
├── claude.js             (tool use loop + TOOLS + calcularPlanPago)
├── detect.js             (detectDocumentRequest, detectDocumentType, detectLeadSignals)
├── notify.js             (notifyEnmanuel, notifyEnmanuelBooking)
├── log.js                (logToAxiom, botLog)
└── handlers/
    └── message.js        (processMessage)

api/webhook.js            (< 80 líneas: orquesta HMAC → idempotency → ratelimit → message)
api/pdf.js                (sin cambios)
api/img.js                (sin cambios)
api/followup.js           (reusa src/store/*, src/prompts.js, src/whatsapp.js)
```

**Criterios del refactor:**
- Cero regresión: 12 tests siguen verdes después de la modularización.
- Cada módulo debe ser testeable en aislamiento (exportar las funciones puras).
- `vercel.json` probablemente necesite incluir `src/**` en `includeFiles` si el tracer no lo detecta automáticamente (al ser imports reales debería tracear bien; verificar en preview).
- Mantener la convención CJS (`require` / `module.exports`) en todo el código de producción. Tests siguen siendo `.mjs`.

**No cambiar como parte del refactor:** comportamiento observable, env vars, flujo del handler, formato de logs, payloads a Meta/Anthropic/Redis. Es puro movimiento + encapsulación.
