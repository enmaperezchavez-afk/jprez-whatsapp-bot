// ============================================
// DASHBOARD METRICAS - Hotfix-17 (Closer SD)
// ============================================
// Endpoint read-only que ejecuta queries APL contra Axiom y devuelve
// JSON agregado para el frontend en /public/dashboard.html.
//
// PRINCIPIOS:
//   - Solo lectura. NO toca prompts, handlers, ni Redis.
//   - Cero dependencias nuevas: fetch nativo (Node 18+ en Vercel).
//   - Token separado del ingest token (least privilege):
//       AXIOM_QUERY_TOKEN debe tener scope `query` en dataset jprez-bot.
//   - Resilient: usa Promise.allSettled para que una query rota no
//     tumbe el dashboard completo. Cada metrica falla a 0 con flag
//     opcional en `errors[]` para debugging.
//   - Cache 60s en CDN edge: el frontend hace setInterval(60s) y
//     queremos que Axiom no se queme con N visitantes simultaneos.
//
// ENDPOINT AXIOM:
//   POST https://api.axiom.co/v1/datasets/_apl?format=tabular
//   Headers: Authorization: Bearer <AXIOM_QUERY_TOKEN>
//   Body: { apl, startTime, endTime }   (ISO 8601)
//   Response (tabular): { tables: [{ fields, columns }] }
//     - fields[i].name = nombre de columna
//     - columns[i] = array de valores para esa columna (1 elemento si
//       es un count escalar, N si hay groupBy)
//
// FORMATO DE RESPUESTA DE ESTE ENDPOINT:
//   {
//     conversations: { today, week, month },
//     messages: { total, audios },
//     intent: { visits, visitsByProject: {pr4, puertoPlata, cruxPrado},
//               discounts, newObjections, competitorRecs },
//     performance: { escalationRate, avgResponseSeconds, calculatorUses },
//     ops: { duplicates, rateLimits },
//     lastUpdated: ISO,
//     errors: []   // metricas que fallaron, vacio si todo OK
//   }
//
// SI AXIOM_QUERY_TOKEN NO ESTA SET: devuelve 503 con mensaje claro
// (mejor que 500 genérico — facilita debugging del Director en Vercel).

const AXIOM_DATASET = process.env.AXIOM_DATASET || "jprez-bot";
const AXIOM_APL_URL = "https://api.axiom.co/v1/datasets/_apl?format=tabular";

// ============================================
// HELPERS DE TIEMPO
// ============================================
// Usa UTC para los rangos. Suficiente para metricas agregadas; el
// "dia" puede correrse +/- 4h vs Santo Domingo, no es crítico para MVP.
function rangeBoundaries(now) {
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const startOfWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return {
    startOfDay: startOfDay.toISOString(),
    startOfWeek: startOfWeek.toISOString(),
    startOfMonth: startOfMonth.toISOString(),
    endTime: now.toISOString(),
  };
}

// ============================================
// QUERY EJECUTOR
// ============================================
// Ejecuta una query APL y devuelve la primera columna como array de
// objetos { ...campos }. El llamador decide como interpretar (escalar,
// lista, etc.).
async function runQuery(token, apl, startTime, endTime) {
  const res = await fetch(AXIOM_APL_URL, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ apl, startTime, endTime }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error("Axiom " + res.status + ": " + body.slice(0, 200));
  }
  const json = await res.json();
  // Formato tabular: tables[0].fields = [{name,type},...], columns = [colA[], colB[], ...]
  const table = json.tables && json.tables[0];
  if (!table || !Array.isArray(table.fields) || !Array.isArray(table.columns)) {
    return [];
  }
  // Reconstituir filas a partir de columnas paralelas.
  const rowCount = table.columns[0] ? table.columns[0].length : 0;
  const rows = [];
  for (let i = 0; i < rowCount; i++) {
    const row = {};
    for (let c = 0; c < table.fields.length; c++) {
      row[table.fields[c].name] = table.columns[c][i];
    }
    rows.push(row);
  }
  return rows;
}

