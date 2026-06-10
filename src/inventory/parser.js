// src/inventory/parser.js — Bloque 1 Fase 2.
//
// Convierte rowObjects (output de sheets-client.rowsToObjects) en
// inventario estructurado. Aplica reglas de validación del Director:
//
// REGLAS:
//   - estado="disponible" + precio válido → unidad incluida
//   - estado="disponible" + precio vacío/0/NaN → SKIP + warning
//   - estado="reservado"|"vendido"|"bloqueado" → incluida con flag
//     (el markdown-formatter decide si la muestra o no, depende del tab)
//
// El parser retorna también `skipped` para que el caller pueda loguear
// inventory_unit_skipped_missing_price a Axiom.

const VALID_ESTADOS = new Set(["disponible", "reservado", "vendido", "bloqueado"]);

// Hotfix-31: manejo de coma. Antes la coma se eliminaba junto con el resto
// de caracteres no numéricos, así que "240,16" (coma decimal) se convertía
// en 24016 — error 100x silencioso en precios. Heurística: si la última
// coma va seguida de 1-2 dígitos al final y está después del último punto,
// es decimal ("240,16", "1.250,50"); si no, es separador de miles
// ("1,250.50", "95,000") y se elimina.
function toNumber(value) {
  if (value == null || value === "") return null;
  let cleaned = String(value).replace(/[^\d.,\-]/g, "");
  const lastComma = cleaned.lastIndexOf(",");
  if (lastComma !== -1) {
    const lastDot = cleaned.lastIndexOf(".");
    if (lastComma > lastDot && /,\d{1,2}$/.test(cleaned)) {
      cleaned =
        cleaned.slice(0, lastComma).replace(/[.,]/g, "") +
        "." +
        cleaned.slice(lastComma + 1);
    } else {
      cleaned = cleaned.replace(/,/g, "");
    }
  }
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function toInt(value) {
  const n = toNumber(value);
  return n == null ? null : Math.round(n);
}

function normEstado(value) {
  const v = String(value || "").trim().toLowerCase();
  return VALID_ESTADOS.has(v) ? v : "disponible";
}

function parseMetaTab(rows, skipped) {
  return rows.map((row) => ({
    proyecto_id: row.proyecto_id,
    nombre_display: row.nombre_display || "",
    ubicacion: row.ubicacion || "",
    entrega_fecha: row.entrega_fecha || "",
    // Bloque 2 hotfix-51: inicio de construcción (opcional, para el header
    // del PDF: "INICIO DE CONSTRUCCIÓN [x] · ENTREGA [y]").
    inicio_construccion: row.inicio_construccion || null,
    plan_normal: row.plan_normal || "",
    plan_feria: row.plan_feria || null,
    total_unidades: toInt(row.total_unidades),
    nota_especial: row.nota_especial || null,
  }));
}

// makeUnitParser: factory que genera parser por tab. Aplica la regla
// "disponible sin precio = skip".
function makeUnitParser(tabName, priceField, fields) {
  return function parseUnits(rows, skipped) {
    const units = [];
    for (const row of rows) {
      const estado = normEstado(row.estado);
      const price = toNumber(row[priceField]);

      // REGLA Director: disponible sin precio = dato incompleto, no mostrar.
      if (estado === "disponible" && (price == null || price <= 0)) {
        skipped.push({
          tab: tabName,
          unidad_id: row.unidad_id || "(sin id)",
          estado,
          reason: "missing_price",
        });
        continue;
      }

      const unit = { unidad_id: row.unidad_id || "", estado };
      unit[priceField] = price;

      for (const [target, parse] of fields) {
        const v = parse(row[target]);
        if (v != null) unit[target] = v;
      }
      if (row.nota) unit.nota = row.nota;

      units.push(unit);
    }
    return units;
  };
}

const parsePR3 = makeUnitParser("pr3", "precio_usd", [
  ["m2", toInt],
  ["vista", (v) => (v ? String(v).trim() : null)],
  // Bloque 2 hotfix diseño: columnas del modelo PDF (hab/baños/parqueos).
  ["hab", (v) => (v ? String(v).trim() : null)],
  ["bano", toNumber],
  ["parqueos", (v) => (v ? String(v).trim() : null)],
]);

const str = (v) => (v ? String(v).trim() : null);

const parsePR4 = makeUnitParser("pr4", "precio_usd", [
  ["tipo", (v) => (v ? String(v).trim().toUpperCase() : null)],
  ["m2", toInt],
  // hab/parqueos como STRING: el modelo trae "1+ESTAR", "2L" (no enteros).
  ["hab", str],
  ["bano", toNumber],
  ["parqueos", str],
  ["orientacion", str],
  // vista alias (el modelo PR4 rotula la orientación como "Vista").
  ["vista", str],
  // Bloque 2 hotfix-51 (Fix 5): nº de encargos del modelo (opcional).
  ["numero_encargos", str],
]);

const parsePSE3 = makeUnitParser("pse3", "precio_usd", [
  ["edificio", toInt],
  ["nivel", str],
  ["tipo", str],
  ["m2", toNumber],
  // Bloque 2 hotfix diseño: hab/baños del modelo PDF.
  ["hab", str],
  ["bano", toNumber],
  ["numero_encargos", str],
]);

const parsePSE4 = makeUnitParser("pse4", "precio_usd", [
  ["edificio", toInt],
  ["tipo", str],
  ["m2", toNumber],
  ["hab", str],
  ["bano", toNumber],
  ["numero_encargos", str],
]);

const parseCruxT6 = makeUnitParser("crux_t6", "precio_usd", [
  ["piso", toInt],
  ["letra", (v) => (v ? String(v).trim().toUpperCase() : null)],
  // Bloque 2 hotfix diseño: columnas del modelo PDF Torre 6.
  ["m2", toNumber],
  ["hab", str],
  ["bano", toNumber],
  ["parqueos", str],
  ["parqueo_tipo", str],
  ["tipo", str],
  ["numero_encargos", str],
]);

const parseCruxListos = makeUnitParser("crux_listos", "precio_dop", [
  ["torre", (v) => (v ? String(v).trim().toUpperCase() : null)],
  ["etapa", toInt],
  ["parqueo_tipo", (v) => (v ? String(v).trim() : null)],
  ["m2", toNumber],
  ["hab", (v) => (v ? String(v).trim() : null)],
  ["bano", toNumber],
]);

// parseInventory: entry point. Recibe el objeto de tabs (output de
// fetchAllTabs después de rowsToObjects por tab) y retorna inventario
// estructurado + listado de unidades skipped.
function parseInventory(tabObjects) {
  const skipped = [];
  const result = {
    meta: parseMetaTab(tabObjects.META || [], skipped),
    proyectos: {
      pr3: parsePR3(tabObjects.PR3 || [], skipped),
      pr4: parsePR4(tabObjects.PR4 || [], skipped),
      pse3: parsePSE3(tabObjects.PSE3 || [], skipped),
      pse4: parsePSE4(tabObjects.PSE4 || [], skipped),
      crux_t6: parseCruxT6(tabObjects.CRUX_TORRE6 || [], skipped),
      crux_listos: parseCruxListos(tabObjects.CRUX_LISTOS || [], skipped),
    },
    skipped,
  };
  return result;
}

module.exports = {
  parseInventory,
  toNumber,
  toInt,
  normEstado,
  VALID_ESTADOS,
};
