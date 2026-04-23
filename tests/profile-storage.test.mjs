// Tests del storage del perfil Mateo (profile:<phone>).
//
// Patron adoptado desde tests/idempotency.test.mjs (skill jprez-security-patterns):
// require.cache patching para interceptar @upstash/redis con un Map stateful.
// Esto funciona porque src/store/redis.js hace require("@upstash/redis") DENTRO
// de la funcion, no al top del modulo.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// Map compartido que simula Redis stateful
const redisState = new Map();
let ttlState = new Map(); // Track TTL por key para testear sliding

{
  const moduleId = require.resolve("@upstash/redis");
  require.cache[moduleId] = {
    id: moduleId,
    filename: moduleId,
    loaded: true,
    exports: {
      Redis: class {
        constructor() {}
        async get(key) {
          return redisState.has(key) ? redisState.get(key) : null;
        }
        async set(key, value, opts = {}) {
          if (opts && opts.nx && redisState.has(key)) return null;
          redisState.set(key, value);
          if (opts && opts.ex) ttlState.set(key, opts.ex);
          return "OK";
        }
        async del(key) {
          const had = redisState.has(key);
          redisState.delete(key);
          ttlState.delete(key);
          return had ? 1 : 0;
        }
      },
    },
  };
}

process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";

const { getCustomerProfile, updateCustomerProfile, PROFILE_KEY_PREFIX, TTL_SECONDS } = require("../src/profile/storage");

const PHONE = "18091112222";

describe("getCustomerProfile", () => {
  beforeEach(() => {
    redisState.clear();
    ttlState.clear();
  });

  it("cliente nuevo: retorna shape con is_new=true y defaults vacios", async () => {
    const profile = await getCustomerProfile(PHONE);
    expect(profile.is_new).toBe(true);
    expect(profile.wa_id).toBe(PHONE);
    expect(profile.telefono).toBe(PHONE);
    expect(profile.nombre).toBeNull();
    expect(profile.tags).toEqual([]);
    expect(profile.conversaciones_count).toBe(0);
  });

  it("cliente existente: retorna el parseado con is_new=false", async () => {
    redisState.set(PROFILE_KEY_PREFIX + PHONE, JSON.stringify({
      wa_id: PHONE,
      nombre: "Juan",
      conversaciones_count: 3,
      tags: ["diaspora"],
    }));
    const profile = await getCustomerProfile(PHONE);
    expect(profile.is_new).toBe(false);
    expect(profile.nombre).toBe("Juan");
    expect(profile.conversaciones_count).toBe(3);
  });

  it("Redis retorna objeto ya parseado (Upstash a veces lo hace)", async () => {
    redisState.set(PROFILE_KEY_PREFIX + PHONE, {
      wa_id: PHONE,
      nombre: "Maria",
    });
    const profile = await getCustomerProfile(PHONE);
    expect(profile.nombre).toBe("Maria");
    expect(profile.is_new).toBe(false);
  });
});

