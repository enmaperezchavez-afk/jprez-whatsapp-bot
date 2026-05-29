// src/documents/project-themes.js — Feature 4.
//
// PROJECT_THEMES define la identidad visual de cada proyecto:
// paleta de color, colores por estado, tipografía y opciones de layout.
// El generator (price-list-generator.js) consume el theme según
// proyectoId vía getTheme(proyectoId).
//
// FASE 2 (actual): PR3 estrena su theme propio (blanco + rojo JPREZ +
// Montserrat + mapa circular + donut + progress bars + footer oscuro).
// PR4 / PSE3 / PSE4 / CRUX_T6 / CRUX_LISTOS siguen usando _CORE (navy
// clásico, igual que antes). Vegeta irá pasando paletas para cada uno.
//
// theme.layout es opcional. Si está ausente o sus flags están en false,
// el generator dibuja el header navy clásico. Cada flag activa un
// behaviour adicional (banda roja, mapa, donut, etc.).

const _CORE = {
  palette: {
    headerBg:        "#1a2b4a",  // navy header (rect full-width)
    headerText:      "#ffffff",  // título proyecto
    accent:          "#c9a227",  // wordmark "JPREZ" + ubicación fallback
    subText:         "#dbe2ee",  // banner del header
    tableHeaderBg:   "#1a2b4a",  // column headers
    tableHeaderText: "#ffffff",
    groupRowBg:      "#eef1f6",  // separador piso/edificio
    border:          "#cfd6e0",
    footerSideText:  "#666666",
    footerCenter:    "#1a2b4a",
    rowText:         "#222222",
    cellTextDim:     "#333333",
    summaryTotalBg:  "#e9edf3",
    summaryPctBg:    "#f3e9c9",
  },
  statusColors: {
    disponible: "#d8f3dc",
    reservado:  "#fff3bf",
    vendido:    "#ffd6d6",
    bloqueado:  "#dee2e6",
  },
  fonts: {
    title:    "Helvetica-Bold",
    body:     "Helvetica",
    bodyBold: "Helvetica-Bold",
  },
  layout: {}, // todo flags off → header navy clásico
};

// Theme propio de Prado Residences III (Brand Book).
//
// HEADER BG por proyecto (F4 — pendiente aplicar en los otros themes
// cuando se repliquen):
//   PR3          → #EAECF0  (gris notable, este theme)
//   PR4          → #E4E6EA  (gris un toque más marcado)
//   PSE3 / PSE4  → #F5EEE0  (arena notable)
//   CRUX *       → #E6F1F1  (verde agua notable)
const PR3_THEME = {
  palette: {
    // Fondo de la franja del header (cubre solo el área superior; el resto
    // del PDF — cards, tabla, footer — sigue blanco).
    headerBg:        "#EAECF0",
    headerText:      "#1F2937", // grafito profundo del Brand Book
    groupRowText:    "#1F2937", // texto de "Piso N" sobre groupRowBg gris
    accent:          "#ED1C29", // rojo JPREZ (banda + pin + donut foreground)
    subText:         "#6B7280", // gris medio (dirección, banner secundario)
    // Tabla con header grafito.
    tableHeaderBg:   "#1F2937",
    tableHeaderText: "#FFFFFF",
    groupRowBg:      "#E5E7EB", // gray-200: separador "Piso N" con presencia visual real
    border:          "#E5E7EB",
    // Footer oscuro.
    footerBg:        "#1F2937",
    footerSideText:  "#9CA3AF",
    footerCenter:    "#FFFFFF",
    // Cuerpo de tabla y resumen.
    rowText:         "#1F2937",
    cellTextDim:     "#374151",
    summaryTotalBg:  "#D1D5DB", // gray-300 (usado por la tabla "resumen por piso")
    summaryPctBg:    "#FEE2E2",
    statLabelText:   "#374151", // legacy fallback
    // Rediseño elegante de cards (cardStyle: "elegant"):
    cardBg:          "#FFFFFF", // fondo blanco
    cardLabel:       "#4A4A4A", // label gris oscuro debajo del número
    totalAccent:     "#1F2937", // borde + número de la card "Total"
    pctAccent:       "#ED1C29", // borde + donut de "% Ventas" (rojo JPREZ)
    rowBg:           "#FFFFFF", // fondo de fila en tabla principal (rowStyle: white-with-bar)
    // Extras PR3.
    sectionBg:       "#FAFAFA",
    whatsappColor:   "#25D366",
    donutTrackBg:    "#F3F4F6", // anillo de fondo del donut
  },
  statusColors: {
    // Brand Book: sobrios y elegantes (no pastel, no chillones).
    // Estos colores son ACCENTS (borde de card, barra lateral, texto
    // del Estatus en la tabla) — NO se usan como bg de filas.
    disponible: "#1F7A4C", // verde bosque
    reservado:  "#7A5F12", // dorado más profundo (mejor legibilidad en filas)
    vendido:    "#8C262D", // rojo vino
    bloqueado:  "#5A5E66", // gris grafito
  },
  fonts: {
    title:    "Montserrat-Bold", // embebida (src/documents/fonts/)
    body:     "Helvetica",        // built-in; mantiene m² nítido
    bodyBold: "Helvetica-Bold",
  },
  layout: {
    bandTop:             true,           // banda arriba (bandHeight px)
    bandBottom:          true,           // banda abajo (bandHeight px)
    bandHeight:          8,              // banda gruesa — igualada arriba y abajo
    bandColor:           "#ED1C29",
    headerStyle:         "white",        // fondo blanco + título oscuro
    headerHeight:        100,            // 100px para acomodar mapa de 90
    mapKey:              "def2_prado3",  // public/logos/def2_prado3.png
    mapDiameter:         90,
    logoWidth:           200,            // logo más grande (era 150)
    logoHeight:          70,             // alto del fit del logo
    address:             "Santo Domingo · Ensanche Paraíso / Calle Francisco Carías Lavander",
    donutPctVentas:      true,           // reemplaza la cell "% Ventas"
    progressBarsByGroup: true,           // barra horizontal en la tabla resumen por piso
    footerStyle:         "dark",         // fondo oscuro + texto blanco
    cardStyle:           "elegant",      // cards blancas + borde + barra lateral + número en color
    rowStyle:            "white-with-bar", // filas blancas + barra lateral 3px del color de estado
  },
};

