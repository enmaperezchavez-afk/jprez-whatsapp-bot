// tests/qa-simulador/run.mjs — Sprint 1.5: runner del simulador QA.
//
//   npm run qa:simulador            -> los 10 escenarios (suite completo)
//   npm run qa:simulador:ci         -> subset CI (5 escenarios, turnos cortos)
//   node tests/qa-simulador/run.mjs --escenarios=dificil-feria,extranjero-pesos
//
// Requiere ANTHROPIC_API_KEY (en el env o en .env.local). Cada escenario:
// conversación cliente-fantasma vs Mateo real + evaluación doctrinal
// (checks programáticos + juez LLM). Reporte por escenario PASS/FAIL con
// la cita exacta de cada violación; JSON persistido en _runs/<ts>/.
// Exit code 1 si algún escenario FAIL (integrable a CI).
//
// Costo: ~6-10 turnos por escenario con max_tokens capados (Mateo 1024,
// cliente 300, juez 1500) + prompt caching del staticBlock.

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { crearMateo, TASA_DOC_FIXTURE } from "./helpers/arnes-mateo.mjs";
import { crearClienteFantasma, simularConversacion } from "./helpers/cliente-fantasma.mjs";
import { evaluarEscenario } from "./helpers/evaluador.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));

// .env.local: carga manual mínima (sin dep dotenv) — solo si la key no
// está ya en el entorno.
function cargarEnvLocal() {
  if (process.env.ANTHROPIC_API_KEY) return;
  const envPath = path.join(DIR, "..", "..", ".env.local");
  if (!existsSync(envPath)) return;
  for (const linea of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

function cargarEscenarios() {
  const personas = JSON.parse(readFileSync(path.join(DIR, "personas.json"), "utf8")).personas;
  const escenarios = JSON.parse(readFileSync(path.join(DIR, "escenarios.json"), "utf8")).escenarios;
  const porId = Object.fromEntries(personas.map((p) => [p.id, p]));
  return escenarios.map((e) => {
    const persona = porId[e.personaId];
    if (!persona) throw new Error(`escenario ${e.id}: persona desconocida ${e.personaId}`);
    return { ...e, persona };
  });
}

function args() {
  const out = { ci: false, escenarios: null };
  for (const a of process.argv.slice(2)) {
    if (a === "--ci" || a === "--subset") out.ci = true;
    const m = a.match(/^--escenarios=(.+)$/);
    if (m) out.escenarios = m[1].split(",").map((s) => s.trim());
  }
  return out;
}

async function correrEscenario({ anthropic, escenario, modoCI }) {
  const persona = { ...escenario.persona };
  if (escenario.objetivoExtra) {
    persona.objetivo += "\nADEMÁS: " + escenario.objetivoExtra;
  }
  const maxTurnos = modoCI ? (escenario.maxTurnosCI || 5) : persona.maxTurnos;
  const tasaDoc = escenario.tasaDoc === "null" ? null : TASA_DOC_FIXTURE;

  const t0 = Date.now();
  const cliente = crearClienteFantasma({ anthropic, persona });
  const mateo = crearMateo({ anthropic, tasaDoc });
  const sim = await simularConversacion({ cliente, mateo, maxTurnos });

  const veredicto = await evaluarEscenario({
    anthropic,
    transcript: sim.transcript,
    eventos: sim.eventos,
    proyecto: escenario.proyecto,
    focos: persona.estresa,
  });

  return {
    id: escenario.id,
    persona: persona.id,
    pass: veredicto.pass,
    turnos: sim.turnos,
    terminoNatural: sim.terminoNatural,
    violaciones: veredicto.violaciones,
    warnings: veredicto.warnings,
    resumenJuez: veredicto.resumenJuez,
    duracionMs: Date.now() - t0,
    transcript: sim.transcript,
    toolsUsadas: sim.eventos.flatMap((e) => (e.tools || []).map((t) => t.tool)),
  };
}

function imprimirReporte(resultados) {
  const linea = "═".repeat(74);
  console.log("\n" + linea);
  console.log("  SIMULADOR QA CLIENTE FANTASMA — REPORTE DOCTRINAL v1.1");
  console.log(linea);
  for (const r of resultados) {
    const estado = r.pass ? "✅ PASS" : "❌ FAIL";
    console.log(`\n${estado}  ${r.id}  (${r.turnos} turnos, ${(r.duracionMs / 1000).toFixed(0)}s, tools: ${[...new Set(r.toolsUsadas)].join(", ") || "ninguna"})`);
    if (r.resumenJuez) console.log(`   juez: ${r.resumenJuez}`);
    for (const v of r.violaciones) {
      console.log(`   [${v.severidad}|${v.fuente}] ${v.regla}`);
      console.log(`     cita: "${v.cita}"`);
    }
    for (const w of r.warnings || []) {
      console.log(`   [warning] ${w.regla} — ${w.cita}`);
    }
  }
  const passed = resultados.filter((r) => r.pass).length;
  console.log("\n" + linea);
  console.log(`  TOTAL: ${passed}/${resultados.length} PASS`);
  console.log(linea + "\n");
}

async function main() {
  cargarEnvLocal();
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("qa:simulador requiere ANTHROPIC_API_KEY (env o .env.local)");
    process.exit(2);
  }
  const { ci, escenarios: filtro } = args();
  const anthropic = new Anthropic();

  let escenarios = cargarEscenarios();
  if (filtro) escenarios = escenarios.filter((e) => filtro.includes(e.id));
  else if (ci) escenarios = escenarios.filter((e) => e.ci);
  if (!escenarios.length) {
    console.error("ningún escenario seleccionado");
    process.exit(2);
  }

  console.log(`Corriendo ${escenarios.length} escenario(s)${ci ? " [subset CI]" : ""}...`);
  const resultados = [];
  for (const e of escenarios) {
    process.stdout.write(`  ▸ ${e.id}... `);
    try {
      const r = await correrEscenario({ anthropic, escenario: e, modoCI: ci });
      console.log(r.pass ? "PASS" : "FAIL");
      resultados.push(r);
    } catch (err) {
      console.log("ERROR: " + err.message);
      resultados.push({
        id: e.id, persona: e.personaId, pass: false, turnos: 0,
        violaciones: [{ regla: "error de ejecución del escenario", cita: err.message, severidad: "alta", fuente: "runner" }],
        warnings: [], transcript: [], toolsUsadas: [], duracionMs: 0,
      });
    }
  }

  imprimirReporte(resultados);

  // Persistir el run completo (transcripciones incluidas) para forense.
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(DIR, "_runs", ts);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "reporte.json"), JSON.stringify(resultados, null, 2));
  console.log("Run persistido en tests/qa-simulador/_runs/" + ts + "/reporte.json");

  process.exit(resultados.every((r) => r.pass) ? 0 : 1);
}

main().catch((e) => {
  console.error("qa:simulador crash:", e);
  process.exit(2);
});
