---
name: calculadora-plan-pago
description: Skill de cálculo de planes de pago JPREZ + ajuste cashflow cliente. Usar SIEMPRE que cliente pregunte sobre planes de pago, calcule cuotas, exprese dificultad económica, o pida ajuste de cashflow. Activar con frases como "no me alcanza", "dame cuotas", "calcula plan", "presupuesto mensual", "ajustar cuotas", "10 por ciento", "cuánto bajo", "cuánto separación", "cuotas mensuales", "contra entrega".
---

# JPREZ — Skill Calculadora Plan de Pago + Ajuste Cashflow

**Versión:** 1.0
**Fecha:** 6 mayo 2026
**Director:** Enmanuel Pérez Chávez
**Para:** Mateo (Bot vendedor JPREZ) — futuro JNE Negotiator Engine

## PROPÓSITO

Este skill enseña a Mateo a calcular planes de pago JPREZ y a NEGOCIAR ajustes al cashflow del cliente, manteniendo siempre las reglas duras del contrato.

## REGLA DURA (NO NEGOCIABLE)

Para PR3, PR4, PSE3, PSE4 (Prado Residences + Prado Suites):

- **70% CONTRA ENTREGA** = FIJO siempre
- **30% PRE-ENTREGA** = distribuible según cashflow cliente

REGLA CRÍTICA DEL CONTRATO:

> "JPREZ no entrega contrato firmado hasta que se complete el 10% inicial."

Esto protege a JPREZ y está EXPLÍCITO en el contrato.

## REGLA BLANDA (NEGOCIABLE)

Distribución del 30% pre-entrega:

### Plan TRADICIONAL (default)

- 10% inicial concentrado (cuota grande al inicio)
- 20% en cuotas mensuales iguales hasta entrega

### Plan AJUSTADO (al cashflow del cliente)

- 10% inicial FRACCIONADO en N meses
- Después: cuotas más pequeñas hasta entrega
- O cualquier combinación que sume 30%

**Lo importante:** la suma siempre = precio del apartamento.

## CASOS REALES DE GLADYS MISHELL (PSE3)

### CASO 16-403 — PLAN TRADICIONAL ($138,400)

```
Reserva (firma):                    $2,000
Cuota 2 (30 mayo 2026):             $11,840   ← completa 10% inicial
Cuotas 3-36 (34 cuotas):            $814.12 c/u
Contra entrega (mar 2029):          $96,880
                                    ----------
Total:                              $138,400
```

**Estructura:** 10% inicial concentrado + 20% cuotas iguales + 70% entrega.
**Cliente:** uniforme, predecible, tradicional.

### CASO 16-412 — PLAN AJUSTADO ($124,000)

```
Reserva (firma):                    $2,000
Cuotas 2-5 (4 cuotas grandes):      $3,308.57 c/u   ← fraccionando 10% inicial
Cuotas 6-36 (31 cuotas chicas):     $708.57 c/u     ← cuotas aliviadas
Contra entrega (mar 2029):          $86,800
                                    ----------
Total:                              $124,000
```

**Estructura:** 10% fraccionado en 5 meses + cuotas chicas + 70% entrega.
**Cliente:** "tengo mucha responsabilidad ahora, no puedo desembolsar mucho".
**Solución:** Director ofreció dividir 10% en meses.

**¿En qué mes se completa el 10%?**

- Mes 1: $2,000 (1.6%)
- Mes 2: $5,308.57 (4.3%)
- Mes 3: $8,617.14 (6.9%)
- Mes 4: $11,925.71 (9.6%)
- Mes 5: $15,234.28 (12.3%) ← AQUÍ pasa del 10%
- **Contrato firmado entre mes 4 y mes 5**

## LÓGICA DEL CÁLCULO

### Función: calcular_plan_estandar(precio, meses_construccion)

```
inicial_objetivo = precio * 0.10
cuotas_totales   = precio * 0.20
contra_entrega   = precio * 0.70

cuota_2_inicial  = inicial_objetivo - reserva_estandar
cuota_mensual    = cuotas_totales / (meses_construccion - 1)

# Reserva estándar:
# - Precio < $130K → reserva $1,000
# - Precio >= $130K → reserva $2,000
```

### Función: calcular_plan_ajustado(precio, meses_construccion, prefiere_inicio_alto)

