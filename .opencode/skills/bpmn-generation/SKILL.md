---
name: bpmn-generation
description: Convierte definiciones validadas en BPMN 2.0 con DI, vistas previas y trazabilidad; entrega los `.bpmn` (BPMN 2.0) por proceso; el contenedor Bizagi .bpm es opcional (`--bpm`). Úsala solo con definiciones que cumplan el contrato.
---

# bpmn-generation

## Cuándo usarla
Cuando existe `workspace/<id>/processes/<pid>/process-definition.json` válida. **Un LLM nunca escribe el XML**: lo genera el motor determinista.

## Procedimiento
1. `node tools/cli.mjs generate <id> --process <pid>` (o `--all`).
2. El motor (`tools/bpmn/`): valida el contrato → `checkDefinition` (bloquea ante huérfanos, sin evento final, condiciones faltantes, evidencia ausente…) → `generate-bpmn.mjs` con **bpmn-moddle** (Collaboration + Process + LaneSet, tareas, eventos, compuertas XOR/AND/OR, flujos con condición, MessageFlows a pools externos, DataStoreReference) → `layout.mjs` (layout horizontal por capas con ruteo ortogonal, sin solapes) → BPMN DI → vista previa desde el DI.
3. Si bloquea, se escribe `workspace/<id>/_intermedios/reports/<pid>.generation-error.json`; devuelve los errores al `process-analyst`.
4. Si todos los procesos seleccionados pasan la validación y ninguno tiene revisión RECHAZADO, `tools/bizagi/native-project.mjs` genera **un único** `workspace/<id>/_intermedios/delivery/<id>.bpm` con paquetes XPDL 2.2 independientes. `--all` incluye todos los procesos seleccionables; `--process` entrega solo el seleccionado y sustituye el contenedor de ese proyecto. Los intermedios se conservan.
5. `node tools/cli.mjs validate-bizagi workspace/<id>/_intermedios/delivery/<id>.bpm` verifica estructura ZIP/XML, referencias, condiciones, carriles, eventos, trazabilidad y correspondencia con las definiciones embebidas. El exportador bloquea construcciones no soportadas en lugar de omitirlas. No copia usuarios, autores ni procesos de la referencia.

## Entrega por proyecto
- `workspace/<id>/_intermedios/delivery/<id>.bpm`: contenedor nativo reconstruido, no un ZIP de archivos `.bpmn` ni un archivo renombrado.
- `outputs/reports/<id>.bizagi-validation.json`: comprobaciones deterministas del contenedor. No equivalen a validación contra un XSD oficial ni a apertura efectiva en Bizagi.

## Vista por actividades
- Si el usuario solicita un diagrama funcional resumido, conservar `process-definition.json` detallado y preparar `functional-definition.json` y `abstraction-map.json` en el mismo directorio. Las referencias orientan el estilo, nunca aportan comportamiento al proceso analizado.
- `node tools/cli.mjs reference-style <referencia.bpm> ...` analiza todos los diagramas de las referencias autorizadas en `inputs/references/`, omitiendo usuarios.
- `node tools/cli.mjs generate-functional <id> --all` genera intermedios en `outputs/functional/`. El mapa debe justificar y cubrir todos los nodos y resultados detallados, conservar las evidencias y no cambiar los estados HTTP conocidos/inferidos/desconocidos.
- Sin `functional-review.json` independiente, válido y ligado mediante hashes a fuente/vista/mapa, sólo produce vistas previas: no sustituye la entrega. Una revisión rechazada del detalle también bloquea la exportación. La cobertura del mapa no demuestra equivalencia de rutas.
- Con las revisiones y validaciones aprobadas, entrega el mismo único `workspace/<id>/_intermedios/delivery/<id>.bpm`, esta vez con las vistas resumidas; conserva el detalle técnico y archiva la entrega anterior.

## Diagrama compacto por funcionalidad e insumos
- `generate` aplica `functionalServiceView` (`tools/analysis/functional-service-view.mjs`): colapsa regiones SESE insignificantes (sin BD, integraciones ni resultados propios) en una actividad `AF_<id>` INFERIDA y nombra por método de negocio. Objetivo: ≤~25 actividades y ≤~12 decisiones; no una tarea por retorno anticipado.
- El agente puede mejorar los nombres con `workspace/<id>/processes/<pid>/functional-names.json` (UTF-8 sin BOM) y regenerar. Si el diagrama sigue siendo extenso, revisar nombres/agrupación antes de entregar.

## Salidas por proceso
- `workspace/<id>/_intermedios/diagrams/<pid>.bpmn` (editable), `<pid>.process.json`, `<pid>.traceability.json` (elemento BPMN → evidencias con estado y archivo:línea)
- `workspace/<id>/_intermedios/previews/<pid>.svg` y `.png`
- `workspace/<id>/_intermedios/reports/<pid>.validation.json|md`, `<pid>.review.json|md`
- `workspace/<id>/_intermedios/traces/<pid>.trace.json`

## Decisiones técnicas
`bpmn-auto-layout` se evaluó y no se usa: no distribuye lanes/colaboraciones con pools externos de forma controlable; se implementó un layout propio verificable (métricas de solapes/cruces en los tests). Los ids de nodos coinciden con los de la definición (estables entre ejecuciones).

## Criterios de éxito
Intermedios `.bpmn` con BPMNDI, parseables y reimportables (round-trip), 0 solapes de formas y validación `APROBADO`; entrega única `.bpm` con tantos diagramas como procesos seleccionados y comprobaciones del contenedor `APROBADO`. Bizagi: la entrega es el `.bpm` generado. La estructura se reconstruye desde una referencia; no se usa el SDK oficial.

## Referencias
`tools/bpmn/generate-bpmn.mjs`, `layout.mjs`, `preview-svg.mjs`, `tools/bizagi/native-project.mjs`, `docs/modeling-rules.md`.
