---
name: process-discovery
description: Descubre candidatos a proceso y reconstruye el modelo intermedio (process-definition) a partir de las trazas, agrupando operaciones técnicas en actividades funcionales con evidencias. Úsala en los modos DISCOVER y GENERATE.
---

# process-discovery

## Cuándo usarla
Modo DISCOVER (listar procesos) y paso previo a generar BPMN (definición de proceso).

## Entradas
`workspace/<id>/analysis/{architecture-map,execution-trace}.json`; para refinar, el código en `source/` y `docs/modeling-rules.md`.

## Procedimiento
1. **Descubrimiento**: `node tools/cli.mjs discover <id>` → candidatos con `process_id`, nombre, descripción, punto de entrada, clases/paquetes, decisiones, rutas, resultados, integraciones, llamadas no resueltas y `evidence_sufficiency` (SUFICIENTE | PARCIAL | INSUFICIENTE) con su razón. Informe: `outputs/reports/<id>-descubrimiento.md`.
2. **Borrador determinista**: `node tools/cli.mjs draft <id> --process <pid|método|--all>` → `processes/<pid>/process-definition.draft.json` (y `process-definition.json` si no existía).
3. **Refinamiento semántico** (subagente `process-analyst`): agrupar operaciones técnicas en actividades de negocio, decidir nivel de abstracción, lanes/participantes justificables, subprocesos si aportan claridad. Valida: `node tools/cli.mjs validate-schema process-definition <archivo>`.

## Reglas
- Un evento final por resultado observable; ramas de error como flujos reales.
- Sin pasos humanos, aprobaciones ni actividades inventadas; alcance `BACKEND_OBSERVABLE` cuando no haya proceso funcional completo.
- Elementos agrupados o deducidos → `INFERIDA` con justificación; sin evidencia → `DESCONOCIDA`.
- No convertir cada método Java en tarea; no duplicar lógica compartida entre procesos (usar `related_processes`).

## Salida / criterios de éxito
`process-definition.json` válida contra `schemas/process-definition.schema.json` y sin errores de `checkDefinition` (se comprueba en `generate`).

## Referencias
`tools/analysis/draft-process.mjs`, `tools/validation/definition-checks.mjs`, `docs/modeling-rules.md`, `docs/agent-contracts.md`.
