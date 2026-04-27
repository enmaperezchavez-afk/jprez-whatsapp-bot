// Tests de hotfix-11 Día 4: admin-testing-mode usa getRedis compartido
// (patrón dual de env vars).
//
// MOTIVACIÓN: Cowork detectó que `src/admin-testing-mode.js` instanciaba su
// propio cliente Redis con `new Redis({ url: UPSTASH_REDIS_REST_URL, ... })`
// y NO soportaba el formato Vercel Storage `UPSTASH_REDIS_REST_KV_REST_API_*`
// que SÍ usa el resto del repo (store/redis, store/meta, store/history,
// profile/storage, security/idempotency, security/ratelimit).
//
// Resultado: si Vercel proveía solo el formato KV_REST_API_*, las llamadas
// /test-on, /test-off, /test-status fallaban silenciosamente con
// `redis_write_error` mientras el resto del bot funcionaba normal — un bug
// asimétrico difícil de diagnosticar.
//
// Fix Hotfix-11:
//   1. Eliminar el getRedis() local + el `let redisClient` memoizado.
//   2. Eliminar `require("@upstash/redis")` top-level.
//   3. Importar `const { getRedis } = require("./store/redis")` (que ya
//      implementa el patrón dual desde hace meses).
//   4. Las 4 llamadas (isActive, activate, deactivate, getStatus) ahora
//      usan `await getRedis()` (el shared es async, el local era sync).
//
// Patrón de tests: string-matching estático sobre el código fuente
// (consistente con hotfix3-polish, hotfix5-identity-inventory,
// hotfix7-supervisor-identity, hotfix8-mojibake, hotfix10-observability).

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const ADMIN_TESTING_PATH = join(PROJECT_ROOT, "src", "admin-testing-mode.js");
const STORE_REDIS_PATH = join(PROJECT_ROOT, "src", "store", "redis.js");

describe("Hotfix-11 — admin-testing-mode usa getRedis compartido (Redis dual)", () => {
  it("admin-testing-mode.js importa getRedis de ./store/redis y NO instancia Redis local", async () => {
    const content = await readFile(ADMIN_TESTING_PATH, "utf-8");

    // Importa el getRedis compartido
    expect(content).toContain('require("./store/redis")');
    expect(content).toMatch(/const\s*\{\s*getRedis\s*\}\s*=\s*require\("\.\/store\/redis"\)/);

    // YA NO requiere @upstash/redis directamente
    expect(content).not.toContain('require("@upstash/redis")');

    // YA NO instancia el cliente Redis localmente
    expect(content).not.toContain("new Redis(");

    // YA NO tiene el flag memoizado redisClient (se delegó al shared)
    expect(content).not.toContain("let redisClient");
  });

  it("las 4 llamadas a getRedis() están awaiteadas (el shared es async)", async () => {
    const content = await readFile(ADMIN_TESTING_PATH, "utf-8");

    // Quitar comentarios para evitar matches falsos en docstrings
    const codeOnly = content
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    // Exactamente 4 llamadas await getRedis() — una por cada función pública
    // que toca Redis: isActive, activate, deactivate, getStatus.
    const awaitedCalls = codeOnly.match(/await\s+getRedis\(\)/g) || [];
    expect(awaitedCalls.length).toBe(4);

    // CERO llamadas sin await (regresión común al editar este archivo).
    // Buscamos `getRedis()` que NO esté precedido de `await ` (con boundary
    // de palabra para no matchear `await getRedis()`).
    const unawaitedCalls = codeOnly.match(/(?<!await\s)\bgetRedis\(\)/g) || [];
    expect(unawaitedCalls.length).toBe(0);
  });

  it("el getRedis compartido (store/redis.js) implementa el patrón dual de env vars", async () => {
    const content = await readFile(STORE_REDIS_PATH, "utf-8");

    // Soporta el formato Vercel Storage (KV_REST_API_*)
    expect(content).toContain("UPSTASH_REDIS_REST_KV_REST_API_URL");
    expect(content).toContain("UPSTASH_REDIS_REST_KV_REST_API_TOKEN");

    // Y el formato manual (UPSTASH_REDIS_REST_*)
    expect(content).toContain("UPSTASH_REDIS_REST_URL");
    expect(content).toContain("UPSTASH_REDIS_REST_TOKEN");

    // Con fallback || entre ambos (KV_REST_API tiene prioridad por venir
    // pre-cargado en deployments Vercel con la integración de Storage).
    expect(content).toMatch(
      /UPSTASH_REDIS_REST_KV_REST_API_URL\s*\|\|\s*process\.env\.UPSTASH_REDIS_REST_URL/
    );
    expect(content).toMatch(
      /UPSTASH_REDIS_REST_KV_REST_API_TOKEN\s*\|\|\s*process\.env\.UPSTASH_REDIS_REST_TOKEN/
    );

    // getRedis es async (admin-testing depende de eso para sus awaits)
    expect(content).toMatch(/async\s+function\s+getRedis/);
  });
});
