---
name: mercado-inmobiliario-rd
description: Skill de mercado inmobiliario completo República Dominicana — financiamiento bancario, fideicomiso Ley 189-11, Bono Primera Vivienda, proceso compra (11 pasos), impuestos (3% transferencia + IPI), extranjeros + dominicanos en exterior, CONFOTUR. Activar SIEMPRE que cliente pregunte sobre "banco", "financiamiento", "préstamo hipotecario", "fideicomiso", "bono primera vivienda", "extranjero", "americano", "dominicano en el exterior", "CONFOTUR", "proceso de compra", "impuestos", "transferencia", "IPI", "notario", "abogado", "tasación", "due diligence", "promesa de venta", "registro de títulos".
---

# JPREZ — Skill Mercado Inmobiliario República Dominicana

Versión 1.0 · Fecha 6 mayo 2026 · Director Enmanuel Pérez Chávez · Para Mateo (Bot vendedor JPREZ) — futuro JNE Negotiator Engine.

## PROPÓSITO

Este skill enseña a Mateo a manejar el conocimiento completo del mercado inmobiliario dominicano para asesorar al cliente en TODO el proceso de compra: financiamiento bancario, fideicomiso, contratos, impuestos, bonos, y casos especiales (extranjeros, dominicanos en exterior).

Importante de formato: este documento es referencia INTERNA para Mateo. Cuando le respondas al cliente NUNCA copies este formato — siempre prosa natural conversacional con números exactos.

## FINANCIAMIENTO BANCARIO RD

### Bancos Principales con Hipotecas

BANCO POPULAR DOMINICANO. Financia hasta el 80% del valor de tasación. Plazo máximo 20 años. Tasa fija durante los primeros 12 meses. Comisión por mora 5.25%. Pagos anticipados 3% sobre valor amortizado durante los primeros 5 años.

BANCO DE RESERVAS (BanReservas). Financia hasta el 90%. Plazo hasta 30 años. Accesible a residentes y extranjeros.

SCOTIABANK. Financia hasta el 90% del valor de la vivienda. Plazo hasta 30 años. No requiere examen médico para póliza de vida. Tasas hipotecarias para extranjeros desde 6.5%.

APAP (Asociación Popular de Ahorros y Préstamos). Financia hasta el 90%. Plazo hasta 40 años. Tasa hipoteca Compra Vivienda 12.50% nominal / 13.32% TAE (240 meses, hasta RD$4,000,000). Vigente desde 01 abril 2026 (PDF oficial APAP scrapeado en `data/apap-tasas-2026-04-01.json`). Especialista hipotecario.

BANCO BHD LEÓN. Líneas competitivas, atención especializada a inversores y procesos digitales modernos.

ASOCIACIÓN LA NACIONAL. Financiamiento hasta 80%, especializada en sectores específicos.

ASOCIACIÓN CIBAO. Tasas competitivas y calificación BBB+ Feller Rate.

### Tasas Hipotecarias RD (Snapshot 2026)

Las tasas residenciales promedio RD oscilan entre 5% y 7%. APAP Compra Vivienda está en 12.50% nominal / 13.32% TAE (data oficial abril 2026). Para extranjeros las tasas típicas van de 8% a 9%. Todo varía según política del Banco Central RD.

Nota interna: para tasas de otros bancos (Popular, BHD, Scotiabank, Banreservas) los tarifarios oficiales no fueron descubiertos en sesión 6 mayo 2026. `data/market-rates.json` los marca como `manual_fallback`. Próxima sesión: investigar tarifarios PDF o llamar bancos. Hasta entonces, dar rango general (5%-13%) cuando cliente pregunte.

### Porcentajes Financiamiento Típico por Perfil

Dominicanos residentes obtienen entre 70% y 90%. Extranjeros entre 60% y 80%. La pre-aprobación bancaria es el gate para acceder al máximo financiamiento.

## FIDEICOMISO INMOBILIARIO (Ley 189-11)

### Qué es

Acto mediante el cual los fideicomitentes (la constructora) transfieren derechos de propiedad a una fiduciaria (entidad administradora). El patrimonio queda SEPARADO del desarrollador. Los bienes NO pertenecen al desarrollador, tienen vida jurídica propia.

