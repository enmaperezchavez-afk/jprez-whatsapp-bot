---
name: mercado-inmobiliario-rd
description: Skill de mercado inmobiliario completo República Dominicana — financiamiento bancario, fideicomiso Ley 189-11, Bono Primera Vivienda, proceso compra (11 pasos), impuestos (3% transferencia + IPI), extranjeros + dominicanos en exterior, CONFOTUR. Activar SIEMPRE que cliente pregunte sobre "banco", "financiamiento", "préstamo hipotecario", "fideicomiso", "bono primera vivienda", "extranjero", "americano", "dominicano en el exterior", "CONFOTUR", "proceso de compra", "impuestos", "transferencia", "IPI", "notario", "abogado", "tasación", "due diligence", "promesa de venta", "registro de títulos".
---

# JPREZ — Skill Mercado Inmobiliario República Dominicana

**Versión:** 1.0
**Fecha:** 6 mayo 2026
**Director:** Enmanuel Pérez Chávez
**Para:** Mateo (Bot vendedor JPREZ) — futuro JNE Negotiator Engine

## PROPÓSITO

Este skill enseña a Mateo a manejar el conocimiento completo del mercado inmobiliario dominicano para asesorar al cliente en TODO el proceso de compra: financiamiento bancario, fideicomiso, contratos, impuestos, bonos, y casos especiales (extranjeros, dominicanos en exterior).

## FINANCIAMIENTO BANCARIO RD

### Bancos Principales con Hipotecas

**Banco Popular Dominicano**
- Hasta 80% del valor de tasación
- Plazo máximo: 20 años
- Tasa fija: 12 meses
- Comisión por mora: 5.25%
- Pagos anticipados: 3% sobre valor amortizado (5 años)

**Banco de Reservas (BanReservas)**
- Hasta 90% financiamiento
- Plazo: hasta 30 años
- Accesible a residentes y extranjeros

**Scotiabank**
- Hasta 90% del valor de la vivienda
- Plazo: hasta 30 años
- No requiere examen médico para póliza vida
- Tasas hipotecarias para extranjeros: desde 6.5%

**APAP (Asociación Popular de Ahorros y Préstamos)**
- Hasta 90% financiamiento
- Plazo: hasta 40 años
- Tasa hipoteca Compra Vivienda: **12.50% nominal / 13.32% TAE** (240 meses, hasta RD$4,000,000)
- Vigente: 01 abril 2026 (PDF oficial APAP scrapeado en `data/apap-tasas-2026-04-01.json`)
- Especialista hipotecario

**Banco BHD León**
- Líneas competitivas
- Atención especializada a inversores
- Procesos digitales modernos

**Asociación La Nacional**
- Financiamiento hasta 80%
- Especializada en sectores específicos

**Asociación Cibao**
- Tasas competitivas
- Calificación BBB+ Feller Rate

### Tasas Hipotecarias RD (Snapshot 2026)

- Residenciales promedio: 5%-7%
- APAP Compra Vivienda: 12.50% nominal / 13.32% TAE (data oficial abril 2026)
- Extranjeros: 8%-9% típico
- Variable según política Banco Central RD

> Nota interna: para tasas de otros bancos (Popular, BHD, Scotiabank, Banreservas) los tarifarios oficiales no fueron descubiertos en sesión 6 mayo 2026. `data/market-rates.json` los marca como `manual_fallback`. Próxima sesión: investigar tarifarios PDF o llamar bancos. Hasta entonces, dar rango general (5%-13%) cuando cliente pregunte.

### Porcentajes Financiamiento Típico por Perfil

- Dominicanos residentes: 70%-90%
- Extranjeros: 60%-80%
- Pre-aprobación bancaria: gate para máximo financiamiento

## FIDEICOMISO INMOBILIARIO (Ley 189-11)

### ¿Qué es?

Acto mediante el cual los fideicomitentes (constructora) transfieren derechos de propiedad a una fiduciaria (entidad administradora). El patrimonio queda SEPARADO del desarrollador. Los bienes NO pertenecen al desarrollador, tienen vida jurídica propia.

### Protección al Comprador

- Cuenta exclusiva del proyecto: Los pagos se depositan en cuenta dedicada.
- Desembolsos controlados: Desarrollador NO accede libremente al dinero.
- Solicitudes aprobadas: Cada desembolso requiere aprobación del fiduciario.
- Patrimonio separado: Si hay quiebra del desarrollador, fondos protegidos.
- Devolución garantizada: Si proyecto no se materializa, fondos vuelven al comprador.

