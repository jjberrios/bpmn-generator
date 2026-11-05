# Uso

## Desde OpenCode (flujo interactivo)

1. Copiar el ZIP a `inputs/projects/` (p. ej. `inputs/projects/servicio.zip`).
2. Abrir OpenCode en la carpeta del proyecto (el agente predeterminado es `bpmn-orchestrator`).
3. Ejecutar los comandos:

```
/bpmn-discover inputs/projects/servicio.zip
/bpmn-generate inputs/projects/servicio.zip --process OrderController_getStatus
/bpmn-generate inputs/projects/servicio.zip --all
/bpmn-validate outputs/diagrams/OrderController_getStatus.bpmn
/bpmn-inspect-reference inputs/references/claro-post-consultareclamos.bpm
```

- **DISCOVER**: ingesta segura, análisis AST, inventario, candidatos a proceso con suficiencia de evidencia. No genera diagramas.
- **GENERATE**: por proceso (`--process <process_id|método>`) o todos los elegibles (`--all`); un `.bpmn` por proceso. Los candidatos con evidencia INSUFICIENTE se omiten y se explica el motivo.
- Los argumentos usan `$ARGUMENTS` de OpenCode; el agente valida rutas e IDs y nunca los interpola sin validar en la shell.

## Desde la línea de comandos (determinista, sin LLM)

```powershell
node tools/cli.mjs ingest inputs/projects/servicio.zip --project-id servicio [--force]
node tools/cli.mjs analyze servicio
node tools/cli.mjs discover servicio
node tools/cli.mjs draft servicio --process <process_id|--all>
node tools/cli.mjs generate servicio --process <process_id> | --all
node tools/cli.mjs validate-bpmn workspace/<id>/_intermedios/diagrams/<pid>.bpmn
node tools/cli.mjs review-check servicio --process <pid>
node tools/cli.mjs validate-schema <contrato> <archivo.json>
node tools/cli.mjs inspect-reference [inputs/references/claro-post-consultareclamos.bpm]
node tools/cli.mjs report servicio --all
node tools/cli.mjs pipeline inputs/projects/servicio.zip --project-id servicio [--process <pid>]
```

Salida siempre JSON. Códigos de salida: 0 correcto, 1 bloqueado/rechazado, 2 error, 64 uso incorrecto.

> `pipeline` usa el **borrador determinista** como modelo de proceso: es útil para pruebas y CI, pero sin refinamiento semántico ni revisión independiente de un LLM.

## Entregables por proceso

| Archivo | Contenido |
|---|---|
| `workspace/<id>/_intermedios/diagrams/<pid>.bpmn` | BPMN 2.0 editable con BPMN DI |
| `workspace/<id>/_intermedios/diagrams/<pid>.process.json` | Definición del proceso (modelo intermedio) |
| `workspace/<id>/_intermedios/diagrams/<pid>.traceability.json` | Elemento BPMN → evidencias (archivo, línea, estado) |
| `workspace/<id>/_intermedios/documents/<pid>.docx` | Word editable: ficha por actividad funcional, con tablas según las imágenes de referencia |
| `workspace/<id>/_intermedios/documents/<pid>.documentation.json` | Datos de las fichas, evidencias, huellas y controles estructurales del Word |
| `workspace/<id>/_intermedios/previews/<pid>.svg/.png` | Vista previa renderizada desde el DI |
| `workspace/<id>/_intermedios/reports/<pid>.validation.json/.md` | Informe de validación |
| `workspace/<id>/_intermedios/reports/<pid>.review.json/.md` | Informe de revisión (hallazgos e inferencias no confirmadas) |
| `workspace/<id>/_intermedios/reports/<id>-descubrimiento.md` | Candidatos a proceso |
| `workspace/<id>/_intermedios/reports/<id>-informe-final.md` | Informe consolidado |
| `workspace/<id>/_intermedios/traces/<pid>.trace.json` | Traza de ejecución usada |

## Entrega

`outputs/<id>/` es una carpeta plana con solo `<pid>.bpmn`, `<id>.bpm` (con `--bpm`) y los Word; los archivos listados arriba (JSON, previews, reportes, trazas) se escriben en `workspace/<id>/_intermedios/`. Cada generación crea el Word de actividades en `workspace/<id>/_intermedios/documents/`; `node tools/cli.mjs document <id> --all` permite actualizar solo los documentos desde los BPMN ya generados y las fichas `activity-documentation.json` preparadas con evidencia del código. Sin fichas, los datos no determinados no se inventan.

## Depuración y repetición

Todo queda en `workspace/<id>/` (`analysis/`, `processes/<pid>/`). Para repetir una etapa basta volver a ejecutar el subcomando correspondiente; `ingest --force` reemplaza la extracción (y borra `analysis/`).
