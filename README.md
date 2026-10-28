# BPMN Reverse Engineer

Agentes de **OpenCode** que analizan código en ZIP y generan BPMN 2.0 editables, documentos Word y trazabilidad. Análisis estructural orientado a Java/Spring, sin ejecutar el proyecto recibido.

## Instalación

Requisitos: Windows, Node.js 22+, Python 3.12+ y OpenCode con un proveedor autenticado.

```powershell
npm ci
python -m pip install -r requirements.txt
```

## Usar los agentes

1. Abre OpenCode en la raíz del repositorio y selecciona **`bpmn-orchestrator`**.
2. Selecciona el modelo que utilizarás. Los subagentes heredan el modelo de la sesión; no requieren modelos separados.
3. Coloca el ZIP en `inputs/projects/` y ejecuta:

```text
/bpmn-discover inputs/projects/servicio.zip
/bpmn-generate inputs/projects/servicio.zip --all
```

Para generar solo un proceso o validar un BPMN:

```text
/bpmn-generate inputs/projects/servicio.zip --process <process_id>
/bpmn-validate outputs/<id>/diagrams/<process_id>.bpmn
```

El orquestador delega automáticamente; no necesitas abrir cada subagente:

| Agente | Función |
| --- | --- |
| `repository-mapper` | Identifica componentes e integraciones. |
| `flow-tracer` | Reconstruye rutas, decisiones y errores. |
| `process-analyst` | Agrupa el comportamiento en actividades funcionales. |
| `bpmn-reviewer` | Contrasta el diagrama con el código. |

Puedes pedir al orquestador **una vista resumida por actividades**. Las referencias de `inputs/references/` orientan el estilo, no las reglas del proceso. Los agentes producen JSON; las herramientas generan el XML.

## Resultados

En `outputs/<id>/`:

- `diagrams/`: BPMN 2.0 (`.bpmn`) y trazabilidad.
- `documents/`: Word de actividades y explicación general.
- `previews/`, `reports/` y `traces/`: vistas y comprobaciones.
- `delivery/`: contenedor Bizagi `.bpm` opcional. Solicítalo al orquestador; en la CLI se activa con `--bpm`.

Para regenerar los Word: `node tools/cli.mjs document <id> --all`.

## Pruebas y publicación

```powershell
npm test
```

Se versionan código, agentes, pruebas, referencias y `package-lock.json`. Se excluyen proyectos recibidos, `workspace/`, resultados y dependencias; sus carpetas de trabajo se conservan con `.gitkeep`.

**Confidencialidad:** el código leído por los agentes se envía al proveedor LLM seleccionado. Revisa las referencias antes de publicar un repositorio público. La cobertura de evidencia no demuestra fidelidad funcional ni las comprobaciones estructurales garantizan la apariencia en Bizagi o Word.

Más detalles: [instalación](docs/installation.md), [uso](docs/usage.md) y [reglas de modelado](docs/modeling-rules.md).