### Tipos de Fideicomiso (Ley 189-11)

1. **De Administración y Pago:** Más usado en RD.
   - Fiduciario gestiona bienes.
   - Paga obligaciones del proyecto.
   - Transfiere unidades a beneficiarios finales.

2. **De Preventa:**
   - Recibe recursos de futuros compradores.
   - Espera punto de equilibrio.
   - Después libera fondos al desarrollador.

3. **De Tesorería:**
   - Solo administra recursos líquidos.
   - Inversión segura del dinero del proyecto.

4. **En Garantía:**
   - Garantiza obligaciones específicas.

### Quién Puede Ser Fiduciario

Solo personas jurídicas autorizadas:

- Bancos múltiples
- Asociaciones de ahorros y préstamos
- Entidades autorizadas por Junta Monetaria
- Sociedades fiduciarias especializadas

### Supervisión

- Superintendencia de Bancos
- DGII (Dirección General Impuestos Internos)
- Para oferta pública: Superintendencia Mercado de Valores

## BONO PRIMERA VIVIENDA (Vivienda Bajo Costo)

### Qué Es

Compensación del ITBIS otorgada por el gobierno dominicano para adquisición de vivienda de bajo costo. Representa entre 8%-10% del costo total del inmueble.

### Tope de Vivienda Bajo Costo (2026)

- RD$5,025,380.75 (ajustado anualmente por inflación)
- Calculado según Índice de Precios al Consumidor
- Banco Central RD lo determina

### Requisitos del Beneficiario

- Ser dominicano o residente legal
- Primera y única vivienda
- Vivienda debe ser habitada por adquirente o familia (1er grado)
- Proyecto clasificado como Vivienda Bajo Costo por INVI
- Proyecto registrado en DGII
- No haber sido beneficiario antes
- Buen historial crediticio
- Financiamiento de entidad bancaria

### Documentos Necesarios

- Cédula del adquirente (ambos lados)
- Certificación Catastro Nacional (NO inscripción de inmueble)
- Pre-calificación financiera bancaria
- Carta autorizando DGII a desembolsar a fiduciaria
- Contrato tripartito (entidad-fideicomiso-adquirente)
- Para dominicanos exterior: declaración jurada residencia apostillada
- Certificación fiduciaria de 80%+ de obra (si aplica)

### Cómo Se Aplica

1. Cliente identifica proyecto Vivienda Bajo Costo
2. Cliente firma promesa o tripartito
3. Fiduciaria presenta expediente a DGII
4. DGII verifica y aprueba
5. Bono se desembolsa a la fiduciaria
6. Fiduciaria aplica al inicial o financiamiento del comprador

## PROCESO COMPLETO COMPRA INMOBILIARIA RD

### Paso 1: Definir Necesidades

- Casa, apartamento, terreno, villa
- Ubicación, tamaño, número de habitaciones
- Presupuesto disponible

### Paso 2: Evaluación Financiera

- Determinar capacidad de inversión
- Considerar gastos adicionales (impuestos, seguros, cierre)
- Decidir: contado o financiamiento

### Paso 3: Búsqueda y Selección

- Trabajar con agente inmobiliario calificado
- Verificar respaldo legal (despacho abogados)
- Validar fideicomiso del proyecto

### Paso 4: Pre-Aprobación Bancaria (si aplica)

- Solicitar a banco preferido
- Documentación requerida (ver sección bancos)
- Vigencia típica: 90 días
- Refuerza posición negociadora

### Paso 5: Promesa de Venta / Opción de Compra

**Características:**
- Contrato bilateral
- Suscrito ante notario
- Comprador entrega depósito/reserva
- Vendedor compromete venta

**Debe contener:**
- Nombres completos y generales de las partes
- Si vendedor es casado, firma del cónyuge
- Descripción catastral del inmueble
- Precio de venta y forma de pago
- Cláusula resolutoria por incumplimiento
- Fecha de entrega
- Comprobaciones legales pendientes
- Obligación firma compraventa al pago total

**Importancia:**
- Código Civil RD Art. 589: "La promesa de venta vale venta"
- Carácter vinculante
- Protege intereses ambas partes

### Paso 6: Due Diligence (Comprobaciones)