### Protección al Comprador

El fideicomiso protege al comprador con cuenta exclusiva del proyecto (los pagos se depositan en cuenta dedicada), desembolsos controlados (el desarrollador NO accede libremente al dinero), solicitudes aprobadas (cada desembolso requiere aprobación del fiduciario), patrimonio separado (si hay quiebra del desarrollador, los fondos quedan protegidos) y devolución garantizada (si el proyecto no se materializa, los fondos vuelven al comprador).

### Tipos de Fideicomiso (Ley 189-11)

DE ADMINISTRACIÓN Y PAGO. El más usado en RD. El fiduciario gestiona bienes, paga obligaciones del proyecto y transfiere unidades a beneficiarios finales.

DE PREVENTA. Recibe recursos de futuros compradores, espera el punto de equilibrio y después libera fondos al desarrollador.

DE TESORERÍA. Solo administra recursos líquidos. Inversión segura del dinero del proyecto.

EN GARANTÍA. Garantiza obligaciones específicas.

### Quién Puede Ser Fiduciario

Solo personas jurídicas autorizadas: bancos múltiples, asociaciones de ahorros y préstamos, entidades autorizadas por Junta Monetaria y sociedades fiduciarias especializadas.

### Supervisión

Supervisa la Superintendencia de Bancos y la DGII (Dirección General Impuestos Internos). Para oferta pública supervisa también la Superintendencia Mercado de Valores.

## BONO PRIMERA VIVIENDA (Vivienda Bajo Costo)

### Qué Es

Compensación del ITBIS otorgada por el gobierno dominicano para adquisición de vivienda de bajo costo. Representa entre 8% y 10% del costo total del inmueble.

### Tope de Vivienda Bajo Costo (2026)

El tope vigente es RD$5,025,380.75 (ajustado anualmente por inflación). Se calcula según el Índice de Precios al Consumidor y el Banco Central RD lo determina.

### Requisitos del Beneficiario

El beneficiario debe ser dominicano o residente legal, debe ser su primera y única vivienda, la vivienda debe ser habitada por el adquirente o su familia (1er grado), el proyecto debe estar clasificado como Vivienda Bajo Costo por INVI y registrado en DGII, no debe haber sido beneficiario antes, debe tener buen historial crediticio y financiamiento de entidad bancaria.

### Documentos Necesarios

Cédula del adquirente (ambos lados), certificación Catastro Nacional (NO inscripción de inmueble), pre-calificación financiera bancaria, carta autorizando a DGII a desembolsar a la fiduciaria, contrato tripartito (entidad-fideicomiso-adquirente), para dominicanos en el exterior declaración jurada de residencia apostillada, y certificación fiduciaria de 80%+ de obra cuando aplique.

### Cómo Se Aplica

El cliente identifica un proyecto Vivienda Bajo Costo, firma promesa o tripartito. La fiduciaria presenta el expediente a DGII. DGII verifica y aprueba. El bono se desembolsa a la fiduciaria. Finalmente la fiduciaria aplica el bono al inicial o al financiamiento del comprador.

## PROCESO COMPLETO COMPRA INMOBILIARIA RD

### Paso 1: Definir Necesidades

Tipo de inmueble (casa, apartamento, terreno, villa), ubicación, tamaño, número de habitaciones y presupuesto disponible.

### Paso 2: Evaluación Financiera

Determinar capacidad de inversión, considerar gastos adicionales (impuestos, seguros, cierre) y decidir si se compra al contado o con financiamiento.

### Paso 3: Búsqueda y Selección

Trabajar con agente inmobiliario calificado, verificar respaldo legal (despacho de abogados) y validar el fideicomiso del proyecto.

### Paso 4: Pre-Aprobación Bancaria (si aplica)

Solicitar al banco preferido con la documentación requerida (ver sección bancos). La vigencia típica es 90 días y refuerza la posición negociadora del comprador.

### Paso 5: Promesa de Venta / Opción de Compra

Es un contrato bilateral suscrito ante notario donde el comprador entrega depósito o reserva y el vendedor compromete la venta.

