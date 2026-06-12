// MATEO V6 — F1: config del tenant JPREZ con PARIDAD probada.
//
// La config (config/tenants/jprez.json) es la futura fuente única. En F1
// el código AÚN NO la consume — este test garantiza que nace ESPEJO del
// comportamiento actual: cada valor se verifica contra la constante o el
// comportamiento del código que lo origina.
//
// EXCEPCIÓN DOCUMENTADA (orden del Director, ratificación 12 jun):
// el plan base de Crux T6 NO se valida por "paridad ciega" con el código
// histórico — el 10/20/70 era BUG (Hotfix-33 lo corrigió a 5/25/70 de la
// Doctrina v1.1). La config nace con el valor DOCTRINAL y el test lo
// asserta contra la doctrina, no contra el pasado.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const CONFIG = JSON.parse(readFileSync("config/tenants/jprez.json", "utf8"));
const SCHEMA = JSON.parse(readFileSync("config/tenant.schema.json", "utf8"));

const { calcularPlanPago, BROCHURE_DRIVE_IDS } = require("../src/handlers/message.js");
const { RESERVAS } = require("../src/documents/cuotas-schedule.js");
const { PROJECT_META, SCHEMES, VALID_PROJECTS } = require("../src/documents/price-list-generator.js");
const { getTheme } = require("../src/documents/project-themes.js");
const { LOGO_KEYS } = require("../src/documents/plan-xlsx-generator.js");
const { HUMAN_HANDOFF_REPLY_ES } = require("../src/detect.js");
const { ADMIN_PHONES } = require("../src/staff.js");
const { CHECKLIST_DOCTRINA } = require("./qa-simulador/helpers/evaluador.mjs");

const porKey = Object.fromEntries(CONFIG.proyectos.map((p) => [p.key, p]));

describe("V6-F1 — estructura (el schema como contrato, validado a mano hasta F2)", () => {
  it("campos requeridos del schema presentes", () => {
    for (const campo of SCHEMA.required) expect(CONFIG, campo).toHaveProperty(campo);
    expect(CONFIG.tenant_id).toBe("jprez");
    expect(CONFIG.prompt_version).toBe(1);
  });

  it("keys canónicas = las del Bloque 2 (decisión 2 de la ratificación)", () => {
    expect(Object.keys(porKey).sort()).toEqual(
      ["crux_listos", "crux_t6", "pr3", "pr4", "pse3", "pse4"]
    );
    // y son EXACTAMENTE las del generador de documentos
    expect(Object.keys(porKey).sort()).toEqual([...VALID_PROJECTS].sort());
  });

  it("todo plan_base y margen suma 100 (validación dura del schema)", () => {
    for (const p of CONFIG.proyectos) {
      if (p.plan_base) expect(p.plan_base.reduce((a, b) => a + b, 0), p.key).toBe(100);
      for (const m of p.margenes || []) expect(m.reduce((a, b) => a + b, 0), p.key).toBe(100);
    }
  });

  it("cero secretos en la config: solo NOMBRES de env vars", () => {
    const raw = readFileSync("config/tenants/jprez.json", "utf8");
    expect(CONFIG.canal.phone_number_id_env).toBe("WHATSAPP_PHONE_NUMBER_ID");
    expect(raw).not.toMatch(/sk-ant|EAAG|Bearer\s|xaat-|AIza/); // shapes de secretos conocidos
  });

  it("la escalera es constitucional: revelar tope/mecánica = false por SCHEMA (const)", () => {
    expect(SCHEMA.properties.doctrina.properties.escalera.properties.revelar_tope).toEqual({ const: false });
    expect(CONFIG.doctrina.escalera.revelar_tope).toBe(false);
    expect(CONFIG.doctrina.escalera.condicion_primero).toBe(true);
  });
});

