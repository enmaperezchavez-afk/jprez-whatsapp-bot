// tests/qa-simulador/comparar-juez.mjs — Dieta de tokens, orden 2:
// ¿puede el juez bajar a Haiku sin perder criterio?
//
//   node tests/qa-simulador/comparar-juez.mjs <carpeta _runs/<ts>>
//
// Re-juzga las transcripciones YA persistidas de un run (no regenera
// conversaciones — solo el veredicto) con Sonnet Y Haiku, y reporta la
// coincidencia. GATE del Director: el juez barato solo entra si coincide
// con el caro (aprobado/reprobado) en ≥ 90% de los escenarios.

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync, readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { juzgarTranscripcion } from "./helpers/evaluador.mjs";
import { crearMedidor, formatoCosto } from "./helpers/costo.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));

function cargarEnvLocal() {
  if (process.env.ANTHROPIC_API_KEY) return;
  const envPath = path.join(DIR, "..", "..", ".env.local");
  if (!existsSync(envPath)) return;
  for (const linea of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

async function main() {
  cargarEnvLocal();
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("requiere ANTHROPIC_API_KEY");
    process.exit(2);
  }

  // carpeta del run: argumento o el último run persistido
  let runDir = process.argv[2];
  if (!runDir) {
    const base = path.join(DIR, "_runs");
    const runs = readdirSync(base).sort();
    runDir = path.join(base, runs[runs.length - 1]);
  }
  const raw = JSON.parse(readFileSync(path.join(runDir, "reporte.json"), "utf8"));
  const resultados = Array.isArray(raw) ? raw : raw.resultados;
  const conTranscript = resultados.filter((r) => r.transcript && r.transcript.length > 1);
  if (!conTranscript.length) {
    console.error("el run no tiene transcripciones utilizables");
    process.exit(2);
  }

  console.log(`Comparando juez Sonnet vs Haiku sobre ${conTranscript.length} transcripciones de ${path.basename(runDir)}...`);
  const anthropic = new Anthropic();
  const medidor = crearMedidor();

  let coinciden = 0;
  const filas = [];
  for (const r of conTranscript) {
    const [caro, barato] = await Promise.all([
      juzgarTranscripcion({ anthropic, transcript: r.transcript, focos: [], model: "claude-sonnet-4-6", usage: medidor }),
      juzgarTranscripcion({ anthropic, transcript: r.transcript, focos: [], model: "claude-haiku-4-5-20251001", usage: medidor }),
    ]);
    const igual = caro.aprobado === barato.aprobado;
    if (igual) coinciden++;
    filas.push(
      `  ${igual ? "✓" : "✗"} ${r.id}: sonnet=${caro.aprobado ? "APRUEBA" : "REPRUEBA"} (${caro.violaciones.length}v) | haiku=${barato.aprobado ? "APRUEBA" : "REPRUEBA"} (${barato.violaciones.length}v)`
    );
    console.log(filas[filas.length - 1]);
  }

  const pct = Math.round((coinciden / conTranscript.length) * 100);
  console.log(`\nCOINCIDENCIA DE VEREDICTO: ${coinciden}/${conTranscript.length} (${pct}%)`);
  console.log(pct >= 90 ? "✅ GATE SUPERADO: el juez puede bajar a Haiku (--juez=haiku)." : "❌ GATE NO superado: el juez se queda en Sonnet.");
  console.log("\n" + formatoCosto(medidor.resumen()));
  process.exit(0);
}

main().catch((e) => {
  console.error("comparar-juez crash:", e.message);
  process.exit(2);
});
