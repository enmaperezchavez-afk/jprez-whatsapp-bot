# MATEO V6 — Diseño CORE/CONFIG (propuesta)

**Estado: PROPUESTA — pendiente de ratificación del Director. Cero ejecución hasta el 🥷.**
Autor: Code · 12 jun 2026 · Se fusiona con el Sprint 2 multi-tenant (Closer SD).

---

## 1. Por qué V6 (el diagnóstico, con evidencia)

1. **El prompt congelado acumula contradicciones que se anulan con parches.**
   MATEO_PROMPT_V5_2 (hash `0b18565e4eb3`, intocable desde Día 2) dice cosas que la
   doctrina ya mató: la Feria de Mayo, "desde US$99K", el plan 10/30/60 para Crux T6.
   Cada corrección es una contra-instrucción en otra capa ("esto ANULA lo que leíste
   arriba"). El LLM recibe señales mezcladas → el drift que mide el certificador
   (baseline 3/11) es en parte estructural, no de reglas faltantes.
2. **OVERRIDES al límite**: 19,998/20,000 chars. No cabe ni una regla más.
3. **La doctrina comercial vive en 9 lugares**: frozen prompt, 4 capas JS, 3 SKILLs,
   constantes de código (`PAYMENT_PLANS`, `DELIVERY_DATES`, `RESERVAS`, themes,
   `BROCHURE_DRIVE_IDS`), snapshot markdown y el Sheet. Cambiar "la reserva de Crux"
   exige grep transversal y rezar.
4. **Tres sistemas de keys de proyecto**: calculadora (`crux/pr3/pr4/puertoPlata`),
   documentos (`crux_t6/crux_listos/pse3/pse4`), tabs del Sheet (`CRUX_TORRE6`...).
   Hay mapeos puente en 3 archivos (`themeIdFor`, `resolveProjectTab`, etapa-infer).
5. **God-handler ~1,900 líneas** (FASE 4 del plan maestro, pendiente desde mayo).
6. **Multitenant hoy = editar ~10 archivos de código por tenant.** Inviable.

## 2. El principio V6

> **CORE 🌐 = el motor, idéntico para todos los tenants.
> CONFIG 🎯 = todo lo que cambia entre tenants, declarativo y validado.
> El prompt NO se escribe: se COMPILA desde CORE + CONFIG.**

### 2.1 TENANT CONFIG (`config/tenants/<id>.json`, validado por schema)

```jsonc
{
  "tenant_id": "jprez",
  "vendedor": { "nombre": "Mateo Reyes", "empresa": "Constructora JPREZ",
                 "tono": "dominicano C+ profesional-cercano", "idiomas": ["es", "en"] },
  "canal": { "phone_number_id": "...", "admin_phones": ["1829..."], "staff": {...} },
  "proyectos": [                       // UNA key canónica por proyecto (mata los 3 sistemas)
    { "key": "crux_t6", "nombre": "Crux del Prado — Torre 6", "ubicacion": "SDN",
      "entrega": "2027-07-01", "en_construccion": true, "moneda": "USD",
      "plan_base": [10,30,60] /* o [5,25,70] — valor del Director */, 
      "margenes": [[10,20,70]], "reserva": 1000,
      "sheet_tab": "CRUX_TORRE6", "theme": "crux_t6", "brochure_drive_id": "..." }
    // pr3, pr4, pse3, pse4, crux_listos...
  ],
  "doctrina": {                        // numerada y TESTEABLE — alimenta prompt Y certificador
    "descuento_autonomo_max": 1500,
    "escalera": { "concesion_inicial": [500, 800], "condicion_primero": true },
    "cubetas": { "A": [...], "B": [...] },
    "reglas_duras": [ { "id": "R4", "texto": "prohibido prometer respuesta futura" }, ... ]
  },
  "integraciones": { "sheet_id": "...", "axiom_dataset": "jprez-bot", "crons": {...} },
  "prompt_version": 1                  // bump = invalidación DELIBERADA de historiales
}
```

- Vive en el **repo** (PR review = audit trail; los VALORES comerciales los ratifica
  solo el Director). Cache compilada en Redis. *(Alternativa Sheet: ver §5.)*
- **Fail-closed de onboarding**: config que no pasa el JSON Schema no arranca.

### 2.2 CORE — los 5 componentes

1. **Prompt compilado**: `compilePrompt(core, tenantConfig)` →
   `IDENTIDAD(core+vendedor) → DOCTRINA(generada de config, numerada, sin contradicciones) →
   INVENTARIO(live) → TOOLS → ESTILO(core)`. Núcleo ≤8K tokens + doctrina compilada ≤4K
   (vs ~32K actual → menos costo, cero arqueología de capas, cero contra-instrucciones).
   **Hash V6 = hash(núcleo_core + config.prompt_version)** — los historiales se invalidan
   solo por bump deliberado, nunca por accidente. El cap de OVERRIDES desaparece.
2. **Tools parametrizadas**: mismos contratos; los enums de proyecto salen de
   `config.proyectos[].key` (una sola key canónica: muere `themeIdFor`/`resolveProjectTab`).
3. **Handler en gates** (cierra FASE 4): el god-handler se descompone en pipeline
   `[resolveTenant → idempotency → testing → extintor/vigía → admin → supervisor → client]`,
   cada gate un módulo con sus tests. `resolveTenant(phone_number_id destino)` es el
   gate 0 del multitenant.
4. **Redis namespaced**: prefijo `t:<tenant_id>:` vía `redis-keys.js` (ya es single source).
5. **Certificador como gate de onboarding**: personas/escenarios CORE + asserts
   **generados de la config** (reserva esperada, fechas, tope, escalera). Un tenant no
   sale a producción sin N/N PASS con SU doctrina — el candado bloqueante por tenant.

## 3. Migración sin big bang (cada fase mergeable y reversible)

| Fase | Qué | Red de seguridad |
|---|---|---|
| F1 | Extraer `config/tenants/jprez.json` del código actual, SIN cambiar comportamiento | Tests de paridad: la config reproduce las constantes actuales 1:1 |
| F2 | `compilePrompt` detrás de flag por tenant | **A/B con el certificador**: V5.2 vs V6 sobre los 11 escenarios — V6 no sale si no iguala o supera |
| F3 | Switch a V6 + retirar capas y contra-instrucciones | Bump deliberado de `prompt_version` (invalidación anunciada), rollback = flag off |
| F4 | Gates del handler (refactor mecánico) | golden-smoke + suite completa como red |
| F5 | Multitenant real: `resolveTenant` + tenant de prueba #2 | Certificador del tenant 2 como gate |

Estimación: F1-F3 ≈ 3-4 días de Code con mediciones; F4-F5 se fusionan con Sprint 2.

## 4. Riesgos y mitigaciones

- **Pérdida de tono/comportamiento al recompilar el prompt** → el A/B del certificador
  es el gate (mismos 11 escenarios, mismo juez) + smoke del Director antes del switch.
- **Invalidación de historiales** → pasa de accidente temido a operación versionada.
- **Prompt caching** → el compilado es estable por tenant+versión: cachea igual o mejor
  (menos tokens = menos costo por cache write).
- **Config como vector de ataque** → schema fail-closed + PR review + los valores
  comerciales solo los cambia el Director.

## 5. Decisiones que pido al Director (ratificar antes de F1)

1. **¿Dónde vive la config?** Recomiendo **repo JSON con PR review** (audit trail,
   versionado, el certificador corre en CI contra ella). Alternativa: tab CONFIG en el
   Sheet (edición sin Git, pero sin review ni CI — puede añadirse DESPUÉS como capa de
   edición que genera el PR).
2. **Keys canónicas de proyecto**: propongo las del Bloque 2
   (`crux_t6, crux_listos, pr3, pr4, pse3, pse4`) — son las de documentos/themes/Sheet.
3. **¿"Mateo Reyes" es CORE o CONFIG?** Recomiendo CONFIG: cada tenant del Closer SD
   tendrá su vendedor con su nombre y tono; el CORE define el *carácter de vendedor
   excelente*, no la identidad.
4. **Plan base de Crux T6 en la config**: el código dice 10/30/60, la doctrina v1.1
   dice 5/25/70 — discrepancia ABIERTA detectada en el audit del Sprint 1.5. La config
   V6 obliga a zanjarla: un solo número, ratificado por usted.
