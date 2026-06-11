// Sprint 1 PR-4 — generador dinámico de documentos: Excel del plan de
// pago por WhatsApp con URL firmada (HMAC + exp 7d, cero storage).
//
// El XLSX generado se valida con el mini-lector zip del PR-1
// (tasa-parser.extractZipEntries): round-trip real sin red.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { signDocPayload, verifyDocPayload, DEFAULT_TTL_MS } = require("../src/security/doc-signing.js");
const { generatePlanXlsx, themeIdFor } = require("../src/documents/plan-xlsx-generator.js");
const { TOOL_GENERAR_PLAN_XLSX, generarPlanXlsxTool } = require("../src/tools/plan-xlsx.js");
const { extractZipEntries } = require("../src/services/tasa-parser.js");

const PLAN = {
  proyecto: "Crux del Prado",
  precio_total_usd: 137000,
  separacion_usd: 13700,
  separacion_pct: 10,
  completivo_total_usd: 27400,
  completivo_pct: 20,
  cuota_mensual_usd: 2108,
  meses_hasta_entrega: 13,
  contra_entrega_usd: 95900,
  contra_entrega_pct: 70,
  entrega_fecha: "2027-07-01",
};

const REAJUSTE = {
  ok: true,
  estimado: true,
  tasa: { mensual_pct: 0.3832, fuente: "CAGR de la serie ICDV oficial (ONE) acumulada" },
  proyeccion: {
    tasa_mensual_pct: 0.3832,
    meses_proyectados: 13,
    reajuste_total_estimado_usd: 5512,
    reajuste_promedio_mensual_usd: 424,
    precio_ajustado_estimado_usd: 142512,
  },
};

const SECRET = "test-secret-firmas";

describe("PLAN-XLSX — doc-signing (HMAC + exp)", () => {
  it("round-trip: firmar y verificar devuelve el payload", () => {
    const { p, s } = signDocPayload({ plan: PLAN, proyectoCalc: "crux" }, { secret: SECRET, now: 1000 });
    const v = verifyDocPayload(p, s, { secret: SECRET, now: 2000 });
    expect(v.ok).toBe(true);
    expect(v.data.plan.precio_total_usd).toBe(137000);
    expect(v.data.exp).toBe(1000 + DEFAULT_TTL_MS);
  });

  it("firma adulterada o payload adulterado -> rechazo", () => {
    const { p, s } = signDocPayload({ plan: PLAN }, { secret: SECRET });
    expect(verifyDocPayload(p, s.replace(/^./, "f"), { secret: SECRET }).ok).toBe(false);
    const otroPayload = Buffer.from(JSON.stringify({ plan: { ...PLAN, precio_total_usd: 1 }, exp: Date.now() + 9e9 })).toString("base64url");
    expect(verifyDocPayload(otroPayload, s, { secret: SECRET }).ok).toBe(false);
  });

  it("link vencido (exp 7d) -> reason expired", () => {
    const { p, s } = signDocPayload({ plan: PLAN }, { secret: SECRET, now: 0 });
    const v = verifyDocPayload(p, s, { secret: SECRET, now: DEFAULT_TTL_MS + 1 });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("expired");
  });

  it("fail-closed: sin secret no firma (throw) ni verifica (no_secret)", () => {
    expect(() => signDocPayload({ plan: PLAN }, { secret: undefined })).toThrow(/META_APP_SECRET/);
    expect(verifyDocPayload("x", "y", { secret: undefined })).toEqual({ ok: false, reason: "no_secret" });
  });
});