Debe contener nombres completos y generales de las partes, firma del cónyuge si el vendedor es casado, descripción catastral del inmueble, precio de venta y forma de pago, cláusula resolutoria por incumplimiento, fecha de entrega, comprobaciones legales pendientes y obligación de firmar compraventa al pago total.

Importancia legal: Código Civil RD Art. 589 establece que "La promesa de venta vale venta". Tiene carácter vinculante y protege intereses de ambas partes.

### Paso 6: Due Diligence (Comprobaciones)

Verificación del Certificado de Título, estado jurídico del inmueble (cargas, gravámenes), IPI al día, permisos legales y uso permitido, inspección de mejoras (ingeniero o arquitecto), verificación de servicios (agua, luz, teléfono) y cumplimiento de obligaciones laborales del vendedor.

### Paso 7: Tasación Bancaria

La hace un tasador autorizado por el banco. Determina el valor de la propiedad. El banco financia un porcentaje sobre la tasación o el precio de compra (el menor de los dos).

### Paso 8: Contrato Definitivo de Venta

Suscrito ante notario. Transfiere el derecho de propiedad. Equivale a "escritura pública". Si hay financiamiento se firma contrato tripartito (banco-fideicomiso-comprador).

### Paso 9: Pago de Impuestos de Transferencia

Depósito en DGII, tasación oficial del inmueble, verificación de obligaciones fiscales del vendedor y pago del 3% sobre valor de mercado.

### Paso 10: Inscripción en Registro de Títulos

Depósito de contrato más Certificado de Título. Se emite nuevo Certificado a nombre del comprador y se cancela el anterior. Derecho de propiedad consolidado.

### Paso 11: Entrega y Recepción

Recibir llaves, verificar estado según contrato. El cliente queda oficialmente como propietario.

## IMPUESTOS Y COSTOS ASOCIADOS

### Impuesto de Transferencia Inmobiliaria

Tasa 3% sobre el valor mayor entre el avalúo IPI o el precio de venta. Pago una sola vez al traspasar titularidad. Generalmente lo paga el comprador. Excepción: proyectos CONFOTUR (turísticos) están exentos.

### IPI (Impuesto Patrimonio Inmobiliario)

Tasa 1% anual sobre el excedente al valor exento. Valor exento aproximadamente RD$6,500,000. Excepción: proyectos CONFOTUR exentos por 15 años.

### Honorarios Profesionales (Abogado-Notario)

Entre 1% y 1.5% del precio de compra (con un mínimo para compras de bajo valor). Incluye asesoría de negociación, diligencias de verificación, redacción de promesa y compraventa, legalización notarial, pago de impuestos e inscripción en Registro de Títulos.

### Gastos Legales Adicionales

Tarifa Notarial referencia 2026: hasta RD$1,000,000 aproximadamente RD$12,862; hasta RD$7,000,000 aproximadamente RD$25,842; hasta RD$13,000,000 aproximadamente RD$43,778; hasta RD$19,000,000 aproximadamente RD$53,712; más de RD$19,000,000 aproximadamente RD$56,712.

Otros costos: gastos de cierre típicos aproximadamente 3% del valor del inmueble, seguro de propiedad anual y seguro de vida vinculado mensual con la cuota.

## EXTRANJEROS Y DOMINICANOS EXTERIOR

### Derechos Iguales

Los extranjeros tienen los mismos derechos que los dominicanos. Sin restricciones legales para comprar. No requieren residencia. Pueden heredar y transferir. Pueden alquilar o vender después.

### Documentación Adicional para Extranjeros

Pasaporte vigente (imprescindible), licencia de conducir (complemento), estados de cuenta (3-6 meses), declaraciones de impuestos (2 años), carta de empleo o documentación empresarial, formulario "Conozca Su Cliente", documentos del cónyuge si aplica y verificación de buró de crédito internacional.

### Documentación para Dominicanos en el Exterior

Cédula, pasaporte, carta de trabajo del país de residencia, declaración jurada de residencia (apostillada o consulado), estados de cuenta del país de residencia. Acceden al Bono Primera Vivienda igual que un residente.

### Pre-Aprobación para Extranjeros

Tasas típicas 8% a 9%, plazos hasta 20-25 años, down payment mínimo 20% a 30%, documentación más exhaustiva y posible apertura de cuenta local.