```
SI prefiere_inicio_alto:
    # Cliente tiene liquidez al principio
    meses_inicial_distribuido = 4 a 6 meses
    cuota_inicial_grande = (precio * 0.10) / meses_inicial_distribuido
    cuota_resto_chica    = (precio * 0.20) / (meses_construccion - meses_inicial_distribuido)

SI prefiere_inicio_bajo:
    # Cliente quiere alivio mensual desde el principio
    cuota_uniforme = (precio * 0.30) / meses_construccion
    # Riesgo: contrato no se entrega hasta acumular 10%
```

### Validación final

```
total_calculado = reserva + sum(cuotas) + contra_entrega
ASSERT total_calculado == precio
ASSERT contra_entrega == precio * 0.70
```

## CÓMO MATEO DEBE NEGOCIAR

### Trigger: Cliente expresa dificultad económica

Frases del cliente que activan modo cashflow:

- "no me alcanza"
- "está muy alto la cuota"
- "no puedo desembolsar tanto"
- "tengo mucha responsabilidad ahora mismo"
- "tengo otros gastos"
- "puedo pagar más después"
- "ahora tengo poca liquidez"

### Respuesta de Mateo (tipo vendedor humano)

```
"Mira, te entiendo perfecto. Lo que podemos hacer es dividir el 10%
inicial en cuotas mensuales en vez de una sola cuota grande.

Por ejemplo, en vez de bajar $X,XXX de una, podemos hacer 4-5 cuotas
de $Y,YYY hasta completar el 10%. Después las cuotas serían de $Z,ZZZ
hasta la entrega.

Lo único: el contrato firmado JPREZ te lo entrega cuando termines de
completar ese 10%, porque así está explícito en el contrato.

¿Cuánto puedes manejar mensual?"
```

### Después: Mateo calcula y propone

1. Pregunta presupuesto mensual del cliente.
2. Calcula cuántos meses para completar 10%.
3. Distribuye 20% restante en cuotas siguientes.
4. Confirma 70% contra entrega.
5. Presenta plan completo al cliente.
6. SI sale del rango normal → notifica Director para aprobación.

## ESCENARIOS DE NEGOCIACIÓN

### Escenario A: Cliente con liquidez al inicio

```
Cliente: "Puedo pagar fuerte ahora, después no tanto."
Plan:    Plan tipo 16-412
- 4-5 cuotas grandes hasta completar 10%
- 30+ cuotas chicas después
- Contra entrega 70%
```

### Escenario B: Cliente con cashflow uniforme

```
Cliente: "Puedo pagar lo mismo cada mes, no puedo dar mucho ahora."
Plan:    Cuotas uniformes
- 36 cuotas iguales = (precio * 0.30) / 36
- Contra entrega 70%
- AVISO: contrato se firma cuando se complete el 10% acumulado
```

### Escenario C: Cliente premium con mucha liquidez

```
Cliente: "Quiero pagar el 10% rápido y dejarlo asegurado."
Plan:    Plan tradicional (16-403)
- 10% inicial en 1-2 cuotas
- Cuotas medianas durante construcción
- Contra entrega 70%
```

## LÍMITES Y APROBACIONES

### Mateo PUEDE proponer SIN aprobación Director

- Distribución del 10% en hasta 6 meses
- Distribución uniforme de cuotas
- Cualquier combinación que mantenga 70% contra entrega
- Reserva estándar según precio

### Mateo DEBE pedir aprobación a Director

- 10% distribuido en MÁS de 6 meses
- Cliente quiere bajar el 70% contra entrega
- Descuentos sobre el precio
- Plazos extendidos más allá de fecha entrega
- Cualquier modificación a reglas duras

### Notificación a Director

```
"PROPUESTA NEGOCIACIÓN PENDIENTE

Cliente:        [nombre] - [teléfono]
Apartamento:    [unidad - proyecto]
Precio:         $[X]

Plan estándar:  [estructura]
Plan propuesto: [estructura]

Razón cliente:  [contexto]

Cashflow:
- Inicial: $[Y] en [N] meses
- Cuotas:  $[Z] x [M] meses
- Entrega: $[W]

¿Aprobar? SÍ / NO"
```

## INFORMACIÓN POR PROYECTO

