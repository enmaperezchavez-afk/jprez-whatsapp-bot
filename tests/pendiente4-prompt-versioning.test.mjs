// Tests del sistema de prompt versioning + auto-invalidación — Pendiente-4.
//
// Cubre:
//   1. computePromptHash determinístico (mismo input → mismo output, 12 chars hex)
//   2. computePromptHash cambia con 1 char diff
//   3. History v1 (array plano) migra a v2 transparentemente al leer
//   4. Hard invalidation: hash mismatch → backup creado + chat:phone borrado
//   5. Backup TTL ≈ 604800s (7 días)
//   6. Sin mismatch (hash igual) → passthrough, no se borra ni se backupea
//   7. Métrica botLog se emite en formato Axiom esperado
//
// Patron: require.cache patching de @upstash/redis (consistente con
// hotfix6-testing-mode.test.mjs / skill jprez-security-patterns §4.1).
// Mock Redis stateful con TTL para verificar backup expirable.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// ===== Estado compartido del Redis mock =====

const redisState = new Map();
const redisTtlSet = new Map(); // key → ttl en segundos seteado por SET con {ex}

function redisGet(key) {
  return redisState.has(key) ? redisState.get(key) : null;
}
function redisSet(key, value, opts = {}) {
  redisState.set(key, value);
  if (opts?.ex) redisTtlSet.set(key, opts.ex);
  return "OK";
}
function redisDel(key) {
  const had = redisState.has(key);
  redisState.delete(key);
  redisTtlSet.delete(key);
  return had ? 1 : 0;
}

// Spy de las llamadas a botLog (level, message, data).
const botLogCalls = [];

// ===== require.cache patching =====

{
  const moduleId = require.resolve("@upstash/redis");
  require.cache[moduleId] = {
    id: moduleId,
    filename: moduleId,
    loaded: true,
    exports: {
      Redis: class {
        constructor() {}
        async get(key) { return redisGet(key); }
        async set(key, value, opts = {}) { return redisSet(key, value, opts); }
        async del(key) { return redisDel(key); }
      },
    },
  };
}

{
  // Stub de log: capturamos las llamadas para Test 7.
  const moduleId = require.resolve("../src/log");
  require.cache[moduleId] = {
    id: moduleId,
    filename: moduleId,
    loaded: true,
    exports: {
      botLog: (level, message, data) => {
        botLogCalls.push({ level, message, data });
      },
      logToAxiom: async () => {},
    },
  };
}

// Env vars para que getRedis devuelva un cliente (no null)
process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";

// Import post-cache-patching
const {
  computePromptHash,
  checkAndInvalidate,
  BACKUP_TTL_SECONDS,
  HASH_LENGTH,
} = require("../src/prompt-version");
const {
  getHistory,
  getHistoryWithMeta,
  addMessage,
} = require("../src/store/history");

// ===== Helpers =====

function resetState() {
  redisState.clear();
  redisTtlSet.clear();
  botLogCalls.length = 0;
}

const PROMPT_A = "Eres un asistente útil. Responde en español.";
const PROMPT_B = "Eres un asistente útil. Responde en español!"; // 1 char diff

const PHONE = "18091234567";

beforeEach(() => {
  resetState();
});

// ===== Tests =====

describe("Pendiente-4 — computePromptHash", () => {
  it("Test 1: determinístico (mismo input → mismo hash, longitud 12 hex)", () => {
    const h1 = computePromptHash(PROMPT_A);
    const h2 = computePromptHash(PROMPT_A);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{12}$/);
    expect(h1.length).toBe(HASH_LENGTH);
  });

  it("Test 2: cambia con 1 char de diferencia", () => {
    const h1 = computePromptHash(PROMPT_A);
    const h2 = computePromptHash(PROMPT_B);
    expect(h1).not.toBe(h2);
    expect(h2).toMatch(/^[0-9a-f]{12}$/);
  });

  it("rechaza inputs inválidos (string vacío, no-string)", () => {
    expect(() => computePromptHash("")).toThrow();
    expect(() => computePromptHash(null)).toThrow();
    expect(() => computePromptHash(undefined)).toThrow();
    expect(() => computePromptHash(42)).toThrow();
  });
});

describe("Pendiente-4 — Migración v1 → v2 en getHistoryWithMeta", () => {
  it("Test 3: historial v1 (array plano) migra transparentemente a v2", async () => {
    // Simular historial v1 escrito por código pre-Pendiente-4 (array plano)
    const v1Messages = [
      { role: "user", content: "hola" },
      { role: "assistant", content: "hola, ¿en qué te ayudo?" },
    ];
    redisState.set("chat:" + PHONE, JSON.stringify(v1Messages));

    const data = await getHistoryWithMeta(PHONE);
    expect(data.v).toBe(1);
    expect(data.promptHash).toBe(null);
    expect(data.messages).toEqual(v1Messages);

    // getHistory() (legacy) debe seguir retornando solo el array de mensajes
    const messages = await getHistory(PHONE);
    expect(messages).toEqual(v1Messages);
  });

  it("getHistoryWithMeta retorna estructura limpia para historial vacío", async () => {
    const data = await getHistoryWithMeta(PHONE);
    expect(data).toEqual({ v: 2, promptHash: null, messages: [] });
  });

  it("addMessage con promptHash escribe estructura v2 que getHistoryWithMeta lee correcto", async () => {
    const hash = computePromptHash(PROMPT_A);
    await addMessage(PHONE, "user", "hola", hash);

    const data = await getHistoryWithMeta(PHONE);
    expect(data.v).toBe(2);
    expect(data.promptHash).toBe(hash);
    expect(data.messages).toEqual([{ role: "user", content: "hola" }]);
  });
});

