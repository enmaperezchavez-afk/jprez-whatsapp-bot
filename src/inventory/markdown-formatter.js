// src/inventory/markdown-formatter.js — Bloque 1 Fase 2.
//
// Convierte el objeto inventory (output de parser.parseInventory) en
// el bloque markdown que se inyecta al system prompt como
// INVENTORY_CONTENT. Replica la estructura semántica del
// inventario-precios.md actual:
//   - 1 sección por proyecto con header ## NOMBRE
//   - Lista de unidades disponibles
//   - Total disponibles X de Y al final por proyecto
//   - Plan de pago + entrega + ubicación desde META
//
// CONTRATO DE COMPORTAMIENTO (preservar idempotencia Mateo):
//   - Crux Torre 6: muestra todas las unidades con flag inline si
//     están reservadas/vendidas/bloqueadas. Replica el formato
//     PISO N: A=$X / B=$Y (RESERVADO) ...
//   - Otros proyectos: solo lista unidades disponibles. Las no-disponibles
//     solo aportan al conteo "X de Y".
//   - Formato prosa, NO tablas markdown (regla del documento: nada de
//     tablas/bullets en mensajes WhatsApp; este texto se inyecta como
//     contexto interno, pero el LLM tiende a copiar formato).

function fmtMoney(n, currency) {
  if (n == null || !Number.isFinite(n)) return "";
  return currency + "$" + Math.round(n).toLocaleString("en-US");
}

function fmtUsd(n) {
  return fmtMoney(n, "US");
}

function fmtDop(n) {
  return fmtMoney(n, "RD");
}

function findMeta(inventory, proyectoId) {
  return (inventory.meta || []).find((m) => m.proyecto_id === proyectoId);
}

function plural(n, singular, pluralForm) {
  return n === 1 ? singular : pluralForm;
}

function countDisponibles(units) {
  return units.filter((u) => u.estado === "disponible").length;
}

function metaLine(meta) {
  if (!meta) return "";
  const parts = [];
  if (meta.entrega_fecha) parts.push("Entrega: " + meta.entrega_fecha);
  if (meta.ubicacion) parts.push("Ubicación: " + meta.ubicacion);
  if (meta.plan_normal) parts.push("Plan normal: " + meta.plan_normal);
  if (meta.plan_feria) parts.push("Plan Feria de Mayo 2026: " + meta.plan_feria);
  return parts.join(". ") + (parts.length ? "." : "");
}

// ============================================
// CRUX LISTOS — RD$, entrega inmediata
// ============================================
function sectionCruxListos(inventory) {
  const units = inventory.proyectos.crux_listos || [];
  const meta = findMeta(inventory, "crux_listos");
  const disponibles = units.filter((u) => u.estado === "disponible");
  const lines = [];
  lines.push("## CRUX DEL PRADO — Unidades Listas para Entrega Inmediata");
  lines.push("");
  if (meta && meta.nota_especial) {
    lines.push(meta.nota_especial);
    lines.push("");
  }
  const byEtapa = {};
  for (const u of disponibles) {
    const k = u.etapa || 0;
    (byEtapa[k] = byEtapa[k] || []).push(u);
  }
  const etapas = Object.keys(byEtapa).sort((a, b) => Number(a) - Number(b));
  for (const e of etapas) {
    const us = byEtapa[e];
    lines.push("### Etapa " + e + " (" + us.length + " " + plural(us.length, "unidad disponible", "unidades disponibles") + ")");
    lines.push("");
    for (const u of us) {
      const parqueoTxt = u.parqueo_tipo ? ", con 2 parqueos " + u.parqueo_tipo + " destechados" : "";
      lines.push(u.unidad_id + " en " + fmtDop(u.precio_dop) + parqueoTxt + ", DISPONIBLE.");
      lines.push("");
    }
  }
  lines.push("### Inventario total listos Crux");
  lines.push("");
  lines.push(disponibles.length + " unidades disponibles para entrega inmediata.");
  lines.push("");
  return lines.join("\n");
}