// Helper: extrae el primer valor numérico de un row (count escalar).
function firstNumber(rows) {
  if (!rows || rows.length === 0) return 0;
  const row = rows[0];
  for (const k of Object.keys(row)) {
    if (typeof row[k] === "number") return row[k];
  }
  return 0;
}

// ============================================
// QUERIES APL
// ============================================
// Cada metrica se construye como string APL escapando ISO en where _time.
// Convencion: `['jprez-bot']` es la notacion APL para el dataset.
//
// NOTA: Axiom guarda los campos del spread directamente en raiz del
// evento (NO bajo `.data`). Es decir: `phone`, `message`, `tool` son
// campos top-level. Verificado en src/log.js:
//   const logEntry = { _time, level, message, ...data };
// (no envuelve `data` en sub-objeto).

function buildQueries(t) {
  const { startOfDay, startOfWeek, startOfMonth } = t;
  return {
    convToday: `['${AXIOM_DATASET}'] | where _time >= datetime("${startOfDay}") | where ['message'] == "Mensaje recibido" | summarize dcount(['phone'])`,
    convWeek: `['${AXIOM_DATASET}'] | where _time >= datetime("${startOfWeek}") | where ['message'] == "Mensaje recibido" | summarize dcount(['phone'])`,
    convMonth: `['${AXIOM_DATASET}'] | where _time >= datetime("${startOfMonth}") | where ['message'] == "Mensaje recibido" | summarize dcount(['phone'])`,
    msgTotal: `['${AXIOM_DATASET}'] | where _time >= datetime("${startOfMonth}") | where ['message'] == "Mensaje recibido" | summarize count()`,
    audios: `['${AXIOM_DATASET}'] | where _time >= datetime("${startOfMonth}") | where ['message'] == "Audio transcrito" | summarize count()`,
    visits: `['${AXIOM_DATASET}'] | where _time >= datetime("${startOfMonth}") | where ['message'] == "Visita agendada notificada" | summarize count()`,
    visitsByProject: `['${AXIOM_DATASET}'] | where _time >= datetime("${startOfMonth}") | where ['message'] == "Visita agendada notificada" | summarize count() by ['project']`,
    discounts: `['${AXIOM_DATASET}'] | where _time >= datetime("${startOfMonth}") | where ['message'] == "Descuento detectado y notificado" | summarize count()`,
    objections: `['${AXIOM_DATASET}'] | where _time >= datetime("${startOfMonth}") | where ['message'] == "OBJECION_NUEVA detectada" | summarize count()`,
    competitorRecs: `['${AXIOM_DATASET}'] | where _time >= datetime("${startOfMonth}") | where ['message'] == "Recomendacion de competencia detectada" | summarize count()`,
    escalations: `['${AXIOM_DATASET}'] | where _time >= datetime("${startOfMonth}") | where ['message'] == "Caso escalado activo" | summarize dcount(['phone'])`,
    calculatorUses: `['${AXIOM_DATASET}'] | where _time >= datetime("${startOfMonth}") | where ['message'] == "Tool use" and ['tool'] == "calcular_plan_pago" | summarize count()`,
    duplicates: `['${AXIOM_DATASET}'] | where _time >= datetime("${startOfMonth}") | where ['message'] == "duplicate_message_ignored" | summarize count()`,
    rateLimits: `['${AXIOM_DATASET}'] | where _time >= datetime("${startOfMonth}") | where ['message'] == "rate_limit_exceeded" | summarize count()`,
    // Hotfix-13 events (TOFU/MOFU — engagement informacional)
    pdfsTotal: `['${AXIOM_DATASET}'] | where _time >= datetime("${startOfMonth}") | where ['message'] == "pdf_sent" | summarize count()`,
    pdfsByProject: `['${AXIOM_DATASET}'] | where _time >= datetime("${startOfMonth}") | where ['message'] == "pdf_sent" | summarize count() by ['project']`,
    pdfsNoUrls: `['${AXIOM_DATASET}'] | where _time >= datetime("${startOfMonth}") | where ['message'] == "pdf_no_urls" | summarize count()`,
  };
}

// ============================================
// HANDLER
// ============================================