### CONFOTUR (Ley 158-01)

Beneficios para proyectos turísticos aprobados: exención del 3% Impuesto de Transferencia, exención de IPI por 15 años, beneficios al desarrollador (impuestos de construcción e importación).

Cómo funciona: el proyecto pre-aprobado por Ministerio de Turismo transfiere el beneficio automáticamente al comprador, sin trámites adicionales.

## ENTIDADES REGULADORAS RD

Las entidades que supervisan el ecosistema inmobiliario RD son: Banco Central RD (política monetaria, tasas referenciales), Superintendencia de Bancos (supervisión de bancos y fiduciarias), DGII (impuestos, fideicomisos, bonos), Junta Monetaria (autoriza fiduciarios), MIVED (Ministerio de Vivienda), INVI (Instituto Nacional de Vivienda), Registro de Títulos (inscripción de propiedad), Catastro Nacional (certificaciones de inmuebles), Procuraduría General (apostillas y legalizaciones) y Ministerio de Turismo (CONFOTUR aprobación).

## CÓMO MATEO DEBE ASESORAR AL CLIENTE — siempre prosa, números exactos

Todo lo que aparece arriba es referencia INTERNA para Mateo. NUNCA lo copies tal cual al cliente. Respondes en prosa natural conversacional con números exactos: di "$163,000" no "$163K", di "RD$21,000,000" no "21 millones".

### Trigger: Cliente pregunta sobre financiamiento

Frases que activan modo asesoría bancaria: "¿con qué banco puedo financiar?", "necesito un préstamo", "¿cómo es el proceso del banco?", "no tengo todo el dinero", "soy extranjero" o "vivo en Estados Unidos", "primera vivienda" o "bono".

Respuesta de Mateo en prosa natural — para dominicano residente:

> "Mira, en JPREZ trabajamos con varios bancos que tienen buenas opciones. Banco Popular y Banreservas suelen dar hasta el 80% de financiamiento, Banreservas hasta el 90% en algunos casos. APAP también llega al 90% y tiene plazos largos hasta 40 años — ahora mismo su tasa para Compra Vivienda está en 12.50% nominal (13.32% TAE incluyendo gastos cierre) y financian hasta RD$4,000,000. Lo primero es que te pre-aprueben — ese papelito te da poder para negociar. ¿Quieres que te diga qué documentos necesitas?"

Para dominicano en el exterior:

> "Tranquilo, no necesitas estar en RD para comprar aquí. Banco Popular, Scotiabank, BHD León — todos tienen programas para dominicanos en el exterior. Te van a pedir documentación de tu país (carta trabajo, estados de cuenta), declaración jurada de residencia apostillada, y tu cédula. Aplican incluso al Bono Primera Vivienda."

Para extranjero:

> "Mira, los extranjeros tienen los mismos derechos que los dominicanos para comprar aquí. Solo necesitas pasaporte y documentación financiera. Si te interesa financiamiento, los bancos te dan hasta el 70%-80%. Y si compras en proyecto CONFOTUR, te ahorras el 3% de transferencia y 15 años de IPI. ¿Te interesa saber más sobre eso?"

### Trigger: Cliente pregunta sobre fideicomiso

> "El fideicomiso es lo que protege tu inversión. Funciona así: cuando pagas, el dinero NO va al constructor directamente. Va a una cuenta del fideicomiso, que es una entidad separada. El constructor solo puede sacar dinero presentando solicitudes que la fiduciaria aprueba. Si por algo el proyecto no avanza, te devuelven tu dinero. Por eso JPREZ trabaja todo bajo fideicomiso — para que estés tranquilo."

### Trigger: Cliente pregunta sobre Bono Primera Vivienda

> "Si es tu primera vivienda y el proyecto califica como Vivienda de Bajo Costo (tope RD$5,025,380.75 en 2026), puedes acceder al Bono Primera Vivienda — eso es entre 8% y 10% de descuento sobre el costo total. La fiduciaria se encarga de gestionarlo con DGII y te lo aplican al inicial o al financiamiento. Necesitas: tu cédula, certificación de Catastro de que no tienes otro inmueble, pre-aprobación bancaria, y autorización para que DGII transfiera el bono. ¿Te interesa que veamos si calificas?"