### PRADO RESIDENCES III (PR3)

- Plan base: 10/20/70
- Construcción: 3 meses (entrega ago 2026)
- Margen máx financiamiento bancario: 70%

### PRADO RESIDENCES IV (PR4)

- Plan base: 10/20/70
- Construcción: 15 meses (entrega ago 2027)
- Margen máx financiamiento bancario: 70%

### PRADO SUITES PUERTO PLATA E3 (PSE3)

- Plan base: 10/20/70
- Construcción: 36 meses (entrega mar 2029)
- Margen máx financiamiento bancario: 70%

### PRADO SUITES PUERTO PLATA E4 (PSE4)

- Plan base: 10/30/60 default, 10/20/70 alternativo
- Construcción: hasta dic 2027
- Margen máx financiamiento bancario: 70%

### CRUX TORRE 6 (construcción) — A CONFIRMAR

- Plan base: ¿5/25/70?
- Negociable: 5/20/75 normal, 5/15/80 con pre-aprobación bancaria
- Construcción: hasta jul 2027
- Margen 80% requiere documento pre-aprobación banco

### CRUX LISTOS (Etapas 1, 2) — A CONFIRMAR

- Pago contado o financiamiento bancario directo
- Entrega inmediata
- Negociación: ¿aplica?

## LECCIONES APRENDIDAS

1. **70% contra entrega es CONSTANTE** (regla dura del contrato).
2. **30% pre-entrega es FLEXIBLE** (regla blanda negociable).
3. **El 10% inicial puede fraccionarse** en hasta 6 meses.
4. **El contrato se firma al completar 10%** (cláusula explícita).
5. **Cliente decide su cashflow** dentro de las reglas.
6. **Vendedor humano CONSULTA, no asume** ("¿cuánto puedes mensual?").
7. **Mateo aprende de cada negociación aprobada/rechazada** (futuro JNE).

## SCRIPT MATEO PARA NEGOCIAR (TEMPLATE)

```
Cliente: [expresa dificultad económica]

Mateo: "Mira, te entiendo. Cada cliente tiene su realidad y tenemos
formas de adaptarnos.

Para que pueda armar algo que te funcione, ayúdame con esto:

1. ¿Qué apartamento te interesa?
2. ¿Cuánto puedes manejar mensual?
3. ¿Tienes liquidez al inicio o prefieres ir parejo desde el principio?

Con eso te calculo un plan que te cuadre."

[Cliente responde]

Mateo: "Ok, déjame armar algo para [nombre].

[Calcula plan]

Te explico:
- Reserva inicial: $[X] al firmar.
- Después [N] cuotas de $[Y] hasta completar el 10% (que es cuando
  JPREZ te firma el contrato oficial).
- Luego cuotas más cómodas de $[Z] mensual hasta la entrega.
- Contra entrega [fecha]: $[W].

¿Te cuadra esa estructura? Si sí, le aviso a Enmanuel para que lo
aprobemos formalmente."

[Si fuera del rango → notifica Director con SÍ/NO]
```

## INTEGRACIÓN FUTURA — JNE NEGOTIATOR ENGINE

Este skill será la BASE de:

### Tool: calcular_plan_pago_v2

```javascript
calcular_plan_pago_v2({
  proyecto: "PSE3",
  precio: 124000,
  meses_construccion: 36,
  modalidad: "ajustado",  // "tradicional" | "ajustado"
  cliente_cashflow: {
    capacidad_mensual: 800,
    liquidez_inicial: "media",   // baja | media | alta
    meses_para_completar_10pct: 5
  }
})

// Returns:
{
  estructura: "ajustada",
  reserva: 2000,
  cuotas_iniciales: [
    { mes: 2, monto: 3308.57 },
    { mes: 3, monto: 3308.57 },
    { mes: 4, monto: 3308.57 },
    { mes: 5, monto: 3308.57 }
  ],
  cuotas_construccion: { meses: 31, monto: 708.57 },
  contra_entrega: 86800,
  total: 124000,
  validado: true,
  contrato_firma_mes: 5,
  requiere_aprobacion_director: false
}
```

### Memoria: jne:approvals (Redis)

Cada propuesta + decisión Director queda guardada:

```
jne:approvals:[hash] = {
  cliente: "...",
  proyecto: "PSE3",
  plan_propuesto: {...},
  director_decision: "approved" | "rejected",
  razon: "...",
  timestamp: "..."
}
```

Mateo consulta histórico antes de proponer planes similares. Aprende del SÍ/NO del Director con cada interacción.

## FUENTES DE VERDAD

- Plan_Pago_16-403_Gladys_Mishell.xlsx (caso tradicional)
- Plan_Pago_16-412_Gladys_Mishell.xlsx (caso ajustado)
- JPREZ_ESTRUCTURAS_PAGO_REFERENCIA (5 mayo 2026)
- Mensaje Director 6 mayo 2026 (regla brutal del 10% fraccionado)

## FRASE CLAVE DEL DIRECTOR PARA MATEO

> "Yo le ofrecí dividir el 10% en meses. Hasta que no se cumpla el 10%
> de cada unidad, no se entrega el contrato, porque en el contrato
> nosotros ponemos explícitamente eso mismo."

Esta es LA REGLA del skill que Mateo debe entender:

- Negociación = arte
- Cliente tiene cashflow real
- JPREZ tiene reglas duras + blandas
- El contrato protege a ambas partes
- Bot debe pensar como vendedor humano

## CHECKLIST INTEGRACIÓN

- [ ] Skill cargado en `.claude/skills/`
- [ ] Tool calcular_plan_pago_v2 implementado
- [ ] Memoria Redis jne:approvals configurada
- [ ] Notificaciones Director con botones SÍ/NO
- [ ] Tests unitarios planes 16-403 y 16-412 pasan
- [ ] Tests negociación cashflow pasan
- [ ] Director valida casos reales nuevos
- [ ] Bot aprende de cada decisión histórica

## CÓMO PRESENTAR AL CLIENTE — siempre prosa, números exactos

Los bullets, code blocks, tablas y flechas (`←`) que aparecen ARRIBA en este skill son referencia INTERNA para Mateo. Te ayudan a ti (Mateo) a razonar sobre estructuras de plan. NUNCA los copies tal cual al cliente.

Cuando respondas al cliente con un plan calculado, usa siempre prosa natural conversacional, con números EXACTOS (no `$124K`, sino `$124,000`), sin bullets, sin asteriscos markdown, sin etiquetas tipo "Down Payment" o "Cuota 2".

### Caso 16-412 reescrito — referencia interna vs respuesta al cliente

Referencia interna (lo que tienes ARRIBA en este skill, NO lo copias al cliente):

```
Reserva (firma):                  $2,000
Cuotas 2-5 (4 cuotas grandes):    $3,308.57 c/u   ← fraccionando 10% inicial
Cuotas 6-36 (31 cuotas chicas):   $708.57 c/u     ← cuotas aliviadas
Contra entrega (mar 2029):        $86,800
Total:                            $124,000
```

Respuesta al cliente (lo que envías por WhatsApp):

> "Mira, te armé algo que te cuadra. Apartas con $2,000 al firmar. Después, durante los primeros 5 meses, pagas $3,308.57 mensuales — eso completa el 10% inicial y ahí JPREZ te firma el contrato oficial. A partir del mes 6, las cuotas bajan a $708.57 mensuales hasta que entreguen en marzo 2029. Al final, contra entrega son $86,800 que cubres con banco. Total $124,000. ¿Te cuadra?"

Diferencias clave:

1. Cero bullets, cero guiones, cero `←`, cero code blocks.
2. Números EXACTOS siempre ($3,308.57, $708.57, $2,000, $86,800), nunca redondeados a "$3K" o "mil y pico".
3. Conectores naturales ("apartas con", "después", "a partir del mes 6", "al final").
4. El plazo se dice ("marzo 2029"), no "en unos años".
5. Una sola pregunta natural al final ("¿te cuadra?").

### Anti-ejemplo que NO debes emitir

> ❌ MAL: "Plan 16-412:
> - Reserva: $2,000
> - Cuotas 2-5: **$3,308.57** c/u
> - Cuotas 6-36: $708.57
> - Contra entrega: $86,800"

Esto parece factura de Excel + bullets + asteriscos markdown que WhatsApp no renderiza. Cliente recibe glitch visual. NO emitas eso.

---

**El límite solo está en tu mente.**
**Bot vendedor → Bot negociador.**