module.exports = async function handler(req, res) {
  const token = process.env.AXIOM_QUERY_TOKEN;
  if (!token) {
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({
      error: "AXIOM_QUERY_TOKEN no configurado en este entorno",
      hint: "Setear en Vercel Project Settings > Environment Variables (scope: query, dataset: " + AXIOM_DATASET + ")",
    });
    return;
  }

  const now = new Date();
  const t = rangeBoundaries(now);
  const queries = buildQueries(t);

  // Promise.allSettled para que cualquier query rota no tumbe el resto.
  const keys = Object.keys(queries);
  const results = await Promise.allSettled(
    keys.map((k) => runQuery(token, queries[k], t.startOfDay /* dummy, APL usa el suyo */, t.endTime))
  );

  const errors = [];
  const data = {};
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const r = results[i];
    if (r.status === "fulfilled") {
      data[k] = r.value;
    } else {
      data[k] = [];
      errors.push({ metric: k, error: String(r.reason && r.reason.message || r.reason) });
    }
  }

  // ============================================
  // MAPEO DE FILAS A SHAPE FINAL
  // ============================================

  // Helper: agrupa rows con shape [{ project, count_ }] en buckets fijos.
  function bucketByProject(rows) {
    const out = { pr4: 0, puertoPlata: 0, cruxPrado: 0, other: 0 };
    for (const row of rows || []) {
      const num = firstNumber([row]);
      const proj = row.project || row["project"];
      if (proj === "pr4") out.pr4 += num;
      else if (proj === "puertoPlata") out.puertoPlata += num;
      else if (proj === "cruxPrado") out.cruxPrado += num;
      // Hotfix-13 también emite project === "crux" en el bloque "envio a todos"
      // (handler line 746) — lo redirigimos a cruxPrado para consistencia visual.
      else if (proj === "crux") out.cruxPrado += num;
      else out.other += num;
    }
    return out;
  }

  const visitsByProject = bucketByProject(data.visitsByProject);
  const pdfsByProject = bucketByProject(data.pdfsByProject);

  // Tasa de escalacion: clientes escalados / clientes activos del mes.
  const monthDistinct = firstNumber(data.convMonth);
  const escalations = firstNumber(data.escalations);
  const escalationRate = monthDistinct > 0
    ? Math.round((escalations / monthDistinct) * 100 * 10) / 10
    : 0;

  const payload = {
    conversations: {
      today: firstNumber(data.convToday),
      week: firstNumber(data.convWeek),
      month: monthDistinct,
    },
    messages: {
      total: firstNumber(data.msgTotal),
      audios: firstNumber(data.audios),
    },
    intent: {
      visits: firstNumber(data.visits),
      visitsByProject,
      discounts: firstNumber(data.discounts),
      newObjections: firstNumber(data.objections),
      competitorRecs: firstNumber(data.competitorRecs),
      pdfs: {
        total: firstNumber(data.pdfsTotal),
        byProject: pdfsByProject,
        // % de requests de PDF que fallaron por falta de URLs (env var ausente).
        // Indicador de salud de configuracion del bot. Si > 5% revisar PDF_*_*.
        noUrlsRate: (function() {
          const sent = firstNumber(data.pdfsTotal);
          const failed = firstNumber(data.pdfsNoUrls);
          const denom = sent + failed;
          return denom > 0 ? Math.round((failed / denom) * 100 * 10) / 10 : 0;
        })(),
      },
    },
    performance: {
      escalationRate,
      // avgResponseSeconds requiere join entre Mensaje recibido y Respuesta
      // enviada por phone — APL no lo hace en una sola query trivial. MVP:
      // dejar en null y mostrar "—" en el frontend. Iteracion futura:
      // 2 queries + post-procesamiento aqui.
      avgResponseSeconds: null,
      calculatorUses: firstNumber(data.calculatorUses),
    },
    ops: {
      duplicates: firstNumber(data.duplicates),
      rateLimits: firstNumber(data.rateLimits),
    },
    lastUpdated: now.toISOString(),
    errors,
  };

  // Cache 60s en CDN para no quemar Axiom con N viewers concurrentes.
  // El frontend hace setInterval(60s), asi que con cache hits desde edge
  // hay como mucho 1 query por minuto a Axiom independiente del trafico.
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=30");
  res.status(200).json(payload);
};
