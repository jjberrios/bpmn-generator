# Reglas de modelado

Convenciones inspiradas en la referencia Bizagi `claro-post-consultareclamos.bpm` (observadas con `inspect-reference`; la referencia solo sirve para convenciones, no para atribuir comportamiento a otros proyectos):

- Un **pool** con el nombre del servicio y **lanes por responsabilidad** (capas/clases con evidencia). Sin lanes si solo hay una responsabilidad.
- Tareas con nombre de acción; compuertas con la **condición** como nombre (`¿condición?`); flujos de decisión etiquetados **SI/NO**; el flujo NO suele ser el `default`.
- **Un evento final por resultado observable** (p. ej. "Respuesta 200 OK", "Respuesta 404 NOT_FOUND"), no un único final genérico.
- Almacenes de datos como `DataStoreReference` asociados a la actividad que los usa.
- Servicios externos como pools colapsados con message flows (solicitud y respuesta).

## Elección de elementos

| Código observado | BPMN |
|---|---|
| `if/else`, `switch`, `orElseThrow` | Compuerta exclusiva (XOR), una salida `default` |
| try/catch cuyo catch converge con el flujo | Excepción "capturada" registrada en `exceptions[]`, sin rama |
| try/catch cuyo catch diverge o lanza | XOR "¿Falla la llamada…?" con rama de excepción |
| `throw` + `@ExceptionHandler` | Tarea "Manejar <Excepción>" + evento final del código HTTP |
| Repositorio / JDBC | serviceTask + DataStoreReference (read/write) |
| RestTemplate / WebClient / Feign | serviceTask + message flows a pool externo |
| Llamada no resoluble | Tarea marcada `DESCONOCIDA` + incertidumbre |
| Paralelo (`CompletableFuture`, etc.) | Compuerta paralela, solo con evidencia de concurrencia |
| Inclusiva | Solo si varias ramas pueden activarse simultáneamente |

## Reglas

1. Representar solo comportamiento sustentado por el backend (`BACKEND_OBSERVABLE`); no asumir usuarios, aprobaciones ni operaciones manuales.
2. No convertir cada método en tarea: agrupar operaciones técnicas en actividades con sentido; lo agrupado es `INFERIDA`.
3. Pools/lanes solo con justificación y evidencia.
4. Todo elemento relevante con evidencia; sin evidencia suficiente → `DESCONOCIDA`.
5. IDs estables; nodos con el ID de la definición.
6. **Diagrama por funcionalidad e insumos, compacto**: `functional-service-view` agrupa en una actividad INFERIDA toda región de decisiones/pasos técnicos (SESE) sin accesos a datos, llamadas externas, desconocidos ni finales; las decisiones sin efecto diferenciado no se dibujan. Objetivo ~25 actividades / ~12 decisiones. Los nombres funcionales se derivan de los métodos o de `functional-names.json` (escrito por el orquestador; UTF-8 sin BOM).
7. Layout horizontal, etiquetas legibles, sin solapes.

## Advertencias conocidas

- `UNION_IMPLICITA` / bpmnlint `fake-join`: varios flujos convergen en una tarea o evento sin compuerta de unión (p. ej. varias ramas hacia un mismo evento final o manejador). Es BPMN válido; se reporta como advertencia aceptada.
- Un elemento `DESCONOCIDA` genera la advertencia `COMPORTAMIENTO_DESCONOCIDO`.