describe("updateCustomerProfile — merge inteligente", () => {
  beforeEach(() => {
    redisState.clear();
    ttlState.clear();
  });

  it("primer update: crea perfil con timestamps + conversaciones_count=1", async () => {
    const merged = await updateCustomerProfile(PHONE, { nombre: "Juan" });
    expect(merged.nombre).toBe("Juan");
    expect(merged.conversaciones_count).toBe(1);
    expect(merged.fecha_primer_contacto).toBeTruthy();
    expect(merged.ultimo_contacto).toBeTruthy();
    expect(merged.wa_id).toBe(PHONE);
    expect(merged.is_new).toBeUndefined(); // No se persiste
  });

  it("scalars: null/undefined/\"\" NO pisan el valor existente", async () => {
    await updateCustomerProfile(PHONE, { nombre: "Juan", proyecto_interes: "crux" });
    const merged = await updateCustomerProfile(PHONE, {
      nombre: null,
      proyecto_interes: undefined,
      tipologia_interes: "",
      presupuesto_mencionado: 150000,
    });
    expect(merged.nombre).toBe("Juan"); // preservado
    expect(merged.proyecto_interes).toBe("crux"); // preservado
    expect(merged.tipologia_interes).toBeNull(); // nunca se seteo
    expect(merged.presupuesto_mencionado).toBe(150000); // actualizado
  });

  it("scalars: valor concreto pisa al existente", async () => {
    await updateCustomerProfile(PHONE, { nombre: "Juan" });
    const merged = await updateCustomerProfile(PHONE, { nombre: "Juan Perez" });
    expect(merged.nombre).toBe("Juan Perez");
  });

  it("arrays: union sin duplicados, orden preservado", async () => {
    await updateCustomerProfile(PHONE, { tags_nuevos: ["diaspora", "USA-NY"] });
    const merged = await updateCustomerProfile(PHONE, { tags_nuevos: ["USA-NY", "inversionista"] });
    expect(merged.tags).toEqual(["diaspora", "USA-NY", "inversionista"]);
  });

  it("competencia_mencionada: union sin duplicados", async () => {
    await updateCustomerProfile(PHONE, { competencia_mencionada: ["Torre X"] });
    const merged = await updateCustomerProfile(PHONE, { competencia_mencionada: ["Torre X", "Vertex"] });
    expect(merged.competencia_mencionada).toEqual(["Torre X", "Vertex"]);
  });

  it("documentos_solicitados (bloque) → documentos_enviados (perfil): mapeo + union", async () => {
    const merged = await updateCustomerProfile(PHONE, { documentos_solicitados: ["brochure-crux"] });
    expect(merged.documentos_enviados).toEqual(["brochure-crux"]);
  });

  it("objecion_detectada: se acumula en objeciones_historicas", async () => {
    await updateCustomerProfile(PHONE, { objecion_detectada: "precio" });
    const merged = await updateCustomerProfile(PHONE, { objecion_detectada: "plazo_entrega" });
    expect(merged.objeciones_historicas).toEqual(["precio", "plazo_entrega"]);
  });

  it("objecion_nueva=true con texto: se push-ea al historial", async () => {
    const merged = await updateCustomerProfile(PHONE, {
      objecion_nueva: true,
      objecion_nueva_texto: "quiere que nos mudemos a Bavaro",
    });
    expect(merged.objeciones_historicas).toContain("quiere que nos mudemos a Bavaro");
  });

  it("siguiente_accion_sugerida='none' NO pisa siguiente_accion_pendiente", async () => {
    await updateCustomerProfile(PHONE, { siguiente_accion_sugerida: "send_brochure" });
    const merged = await updateCustomerProfile(PHONE, { siguiente_accion_sugerida: "none" });
    expect(merged.siguiente_accion_pendiente).toBe("send_brochure"); // preservado
  });

  it("siguiente_accion_sugerida valida pisa el valor anterior", async () => {
    await updateCustomerProfile(PHONE, { siguiente_accion_sugerida: "send_brochure" });
    const merged = await updateCustomerProfile(PHONE, { siguiente_accion_sugerida: "schedule_visit" });
    expect(merged.siguiente_accion_pendiente).toBe("schedule_visit");
  });

  it("info_interna: shallow merge (delta gana por key)", async () => {
    await updateCustomerProfile(PHONE, { info_interna: { profesion: "ingeniero", zona: "naco" } });
    const merged = await updateCustomerProfile(PHONE, { info_interna: { zona: "piantini", empresa: "X" } });
    expect(merged.info_interna).toEqual({
      profesion: "ingeniero", // preservado
      zona: "piantini", // pisado
      empresa: "X", // nuevo
    });
  });

  it("ultimo_contacto se bumpea en cada update", async () => {
    const first = await updateCustomerProfile(PHONE, { nombre: "Juan" });
    await new Promise((r) => setTimeout(r, 10));
    const second = await updateCustomerProfile(PHONE, { nombre: "Juan" });
    expect(second.ultimo_contacto >= first.ultimo_contacto).toBe(true);
  });

  it("conversaciones_count incrementa 1 por update", async () => {
    const a = await updateCustomerProfile(PHONE, {});
    const b = await updateCustomerProfile(PHONE, {});
    const c = await updateCustomerProfile(PHONE, {});
    expect(a.conversaciones_count).toBe(1);
    expect(b.conversaciones_count).toBe(2);
    expect(c.conversaciones_count).toBe(3);
  });

  it("fecha_primer_contacto se setea SOLO en la primera interaccion", async () => {
    const first = await updateCustomerProfile(PHONE, {});
    const firstDate = first.fecha_primer_contacto;
    await new Promise((r) => setTimeout(r, 10));
    const second = await updateCustomerProfile(PHONE, {});
    expect(second.fecha_primer_contacto).toBe(firstDate);
  });

  it("TTL sliding: cada update reseta EX a 90 dias", async () => {
    await updateCustomerProfile(PHONE, {});
    expect(ttlState.get(PROFILE_KEY_PREFIX + PHONE)).toBe(TTL_SECONDS);
    // simular que paso tiempo -> re-update reseta
    ttlState.delete(PROFILE_KEY_PREFIX + PHONE);
    await updateCustomerProfile(PHONE, {});
    expect(ttlState.get(PROFILE_KEY_PREFIX + PHONE)).toBe(TTL_SECONDS);
  });

  it("wa_id y telefono se fuerzan siempre al phone pasado", async () => {
    redisState.set(PROFILE_KEY_PREFIX + PHONE, JSON.stringify({
      wa_id: "NUMERO_VIEJO_INCORRECTO",
      telefono: "OTRO_NUMERO",
    }));
    const merged = await updateCustomerProfile(PHONE, {});
    expect(merged.wa_id).toBe(PHONE);
    expect(merged.telefono).toBe(PHONE);
  });
});