describe("V6-F1 — PARIDAD de comportamiento (config ↔ código actual)", () => {
  it("planes y fechas: la calculadora REAL reproduce cada proyecto en construcción", () => {
    for (const p of CONFIG.proyectos) {
      if (!p.calc_key_legacy || !p.plan_base) continue;
      const plan = calcularPlanPago(p.calc_key_legacy, 100000, p.etapa_legacy);
      expect(plan.error, p.key).toBeUndefined();
      expect(plan.separacion_pct, p.key).toBe(p.plan_base[0]);
      expect(plan.completivo_pct, p.key).toBe(p.plan_base[1]);
      expect(plan.contra_entrega_pct, p.key).toBe(p.plan_base[2]);
      expect(plan.entrega_fecha, p.key).toBe(p.entrega);
    }
  });

  it("EXCEPCIÓN Hotfix-33: Crux T6 = 5/25/70 por DOCTRINA, no por paridad histórica", () => {
    expect(porKey.crux_t6.plan_base).toEqual([5, 25, 70]);
    expect(porKey.crux_t6.margenes).toEqual([[5, 20, 75], [5, 15, 80]]);
    expect(porKey.crux_t6.nota_margenes).toMatch(/pre-aprobación bancaria/);
    // y el código YA lo refleja (el hotfix aterrizó antes que F1):
    expect(SCHEMES.crux_t6).toEqual({ sep: 0.05, comp: 0.25, saldo: 0.70 });
  });

  it("reservas por proyecto = cuotas-schedule (doctrina v1.1)", () => {
    expect(porKey.crux_t6.reserva).toBe(RESERVAS.crux);
    expect(porKey.pr3.reserva).toBe(RESERVAS.pr3);
    expect(porKey.pr4.reserva).toBe(RESERVAS.pr4);
    expect(porKey.pse3.reserva).toBe(RESERVAS.puertoPlata);
    expect(porKey.pse4.reserva).toBe(RESERVAS.puertoPlata);
  });

  it("identidad documental: nombres, moneda, themes y logos = Bloque 2", () => {
    for (const p of CONFIG.proyectos) {
      expect(PROJECT_META[p.key], p.key).toBeDefined();
      expect(PROJECT_META[p.key].name, p.key).toBe(p.nombre);
      expect(PROJECT_META[p.key].currency, p.key).toBe(p.moneda);
      expect(getTheme(p.key), p.key).toBeDefined();
      expect(getTheme(p.key).palette.accent, p.key).toMatch(/^#/);
      if (LOGO_KEYS[p.key]) expect(LOGO_KEYS[p.key], p.key).toBe(p.logo);
    }
    // NOTA (no-assert): PROJECT_META.location dice "SANTIAGO" para Crux y el
    // frozen prompt dice "SDN" — discrepancia ABIERTA reportada al Director;
    // la ubicación NO se valida hasta que él la zanje.
  });

  it("brochures = BROCHURE_DRIVE_IDS del handler", () => {
    for (const p of CONFIG.proyectos) {
      expect(p.brochure_drive_id, p.key).toBe(BROCHURE_DRIVE_IDS[p.key]);
    }
  });

  it("doctrina: tope, handoff canónico y reglas duras = fuentes vivas", () => {
    expect(CONFIG.doctrina.descuento_autonomo_max_usd).toBe(1500);
    expect(CHECKLIST_DOCTRINA).toContain("US$1,500"); // el certificador audita el mismo número
    expect(CONFIG.doctrina.handoff_canonico_es).toBe(HUMAN_HANDOFF_REPLY_ES); // single source
    const ids = CONFIG.doctrina.reglas_duras.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(["R4", "R5", "FERIA", "TASA", "ICDV", "BPV", "RANGOS"]));
    const skillVendedor = readFileSync(".claude/skills/vendedor-whatsapp-jprez/SKILL.md", "utf8");
    expect(skillVendedor).toMatch(/prometer respuesta futura/i); // R4 vive en el skill hoy
  });

  it("canal: admin_phones = ADMIN_PHONES del código", () => {
    expect(CONFIG.canal.admin_phones).toEqual(ADMIN_PHONES);
  });

  it("entregas: E4 dic 2027 y E3 mar 2029 (datos canónicos post-Sprint0)", () => {
    expect(porKey.pse4.entrega).toBe("2027-12-01");
    expect(porKey.pse3.entrega).toBe("2029-03-01");
    expect(porKey.pr3.entrega).toBe("2026-08-01");
    expect(porKey.crux_listos.entrega).toBeNull(); // entrega inmediata
    expect(porKey.crux_listos.plan_base).toBeNull(); // sin plan de cuotas
  });
});