describe("Pendiente-4 — checkAndInvalidate (HARD mode)", () => {
  it("Test 4: hash mismatch → chat:phone borrado + backup creado", async () => {
    const hashA = computePromptHash(PROMPT_A);
    const hashB = computePromptHash(PROMPT_B);

    // Sembrar historial v2 con hashA y 3 mensajes
    await addMessage(PHONE, "user", "primer mensaje", hashA);
    await addMessage(PHONE, "assistant", "respuesta 1", hashA);
    await addMessage(PHONE, "user", "segundo mensaje", hashA);
    expect(redisState.has("chat:" + PHONE)).toBe(true);

    // Llamar con hash distinto
    const result = await checkAndInvalidate(PHONE, hashB);

    expect(result.invalidated).toBe(true);
    expect(result.messagesDropped).toBe(3);
    expect(result.backupKey).toMatch(/^backup:chat:18091234567:\d+-[a-z0-9]{1,4}$/);

    // chat:phone debe estar borrado, backup presente
    expect(redisState.has("chat:" + PHONE)).toBe(false);
    expect(redisState.has(result.backupKey)).toBe(true);

    // El backup debe contener el historial v2 completo (3 mensajes con hashA)
    const backupRaw = redisState.get(result.backupKey);
    const backup = JSON.parse(backupRaw);
    expect(backup.promptHash).toBe(hashA);
    expect(backup.messages.length).toBe(3);
    expect(backup.messages[0]).toEqual({ role: "user", content: "primer mensaje" });
  });

  it("Test 5: backup tiene TTL de 7 días (604800s)", async () => {
    const hashA = computePromptHash(PROMPT_A);
    const hashB = computePromptHash(PROMPT_B);

    await addMessage(PHONE, "user", "msg", hashA);
    const result = await checkAndInvalidate(PHONE, hashB);
    expect(result.invalidated).toBe(true);

    const ttl = redisTtlSet.get(result.backupKey);
    expect(ttl).toBe(BACKUP_TTL_SECONDS);
    expect(ttl).toBe(604800);
  });

  it("Test 6: hash igual → passthrough (NO borra, NO crea backup)", async () => {
    const hashA = computePromptHash(PROMPT_A);

    await addMessage(PHONE, "user", "msg1", hashA);
    await addMessage(PHONE, "assistant", "msg2", hashA);
    const initialKeys = [...redisState.keys()];

    const result = await checkAndInvalidate(PHONE, hashA);

    expect(result.invalidated).toBe(false);
    expect(result.backupKey).toBeUndefined();
    // chat:phone preservado
    expect(redisState.has("chat:" + PHONE)).toBe(true);
    // Sin backup keys creadas
    const finalKeys = [...redisState.keys()];
    expect(finalKeys).toEqual(initialKeys);
    // Y NO se logueó "prompt_invalidation"
    const invalidationLogs = botLogCalls.filter(
      (c) => c.message === "prompt_invalidation"
    );
    expect(invalidationLogs.length).toBe(0);
  });

  it("historial v1 legacy (sin hash) → passthrough en primera llamada", async () => {
    // Sembrar v1 (sin hash). El feature NO debe invalidar — un cliente
    // pre-Pendiente-4 no pierde su historial al primer turno post-deploy.
    redisState.set(
      "chat:" + PHONE,
      JSON.stringify([{ role: "user", content: "hola pre-deploy" }])
    );
    const hash = computePromptHash(PROMPT_A);

    const result = await checkAndInvalidate(PHONE, hash);

    expect(result.invalidated).toBe(false);
    expect(redisState.has("chat:" + PHONE)).toBe(true);
  });
});

describe("Pendiente-4 — Métrica Axiom", () => {
  it("Test 7: prompt_invalidation se emite con todos los campos esperados", async () => {
    const hashA = computePromptHash(PROMPT_A);
    const hashB = computePromptHash(PROMPT_B);

    await addMessage(PHONE, "user", "uno", hashA);
    await addMessage(PHONE, "assistant", "dos", hashA);
    botLogCalls.length = 0; // Limpiar logs previos a la invalidación

    const result = await checkAndInvalidate(PHONE, hashB);
    expect(result.invalidated).toBe(true);

    const invalidationLog = botLogCalls.find(
      (c) => c.message === "prompt_invalidation"
    );
    expect(invalidationLog).toBeDefined();
    expect(invalidationLog.level).toBe("info");
    expect(invalidationLog.data).toMatchObject({
      phone: PHONE,
      oldHash: hashA,
      newHash: hashB,
      mode: "hard",
      messagesDropped: 2,
    });
    expect(invalidationLog.data.backupKey).toMatch(
      /^backup:chat:18091234567:\d+-[a-z0-9]{1,4}$/
    );
  });
});