describe("PLAN-XLSX — generador (ExcelJS + themes Bloque 2)", () => {
  it("genera un XLSX real: zip válido con hoja Plan de Pago y los montos", async () => {
    const buf = await generatePlanXlsx({ plan: PLAN, proyectoCalc: "crux" });
    const entries = extractZipEntries(buf); // lector zip del PR-1
    expect(entries.has("xl/workbook.xml")).toBe(true);
    const workbook = entries.get("xl/workbook.xml").toString("utf8");
    expect(workbook).toContain("Plan de Pago");
    const sheetXml = entries.get("xl/worksheets/sheet1.xml").toString("utf8");
    const shared = entries.has("xl/sharedStrings.xml")
      ? entries.get("xl/sharedStrings.xml").toString("utf8")
      : "";
    const contenido = sheetXml + shared;
    expect(contenido).toContain("137000");
    expect(contenido).toContain("2108");
    expect(contenido).toContain("CONSTRUCTORA JPREZ");
    expect(contenido).toContain("Crux del Prado");
    expect(contenido).not.toContain("REAJUSTE"); // sin reajuste no hay sección
  });

  it("con reajuste agrega la sección ESTIMADA con disclaimer", async () => {
    const buf = await generatePlanXlsx({ plan: PLAN, reajuste: REAJUSTE, proyectoCalc: "crux" });
    const entries = extractZipEntries(buf);
    const contenido =
      entries.get("xl/worksheets/sheet1.xml").toString("utf8") +
      (entries.has("xl/sharedStrings.xml") ? entries.get("xl/sharedStrings.xml").toString("utf8") : "");
    expect(contenido).toMatch(/REAJUSTE ICDV/);
    expect(contenido).toMatch(/NO ES GARANT/);
    expect(contenido).toContain("5512");
    expect(contenido).toContain("142512");
  });

  it("plan inválido -> throw (fail-closed)", async () => {
    await expect(generatePlanXlsx({ plan: { error: "x" }, proyectoCalc: "crux" })).rejects.toThrow();
    await expect(generatePlanXlsx({ plan: null, proyectoCalc: "crux" })).rejects.toThrow();
  });

  it("themeIdFor mapea keys calculadora -> keys Bloque 2", () => {
    expect(themeIdFor("crux")).toBe("crux_t6");
    expect(themeIdFor("puertoPlata", "E3")).toBe("pse3");
    expect(themeIdFor("puertoPlata", "E4")).toBe("pse4");
    expect(themeIdFor("pr3")).toBe("pr3");
  });
});

describe("PLAN-XLSX — tool generar_plan_pago_xlsx", () => {
  const calcularFijo = () => PLAN;
  const baseDeps = (extra = {}) => ({
    calcularPlanPago: calcularFijo,
    sendDocument: async () => {},
    phone: "18091234567",
    signPayload: (data) => signDocPayload(data, { secret: SECRET }),
    ...extra,
  });

  it("schema válido: enum de proyectos + incluir_reajuste + disciplina de invocación", () => {
    expect(TOOL_GENERAR_PLAN_XLSX.name).toBe("generar_plan_pago_xlsx");
    expect(TOOL_GENERAR_PLAN_XLSX.description).toMatch(/NO prometas/i);
    expect(TOOL_GENERAR_PLAN_XLSX.input_schema.properties.incluir_reajuste.type).toBe("boolean");
    expect(TOOL_GENERAR_PLAN_XLSX.input_schema.required).toEqual(["proyecto", "precio_usd"]);
  });

  it("manda el documento con URL firmada de /api/plan-xlsx", async () => {
    const sends = [];
    const out = await generarPlanXlsxTool(
      { proyecto: "crux", precio_usd: 137000 },
      baseDeps({ sendDocument: async (...args) => sends.push(args) })
    );
    expect(out.sent).toBe(true);
    expect(sends).toHaveLength(1);
    const [phone, url, filename] = sends[0];
    expect(phone).toBe("18091234567");
    expect(url).toMatch(/\/api\/plan-xlsx\?p=.+&s=[0-9a-f]{64}/);
    expect(filename).toMatch(/Plan de Pago/);
    // la URL firmada verifica y trae el plan exacto
    const u = new URL(url);
    const v = verifyDocPayload(u.searchParams.get("p"), u.searchParams.get("s"), { secret: SECRET });
    expect(v.ok).toBe(true);
    expect(v.data.plan.cuota_mensual_usd).toBe(2108);
  });

  it("incluir_reajuste=true incorpora la proyección al payload", async () => {
    const sends = [];
    const out = await generarPlanXlsxTool(
      { proyecto: "crux", precio_usd: 137000, incluir_reajuste: true },
      baseDeps({
        sendDocument: async (...args) => sends.push(args),
        proyectarReajuste: async () => REAJUSTE,
      })
    );
    expect(out.sent).toBe(true);
    expect(out.con_reajuste).toBe(true);
    const u = new URL(sends[0][1]);
    const v = verifyDocPayload(u.searchParams.get("p"), u.searchParams.get("s"), { secret: SECRET });
    expect(v.data.reajuste.proyeccion.reajuste_total_estimado_usd).toBe(5512);
  });

  it("reajuste caído -> Excel sale SIN sección y lo declara (no muere el envío)", async () => {
    const out = await generarPlanXlsxTool(
      { proyecto: "crux", precio_usd: 137000, incluir_reajuste: true },
      baseDeps({ proyectarReajuste: async () => { throw new Error("redis caído"); } })
    );
    expect(out.sent).toBe(true);
    expect(out.con_reajuste).toBe(false);
    expect(out.message).toMatch(/omiti/i);
  });

  it("needs_etapa passthrough + error de calculadora -> sent:false", async () => {
    const soft = await generarPlanXlsxTool(
      { proyecto: "puertoPlata", precio_usd: 100000 },
      baseDeps({ calcularPlanPago: () => ({ needs_etapa: true, ask_client: "pregunta" }) })
    );
    expect(soft.needs_etapa).toBe(true);

    const err = await generarPlanXlsxTool(
      { proyecto: "crux", precio_usd: 100000 },
      baseDeps({ calcularPlanPago: () => ({ error: "Proyecto no reconocido" }) })
    );
    expect(err.sent).toBe(false);
  });

  it("envío de WhatsApp falla -> sent:false honesto (nunca lanza)", async () => {
    const out = await generarPlanXlsxTool(
      { proyecto: "crux", precio_usd: 137000 },
      baseDeps({ sendDocument: async () => { throw new Error("media error"); } })
    );
    expect(out.sent).toBe(false);
    expect(out.error).toBe("envio_fallo");
  });
});

