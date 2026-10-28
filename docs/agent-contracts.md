# Contratos entre agentes

Todos los intercambios usan JSON validado con los esquemas de `schemas/`. Los subagentes **devuelven JSON**; el orquestador lo persiste en `workspace/<id>/...` y lo valida con `node tools/cli.mjs validate-schema <contrato> <archivo>` antes de continuar.

| Contrato | Esquema | Productor | Consumidor |
|---|---|---|---|
| repository-manifest | `schemas/repository-manifest.schema.json` | `extract_zip.py` | todos |
| architecture-map | `schemas/architecture-map.schema.json` | `analyze_project.py`, `repository-mapper` | `process-analyst`, discover |
| execution-trace | `schemas/execution-trace.schema.json` | `java_trace.py`, `flow-tracer` | `process-analyst`, revisión |
| process-definition | `schemas/process-definition.schema.json` | `draftProcess`, `process-analyst` | generador BPMN, revisión |
| evidence | `schemas/evidence.schema.json` | analizadores y agentes | todos |
| review-report | `schemas/review-report.schema.json` | `review-checks`, `bpmn-reviewer` | orquestador, informe final |

## Evidencia

```json
{ "id": "EV2", "status": "CONFIRMADA", "file": "src/main/java/.../OrderController.java",
  "line_start": 24, "line_end": 24, "class": "OrderController", "method": "getStatus",
  "snippet": "if (orderId == null || orderId.isBlank()) {" }
```
`INFERIDA` y `DESCONOCIDA` exigen `justification`. `CONFIRMADA` exige `line_start`. No existe un valor numérico de confianza.

## process-definition (campos principales)

`schema_version`, `id`, `name`, `description`, `entry_point`, `abstraction_level` (FUNCIONAL | BACKEND_OBSERVABLE | DETALLADO), `scope_note`, `participants` (internal con `is_pool` = pool principal; internal sin `is_pool` = lane; external = pool colapsado con message flows; data_store), `activities`, `events`, `decisions` (`exclusive|parallel|inclusive`), `flows` (con `branch`, `condition`), `message_flows`, `outcomes`, `exceptions`, `related_processes`, `evidence`, `uncertainties`, `review_status`.

## Flujo de mensajes entre agentes

1. orquestador → `repository-mapper`: `project-id`, rutas en `workspace/<id>/analysis/`. Devuelve `architecture-map` (se guarda como `architecture-map.agent.json`).
2. orquestador → `flow-tracer`: entry point + traza determinista. Devuelve `execution-trace` (`processes/<pid>/execution-trace.agent.json`).
3. orquestador → `process-analyst`: borrador + trazas + arquitectura. Devuelve `process-definition` (`processes/<pid>/process-definition.json`). Si no valida, se devuelven los errores literales (máx. 2 reintentos).
4. `generate` (determinista) → BPMN + validación + revisión automática.
5. orquestador → `bpmn-reviewer`: definición, BPMN, informes y código. Devuelve `review-report` (`processes/<pid>/review-agent.json`), que se fusiona con la revisión automática.
6. Con hallazgos CRÍTICO/ALTO: corrección por `process-analyst` y repetición (máx. 2 iteraciones).

## Veredictos de revisión

CRÍTICO/ALTO → `RECHAZADO`; MEDIO o inferencias no confirmadas → `APROBADO_CON_OBSERVACIONES`; en otro caso `APROBADO`. Un veredicto de revisión **no** equivale a fidelidad funcional comprobada ni a compatibilidad con Bizagi.
