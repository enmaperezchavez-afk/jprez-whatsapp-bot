---
name: jprez-security-patterns
description: "Patrones de seguridad establecidos en el bot JPREZ durante Día 1. Usar ANTES de tocar cualquier lógica relacionada con: validación HMAC del webhook de Meta, raw body capture, rate limiting, idempotencia de mensajes duplicados, fail-open vs fail-closed, testing de seguridad con Vitest. Cubre: por qué Vercel rompe HMAC sin bodyParser:false, cuándo usar crypto.timingSafeEqual vs ===, transición warning-only → enforcement, rate limiting con @upstash/ratelimit (sliding window, staff bypass, fail-open con alerta), idempotencia con SET NX EX 3600 por message.id, y los 3 patrones de test que funcionaron: require.cache patching (porque vi.mock NO intercepta require() dentro de funciones de módulos CJS), stateful Redis mock (Map compartido para simular NX), y vi.spyOn(console.log) síncrono para verificar botLog. También incluye gotchas reales que nos pasaron (caracteres invisibles en env vars, formato de body distinto entre tests y Meta real, typo de 1 caracter que tiró producción)."
---

# Patrones de seguridad — Bot JPREZ

Referencia de todo lo aprendido en Día 1. Léela antes de modificar HMAC, rate limit, idempotencia o los tests asociados. Código en inglés por convención; documentación en español.

## 1. HMAC — validación de webhooks de Meta

### 1.1 Raw body capture: por qué es crítico

Meta firma el body crudo de cada webhook con SHA256. Nosotros recibimos el request en Vercel Functions.

**Problema descubierto en la Fase 1 del endurecimiento (commit `527a90d`):** Vercel por defecto parsea el body JSON y lo entrega como `req.body` (objeto JS). Si nosotros re-serializamos con `JSON.stringify(req.body)` para firmar, el string **NO es byte-exact** al que Meta firmó (cambia espaciado, orden de keys, escapes). Resultado: todas las firmas válidas fallaban la comparación. Por eso HMAC estuvo "warning-only" hasta el fix.

