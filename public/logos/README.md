# Logos de proyectos para el PDF de listado de precios

El generador (`src/documents/price-list-generator.js`, Fix 4 Hotfix-51) busca
el logo de cada proyecto en esta carpeta y lo embebe arriba a la derecha del
header del PDF. **Si el archivo no existe, usa un wordmark de texto** (no falla).

Para activar los logos, coloca los PNG (o JPG) con estos nombres exactos:

| Archivo               | Proyectos que lo usan      |
|-----------------------|----------------------------|
| `prado3.png`          | pr3                        |
| `prado4.png`          | pr4                        |
| `pradosuites.png`     | pse3, pse4                 |
| `crux.png`            | crux_t6, crux_listos       |

Recomendaciones:
- PNG con fondo transparente, ~150×46 px (se escala con `fit: [150, 46]`).
- Peso ligero (~50 KB). Extensiones aceptadas: `.png`, `.jpg`, `.jpeg`.

Los archivos se bundlean en la función serverless vía `includeFiles`
(`public/logos/**` en `vercel.json`). Tras subir los PNG y desplegar, los
logos aparecen automáticamente — sin cambios de código.