describe("PLAN-XLSX — wiring (Sprint1 PR-4)", () => {
  it("generar_plan_pago_xlsx está en TOOLS[] de message.js con DI completa", () => {
    const messageHandler = readFileSync("src/handlers/message.js", "utf8");
    expect(messageHandler).toContain("TOOL_GENERAR_PLAN_XLSX");
    expect(messageHandler).toContain('require("../tools/plan-xlsx")');
    expect(messageHandler).toMatch(/generar_plan_pago_xlsx:/);
    expect(messageHandler).toMatch(/sendDocument,\s*\n\s*phone: senderPhone/);
  });

  it("build + route de /api/plan-xlsx en vercel.json", () => {
    const vercelJson = JSON.parse(readFileSync("vercel.json", "utf8"));
    expect(vercelJson.builds.some((b) => b.src === "api/plan-xlsx.js")).toBe(true);
    expect(
      vercelJson.routes.some((r) => r.src === "/api/plan-xlsx" && r.dest === "/api/plan-xlsx.js")
    ).toBe(true);
  });

  it("doctrina en calculadora SKILL, NO en OVERRIDES", () => {
    const skill = readFileSync(".claude/skills/calculadora-plan-pago/SKILL.md", "utf8");
    expect(skill).toContain("generar_plan_pago_xlsx");
    expect(skill).toMatch(/NUNCA prometas un documento sin invocar/i);
    const overrides = readFileSync("src/prompts/overrides-layer.js", "utf8");
    expect(overrides).not.toContain("generar_plan_pago_xlsx");
  });

  it("endpoint exporta handler async y exige firma (403 sin params)", async () => {
    const handler = require("../api/plan-xlsx.js");
    expect(handler.constructor.name).toBe("AsyncFunction");
    const prev = process.env.META_APP_SECRET;
    process.env.META_APP_SECRET = SECRET;
    let status = null;
    const res = {
      status: (s) => ({ json: () => (status = s), send: () => (status = s) }),
      setHeader: () => {},
    };
    await handler({ method: "GET", query: {} }, res);
    expect(status).toBe(403);
    // link vencido -> 410 distinguible
    const { p, s } = signDocPayload({ plan: PLAN, proyectoCalc: "crux" }, { secret: SECRET, now: 0 });
    await handler({ method: "GET", query: { p, s } }, res);
    expect(status).toBe(410);
    if (prev === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = prev;
  });
});
