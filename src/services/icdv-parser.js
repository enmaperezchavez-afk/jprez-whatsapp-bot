// src/services/icdv-parser.js — Scraper ICDV (ONE), núcleo PURO.
//
// El ICDV (Índice de Costos Directos de la Construcción de Viviendas) lo
// publica la Oficina Nacional de Estadística (ONE) SOLO como boletín PDF
// mensual. No hay Excel, ni datos abiertos, ni tabla web, ni API. El dato
// vive DENTRO del PDF y el link al PDF tiene un slug aleatorio no derivable
// (ej. /media/pffd0cf1/icdv-abril-2026.pdf). Ver audit en memoria.
//
// Este módulo es 100% PURO (string -> objeto), sin red ni dependencias.
// Toda la parte que toca red/PDF vive en icdv-scraper.js. Así el parser
// —la lógica frágil que hay que blindar contra cambios de formato— se
// testea con fixtures reales del boletín, sin mocks de fetch.
//
// CONTRATO de 3 etapas (espejo del patrón market.js del repo):
//   1. discoverLatestFromListing(html) -> {mes, anio, ...} más reciente.
//   2. extractPdfUrl(landingHtml, origin) -> URL absoluta del PDF (slug random).
//   3. parseBulletinText(pdfText) -> objeto estructurado del índice.
// + mergeIntoSeries() para acumular la serie histórica que la ONE no da.

// Meses español -> número. La ONE escribe el mes capitalizado en el slug
// (abril) y en la prosa ("En Abril 2026..."). Normalizamos a minúscula
// sin acentos antes de buscar.
const MESES = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

const MESES_NOMBRE = Object.keys(MESES); // index 0 = enero

// Slug canónico de la publicación ICDV en one.gob.do. ESTABLE (a
// diferencia del slug del PDF). El mes y año salen de aquí.
const ICDV_SLUG = "indice-de-costos-directos-de-la-construccion-de-viviendas-icdv";
const ONE_ORIGIN = "https://www.one.gob.do";