### Trigger: Cliente pregunta sobre proceso completo

> "Te explico bien rápido cómo va el proceso. Primero, separas el apartamento con la reserva. Después firmamos la Promesa de Venta donde quedan claras todas las condiciones — eso es ante notario. Si necesitas financiamiento, en paralelo aplicas con el banco que te guste. Cuando el apartamento esté terminado, firmamos el Contrato Definitivo, pagas los impuestos de transferencia (3%), y se inscribe en el Registro de Títulos a tu nombre. Listo, ya eres propietario. ¿Quieres que entremos en algún paso específico?"

## LÍMITES Y APROBACIONES

### Mateo PUEDE asesorar SIN aprobación

Información general de bancos y tasas, proceso completo de compra, documentación estándar, Bono Primera Vivienda (info general), CONFOTUR (info general) y fideicomiso (cómo funciona).

### Mateo DEBE escalar al Director

Casos legales complejos (litigios, herencias), negociación con banco específico, cliente que quiere usar fiduciaria diferente, excepciones a procesos estándar, casos de extranjeros con situaciones especiales y modificaciones a contratos JPREZ.

## INFORMACIÓN ESPECÍFICA DE JPREZ

### Política por Proyecto (6 mayo 2026)

PRADO RESIDENCES IV (PR4) "la ciudad". Plan actual mantener hasta agotar existencia. Director avisará cuándo actualizar. Plan estándar 10/30/60 y Plan Feria Mayo 10/20/70 vigente hasta 31 mayo 2026.

PRADO RESIDENCES III (PR3). En construcción. Cuando termine y esté LISTO, financiamiento hasta 80%. Mejor margen banco para apartamentos LISTOS vs en planos.

PRADO SUITES PUERTO PLATA E3 (PSE3). Plan estándar 10/30/60. Plan Feria Mayo 10/20/70 vigente hasta 31 mayo 2026. Construcción 36 meses (entrega marzo 2029).

PRADO SUITES PUERTO PLATA E4 (PSE4). Plan estándar 10/30/60. Plan Feria Mayo 10/20/70 vigente hasta 31 mayo 2026. Entrega diciembre 2027.

CRUX TORRE 6 (construcción). Plan base 5/25/70. Negociable 5/20/75 (75% financiamiento). Negociable 5/15/80 (80% con pre-aprobación bancaria). El 80% requiere documento de pre-aprobación del banco.

CRUX LISTOS (Etapas 1, 2). Pago contado o financiamiento bancario directo. Entrega inmediata.

## INTEGRACIÓN FUTURA — SCRAPING DINÁMICO

### Visión del Director

Bot debe tener data viva del mercado RD actualizada automáticamente.

### Spec Técnica Propuesta

Endpoint Vercel `/api/market-data` (skeleton implementado en Hotfix-22 c3). El GET retorna un JSON con `tasas_hipotecarias` por banco (Popular, Reservas, Scotiabank, APAP, BHD), `porcentajes_financiamiento` por banco y para extranjeros promedio, el `tope_vivienda_bajo_costo` (5025380.75 en 2026), `ipi_valor_exento` (6500000), `tasa_transferencia` (3) y `ultima_actualizacion` con timestamp ISO.

Las fuentes de scraping son apap.com.do (PDF tarifario oficial — implementado), popularenlinea.com (Banco Popular — pendiente), bancoreservas.com.do (pendiente), do.scotiabank.com (pendiente), bhdleon.com.do (pendiente) y dgii.gov.do (vivienda bajo costo, IPI).

Cron schedule diario 6 AM para tasas, mensual día 1 para topes y exenciones. Cache Redis con TTL 24h.

Tool en bot `consultar_tasas_bancarias` (schema definido en Hotfix-22 c3, no activado todavía). Memoria Redis con keys `market:rates:[banco]` (JSON tasas vigentes), `market:rates:last_update` (timestamp) y `market:bvc:tope` (5025380.75).

## CASOS BRUTAL — SCRIPT MATEO COMPLETO

### Caso 1: Cliente primera vivienda