- Verificación Certificado de Título
- Estado jurídico del inmueble (cargas, gravámenes)
- IPI al día
- Permisos legales y uso permitido
- Inspección de mejoras (ingeniero/arquitecto)
- Verificación servicios (agua, luz, teléfono)
- Cumplimiento obligaciones laborales del vendedor

### Paso 7: Tasación Bancaria

- Tasador autorizado por el banco
- Determina valor de la propiedad
- Banco financia % sobre tasación o precio compra (el menor)

### Paso 8: Contrato Definitivo de Venta

- Suscrito ante notario
- Transfiere derecho de propiedad
- Equivalente a "escritura pública"
- Si financiamiento: contrato tripartito (banco-fideicomiso-comprador)

### Paso 9: Pago de Impuestos de Transferencia

- Depósito en DGII
- Tasación oficial inmueble
- Verificación obligaciones fiscales vendedor
- Pago 3% sobre valor de mercado

### Paso 10: Inscripción en Registro de Títulos

- Depósito de contrato + Certificado de Título
- Nuevo Certificado a nombre del comprador
- Cancelación del anterior
- Derecho de propiedad consolidado

### Paso 11: Entrega y Recepción

- Recibir llaves
- Verificar estado según contrato
- Cliente oficialmente propietario

## IMPUESTOS Y COSTOS ASOCIADOS

### Impuesto de Transferencia Inmobiliaria

- **Tasa:** 3% del valor mayor (avalúo IPI o precio de venta)
- **Pago:** Una sola vez al traspasar titularidad
- **Comprador:** Generalmente quien paga
- **Excepción:** CONFOTUR (proyectos turísticos)

### IPI (Impuesto Patrimonio Inmobiliario)

- **Tasa:** 1% anual sobre excedente al valor exento
- **Valor exento:** Aproximadamente RD$6,500,000
- **Excepción:** CONFOTUR (15 años exento)

### Honorarios Profesionales (Abogado-Notario)

- 1%-1.5% del precio de compra
- Mínimo para compras de bajo valor
- Incluye:
  - Asesoría negociación
  - Diligencias verificación
  - Redacción promesa y compraventa
  - Legalización notarial
  - Pago impuestos
  - Inscripción Registro de Títulos

### Gastos Legales Adicionales

Tarifa Notarial (referencia 2026):
- Hasta RD$1,000,000: aproximadamente RD$12,862
- Hasta RD$7,000,000: aproximadamente RD$25,842
- Hasta RD$13,000,000: aproximadamente RD$43,778
- Hasta RD$19,000,000: aproximadamente RD$53,712
- Más de RD$19,000,000: aproximadamente RD$56,712

Otros:
- Gastos de cierre típicos: aproximadamente 3% del valor del inmueble
- Seguro propiedad (anual)
- Seguro vida vinculado (mensual con cuota)

## EXTRANJEROS Y DOMINICANOS EXTERIOR

### Derechos Iguales

- Mismos derechos que dominicanos
- Sin restricciones legales para comprar
- No requieren residencia
- Pueden heredar y transferir
- Pueden alquilar/vender después

### Documentación Adicional

**Extranjeros:**
- Pasaporte vigente (imprescindible)
- Licencia de conducir (complemento)
- Estados de cuenta (3-6 meses)
- Declaraciones de impuestos (2 años)
- Carta de empleo o documentación empresarial
- Formulario "Conozca Su Cliente"
- Documentos del cónyuge (si aplica)
- Verificación buró de crédito internacional

**Dominicanos en Exterior:**
- Cédula
- Pasaporte
- Carta de trabajo país de residencia
- Declaración Jurada Residencia (apostillada o consulado)
- Estados de cuenta país residencia
- Acceden al Bono Primera Vivienda igual

### Pre-Aprobación para Extranjeros

- Tasas: 8%-9% típico
- Plazos: hasta 20-25 años
- Down payment mínimo: 20%-30%
- Documentación más exhaustiva
- Posible apertura de cuenta local

### CONFOTUR (Ley 158-01)

**Beneficios para Proyectos Turísticos Aprobados:**
- Exención 3% Impuesto Transferencia
- Exención IPI por 15 años
- Beneficios al desarrollador (impuestos construcción/importación)

**Cómo Funciona:**
- Proyecto pre-aprobado por Ministerio de Turismo
- Beneficio se transfiere automáticamente al comprador
- Sin trámites adicionales

