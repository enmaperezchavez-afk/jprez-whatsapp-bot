// src/inventory/admin-commands.js — Bloque 1 Fase 3.5b.
//
// Parser + executor de comandos supervisor para editar inventario:
//   /reservar [proyecto] [unidad]
//   /vender [proyecto] [unidad]
//   /liberar [proyecto] [unidad] [precio]
//   /precio [proyecto] [unidad] [monto]
//   /inventario [proyecto]
//   /inventario
//
// REGLA Director: PROYECTO PRIMERO. "15-102" puede existir en PSE3 Y PSE4
// — sin proyecto el bot nunca puede acertar. Cliente que mande estos
// comandos = ignorado SILENCIOSAMENTE (no revelar que existen).
//
// CONTRATO:
//   parseAdminCommand(text) → { command, project?, unit?, price?, error? } | null
//     null = no es comando admin (procesar como mensaje normal)
//   executeAdminCommand(parsed, ctx) → { reply, didWrite }
//     reply = string para mandar al supervisor
//     didWrite = true si escribió Sheet (caller invalida cache Redis)

const { toNumber } = require("./parser");
// Sprint1.8 PR-3: montos con formato en confirmaciones ("US$95,000",
// no "95000"). natural-admin no requiere este módulo (sin ciclo).
const { formatMonto } = require("./natural-admin");

const VALID_PROJECTS = {
  pr3: "PR3",
  pr4: "PR4",
  pse3: "PSE3",
  pse4: "PSE4",
  crux_t6: "CRUX_TORRE6",
  crux_listos: "CRUX_LISTOS",
};

const VALID_PROJECT_KEYS_LIST = Object.keys(VALID_PROJECTS).join(", ");

const WRITE_COMMANDS = new Set(["reservar", "vender", "liberar", "precio"]);
const READ_COMMANDS = new Set(["inventario"]);
const ALL_COMMANDS = new Set([...WRITE_COMMANDS, ...READ_COMMANDS]);

// parseAdminCommand: extrae comando + args. Devuelve null si el texto
// NO comienza con un slash command reconocido. Es resilient a múltiples
// espacios y trim.
function parseAdminCommand(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  // Tokenizar por whitespace
  const tokens = trimmed.slice(1).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const command = tokens[0].toLowerCase();
  if (!ALL_COMMANDS.has(command)) return null;

  const result = { command };

  // /inventario sin args = resumen todos
  // /inventario [proyecto] = resumen proyecto
  if (command === "inventario") {
    if (tokens.length === 1) return result;
    result.project = tokens[1].toLowerCase();
    return result;
  }

  // Write commands necesitan proyecto + unidad (+precio para liberar/precio)
  if (tokens.length < 2) {
    result.error = "missing_project";
    return result;
  }
  result.project = tokens[1].toLowerCase();

  if (tokens.length < 3) {
    result.error = "missing_unit";
    return result;
  }

  // Hotfix-31: la unidad puede tener espacios ("APT 201"). Para comandos
  // con precio, el precio es el ÚLTIMO token y la unidad lo de en medio.
  if (command === "liberar" || command === "precio") {
    result.unit = tokens.length >= 4 ? tokens.slice(2, -1).join(" ") : tokens[2];
    if (tokens.length < 4) {
      result.error = "missing_price";
      return result;
    }
    // Hotfix-31: toNumber maneja coma decimal/miles ("95,000" y "240,16").
    const price = toNumber(tokens[tokens.length - 1]);
    if (price == null || price <= 0) {
      result.error = "invalid_price";
      return result;
    }
    result.price = price;
  } else {
    result.unit = tokens.slice(2).join(" ");
  }

  return result;
}

// validateProject: normaliza + valida. Retorna { tab, displayName } o null si inválido.
function resolveProjectTab(projectKey) {
  if (!projectKey) return null;
  const key = String(projectKey).toLowerCase();
  const tab = VALID_PROJECTS[key];
  if (!tab) return null;
  return { key, tab };
}

// formatSummary: dado totals { pr3: { disponibles, total }, ... } → texto WhatsApp.
function formatSummary(totals, projectKey) {
  if (projectKey) {
    const t = totals[projectKey];
    if (!t) return "No tengo conteos para " + projectKey + " todavía. Verifica que el Sheet esté poblado.";
    return "📊 " + projectKey.toUpperCase() + ": " + t.disponibles + " disponibles de " + t.total + " total.";
  }
  const labels = {
    pr3: "PR3",
    pr4: "PR4",
    pse3: "PSE3",
    pse4: "PSE4",
    crux_t6: "Crux T6",
    crux_listos: "Crux Listos",
  };
  const lines = ["📊 Inventario JPREZ"];
  for (const key of Object.keys(VALID_PROJECTS)) {
    const t = totals[key];
    if (!t) {
      lines.push(labels[key] + ": (sin datos)");
    } else {
      lines.push(labels[key] + ": " + t.disponibles + "/" + t.total + " disponibles");
    }
  }
  return lines.join("\n");
}