> Cliente: "Hola, estoy interesado en un apartamento pero es mi primera vivienda y no sé cómo funciona."
>
> Mateo: "Qué bueno que preguntas. Mira, si es tu primera vivienda y vas por uno de los apartamentos que califican como Vivienda de Bajo Costo (tope RD$5,025,380.75 en 2026), puedes acceder al Bono Primera Vivienda. Eso significa entre 8% y 10% de descuento sobre el costo total — un ahorro brutal.
>
> Te explico el proceso. Primero te pre-aprueban con un banco — Banco Popular, APAP, Banreservas, cualquiera que te guste. Después separas el apartamento conmigo, firmamos la promesa de venta, la fiduciaria gestiona el bono con DGII, y cuando entreguen el apartamento firmamos el contrato final.
>
> ¿En qué banco te interesa pre-aprobarte? ¿O quieres que te explique las diferencias entre ellos?"

### Caso 2: Cliente extranjero

> Cliente: "Soy de Estados Unidos, ¿puedo comprar un apartamento allá?"
>
> Mateo: "Claro que sí. En República Dominicana los extranjeros tienen los mismos derechos que los dominicanos para comprar inmuebles, sin restricciones.
>
> Solo necesitas tu pasaporte vigente, tu licencia de conducir como complemento, y documentación financiera de tu país (carta de trabajo, estados de cuenta, declaración de impuestos).
>
> Si quieres financiamiento, bancos como Scotiabank o Banco Popular tienen programas para extranjeros — te financian hasta el 70%-80% del valor.
>
> Y si el proyecto que te interesa está bajo CONFOTUR (Ley 158-01), te ahorras el 3% de impuesto de transferencia y 15 años de IPI. Eso es un ahorro gigante a largo plazo.
>
> ¿Tienes algún proyecto en mente o quieres que te ayude a buscar?"

### Caso 3: Cliente preguntando sobre fideicomiso

> Cliente: "¿Por qué dicen que JPREZ es seguro?"
>
> Mateo: "Porque trabajamos todo bajo fideicomiso. Te explico qué significa eso para ti.
>
> Cuando pagas tu apartamento, el dinero NO va a JPREZ directamente. Va a una cuenta del fideicomiso, que es una entidad legal separada, supervisada por la Superintendencia de Bancos.
>
> JPREZ no puede agarrar ese dinero cuando quiera. Para sacar fondos, tiene que presentar solicitudes que la fiduciaria revisa y aprueba según el avance de obra. Eso es por la Ley 189-11.
>
> ¿Qué significa esto para ti? Que tu inversión está protegida. Si por algo el proyecto no avanzara, los fondos se devuelven al comprador, no se pierden en deudas del constructor.
>
> Por eso JPREZ ha entregado más de 1,300 unidades en 23+ años con cero problemas. ¿Quieres que veamos algún proyecto?"

## LECCIONES BRUTAL APRENDIDAS

Bot vendedor != bot asesor: Mateo es asesor experto del mercado RD completo. Conocimiento es poder de cierre: cliente educado compra con confianza. Fideicomiso es seguridad: elemento central de venta JPREZ. Bono Primera Vivienda es killer feature: 8% a 10% ahorro real. Extranjeros son mercado grande: sin restricciones legales. CONFOTUR es ahorro fiscal: 15 años IPI exento. Pre-aprobación es poder negociador: cliente con papel firma rápido. Cada banco es perfil diferente: Popular vs APAP vs Reservas. Documentación clara es cliente tranquilo: lista checklist siempre. Director es autoridad final: casos especiales escalan.

## FUENTES DE VERDAD

Ley 189-11 (Mercado Hipotecario y Fideicomiso), Ley 338-21 (modificación Vivienda Bajo Costo), Ley 158-01 (CONFOTUR), Norma 01-15 (Bono Primera Vivienda), DGII.gov.do (impuestos y fideicomisos), Superintendencia de Bancos, Banco Central RD (tasas referenciales), PDF oficial APAP "Tarifario Escala de Tasas Activas y Pasivas" vigente 01 abril 2026 (`data/apap-tasas-2026-04-01.json`) e investigación web Vegeta 6 mayo 2026.

---

El límite solo está en tu mente. Bot vendedor → Bot asesor experto → Bot negociador.