// quitarAcentos: para matchear "Índice"/"índice", "Abril"/"abril" sin
// depender de la capitalización ni de los acentos del boletín.
function quitarAcentos(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

// normalizar: colapsa todo run de whitespace (incluye los espacios
// múltiples del texto justificado del PDF y los saltos de línea) a UN
// solo espacio. Hace que todos los regex de abajo sean robustos al
// layout. NO toca acentos (los regex usan quitarAcentos por separado).
function normalizar(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

// parseNum: "240.16" -> 240.16, "-0.16" -> -0.16, "238.57." -> 238.57.
// Extrae el PRIMER token numérico válido (con signo y decimal opcional),
// ignorando puntuación pegada como el punto final de fin de oración —
// los grupos de captura como ([\d.]+) pueden arrastrar un "." de cierre
// ("238.57. Desde"), y Number("238.57.") es NaN. Devuelve null si no hay
// número. La ONE usa punto decimal en estos boletines.
function parseNum(s) {
  if (s == null) return null;
  // Hotfix-31: acepta también decimales sin dígito inicial (".5%").
  const m = String(s).replace(/,/g, "").match(/-?(?:\d+(?:\.\d+)?|\.\d+)/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function mesANumero(nombre) {
  return MESES[quitarAcentos(nombre).toLowerCase()] || null;
}

function periodoDe(anio, monthIndex) {
  return `${anio}-${String(monthIndex).padStart(2, "0")}`;
}

// ============================================================
// ETAPA 1 — discoverLatestFromListing(html)
// ============================================================
// El listado de publicaciones de la ONE enlaza cada boletín con un href
// estable: /publicaciones/{AÑO}/...icdv-{mes}-{año}/. Extraemos todos los
// que matcheen el slug ICDV, parseamos mes+año del propio slug, y
// devolvemos el más reciente. Devuelve null si no hay ninguno.
function discoverLatestFromListing(html) {
  const all = listIcdvPublications(html);
  return all.length ? all[0] : null;
}

// listIcdvPublications: todos los boletines ICDV hallados en un HTML,
// ordenados del más reciente al más viejo. Cada item:
//   { mes, anio, month_index, periodo, landing_path, landing_url }
function listIcdvPublications(html) {
  const src = String(html || "");
  // href="/publicaciones/2026/...icdv-abril-2026/"  (con o sin trailing slash)
  const re = new RegExp(
    `/publicaciones/(\\d{4})/${ICDV_SLUG}-([a-zA-Zñáéíóú]+)-(\\d{4})/?`,
    "gi"
  );
  const vistos = new Map(); // periodo -> item (dedupe)
  let m;
  while ((m = re.exec(src)) !== null) {
    const mesNombre = quitarAcentos(m[2]).toLowerCase();
    const monthIndex = MESES[mesNombre];
    const anio = parseInt(m[3], 10);
    if (!monthIndex || !anio) continue;
    const periodo = periodoDe(anio, monthIndex);
    if (vistos.has(periodo)) continue;
    const landing_path = `/publicaciones/${m[1]}/${ICDV_SLUG}-${mesNombre}-${anio}/`;
    vistos.set(periodo, {
      mes: mesNombre,
      anio,
      month_index: monthIndex,
      periodo,
      landing_path,
      landing_url: ONE_ORIGIN + landing_path,
    });
  }
  return Array.from(vistos.values()).sort((a, b) =>
    b.periodo.localeCompare(a.periodo)
  );
}

// buildLandingUrl: URL de la landing para un mes/año conocido. El patrón
// del slug de la publicación es ESTABLE, así que para un mes objetivo
// podemos ir directo sin scrapear el listado. mes puede ser nombre
// ("abril") o número (4).
function buildLandingUrl(mes, anio) {
  const monthIndex =
    typeof mes === "number" ? mes : mesANumero(mes);
  if (!monthIndex || !anio) return null;
  const nombre = MESES_NOMBRE[monthIndex - 1];
  return `${ONE_ORIGIN}/publicaciones/${anio}/${ICDV_SLUG}-${nombre}-${anio}/`;
}

// ============================================================
// ETAPA 2 — extractPdfUrl(landingHtml, origin)
// ============================================================
// La landing tiene UN botón de descarga: <a href="/media/{slug}/...pdf"
// download>. El slug es aleatorio (pffd0cf1, ewfe4lqe...) y el nombre
// del archivo varía (boletin-icdv-... vs icdv-...). Por eso NUNCA
// construimos la URL del PDF: la extraemos del HTML. Devuelve URL
// absoluta o null.
function extractPdfUrl(landingHtml, origin = ONE_ORIGIN) {
  const src = String(landingHtml || "");
  // Preferimos el /media/*.pdf (boletín alojado). Tomamos el primero.
  // Hotfix-31: href\s*=\s* tolera espacios alrededor del = (variaciones
  // del CMS de la ONE no deben romper el scrape del mes).
  let m = src.match(/href\s*=\s*["'](\/media\/[^"']+?\.pdf)["']/i);
  if (!m) {
    // Fallback: cualquier href absoluto a un .pdf de one.gob.do.
    m = src.match(/href\s*=\s*["'](https?:\/\/[^"']*one\.gob\.do\/[^"']+?\.pdf)["']/i);
    if (m) return m[1];
    return null;
  }
  const path = m[1];
  return /^https?:/i.test(path) ? path : origin.replace(/\/$/, "") + path;
}

// ============================================================
// ETAPA 3 — parseBulletinText(pdfText)
// ============================================================
// Extrae los números del texto del boletín (salida de pdf-parse). La
// frase ANCLA es muy estable mes a mes:
//   "En {Mes} {Año} el Índice ... fue de {INDICE} en promedio,
//    registrando un incremento/disminución de {PUNTOS} puntos, en
//    comparación con el mes anterior que fue de {ANTERIOR}. Desde
//    Diciembre del {AAAA} ... variación acumulada de {AÑO_CORRIDO}%.
//    Al comparar ... {Mes} {Año} con los de {Mes} {Año-1} ... una
//    variación de {12_MESES}%."
//
// Política de robustez: los campos CORE (mes, anio, indice,
// indice_anterior, var_anio_corrido, var_12m) son obligatorios; si falta
// alguno -> error (no servimos un dato a medias al cliente). Los
// sub_indices y grupos son best-effort: si el formato cambia, quedan en
// null pero el dato principal sigue sirviendo.
function parseBulletinText(rawText) {
  const text = normalizar(rawText);
  const plain = quitarAcentos(text); // para matchear sin acentos

  // --- CORE: frase ancla del índice general ---
  // "En Abril 2026 el Indice ... fue de 240.16 en promedio"
  const mHead = plain.match(
    /En\s+([A-Za-z]+)\s+(\d{4})\s+el\s+Indice[^.]*?fue de\s+([\d.]+)\s+en promedio/i
  );
  if (!mHead) {
    throw new Error(
      "ICDV parse: no se encontró la frase ancla del índice general"
    );
  }
  const mes = mHead[1].toLowerCase();
  const month_index = MESES[mes];
  const anio = parseInt(mHead[2], 10);
  const indice = parseNum(mHead[3]);
  if (!month_index || !anio || indice == null) {
    throw new Error(`ICDV parse: cabecera inválida (${mHead[1]} ${mHead[2]})`);
  }

  // delta en puntos (texto trae magnitud sin signo: "incremento/
  // disminución de X puntos"). Capturamos magnitud + la palabra para el
  // signo, pero el delta canónico lo calculamos de los índices.
  const mPuntos = plain.match(
    /registrando una?\s+(incremento|disminuci[oó]n|reducci[oó]n|aumento|baja)\s+de\s+([\d.]+)\s+puntos/i
  );

  // índice del mes anterior
  const mPrev = plain.match(/mes anterior que fue de\s+([\d.]+)/i);
  const indice_anterior = mPrev ? parseNum(mPrev[1]) : null;
  if (indice_anterior == null) {
    throw new Error("ICDV parse: no se encontró el índice del mes anterior");
  }

  // variación acumulada año corrido
  const mAcum = plain.match(/variaci[oó]n acumulada de\s+(-?[\d.]+)\s*%/i);
  const var_anio_corrido_pct = mAcum ? parseNum(mAcum[1]) : null;

  // variación 12 meses (interanual): "Al comparar ... mostrado una
  // variación de X%". Usamos el contexto "Al comparar" para no chocar
  // con la acumulada.
  const m12 = plain.match(
    /Al comparar[^%]*?mostrado una variaci[oó]n de\s+(-?[\d.]+)\s*%/i
  );
  const var_12m_pct = m12 ? parseNum(m12[1]) : null;

  if (var_anio_corrido_pct == null || var_12m_pct == null) {
    throw new Error(
      "ICDV parse: faltan variaciones acumulada/12-meses (core)"
    );
  }

  // delta y variación mensual: canónicos calculados de los índices.
  const delta_puntos = round2(indice - indice_anterior);
  const var_mensual_pct = round2((indice / indice_anterior - 1) * 100);
  // signo declarado en el texto (sanity): si dice disminución/reducción/
  // baja, el delta debería ser <= 0.
  const tendencia = mPuntos
    ? /incremento|aumento/i.test(mPuntos[1])
      ? "alza"
      : "baja"
    : delta_puntos >= 0
    ? "alza"
    : "baja";

  // --- BEST-EFFORT: sub-índices por tipología ---
  // "el ICDV fue de 247.57 para la vivienda unifamiliar de un nivel;
  //  242.40 ... de dos niveles; 235.31 ... multifamiliar de cuatro
  //  niveles, y 235.37 ... de ocho niveles"
  const sub_indices = parseSubIndices(plain);

  // --- BEST-EFFORT: variación mensual por grupo de costos ---
  const grupos = parseGrupos(plain);

  return {
    fuente: "ONE",
    indicador: "ICDV",
    base: "octubre 2009",
    region: "Región Metropolitana (Distrito Nacional y Santo Domingo)",
    mes,
    anio,
    month_index,
    periodo: periodoDe(anio, month_index),
    indice,
    indice_anterior,
    delta_puntos,
    tendencia,
    var_mensual_pct,
    var_anio_corrido_pct,
    var_12m_pct,
    sub_indices,
    grupos,
  };
}

function parseSubIndices(plain) {
  const out = {
    unifamiliar_1n: null,
    unifamiliar_2n: null,
    multifamiliar_4n: null,
    multifamiliar_8n: null,
  };
  const m = plain.match(
    /ICDV fue de\s+([\d.]+)\s+para la vivienda unifamiliar\s+de un nivel;\s*([\d.]+)\s+para la vivienda unifamiliar de dos niveles;\s*([\d.]+)\s+para\s+la\s+multifamiliar\s+de\s+cuatro\s+niveles,\s*y\s+([\d.]+)\s+para la multifamiliar de ocho/i
  );
  if (m) {
    out.unifamiliar_1n = parseNum(m[1]);
    out.unifamiliar_2n = parseNum(m[2]);
    out.multifamiliar_4n = parseNum(m[3]);
    out.multifamiliar_8n = parseNum(m[4]);
  }
  return out;
}

function parseGrupos(plain) {
  const out = {
    herramientas: null,
    materiales: null,
    subcontratos: null,
    mano_obra: null,
    maquinarias: null,
  };
  // Prosa: "las herramientas presentaron un incremento, con un 9.94%.
  // los materiales con un 1.37%; los subcontratos ... 0.72%; ... la mano
  // de obra con un 0.00%; y las maquinarias con un -0.16%."
  const grab = (label, re) => {
    const m = plain.match(re);
    if (m) out[label] = parseNum(m[1]);
  };
  grab("herramientas", /herramientas[^%]*?con un\s+(-?[\d.]+)\s*%/i);
  grab("materiales", /materiales con un\s+(-?[\d.]+)\s*%/i);
  grab("subcontratos", /subcontratos[^%]*?con un\s+(-?[\d.]+)\s*%/i);
  grab("mano_obra", /mano de obra con un\s+(-?[\d.]+)\s*%/i);
  grab("maquinarias", /maquinarias con un\s+(-?[\d.]+)\s*%/i);
  return out;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ============================================================
// SERIE — mergeIntoSeries(existing, entry)
// ============================================================
// La ONE no publica la serie completa en ningún lado: cada boletín solo
// trae el mes actual y el anterior. Acumulamos nosotros. Upsert por
// `periodo` (YYYY-MM): si el periodo ya existe lo reemplaza (re-scrape /
// rectificación), si no lo agrega. Devuelve nuevo array ordenado del más
// reciente al más viejo. NO muta el input.
function mergeIntoSeries(existing, entry) {
  const base = Array.isArray(existing) ? existing.slice() : [];
  if (!entry || !entry.periodo) return base.sort(ordPeriodoDesc);
  // Hotfix-31: un periodo malformado ("202-4") rompería el orden
  // cronológico de toda la serie (sort por string). Se ignora la entrada
  // en vez de contaminar el store canónico de Redis.
  if (!/^\d{4}-\d{2}$/.test(String(entry.periodo))) {
    return base.sort(ordPeriodoDesc);
  }
  const filtered = base.filter((e) => e && e.periodo !== entry.periodo);
  filtered.push(entry);
  return filtered.sort(ordPeriodoDesc);
}

function ordPeriodoDesc(a, b) {
  return String(b.periodo).localeCompare(String(a.periodo));
}

module.exports = {
  // etapas
  discoverLatestFromListing,
  listIcdvPublications,
  buildLandingUrl,
  extractPdfUrl,
  parseBulletinText,
  mergeIntoSeries,
  // helpers expuestos para test
  normalizar,
  quitarAcentos,
  parseNum,
  mesANumero,
  MESES,
  ONE_ORIGIN,
  ICDV_SLUG,
};