// ============================================
// CRUX TORRE 6 — USD, muestra reservadas/vendidas inline
// ============================================
function sectionCruxTorre6(inventory) {
  const units = inventory.proyectos.crux_t6 || [];
  const meta = findMeta(inventory, "crux_t6");
  const lines = [];
  lines.push("## CRUX DEL PRADO — Torre 6");
  lines.push("");
  if (meta) {
    lines.push(metaLine(meta));
    lines.push("");
  }
  // Agrupar por piso
  const byPiso = {};
  for (const u of units) {
    const p = u.piso;
    if (p == null) continue;
    (byPiso[p] = byPiso[p] || []).push(u);
  }
  const pisos = Object.keys(byPiso).map(Number).sort((a, b) => a - b);
  lines.push("### Precios por unidad (US$)");
  lines.push("");
  for (const piso of pisos) {
    const ul = byPiso[piso].slice().sort((a, b) => String(a.letra).localeCompare(b.letra));
    const segments = ul.map((u) => {
      const flag = u.estado !== "disponible" ? " (" + u.estado.toUpperCase() + ")" : "";
      return u.letra + "=" + fmtUsd(u.precio_usd) + flag;
    });
    const dispCount = ul.filter((u) => u.estado === "disponible").length;
    const dispLabel =
      dispCount === ul.length
        ? "todos disponibles"
        : dispCount + " " + plural(dispCount, "disponible", "disponibles");
    lines.push("PISO " + piso + ": " + segments.join(" / ") + " — " + dispLabel + ".");
    lines.push("");
  }
  const totalDisp = countDisponibles(units);
  const totalUnidades = meta && meta.total_unidades ? meta.total_unidades : units.length;
  lines.push("Total disponibles: " + totalDisp + " de " + totalUnidades + ".");
  lines.push("");
  return lines.join("\n");
}

// ============================================
// PR3 — solo disponibles + total
// ============================================
function sectionPR3(inventory) {
  const units = inventory.proyectos.pr3 || [];
  const meta = findMeta(inventory, "pr3");
  const disponibles = units.filter((u) => u.estado === "disponible");
  const lines = [];
  lines.push("## PRADO RESIDENCES III");
  lines.push("");
  if (meta) {
    lines.push(metaLine(meta));
    lines.push("");
  }
  lines.push("### Unidades disponibles");
  lines.push("");
  for (const u of disponibles) {
    const parts = [u.unidad_id + " en " + fmtUsd(u.precio_usd)];
    if (u.m2) parts.push(u.m2 + "m²");
    if (u.vista) parts.push("vista " + u.vista);
    lines.push(parts.join(", ") + ".");
    lines.push("");
  }
  const total = meta && meta.total_unidades ? meta.total_unidades : units.length;
  lines.push("Total disponibles: " + disponibles.length + " de " + total + ".");
  lines.push("");
  return lines.join("\n");
}

// ============================================
// PR4 — solo disponibles + total
// ============================================
function sectionPR4(inventory) {
  const units = inventory.proyectos.pr4 || [];
  const meta = findMeta(inventory, "pr4");
  const disponibles = units.filter((u) => u.estado === "disponible");
  const lines = [];
  lines.push("## PRADO RESIDENCES IV");
  lines.push("");
  if (meta) {
    lines.push(metaLine(meta));
    lines.push("");
  }
  lines.push("### Unidades disponibles");
  lines.push("");
  for (const u of disponibles) {
    const parts = [u.unidad_id + " en " + fmtUsd(u.precio_usd)];
    if (u.m2) parts.push(u.m2 + "m²");
    if (u.hab != null) parts.push(u.hab + " hab");
    if (u.bano != null) parts.push(u.bano + " baños");
    if (u.parqueos != null) parts.push(u.parqueos + " parqueos");
    lines.push(parts.join(", ") + ".");
    lines.push("");
  }
  const total = meta && meta.total_unidades ? meta.total_unidades : units.length;
  lines.push("Total disponibles: " + disponibles.length + " de " + total + ".");
  lines.push("");
  return lines.join("\n");
}

