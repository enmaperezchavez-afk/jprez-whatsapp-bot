// api/health.js — Hotfix-25 Día 2 (Parte B).
//
// Dashboard de SALUD operacional del bot Mateo. Complementa /api/dashboard
// (que mide actividad comercial: visitas, escalaciones, conversaciones).
//
// PRINCIPIOS:
//   - Solo lectura. Igual patrón que /api/dashboard.
//   - Cero dependencias nuevas: fetch nativo (Node 18+ en Vercel).
//   - Token shared secret: HEALTH_DASHBOARD_TOKEN (env var separado del
//     ingest token de Axiom).
//   - Token de query Axiom: AXIOM_QUERY_TOKEN (reusa el que ya existe
//     para /api/dashboard).
//   - Promise.allSettled para que una query rota no tumbe todo.
//   - Cache 60s en CDN edge (mismo patrón).
//
// MÉTRICAS (8):
//   1. system_prompt_size (input tokens promedio últimas 24h)
//   2. cache_hit_rate (cache_read / total input tokens)
//   3. tool_use_loop_count (iteración promedio del callClaudeWithTools loop)
//   4. failure_rate ("se me complicó" / total respuestas)
//   5. cost_per_message (cálculo exact con cache pricing Sonnet 4.6)
//   6. messages_24h (count Mensaje recibido)
//   7. rate_limit_warnings (claude_ratelimit_warning event count)
//   8. parameter_block_strips (perfil_update_truncated_stripped count)
//
// AUTH:
//   GET /api/health
//   Header: Authorization: Bearer <HEALTH_DASHBOARD_TOKEN>
//   Sin header válido → 401.
//
// QUERY PARAM:
//   ?hours=N — ventana temporal (default 24, max 168 = 1 semana)

const AXIOM_DATASET = process.env.AXIOM_DATASET || "jprez-bot";
const AXIOM_APL_URL = "https://api.axiom.co/v1/datasets/_apl?format=tabular";

// ============================================
// PRECIOS HARDCODED — Claude Sonnet 4.6 (12 mayo 2026)
// ============================================
// Fuente: https://www.anthropic.com/pricing (consultado por Director)
// Si cambian precios o se cambia modelo, redeploy con valores nuevos.
const PRICE_INPUT_FRESH = 0.000003;    // $3 / 1M input tokens
const PRICE_CACHE_CREATION = 0.00000375; // $3.75 / 1M (ephemeral 5min)
const PRICE_CACHE_READ = 0.0000003;    // $0.30 / 1M (cache hit)
const PRICE_OUTPUT = 0.000015;         // $15 / 1M output tokens

// ============================================
// HELPERS
// ============================================

function rangeBoundaries(hours) {
  const now = new Date();
  const startTime = new Date(now.getTime() - hours * 60 * 60 * 1000);
  return {
    startTime: startTime.toISOString(),
    endTime: now.toISOString(),
  };
}

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
  const table = json.tables && json.tables[0];
  if (!table || !Array.isArray(table.fields) || !Array.isArray(table.columns)) {
    return [];
  }
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

function buildQueries(startTime, endTime) {
  const ds = AXIOM_DATASET;
  return {
    // 1. system_prompt_size promedio (input_tokens del log claude_response)
    promptSizeAvg: `['${ds}'] | where _time >= datetime("${startTime}") | where ['message'] == "claude_response" | summarize avg(['input_tokens'])`,
    promptSizeMax: `['${ds}'] | where _time >= datetime("${startTime}") | where ['message'] == "claude_response" | summarize max(['input_tokens'])`,

    // 2. cache hit rate — sumar cache_read y total tokens, dividir
    cacheReadTotal: `['${ds}'] | where _time >= datetime("${startTime}") | where ['message'] == "claude_response" | summarize sum(['cache_read_input_tokens'])`,
    cacheCreationTotal: `['${ds}'] | where _time >= datetime("${startTime}") | where ['message'] == "claude_response" | summarize sum(['cache_creation_input_tokens'])`,
    inputFreshTotal: `['${ds}'] | where _time >= datetime("${startTime}") | where ['message'] == "claude_response" | summarize sum(['input_tokens'])`,
    outputTotal: `['${ds}'] | where _time >= datetime("${startTime}") | where ['message'] == "claude_response" | summarize sum(['output_tokens'])`,

    // 3. tool_use_loop count promedio (iteration field del claude_response)
    toolLoopAvg: `['${ds}'] | where _time >= datetime("${startTime}") | where ['message'] == "claude_response" | summarize avg(['iteration'])`,
    toolLoopMax: `['${ds}'] | where _time >= datetime("${startTime}") | where ['message'] == "claude_response" | summarize max(['iteration'])`,

    // 4. failure_rate — empty_reply_after_strip / total responses
    failureCount: `['${ds}'] | where _time >= datetime("${startTime}") | where ['message'] == "empty_reply_after_strip" | summarize count()`,
    responsesCount: `['${ds}'] | where _time >= datetime("${startTime}") | where ['message'] == "Respuesta enviada" | summarize count()`,

    // 6. messages_24h (Mensaje recibido)
    messagesReceived: `['${ds}'] | where _time >= datetime("${startTime}") | where ['message'] == "Mensaje recibido" | summarize count()`,
    uniquePhones: `['${ds}'] | where _time >= datetime("${startTime}") | where ['message'] == "Mensaje recibido" | summarize dcount(['phone'])`,

    // 7. rate_limit_warnings
    rateLimitWarnings: `['${ds}'] | where _time >= datetime("${startTime}") | where ['message'] == "claude_ratelimit_warning" | summarize count()`,

    // 8. parameter_block_strips (R4 c5 Hotfix-24 hit)
    parameterStrips: `['${ds}'] | where _time >= datetime("${startTime}") | where ['message'] == "perfil_update_truncated_stripped" | summarize count()`,
  };
}