// executeAdminCommand: ejecuta el comando ya parseado. Devuelve
// { reply, didWrite }. didWrite=true indica que el caller debe
// invalidar la cache Redis del inventario.
//
// ctx contiene:
//   - supervisorPhone (string)
//   - sheetsWriter (módulo, default lazy require)
//   - inventoryLoader (módulo, default lazy require)
//   - redis (instancia o null)
async function executeAdminCommand(parsed, ctx) {
  if (!parsed) return { reply: null, didWrite: false };

  const { command, project, unit, price, error } = parsed;

  if (error === "missing_project") {
    return {
      reply:
        "¿En cuál proyecto? " + VALID_PROJECT_KEYS_LIST +
        '\n(También puedes decirlo natural: "reserva el 15-102 de puerto plata etapa 4")',
      didWrite: false,
    };
  }
  if (error === "missing_unit") {
    return {
      reply: "¿Cuál unidad en " + project + "?",
      didWrite: false,
    };
  }
  if (error === "missing_price") {
    return {
      reply: "¿A qué precio " + command + " " + unit + " en " + project + "?",
      didWrite: false,
    };
  }
  if (error === "invalid_price") {
    return {
      reply: "Precio inválido. Pasa un número positivo.",
      didWrite: false,
    };
  }

  // Resolver proyecto a tab
  if (command !== "inventario" || project) {
    const resolved = resolveProjectTab(project);
    if (!resolved) {
      return {
        reply: "Proyecto " + project + " no reconocido. Válidos: " + VALID_PROJECT_KEYS_LIST,
        didWrite: false,
      };
    }
    parsed.tab = resolved.tab;
  }

  // Lazy require para que el módulo no falle a cargar si Sheets no configurado
  const sheetsWriter = ctx.sheetsWriter || require("./sheets-writer");
  const inventoryLoader = ctx.inventoryLoader || require("./loader");

  if (command === "inventario") {
    const inv = await inventoryLoader.loadInventory({ redis: ctx.redis });
    const totals = inv.totals || {};
    return {
      reply: formatSummary(totals, project ? project.toLowerCase() : null),
      didWrite: false,
    };
  }

  // Comandos de escritura
  let result;
  if (command === "reservar" || command === "vender") {
    const newStatus = command === "reservar" ? "reservado" : "vendido";
    result = await sheetsWriter.updateUnitStatus({
      tabName: parsed.tab,
      unitId: unit,
      newStatus,
      supervisorPhone: ctx.supervisorPhone,
    });
  } else if (command === "liberar") {
    // Liberar = setear estado disponible + precio nuevo
    const statusRes = await sheetsWriter.updateUnitStatus({
      tabName: parsed.tab,
      unitId: unit,
      newStatus: "disponible",
      supervisorPhone: ctx.supervisorPhone,
    });
    if (!statusRes.ok) {
      result = statusRes;
    } else {
      const priceRes = await sheetsWriter.updateUnitPrice({
        tabName: parsed.tab,
        unitId: unit,
        newPrice: price,
        supervisorPhone: ctx.supervisorPhone,
      });
      result = priceRes.ok
        ? { ok: true, range: priceRes.range, oldValue: priceRes.oldValue }
        : priceRes;
    }
  } else if (command === "precio") {
    result = await sheetsWriter.updateUnitPrice({
      tabName: parsed.tab,
      unitId: unit,
      newPrice: price,
      supervisorPhone: ctx.supervisorPhone,
    });
  }

  if (!result || !result.ok) {
    if (result && result.reason === "unit_not_found") {
      return {
        reply: "No encontré " + unit + " en " + project + ". Verifica el ID.",
        didWrite: false,
      };
    }
    if (result && result.reason === "missing_env_vars") {
      return {
        reply: "Sheets no está configurado todavía (env vars). Avísame cuando lo armes.",
        didWrite: false,
      };
    }
    if (result && result.reason === "column_not_found") {
      return {
        reply: "El Sheet de " + project + " no tiene la columna esperada (" + result.column + "). Verifica headers.",
        didWrite: false,
      };
    }
    return {
      reply: "No pude actualizar " + unit + " en " + project + ". Revisa logs Axiom.",
      didWrite: false,
    };
  }

  // Construir confirmación según comando. Montos SIEMPRE formateados
  // (Sprint1.8 PR-3): "US$95,000", no "95000". Crux Listos va en RD$.
  const moneda = parsed.tab === "CRUX_LISTOS" ? "RD$" : "US$";
  let confirm;
  if (command === "reservar") {
    confirm = "✅ " + parsed.tab + " " + unit + " marcada como reservada.";
  } else if (command === "vender") {
    confirm = "✅ " + parsed.tab + " " + unit + " marcada como vendida.";
  } else if (command === "liberar") {
    confirm = "✅ " + parsed.tab + " " + unit + " liberada en " + formatMonto(price, moneda) + ".";
  } else if (command === "precio") {
    confirm = "✅ Precio de " + parsed.tab + " " + unit + " actualizado a " + formatMonto(price, moneda) + ".";
  }

  // Invalidar cache Redis para que el próximo cliente vea el cambio
  if (ctx.redis) {
    try {
      await ctx.redis.del("inventory:current");
    } catch (e) {
      // Best effort — si falla, el TTL 5min lo regenera de todos modos
    }
  }

  return { reply: confirm, didWrite: true };
}

module.exports = {
  parseAdminCommand,
  executeAdminCommand,
  resolveProjectTab,
  formatSummary,
  VALID_PROJECTS,
  VALID_PROJECT_KEYS_LIST,
  WRITE_COMMANDS,
  READ_COMMANDS,
  ALL_COMMANDS,
};