**Solución (commit `9022046`, PR #1):**

```js
// api/webhook.js
async function handler(req, res) { /* ... */ }

handler.config = {
  api: {
    bodyParser: false,   // ← crítico: desactiva el parser automático de Vercel
  },
};

module.exports = handler;
```

Con `bodyParser: false`, `req` es un stream `Readable`. Leemos los bytes crudos:

```js
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
```

**Importante**: después de la verificación HMAC hacemos `JSON.parse(rawBody)` manualmente. Si falla, respondemos 400 (no 500, para no provocar reintentos de Meta).

### 1.2 timingSafeEqual vs ===

Comparar strings con `===` es vulnerable a timing attacks: la duración de la comparación depende de en qué byte difieren, filtrando información sobre la firma correcta.

**Patrón obligatorio:**

```js
const sigBuf = Buffer.from(signatureHeader);
const expBuf = Buffer.from(expected);

// timingSafeEqual tira si los largos difieren; chequeamos ANTES para no tirar.
if (sigBuf.length !== expBuf.length) {
  return { status: "invalid", reason: "Firma de largo inesperado" };
}
const isValid = crypto.timingSafeEqual(sigBuf, expBuf);
```

La función `verifyWebhookSignature(rawBody, signatureHeader)` retorna un objeto con `status` discriminado: `"valid" | "invalid" | "missing_secret" | "missing_signature"`. El handler hace el routing a 401 o bypass según el status. No usar booleans — los estados dan más información para logging estructurado.

### 1.3 Warning-only → enforcement (transición segura)

El hardening de HMAC se hizo en **dos PRs separados**, sin downtime:

- **PR #1 — `feature/hmac-rawbody-fix`** (raw body capture, sigue warning-only). Propósito: primero arreglar el bug de body sin cambiar comportamiento público. Los logs de Axiom empezaron a mostrar `HMAC valido` para requests legítimos de Meta. Esa fue la prueba de que la Fase 2 era segura.
- **PR #2 — `feature/hmac-enforcement`** (rechazo con 401). Una vez confirmado que las firmas legítimas pasaban, activamos el enforcement real:

```js
if (hmac.status === "valid") {
  botLog("info", "HMAC valido", { ip: clientIp });
} else if (hmac.status === "missing_secret") {
  // META_APP_SECRET no configurado → modo dev, procesa con warning
  botLog("warn", "HMAC no validado (META_APP_SECRET ausente)", { ip: clientIp });
} else {
  // invalid o missing_signature → rechazar
  botLog("warn", "Request rechazado por HMAC invalido", { status: hmac.status, reason: hmac.reason, ip: clientIp });
  return res.status(401).json({ error: "Unauthorized: invalid webhook signature" });
}
```

**Regla del patrón "warning → enforce":** siempre **medí primero** en modo observación antes de activar el bloqueo. Si PR #2 se hubiera hecho sin PR #1, todas las firmas legítimas hubieran rebotado con 401 y el bot muere.

## 2. Rate limiting — protección por phone

Implementado con `@upstash/ratelimit` v2 + `@upstash/redis` sobre el mismo Upstash ya configurado.

### 2.1 Parámetros

```js
const RATELIMIT_MAX = 10;        // 10 mensajes
const RATELIMIT_WINDOW = "60 s"; // por ventana de 60 segundos, sliding
const RATELIMIT_PREFIX = "ratelimit"; // keys → ratelimit:<phone>
```

Sliding window: cada mensaje cuenta y el contador decrementa gradualmente al pasar segundos. Más justo que fixed window (evita "burst al inicio de cada minuto").

Instancia memoizada al module scope (lazy init en `getRatelimit()`): una sola construcción por cold start, reutilizada en todas las invocaciones.

### 2.2 Staff bypass

`STAFF_PHONES` incluye Enmanuel (`"18299943102"`). Los staff **nunca consultan el contador** — el bypass está en la entrada del check, antes de llamar `getRatelimit()`:

```js
if (inboundPhone && !STAFF_PHONES[inboundPhone]) {
  // ... check de rate limit
}
```

Razón: Enmanuel usa el bot como interfaz de trabajo (modo supervisor). Rate-limitarlo rompería su flujo legítimo. En cambio idempotencia sí aplica a staff (doble-tap accidental se deduplica igual).

### 2.3 Fail-open con alarma

Si Redis cae (`getRedis()` retorna null) o el limiter tira excepción (timeout, red), **procesamos el mensaje igual**. Alternativa (fail-closed) sería peor: incidente de infra = bot muerto para todos.

```js
const ratelimit = await getRatelimit();
if (!ratelimit) {
  botLog("warn", "rate_limit_bypassed_redis_unavailable", {
    event_type: "rate_limit_bypassed_redis_unavailable",
    phone: inboundPhone,
    timestamp: new Date().toISOString(),
  });
} else {
  try {
    const { success, limit, remaining, reset } = await ratelimit.limit(inboundPhone);
    if (!success) { /* bloqueo + mensaje amable */ }
  } catch (e) {
    botLog("warn", "rate_limit_bypassed_error", { /* ... */ error: e.message });
  }
}
```

Los logs `rate_limit_bypassed_*` son **alarmas**: si aparecen en Axiom, significa que estamos sin protección. Configurá alert en Axiom para frecuencia > N/hora.

### 2.4 Mensaje amable cuando se excede

Cuando bloqueamos (`success === false`), enviamos al cliente un único mensaje y respondemos 200 a Meta (sin reintentos):

```js
await sendWhatsAppMessage(
  inboundPhone,
  "¡Gracias por tu interés en Constructora JPREZ! 🙌 Estoy procesando tus mensajes con calma para darte la mejor atención. En unos segundos te respondo todo con detalle."
);
return res.status(200).send("EVENT_RECEIVED");
```

**Sin loop posible**: `sendWhatsAppMessage` es outbound a Meta (graph.facebook.com), no vuelve a entrar a nuestro webhook. El rate limiter se keyea por el phone **entrante**, nunca se auto-dispara.

## 3. Idempotencia — dedupe por message.id

Meta reintenta webhooks cuando no recibe 200 rápido (o por glitches de red). Cada reintento trae el mismo `message.id`. Sin dedupe, procesamos el mismo mensaje N veces → N respuestas de Claude → cliente confundido → drain del rate limit.

### 3.1 Orden en el handler: idempotencia ANTES del rate limit

**Decisión deliberada en Día 1** (considerada y validada):

```
HMAC → JSON parse → Idempotencia → Rate limit → processMessage
```

Razón: si Meta reintenta 5 veces el mismo mensaje por un glitch, no queremos gastar 5 hits del rate limit al cliente (podría activar el bloqueo contra un cliente legítimo).

### 3.2 SET NX EX atómico

Patrón clave: **una sola operación Redis**, atómica, que nos dice si era la primera vez:

```js
const result = await redis.set("processed:" + messageId, "1", {
  nx: true,
  ex: 3600,  // 1 hora de TTL
});

if (result === "OK") {
  // primera vez: la key se creó. Continuar.
} else {
  // result === null: la key ya existía. Es un duplicado.
  botLog("info", "duplicate_message_ignored", { /* ... */ });
  return res.status(200).send("EVENT_RECEIVED");
}
```

**No hacer esto** (race condition):
```js
// ❌ MAL: dos requests concurrentes pueden pasar los dos
const exists = await redis.get("processed:" + messageId);
if (!exists) {
  await redis.set("processed:" + messageId, "1", { ex: 3600 });
  // procesar...
}
```

TTL de 3600s (1h) es suficiente para cubrir todos los retries realistas de Meta (típicamente 10-15min). Si por alguna razón llega un duplicado después de 1h, lo procesamos de nuevo — aceptable, extremadamente raro.

### 3.3 Aplica a TODOS (incluido staff)

A diferencia del rate limit, idempotencia no bypasea staff. Si Enmanuel hace doble-tap en un mensaje, queremos dedupe. No hay downside.

### 3.4 Status updates sin message.id

Los eventos `delivery`, `read`, `sent` de Meta vienen con `value.statuses[...]` en vez de `value.messages[...]`. Chaining opcional resuelve:

```js
const messageId = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.id;
if (messageId) {
  // aplicar dedupe
}
// sin messageId: continuar al rate limit + processMessage (que también salta status updates)
```

### 3.5 Fail-open con misma política que rate limit

Si `getRedis()` retorna null, o el SET tira excepción, loguear `idempotency_bypassed_redis_unavailable` y procesar igual. El mismo event_type para ambos casos (null o error) simplifica las alertas en Axiom.

## 4. Patrones de test — Vitest con módulos CJS

El código de producción es CommonJS (`require` / `module.exports`). Los tests son `.mjs` (ESM) porque Vitest v4 lo requiere. Combinar ambos tiene 3 patrones que funcionan.

### 4.1 require.cache patching (cuando vi.mock NO sirve)

**Descubierto a las malas** durante el testing de rate limiting: `vi.mock("@upstash/ratelimit", () => ({ ... }))` NO intercepta los `require("@upstash/ratelimit")` que se ejecutan **dentro de una función** de un módulo CJS importado dinámicamente. El factory del mock nunca se invocaba (verificado con `console.log` adentro).

Resultado: la instancia REAL de Ratelimit se construye con nuestro Redis mock inválido, tira excepción en `limit()`, cae al catch de `getRatelimit`, retorna null, el handler fail-open y el counter nunca se toca. Los tests fallaban con `undefined !== 10` y era confuso.

**Solución que sí funciona**: poblar `require.cache` ANTES del import dinámico del módulo bajo test.

```js
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const redisState = new Map();

// Parchar @upstash/redis
{
  const moduleId = require.resolve("@upstash/redis");
  require.cache[moduleId] = {
    id: moduleId,
    filename: moduleId,
    loaded: true,
    exports: {
      Redis: class {
        constructor() {}
        async get(key) { return redisState.has(key) ? redisState.get(key) : null; }
        async set(key, value, opts = {}) {
          if (opts && opts.nx && redisState.has(key)) return null;
          redisState.set(key, value);
          return "OK";
        }
        async del(key) {
          const had = redisState.has(key);
          redisState.delete(key);
          return had ? 1 : 0;
        }
      },
    },
  };
}

// Después del patching, ahora sí el import
const handler = (await import("../api/webhook.js")).default;
```

Cuando webhook.js ejecute su `require("@upstash/redis")` lazy dentro de `getRedis()`, Node consulta `require.cache` antes de resolver desde disco — y encuentra nuestro mock.

**Reglas**:
- Patchear cache ANTES del import dinámico del módulo bajo test.
- El import debe ser dinámico (`await import(...)`), no estático (los estáticos se hoistean arriba del patching).
- Cada test file tiene su propio require.cache porque Vitest aísla en workers — no hay leak entre test files.

### 4.2 Stateful Redis mock (Map compartido)

Para testear idempotencia, el mock de Redis debe PERSISTIR estado entre llamadas (simular que una key quedó después del primer SET). Un Map al module scope del test file cubre el caso:

```js
const redisState = new Map();

// Redis mock usa redisState via closure
// ... tests ...

beforeEach(() => {
  redisState.clear();  // aislar estado entre tests
  // ... otros resets
});
```

El mock puede ser **sofisticado o simple** según el test:
- Rate limit test: mock no-op (`set` siempre devuelve `"OK"`) porque sus tests no dependen de NX.
- Idempotencia test: mock que implementa NX (`set` devuelve `null` si la key existe) — esencial para el test de "duplicado".

### 4.3 vi.spyOn(console, "log") síncrono para verificar botLog

`botLog(level, message, data)` llama `console.log(message, JSON.stringify(data))` **sincrónicamente** antes de `waitUntil(logToAxiom(...))`. Por eso el spy captura los argumentos al momento que termina el handler, sin esperar a la promesa de Axiom.

```js
let consoleSpy;

beforeEach(() => {
  consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();  // importante: no dejar el spy activo
});

it("verifica log de duplicate_message_ignored", async () => {
  // ... ejecutar handler ...
  const dupLog = consoleSpy.mock.calls.find(args => args[0] === "duplicate_message_ignored");
  expect(dupLog).toBeDefined();
  expect(dupLog[1]).toContain(messageId);  // el JSON stringified contiene la info
});
```

**No intentar verificar logs via fetch mock a Axiom**: `waitUntil` schedulea la promesa async, y la assertion síncrona puede correr antes de que el fetch a api.axiom.co salga. Spy en console.log es determinístico.

### 4.4 Body de test con `messageType: "unknown"`

Para tests que necesitan **que el handler no procese** downstream real (sin Anthropic, sin lógica de negocio), el trick:

```js
function buildMessageBody(phone, messageId) {
  return JSON.stringify({
    entry: [{
      changes: [{
        value: {
          messages: [{ from: phone, id: messageId, type: "unknown" }],
          contacts: [{ profile: { name: "Test" }, wa_id: phone }],
        },
      }],
    }],
  });
}
```

`type: "unknown"` hace que `processMessage` caiga en el `else` branch del switch de messageType, enviando un único outbound ("Hola! Por el momento solo puedo leer texto y notas de voz...") via `sendWhatsAppMessage` y retornando. Eso nos da un marcador fácil para distinguir "procesó" de "no procesó":

- Si `processMessage` corrió → 1 fetch call a `graph.facebook.com`.
- Si fue bloqueado antes (rate limit, idempotency) → 0 fetch calls a `graph.facebook.com`.

Filtro de assertions:
```js
const waCalls = fetchMock.mock.calls.filter(([url]) =>
  typeof url === "string" && url.includes("graph.facebook.com")
);
expect(waCalls.length).toBe(0);  // no procesó
```

## 5. Gotchas conocidos (errores que nos pasaron de verdad)

### 5.1 Caracteres invisibles en env vars

Los env vars copia-pegados desde dashboards web a veces traen caracteres invisibles al inicio/final (zero-width space, BOM, espacios). Para valores sensibles como `META_APP_SECRET` esto **es letal**: el HMAC falla sin mensaje claro.

**Mitigaciones**:
- En Vercel dashboard: pegar el valor en un editor plano (Notepad, vim) antes de pegarlo al formulario.
- Si aparecen fallos persistentes de HMAC con valores "correctos" a simple vista, hacer `echo -n "$META_APP_SECRET" | xxd` desde una función de diagnóstico y verificar el hex.

### 5.2 Formato de body distinto entre tests y producción

Nuestros tests construyen bodies mínimos (un solo message, contacts opcional). Meta real manda mucho más (`metadata`, `display_phone_number`, `phone_number_id`, contexto de referencias, etc.). **Nunca asumir que un test passing = prod ok** para cambios de parsing del body. Validar con webhook real o al menos con payloads reales capturados.

### 5.3 Body parser roto por typo de 1 carácter

Incidente real de Día 1: un typo de **una `h` sobrante** al final de una línea (`const Anthropic = require("@anthropic-ai/sdk");h`) tiró el bot en producción con `ReferenceError: h is not defined` en cold start. El parseo de Node falló sin deploy error porque era válido sintácticamente hasta el `;` y la `h` se interpretaba como una referencia.

**Mitigación implementada**: husky pre-commit hook que corre `node --check` sobre cada `api/*.js` staged:

```sh
# .husky/pre-commit
for file in $(git diff --cached --name-only --diff-filter=ACM | grep '^api/.*\.js$'); do
  echo "Checking syntax: $file"
  node --check "$file" || {
    echo "❌ Syntax error in $file — commit aborted."
    exit 1
  }
done
```

Aborta el commit si hay error de sintaxis. No hace análisis semántico, pero atrapa typos grandes.

### 5.4 @upstash/ratelimit como dependencia de producción

`@upstash/ratelimit` va en `dependencies`, **no** en `devDependencies`. Necesita estar en el bundle serverless. Verificar con `npm ls @upstash/ratelimit` que esté listado bajo `dependencies`.

### 5.5 Vercel Hobby plan limita cron jobs a daily

Si el plan es Hobby (no Pro), cron de `0 */12 * * *` (dos veces por día) es rechazado por el build. Para mantener soporte Hobby, usar cron daily: `0 13 * * *` (9am RD). Cuando migren a Pro, cambiar a `0 13,23 * * *` para doble corrida y mejor cobertura de la ventana horaria de envío (9am-7pm RD).

### 5.6 vercel.json includeFiles para archivos leídos en runtime

Los skills `.claude/skills/**/*.md` se leen con `fs.readFileSync` en cold start. El Vercel tracer no detecta paths dinámicos de `path.join(__dirname, "..", ...)`. Sin `config.includeFiles: ".claude/skills/**/*.md"` en el build de webhook.js, los archivos NO van al bundle y el cold start loggea `[prompt] ERROR loading skill files: ENOENT...`.

```json
{
  "src": "api/webhook.js",
  "use": "@vercel/node",
  "config": {
    "includeFiles": ".claude/skills/**/*.md"
  }
}
```

Verificar post-deploy en Runtime Logs: debe aparecer `[prompt] skill loaded: XXXXX chars, inventory: YYYY chars`. Si no aparece, el bundling falló.