// ============================================
// HANDLER
// ============================================

module.exports = async function handler(req, res) {
  // Auth shared secret
  const expectedToken = process.env.HEALTH_DASHBOARD_TOKEN;
  if (!expectedToken) {
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({
      error: "HEALTH_DASHBOARD_TOKEN no configurado",
      hint: "Setear en Vercel Project Settings > Environment Variables",
    });
    return;
  }

  const authHeader = req.headers.authorization || "";
  const providedToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;
  if (!providedToken || providedToken !== expectedToken) {
    res.setHeader("Cache-Control", "no-store");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Axiom token
  const axiomToken = process.env.AXIOM_QUERY_TOKEN;
  if (!axiomToken) {
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({
      error: "AXIOM_QUERY_TOKEN no configurado",
      hint: "Reusar el token de /api/dashboard",
    });
    return;
  }

  // Ventana temporal
  const hoursParam = parseInt(req.query?.hours || "24", 10);
  const hours = Math.max(1, Math.min(168, isNaN(hoursParam) ? 24 : hoursParam));
  const { startTime, endTime } = rangeBoundaries(hours);

  const queries = buildQueries(startTime, endTime);

  const keys = Object.keys(queries);
  const results = await Promise.allSettled(
    keys.map((k) => runQuery(axiomToken, queries[k], startTime, endTime)),
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
  // CÁLCULOS DERIVADOS
  // ============================================

  const inputFresh = firstNumber(data.inputFreshTotal);
  const cacheRead = firstNumber(data.cacheReadTotal);
  const cacheCreation = firstNumber(data.cacheCreationTotal);
  const outputTokens = firstNumber(data.outputTotal);

  // Cache hit rate: cache_read / total input (input + cache_creation + cache_read)
  const totalInputAll = inputFresh + cacheCreation + cacheRead;
  const cacheHitRate = totalInputAll > 0
    ? Math.round((cacheRead / totalInputAll) * 100 * 100) / 100
    : 0;

  // Costo total (USD)
  const totalCostUsd = (
    inputFresh * PRICE_INPUT_FRESH +
    cacheCreation * PRICE_CACHE_CREATION +
    cacheRead * PRICE_CACHE_READ +
    outputTokens * PRICE_OUTPUT
  );

  // Cost per message
  const messagesReceived = firstNumber(data.messagesReceived);
  const costPerMessage = messagesReceived > 0
    ? Math.round((totalCostUsd / messagesReceived) * 10000) / 10000
    : 0;

  // Failure rate
  const failures = firstNumber(data.failureCount);
  const responses = firstNumber(data.responsesCount);
  const failureRate = responses > 0
    ? Math.round((failures / responses) * 100 * 100) / 100
    : 0;

  const payload = {
    window: {
      hours,
      startTime,
      endTime,
    },
    prompt: {
      avgInputTokens: Math.round(firstNumber(data.promptSizeAvg)),
      maxInputTokens: firstNumber(data.promptSizeMax),
    },
    cache: {
      hitRatePct: cacheHitRate,
      readTokens: cacheRead,
      creationTokens: cacheCreation,
      freshInputTokens: inputFresh,
    },
    toolLoop: {
      avgIterations: Math.round(firstNumber(data.toolLoopAvg) * 100) / 100,
      maxIterations: firstNumber(data.toolLoopMax),
    },
    failures: {
      seComplicoCount: failures,
      totalResponses: responses,
      failureRatePct: failureRate,
    },
    cost: {
      totalUsd: Math.round(totalCostUsd * 100) / 100,
      perMessageUsd: costPerMessage,
      pricing: {
        inputFresh: PRICE_INPUT_FRESH,
        cacheCreation: PRICE_CACHE_CREATION,
        cacheRead: PRICE_CACHE_READ,
        output: PRICE_OUTPUT,
        model: "claude-sonnet-4-6",
      },
    },
    volume: {
      messagesReceived,
      uniquePhones: firstNumber(data.uniquePhones),
      outputTokensTotal: outputTokens,
    },
    ops: {
      rateLimitWarnings: firstNumber(data.rateLimitWarnings),
      parameterBlockStrips: firstNumber(data.parameterStrips),
    },
    lastUpdated: new Date().toISOString(),
    errors,
  };

  // Cache 60s CDN + stale-while-revalidate 30s
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=30");
  res.status(200).json(payload);
};
