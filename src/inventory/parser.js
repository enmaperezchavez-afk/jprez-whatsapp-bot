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

function toNumber(value) {
  if (value == null || value === "") return null;
  const cleaned = String(value).replace(/[^\d.-]/g, "");
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
]);

const parsePR4 = makeUnitParser("pr4", "precio_usd", [
  ["tipo", (v) => (v ? String(v).trim().toUpperCase() : null)],
  ["m2", toInt],
  ["hab", toInt],
  ["bano", toNumber],
  ["parqueos", toInt],
  ["orientacion", (v) => (v ? String(v).trim() : null)],
]);

const parsePSE3 = makeUnitParser("pse3", "precio_usd", [
  ["edificio", toInt],
  ["nivel", (v) => (v ? String(v).trim() : null)],
  ["tipo", (v) => (v ? String(v).trim() : null)],
  ["m2", toInt],
]);

const parsePSE4 = makeUnitParser("pse4", "precio_usd", [
  ["edificio", toInt],
  ["tipo", (v) => (v ? String(v).trim() : null)],
  ["m2", toInt],
  ["hab", toInt],
]);

const parseCruxT6 = makeUnitParser("crux_t6", "precio_usd", [
  ["piso", toInt],
  ["letra", (v) => (v ? String(v).trim().toUpperCase() : null)],
]);

const parseCruxListos = makeUnitParser("crux_listos", "precio_dop", [
  ["torre", (v) => (v ? String(v).trim().toUpperCase() : null)],
  ["etapa", toInt],
  ["parqueo_tipo", (v) => (v ? String(v).trim() : null)],
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
