# Instalación (Windows)

## Requisitos

| Software | Versión probada |
|---|---|
| Node.js | 22.19.0 |
| npm | 10.9.3 |
| Python | 3.12.10 |
| OpenCode | 2.1.2 (con un proveedor autenticado) |

## Pasos

```powershell
cd <carpeta del proyecto>
npm ci                       # dependencias Node con versiones fijadas (package-lock.json)
pip install -r requirements.txt   # tree-sitter 0.26.0 y tree-sitter-java 0.23.5
```

No se modifica la configuración global de OpenCode ni las credenciales. La configuración del proyecto está en `opencode.json`, `.opencode/` y `AGENTS.md`.

## Verificación

```powershell
npm test                     # node:test + unittest
node tools/cli.mjs pipeline tests/fixtures/orders-service.zip --project-id orders-service --force
node tools/cli.mjs inspect-reference
```

Comprobar que OpenCode carga el sistema (desde la carpeta del proyecto):

```powershell
opencode api agent.list --param "location[directory]=$PWD"
opencode api command.list --param "location[directory]=$PWD"
opencode api skill.list --param "location[directory]=$PWD"
opencode models
```

## Archivo de referencia Bizagi (opcional)

Copiar `claro-post-consultareclamos.bpm` a `inputs/references/`. Si no está, `inspect-reference` informa que la prueba no se ejecutó y el resto funciona.

## Cambiar modelos

Seleccionar el modelo en la sesión de OpenCode. Los subagentes no tienen modelos propios configurados: heredan el modelo de la sesión principal. `opencode.json` define el modelo predeterminado del proyecto; no es necesario editar los prompts ni configurar un modelo diferente por agente.

## Variables de entorno

`BPMN_RE_PYTHON`: ejecutable de Python a usar (por defecto `python`).