// Hermano corporativo de PR3 — mismo accent rojo, headerBg un toque más
// marcado, "IV" del título en rojo.
const PR4_THEME = {
  palette: { ...PR3_THEME.palette, headerBg: "#E4E6EA" },
  statusColors: PR3_THEME.statusColors,
  fonts: PR3_THEME.fonts,
  layout: {
    ...PR3_THEME.layout,
    mapKey: "def2_prado4",
    address: "Santo Domingo · Sector Evaristo Morales",
    titleHighlightWord: "IV", // últ. palabra del título en accent
  },
};

// Turquesa premium — CRUX_T6 y CRUX_LISTOS comparten theme.
const CRUX_THEME = {
  palette: {
    ...PR3_THEME.palette,
    headerBg:  "#E6F1F1",          // verde agua notable
    accent:    "#1FAFB5",          // turquesa de marca CRUX
    pctAccent: "#1FAFB5",          // donut % Ventas en turquesa
  },
  statusColors: PR3_THEME.statusColors,
  fonts: PR3_THEME.fonts,
  layout: {
    ...PR3_THEME.layout,
    mapKey:     "FINAL_crux",
    address:    "Santo Domingo Norte · Colinas del Arroyo II",
    bandColor:  ["#7CB342", "#1FAFB5", "#1565C0"], // array = gradient verde→turquesa→azul
  },
};

// Turquesa playero — PSE3 y PSE4 comparten theme.
const PSE_THEME = {
  palette: {
    ...PR3_THEME.palette,
    headerBg:  "#F5EEE0",          // arena notable
    accent:    "#1E91A4",          // turquesa playero
    pctAccent: "#1E91A4",
  },
  statusColors: PR3_THEME.statusColors,
  fonts: PR3_THEME.fonts,
  layout: {
    ...PR3_THEME.layout,
    mapKey:    "FINAL_pradosuites",
    address:   "Puerto Plata · Sector Muñoz / Av. Manuel Tavárez Justo",
    bandColor: "#1E91A4",          // banda turquesa sólida
  },
};

const PROJECT_THEMES = {
  pr3:         PR3_THEME,
  pr4:         PR4_THEME,
  pse3:        PSE_THEME,
  pse4:        PSE_THEME,
  crux_t6:     CRUX_THEME,
  crux_listos: CRUX_THEME,
};

function getTheme(proyectoId) {
  return PROJECT_THEMES[proyectoId] || _CORE;
}

module.exports = { PROJECT_THEMES, getTheme };