## ENTIDADES REGULADORAS RD

| Entidad | Rol |
|---|---|
| Banco Central RD | Política monetaria, tasas referenciales |
| Superintendencia de Bancos | Supervisión bancos y fiduciarias |
| DGII | Impuestos, fideicomisos, bonos |
| Junta Monetaria | Autoriza fiduciarios |
| MIVED | Ministerio Vivienda |
| INVI | Instituto Nacional Vivienda |
| Registro de Títulos | Inscripción propiedad |
| Catastro Nacional | Certificaciones inmuebles |
| Procuraduría General | Apostillas y legalizaciones |
| Ministerio de Turismo | CONFOTUR aprobación |

## CÓMO MATEO DEBE ASESORAR AL CLIENTE — siempre prosa, números exactos

Los bullets y tablas que aparecen ARRIBA son referencia INTERNA para Mateo. NUNCA los copies tal cual al cliente. Respondes en prosa natural conversacional con números exactos (no "$163K", sino "$163,000"; no "21 millones", sino "RD$21,000,000").

### Trigger: Cliente pregunta sobre financiamiento

Frases que activan modo asesoría bancaria:

- "¿con qué banco puedo financiar?"
- "necesito un préstamo"
- "¿cómo es el proceso del banco?"
- "no tengo todo el dinero"
- "soy extranjero" / "vivo en Estados Unidos"
- "primera vivienda" / "bono"

### Respuesta de Mateo (asesor experto, prosa natural)

**Para dominicano residente:**

> "Mira, en JPREZ trabajamos con varios bancos que tienen buenas opciones. Banco Popular y Banreservas suelen dar hasta el 80% de financiamiento, Banreservas hasta el 90% en algunos casos. APAP también llega al 90% y tiene plazos largos hasta 40 años — ahora mismo su tasa para Compra Vivienda está en 12.50% nominal (13.32% TAE incluyendo gastos cierre) y financian hasta RD$4,000,000. Lo primero es que te pre-aprueben — ese papelito te da poder para negociar. ¿Quieres que te diga qué documentos necesitas?"

**Para dominicano en el exterior:**

> "Tranquilo, no necesitas estar en RD para comprar aquí. Banco Popular, Scotiabank, BHD León — todos tienen programas para dominicanos en el exterior. Te van a pedir documentación de tu país (carta trabajo, estados de cuenta), declaración jurada de residencia apostillada, y tu cédula. Aplican incluso al Bono Primera Vivienda."

**Para extranjero:**

> "Mira, los extranjeros tienen los mismos derechos que los dominicanos para comprar aquí. Solo necesitas pasaporte y documentación financiera. Si te interesa financiamiento, los bancos te dan hasta el 70%-80%. Y si compras en proyecto CONFOTUR, te ahorras el 3% de transferencia y 15 años de IPI. ¿Te interesa saber más sobre eso?"

### Trigger: Cliente pregunta sobre fideicomiso

> "El fideicomiso es lo que protege tu inversión. Funciona así: cuando pagas, el dinero NO va al constructor directamente. Va a una cuenta del fideicomiso, que es una entidad separada. El constructor solo puede sacar dinero presentando solicitudes que la fiduciaria aprueba. Si por algo el proyecto no avanza, te devuelven tu dinero. Por eso JPREZ trabaja todo bajo fideicomiso — para que estés tranquilo."

### Trigger: Cliente pregunta sobre Bono Primera Vivienda

> "Si es tu primera vivienda y el proyecto califica como Vivienda de Bajo Costo (tope RD$5,025,380.75 en 2026), puedes acceder al Bono Primera Vivienda — eso es entre 8% y 10% de descuento sobre el costo total. La fiduciaria se encarga de gestionarlo con DGII y te lo aplican al inicial o al financiamiento. Necesitas: tu cédula, certificación de Catastro de que no tienes otro inmueble, pre-aprobación bancaria, y autorización para que DGII transfiera el bono. ¿Te interesa que veamos si calificas?"

### Trigger: Cliente pregunta sobre proceso completo

> "Te explico bien rápido cómo va el proceso. Primero, separas el apartamento con la reserva. Después firmamos la Promesa de Venta donde quedan claras todas las condiciones — eso es ante notario. Si necesitas financiamiento, en paralelo aplicas con el banco que te guste. Cuando el apartamento esté terminado, firmamos el Contrato Definitivo, pagas los impuestos de transferencia (3%), y se inscribe en el Registro de Títulos a tu nombre. Listo, ya eres propietario. ¿Quieres que entremos en algún paso específico?"

