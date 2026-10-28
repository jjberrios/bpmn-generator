---
name: project-ingestion
description: Extrae y prepara de forma segura un proyecto ZIP (anti Zip Slip, anti ZIP bomb, sin enlaces simbólicos, sin ejecutar contenido) y genera el manifiesto del repositorio. Úsala antes de cualquier análisis de un ZIP.
---

# project-ingestion

## Cuándo usarla
Siempre que se reciba un ZIP bajo `inputs/projects/` y antes de analizarlo.

## Entradas
- Ruta del ZIP (validada: existe, extensión `.zip`, bajo `inputs/projects/` o ruta indicada por el usuario).
- `project-id` (regex `^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$`; por defecto, derivado del nombre del ZIP).
- Opcional: `--force` para reemplazar una extracción previa generada por esta herramienta.

## Procedimiento
1. `node tools/cli.mjs ingest <zip> --project-id <id> [--force]` (envuelve `tools/ingestion/extract_zip.py`).
2. Lee el JSON de salida: `ok`, `totals`, `sensitive_files`, `warnings`.
3. Si `ok:false` (exit 2) informa el motivo exacto y **detén** el análisis: el ZIP se rechaza completo ante `..`, rutas absolutas/unidades, flujos alternos NTFS, nombres reservados de Windows, enlaces simbólicos, ZIP corrupto o vacío, o límites excedidos.

## Controles implementados
Integridad (`testzip`), extracción aislada en `workspace/<id>/source/`, rutas relativas conservadas, creación exclusiva (sin sobrescrituras), duplicados descartados con advertencia, límites configurables (archivos, bytes totales, bytes por archivo, ratio de compresión, profundidad), exclusión de directorios irrelevantes (`.git`, `node_modules`, `target`, `build`, `.idea`…) y binarios, **no extracción** de `.env`, claves y keystores (quedan listados en `sensitive_files`), redacción de valores `password/secret/token/apikey…` en configuración. Nunca se ejecuta ni instala nada del proyecto.

## Salidas
`workspace/<id>/source/` y `workspace/<id>/repository-manifest.json` (contrato `schemas/repository-manifest.schema.json`; verifica con `node tools/cli.mjs validate-schema repository-manifest <archivo>`).

## Criterios de éxito
`ok:true`, manifiesto válido contra el esquema, sin archivos sensibles en `source/`, sin extracción parcial tras un rechazo.

## Referencias
`tools/ingestion/extract_zip.py`, `docs/limitations.md`, `docs/architecture.md`.
