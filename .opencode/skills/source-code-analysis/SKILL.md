---
name: source-code-analysis
description: Análisis estructural (AST con tree-sitter) de proyectos Java/Spring: puntos de entrada, componentes, integraciones, condiciones, excepciones y grafo de ejecución. Úsala para generar o verificar architecture-map y execution-trace.
---

# source-code-analysis

## Cuándo usarla
Tras la ingesta, para obtener el inventario técnico y las trazas por punto de entrada; y por los subagentes `repository-mapper` y `flow-tracer` como método de verificación.

## Entradas
`workspace/<id>/source/` y `repository-manifest.json` generados por `project-ingestion`.

## Procedimiento
1. `node tools/cli.mjs analyze <id>` (envuelve `tools/analysis/analyze_project.py`: `java_index.py` indexa clases/anotaciones/configuración; `java_trace.py` recorre el AST).
2. Resultado en `workspace/<id>/analysis/architecture-map.json` y `execution-trace.json`.
3. Valida: `node tools/cli.mjs validate-schema architecture-map <archivo>` y `... execution-trace <archivo>`.
4. Revisa `unresolved` y `limitations`: son llamadas que el análisis estático no resuelve (interfaces con varias implementaciones, reflexión). **Se conservan como desconocidas**, nunca se adivinan.

## Qué detecta (Java 8/11/17/21, Spring)
Puntos de entrada (`@RestController`, `@GetMapping`…, `@Scheduled`, listeners, `main`); relaciones controlador→servicio→repositorio→cliente; inlining de llamadas resolubles; `if/else/switch`; `try/catch` y `throw` enlazados a `@ExceptionHandler`; `Optional.orElseThrow`; bucles; Spring Data (repositorios), JDBC/SQL, RestTemplate/WebClient/Feign, mensajería. Cada nodo lleva `resolution` (DIRECTA/INDIRECTA/DINAMICA/NO_RESUELTA) y una evidencia con archivo/línea/snippet.

## Extensión a otros lenguajes
Registrar un analizador nuevo en el registro de `analyze_project.py`; mientras no exista, el lenguaje se informa como `unresolved` sin análisis estructural.

## Criterios de éxito
Ambos JSON válidos contra sus esquemas; cada entry point REST esperado tiene traza; toda evidencia referencia archivo y líneas reales.

## Referencias
`tools/analysis/`, `schemas/architecture-map.schema.json`, `schemas/execution-trace.schema.json`.