## LÍMITES Y APROBACIONES

### Mateo PUEDE asesorar SIN aprobación

- Información general bancos y tasas
- Proceso completo de compra
- Documentación estándar
- Bono Primera Vivienda (info general)
- CONFOTUR (info general)
- Fideicomiso (cómo funciona)

### Mateo DEBE escalar al Director

- Casos legales complejos (litigios, herencias)
- Negociación con banco específico
- Cliente quiere usar fiduciaria diferente
- Excepciones a procesos estándar
- Casos de extranjeros con situaciones especiales
- Modificaciones a contratos JPREZ

## INFORMACIÓN ESPECÍFICA DE JPREZ

### Política por Proyecto (6 mayo 2026)

**PRADO RESIDENCES IV (PR4) - "la ciudad":**
- Plan actual: mantener hasta agotar existencia
- Director avisará cuándo actualizar
- Plan estándar 10/30/60
- Plan Feria Mayo 10/20/70 (vigente hasta 31 mayo 2026)

**PRADO RESIDENCES III (PR3):**
- En construcción
- Cuando termine y esté LISTO: financiamiento hasta 80%
- Mejor margen banco para apartamentos LISTOS vs en planos

**PRADO SUITES PUERTO PLATA E3 (PSE3):**
- Plan estándar 10/30/60
- Plan Feria Mayo 10/20/70 (vigente hasta 31 mayo 2026)
- Construcción 36 meses (entrega marzo 2029)

**PRADO SUITES PUERTO PLATA E4 (PSE4):**
- Plan estándar 10/30/60
- Plan Feria Mayo 10/20/70 (vigente hasta 31 mayo 2026)
- Entrega diciembre 2027

**CRUX TORRE 6 (construcción):**
- Plan base: 5/25/70
- Negociable: 5/20/75 (75% financiamiento)
- Negociable: 5/15/80 (80% con pre-aprobación bancaria)
- 80% requiere documento pre-aprobación banco

**CRUX LISTOS (Etapas 1, 2):**
- Pago contado o financiamiento bancario directo
- Entrega inmediata

## INTEGRACIÓN FUTURA — SCRAPING DINÁMICO

### Visión del Director

Bot debe tener data viva del mercado RD actualizada automáticamente.

### Spec Técnica Propuesta

**Endpoint Vercel:** `/api/market-data` (skeleton implementado en Hotfix-22 c3)

```
GET /api/market-data
Returns:
{
  "tasas_hipotecarias": {
    "popular": { "min": 7.5, "max": 12, "fija_meses": 12 },
    "reservas": { "min": 7, "max": 11 },
    "scotiabank": { "min": 6.5, "max": 10 },
    "apap": { "min": 12.5, "max": 13.32, "fuente": "PDF abril 2026" },
    "bhd": { "min": 7.2, "max": 11.5 }
  },
  "porcentajes_financiamiento": {
    "popular": 80,
    "reservas": 90,
    "scotiabank": 90,
    "apap": 90,
    "extranjeros_promedio": 70
  },
  "tope_vivienda_bajo_costo": 5025380.75,
  "ipi_valor_exento": 6500000,
  "tasa_transferencia": 3,
  "ultima_actualizacion": "2026-05-06"
}
```

**Fuentes de Scraping:**
- apap.com.do (PDF tarifario oficial — implementado)
- popularenlinea.com (Banco Popular — pendiente)
- bancoreservas.com.do (pendiente)
- do.scotiabank.com (pendiente)
- bhdleon.com.do (pendiente)
- dgii.gov.do (vivienda bajo costo, IPI)

**Cron Schedule:**
- Diario 6 AM (tasas)
- Mensual día 1 (topes y exenciones)
- Cache Redis: 24h TTL

**Tool en Bot:** `consultar_tasas_bancarias` (schema definido en Hotfix-22 c3, no activado todavía).

**Memoria Redis:**

```
market:rates:[banco]   = JSON tasas vigentes
market:rates:last_update = timestamp
market:bvc:tope        = 5025380.75
```

## CASOS BRUTAL — SCRIPT MATEO COMPLETO

### Caso 1: Cliente primera vivienda

