---
name: bpmn-validation
description: Valida un .bpmn generado (XML, referencias, estructura BPMN, DI, bpmnlint, round-trip y trazabilidad) y ejecuta la revisión determinista contra el código; bloquea la aprobación ante errores críticos.
---

# bpmn-validation

## Cuándo usarla
Después de generar un BPMN, ante `/bpmn-validate`, y por el revisor para contrastar resultados.

## Procedimiento
1. Validación del archivo: `node tools/cli.mjs validate-bpmn <ruta.bpmn>` (usa `<base>.process.json` y `<base>.traceability.json` contiguos; opciones `--definition`, `--sidecar`).
2. Comprobaciones: XML parseable; ids únicos; referencias; inicio/fin; elementos huérfanos; compuertas (bifurcación, condiciones, default); alcanzabilidad; lanes y pools; message flows entre pools distintos; BPMN DI (planos, bounds, coordenadas, waypoints, solapes, segmentos diagonales); **bpmnlint** (recommended); round-trip con bpmn-moddle; trazabilidad contra la definición (elementos, nombres, flujos, evidencia).
3. Informe: `outputs/reports/<pid>.validation.json|md` con `approval` APROBADO | BLOQUEADO (exit 1 = bloqueado). Cualquier `ERROR` bloquea.
4. Revisión determinista contra el código: `node tools/cli.mjs review-check <id> --process <pid>`: verifica que archivos/líneas/snippets existan, detecta actividades sin evidencia, ramas omitidas, decisiones invertidas o con condición alterada, operaciones omitidas, comportamiento no resuelto marcado como CONFIRMADA, y lista las inferencias no confirmadas. Fusiona `review-agent.json` si existe.

## Límites (decir siempre)
- Validar XML/semántica **no** prueba fidelidad funcional.
- Los informes reportan cobertura de evidencia y fidelidad funcional por separado; esta última no se verifica automáticamente.
- La revisión semántica independiente la aporta `bpmn-reviewer`.

## Referencias
`tools/validation/validate-bpmn.mjs`, `review-checks.mjs`, `definition-checks.mjs`, `schemas/review-report.schema.json`.
