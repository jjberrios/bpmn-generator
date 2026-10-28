# Arquitectura

## Visión general

BPMN Reverse Engineer separa **orquestación inteligente (OpenCode + LLM)** de **procesamiento determinista (scripts locales)**.

```
 usuario ──► /bpmn-discover | /bpmn-generate | /bpmn-validate | /bpmn-inspect-reference
                │
        ┌───────▼────────┐   delega (solo lectura)   ┌───────────────────┐
        │ bpmn-orchestrator│──────────────────────────►│ repository-mapper │
        │   (primary)      │──────────────────────────►│ flow-tracer       │
        │                  │──────────────────────────►│ process-analyst   │
        │                  │──────────────────────────►│ bpmn-reviewer     │
        └───────┬──────────┘                           └───────────────────┘
                │ node tools/cli.mjs <subcomando>  (única shell permitida)
        ┌───────▼───────────────────────────────────────────────────────────┐
        │ ingest → analyze → discover → draft → generate → validate → review │
        └───────────────────────────────────────────────────────────────────┘
```

Los scripts **no son agentes**: no interpretan semántica ni llaman a un LLM. El CLI puede usarse sin OpenCode (`node tools/cli.mjs pipeline <zip>`), en cuyo caso el modelo de proceso es el **borrador determinista** (sin refinamiento semántico ni revisión independiente de un LLM).

## Agentes y modelos

| Agente | Tipo | Modelo (`opencode.json`) | Variante |
|---|---|---|---|
| bpmn-orchestrator | primary | github-copilot/claude-sonnet-5.5 | high |
| repository-mapper | subagent | github-copilot/claude-haiku-5.5 | medium |
| flow-tracer | subagent | github-copilot/claude-sonnet-5.5 | high |
| process-analyst | subagent | github-copilot/claude-sonnet-5.5 | high |
| bpmn-reviewer | subagent | github-copilot/gpt-6.1-sol | high |

Los identificadores y variantes se comprobaron con `opencode models` y con el catálogo de OpenCode (variantes `low, medium, high, xhigh, max`). No hubo sustituciones: GPT-6.1 Sol está disponible. Para cambiar un modelo basta editar `agents.<id>.model` en `opencode.json` (sin tocar prompts ni reglas).

## Etapas y artefactos

| Etapa | Herramienta | Artefacto (contrato) |
|---|---|---|
| Ingesta | `tools/ingestion/extract_zip.py` | `workspace/<id>/source/`, `repository-manifest.json` |
| Análisis | `tools/analysis/{java_index,java_trace,analyze_project}.py` | `analysis/architecture-map.json`, `analysis/execution-trace.json` |
| Descubrimiento | `tools/analysis/draft-process.mjs` (`discoverCandidates`) | `discovery.json`, `outputs/reports/<id>-descubrimiento.md` |
| Borrador | `draftProcess` | `processes/<pid>/process-definition.draft.json` |
| Refinamiento (LLM) | `process-analyst` (+ `flow-tracer`) | `processes/<pid>/process-definition.json` |
| Generación | `tools/bpmn/{generate-bpmn,layout,preview-svg}.mjs` | `outputs/diagrams/<pid>.bpmn`, `.process.json`, `.traceability.json`, previews |
| Validación | `tools/validation/validate-bpmn.mjs` | `outputs/reports/<pid>.validation.json/.md` |
| Revisión | `review-checks.mjs` + `bpmn-reviewer` | `outputs/reports/<pid>.review.json/.md` |
| Referencia | `tools/reference/inspect-xpdl.mjs` | `outputs/_shared/reports/reference-inspection.json/.md` |

Cada contrato entre etapas se valida con JSON Schema 2020-12 (Ajv, `schemas/`) antes de avanzar. `workspace/<id>/` conserva todos los resultados intermedios para depurar y repetir análisis.

## Motor BPMN

- **bpmn-moddle 10.3.1** serializa/parsea el XML (Collaboration, Process, LaneSet, SequenceFlow, MessageFlow, DataStoreReference, BPMNDI).
- **Layout propio** por capas (rangos por camino más largo, filas por lane, ruteo ortogonal con puntuación de colisiones). `bpmn-auto-layout` 1.3.0 está instalado como dependencia evaluada pero **no se usa**: no distribuye lanes ni pools externos de forma controlable. Las métricas (solapes, cruces, rutas de respaldo) se verifican en tests.
- **bpmnlint 11.15.0** (conjunto `recommended`) y comprobaciones propias de estructura, DI, round-trip y trazabilidad.
- **@resvg/resvg-js** renderiza el SVG (generado desde el DI) a PNG.
- `bpmn-js` no se integra: es un visor/modeler de navegador y no aporta al motor de línea de comandos.

## Modelo de evidencia

`CONFIRMADA` (directa en el código) · `INFERIDA` (deducida, con justificación) · `DESCONOCIDA` (sin evidencia suficiente). Cada elemento del BPMN enlaza a archivo/línea/clase/método (documentación del elemento y sidecar `.traceability.json`). Las inferencias son visibles en el informe de revisión.

## Seguridad y permisos

Los subagentes tienen `deny *` por defecto y solo `read/glob/grep` sobre rutas del proyecto y `skill` concretas; no tienen `edit`, `shell` ni `subagent`. El orquestador solo puede ejecutar `node tools/cli.mjs *` y `npm test`, y escribir en `workspace/`. Detalles de controles de ZIP en `docs/limitations.md`.

## Extensibilidad

Nuevos lenguajes: registrar un analizador en `tools/analysis/analyze_project.py` que emita `architecture-map` y `execution-trace` conformes a los esquemas. El resto del pipeline (borrador, BPMN, validación, revisión) es independiente del lenguaje.