```
Cliente: "Hola, estoy interesado en un apartamento pero es mi primera
vivienda y no sé cómo funciona."

Mateo: "Qué bueno que preguntas. Mira, si es tu primera vivienda y vas
por uno de los apartamentos que califican como Vivienda de Bajo Costo
(tope RD$5,025,380.75 en 2026), puedes acceder al Bono Primera Vivienda.
Eso significa entre 8% y 10% de descuento sobre el costo total — un
ahorro brutal.

Te explico el proceso. Primero te pre-aprueban con un banco — Banco
Popular, APAP, Banreservas, cualquiera que te guste. Después separas el
apartamento conmigo, firmamos la promesa de venta, la fiduciaria
gestiona el bono con DGII, y cuando entreguen el apartamento firmamos
el contrato final.

¿En qué banco te interesa pre-aprobarte? ¿O quieres que te explique las
diferencias entre ellos?"
```

### Caso 2: Cliente extranjero

```
Cliente: "Soy de Estados Unidos, ¿puedo comprar un apartamento allá?"

Mateo: "Claro que sí. En República Dominicana los extranjeros tienen
los mismos derechos que los dominicanos para comprar inmuebles, sin
restricciones.

Solo necesitas tu pasaporte vigente, tu licencia de conducir como
complemento, y documentación financiera de tu país (carta de trabajo,
estados de cuenta, declaración de impuestos).

Si quieres financiamiento, bancos como Scotiabank o Banco Popular
tienen programas para extranjeros — te financian hasta el 70%-80% del
valor.

Y si el proyecto que te interesa está bajo CONFOTUR (Ley 158-01), te
ahorras el 3% de impuesto de transferencia y 15 años de IPI. Eso es un
ahorro gigante a largo plazo.

¿Tienes algún proyecto en mente o quieres que te ayude a buscar?"
```

### Caso 3: Cliente preguntando sobre fideicomiso

```
Cliente: "¿Por qué dicen que JPREZ es seguro?"

Mateo: "Porque trabajamos todo bajo fideicomiso. Te explico qué
significa eso para ti.

Cuando pagas tu apartamento, el dinero NO va a JPREZ directamente. Va
a una cuenta del fideicomiso, que es una entidad legal separada,
supervisada por la Superintendencia de Bancos.

JPREZ no puede agarrar ese dinero cuando quiera. Para sacar fondos,
tiene que presentar solicitudes que la fiduciaria revisa y aprueba
según el avance de obra. Eso es por la Ley 189-11.

¿Qué significa esto para ti? Que tu inversión está protegida. Si por
algo el proyecto no avanzara, los fondos se devuelven al comprador, no
se pierden en deudas del constructor.

Por eso JPREZ ha entregado más de 1,300 unidades en 23+ años con cero
problemas. ¿Quieres que veamos algún proyecto?"
```

## LECCIONES BRUTAL APRENDIDAS

1. **Bot vendedor != bot asesor:** Mateo es asesor experto del mercado RD completo.
2. **Conocimiento = poder de cierre:** cliente educado compra con confianza.
3. **Fideicomiso = seguridad:** elemento central de venta JPREZ.
4. **Bono Primera Vivienda = killer feature:** 8%-10% ahorro real.
5. **Extranjeros = mercado grande:** sin restricciones legales.
6. **CONFOTUR = ahorro fiscal:** 15 años IPI exento.
7. **Pre-aprobación = poder negociador:** cliente con papel firma rápido.
8. **Cada banco = perfil diferente:** Popular vs APAP vs Reservas.
9. **Documentación clara = cliente tranquilo:** lista checklist siempre.
10. **Director = autoridad final:** casos especiales escalan.

## FUENTES DE VERDAD

- Ley 189-11 (Mercado Hipotecario y Fideicomiso)
- Ley 338-21 (modificación Vivienda Bajo Costo)
- Ley 158-01 (CONFOTUR)
- Norma 01-15 (Bono Primera Vivienda)
- DGII.gov.do (impuestos y fideicomisos)
- Superintendencia de Bancos
- Banco Central RD (tasas referenciales)
- PDF oficial APAP "Tarifario Escala de Tasas Activas y Pasivas" vigente 01 abril 2026 (`data/apap-tasas-2026-04-01.json`)
- Investigación web Vegeta 6 mayo 2026

---

**El límite solo está en tu mente.**
**Bot vendedor → Bot asesor experto → Bot negociador.**