// ============================================
// PSE3 — agrupado por edificio + nivel
// ============================================
function sectionPSE3(inventory) {
  const units = inventory.proyectos.pse3 || [];
  const meta = findMeta(inventory, "pse3");
  const disponibles = units.filter((u) => u.estado === "disponible");
  const lines = [];
  lines.push("## PRADO SUITES PUERTO PLATA — Etapa 3");
  lines.push("");
  if (meta) {
    lines.push(metaLine(meta));
    lines.push("");
  }
  // Agrupar por edificio y nivel
  const byEdif = {};
  for (const u of disponibles) {
    if (u.edificio == null) continue;
    const e = u.edificio;
    const n = u.nivel || "";
    byEdif[e] = byEdif[e] || {};
    (byEdif[e][n] = byEdif[e][n] || []).push(u);
  }
  const edifs = Object.keys(byEdif).sort((a, b) => Number(a) - Number(b));
  for (const e of edifs) {
    const niveles = Object.keys(byEdif[e]);
    const total = niveles.reduce((sum, n) => sum + byEdif[e][n].length, 0);
    lines.push("#### Disponibles Edificio " + e + " (" + total + " " + plural(total, "unidad", "unidades") + ")");
    lines.push("");
    for (const n of niveles) {
      const us = byEdif[e][n];
      const segs = us.map((u) => {
        const meta2 = u.m2 ? " (" + u.m2 + "m²" + (u.tipo ? ", " + u.tipo : "") + ")" : "";
        return u.unidad_id + " en " + fmtUsd(u.precio_usd) + meta2;
      });
      lines.push("NIVEL " + n + ": " + segs.join(" | ") + ".");
      lines.push("");
    }
  }
  const total = meta && meta.total_unidades ? meta.total_unidades : units.length;
  lines.push("Total disponibles E3: " + disponibles.length + " de " + total + ".");
  lines.push("");
  return lines.join("\n");
}

// ============================================
// PSE4 — agrupado por edificio
// ============================================
function sectionPSE4(inventory) {
  const units = inventory.proyectos.pse4 || [];
  const meta = findMeta(inventory, "pse4");
  const disponibles = units.filter((u) => u.estado === "disponible");
  const lines = [];
  lines.push("## PRADO SUITES PUERTO PLATA — Etapa 4");
  lines.push("");
  if (meta) {
    lines.push(metaLine(meta));
    lines.push("");
  }
  const byEdif = {};
  for (const u of disponibles) {
    if (u.edificio == null) continue;
    (byEdif[u.edificio] = byEdif[u.edificio] || []).push(u);
  }
  const edifs = Object.keys(byEdif).sort((a, b) => Number(a) - Number(b));
  for (const e of edifs) {
    const us = byEdif[e];
    lines.push("Edificio " + e + " (" + us.length + " " + plural(us.length, "disponible", "disponibles") + "):");
    for (const u of us) {
      const parts = [u.unidad_id + " en " + fmtUsd(u.precio_usd)];
      if (u.m2) parts.push(u.m2 + "m²");
      if (u.hab != null) parts.push(u.hab + " hab");
      lines.push("  - " + parts.join(", ") + ".");
    }
    lines.push("");
  }
  const total = meta && meta.total_unidades ? meta.total_unidades : units.length;
  lines.push("Total disponibles E4: " + disponibles.length + " de " + total + ".");
  lines.push("");
  return lines.join("\n");
}

// ============================================
// ENTRY POINT
// ============================================
function formatInventoryMarkdown(inventory) {
  const sections = [
    "# Inventario y Precios — JPREZ (live desde Google Sheets)",
    "",
    "Documento generado automáticamente. Para precios y disponibilidad EXACTOS consulta este bloque, no la memoria del modelo. Si hay conflicto, este bloque manda.",
    "",
    "---",
    "",
    sectionCruxListos(inventory),
    "---",
    "",
    sectionCruxTorre6(inventory),
    "---",
    "",
    sectionPR3(inventory),
    "---",
    "",
    sectionPR4(inventory),
    "---",
    "",
    sectionPSE3(inventory),
    "---",
    "",
    sectionPSE4(inventory),
  ];
  return sections.join("\n");
}

module.exports = {
  formatInventoryMarkdown,
  // exportar las secciones individuales para test granular
  sectionCruxListos,
  sectionCruxTorre6,
  sectionPR3,
  sectionPR4,
  sectionPSE3,
  sectionPSE4,
  // helpers exportados para test
  fmtUsd,
  fmtDop,
};
