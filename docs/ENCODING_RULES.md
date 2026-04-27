# Reglas de Encoding del Repositorio

> Este documento existe porque el commit `527a90d` (17 abril 2026, 12:15 AM)
> introdujo 21 mojibakes en una sola edición, causando bugs UX hasta el
> Hotfix-8 (27 abril 2026). NO debe volver a pasar.

---

## Las 4 Reglas Ninja

### Regla #1 — NUNCA editar archivos con texto en español en el GitHub web editor

El editor web de GitHub puede aplicar encoding raro al guardar copy/paste. Siempre:

1. Clonar el repo localmente.
2. Editar con VS Code (o el editor de tu preferencia) configurado en UTF-8.
3. `git commit` + `git push` desde terminal.

### Regla #2 — Verificar encoding al copy/paste

Si copias texto con acentos (de ChatGPT, Claude chat, terminal, Word, Excel):

- Verificar que origen **y** destino estén en UTF-8.
- En Windows CMD/PowerShell: `chcp 65001` antes de copiar.
- En VS Code: la barra de estado inferior debe decir **"UTF-8"** (cambiar si dice "Western" o cualquier otro).

### Regla #3 — Pre-commit hook automático

El repositorio tiene un hook (`.husky/pre-commit`) que **aborta commits con mojibake**. Si te bloquea: revisa tu editor — no fuerces el commit con `--no-verify`.

Cómo testearlo manualmente sobre los archivos staged:

```bash
node scripts/check-encoding.mjs
```

Cómo escanear todo el repo (auditoría):

```bash
node scripts/check-encoding.mjs --all
```

> El script está implementado en Node.js (no bash) para portabilidad cross-platform y para compartir el regex con el regression-guard test del Hotfix-8 (commit `d1322d2`, archivo `tests/hotfix8-mojibake.test.mjs`).

### Regla #4 — Normalización en runtime

El código usa `stripAccents()` en `src/detect.js` para detección de intención del cliente. Esto **NO debe quitarse**. Si refactorizas `detect.js`, mantener la normalización — sin ella, los inputs con tildes dejarían de matchear las keywords sin tilde.

---

## Caso Histórico — Commit 527a90d (Paciente Cero)

| Campo | Valor |
|---|---|
| **Fecha** | 17 abril 2026, 12:15 AM |
| **Autor** | enmaperezchavez-afk (vía GitHub web editor) |
| **Mensaje** | `fix: HMAC warning-only mode y corregir isStaff temporal dead zone` |
| **Líneas** | +845 (archivo casi se duplicó) |
| **Daño** | 21 mojibakes en `webhook.js` (después distribuidos en `detect.js`, `notify.js`, `staff.js` durante refactor modular) |

### Mecanismo de la corrupción

Texto UTF-8 fue interpretado como Latin-1, luego re-encodeado como UTF-8. Cada carácter de 2 bytes (UTF-8) tratado como 2 caracteres Latin-1, re-encoded a 4 bytes UTF-8 = mojibake.

Ejemplos (vistos en commit 527a90d):

| UTF-8 limpio | Mojibake |
|---|---|
| `é` | `Ã©` |
| `á` | `Ã¡` |
| `ó` | `Ã³` |
| `ñ` | `Ã±` |
| `í` | `Ã­` |
| `ú` | `Ãº` |
| `🔥` | `ð¥` |
| `⚠️` | `â ï¸` |

---

## Cómo arreglar mojibake si entra al repo

Si el pre-commit hook te aborta, **NO fuerces** con `--no-verify`. En su lugar:

1. Identifica los archivos afectados:
   ```bash
   git diff --cached --name-only
   ```
2. Para cada archivo:
   - Abrir en editor con encoding UTF-8 forzado.
   - Re-escribir las palabras con acentos manualmente.
   - Verificar con `node scripts/check-encoding.mjs`.
3. Si ya commiteaste antes de notar:
   - Revertir o crear un hotfix dedicado de cleanup.
   - Cleanup masivo en un solo commit honesto (modelo Hotfix-8 / commit `d1322d2`).

---

## Para Closer SD multi-tenant

Cuando se haga onboarding de un cliente nuevo a Closer SD:

1. **Auditoría inicial obligatoria:**
   - Escanear todos los prompts/templates del cliente con un equivalente de `check-encoding.mjs`.
   - Detectar mojibake antes del deployment.

2. **Workflow de validación encoding:**
   - Cliente sube prompts vía dashboard (no GitHub web editor).
   - Validación automática server-side (mismo regex, misma lógica).
   - Rechazar uploads con mojibake con mensaje claro y accionable.

3. **Documentación al cliente:**
   - Versión simplificada de este doc en español de negocio.
   - Ejemplos visuales de qué NO hacer.

---

## Defensa de 4 capas — Plan Hokage

| Capa | Implementación | Cuándo dispara |
|---|---|---|
| **1** | `.husky/pre-commit` ejecuta `node scripts/check-encoding.mjs` | Commit local — antes de que el bug entre al repo |
| **2** | `.github/workflows/encoding-check.yml` (CI) ejecuta `--all` | PR/push a main — si alguien commitea con `--no-verify` |
| **3** | `tests/hotfix8-mojibake.test.mjs` — regression-guard en suite | `npm test` y CI test — si pasa los hooks |
| **4** | Esta documentación (`docs/ENCODING_RULES.md`) | Onboarding de nuevos contribuyentes y referencia al fallar el hook |

Las 4 capas son redundantes a propósito — si una falla, las otras tres lo agarran.
