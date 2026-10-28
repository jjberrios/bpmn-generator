# Limitaciones

## Formato .bpm
El contenedor se reconstruye a partir de la estructura de la referencia, no con un SDK oficial. Se valida con bpmn-moddle, bpmnlint y comprobaciones propias.

## Análisis estático
- Solo hay analizador estructural para **Java** (tree-sitter-java). Otros lenguajes quedan inventariados como `unresolved`, sin trazas.
- Llamadas **no resolubles** (interfaces con varias implementaciones, reflexión, inyección dinámica, lambdas complejas) se marcan `NO_RESUELTA`/`DESCONOCIDA`; no se adivina la implementación.
- Límites del recorrido: profundidad 8, 600 nodos y 300 rutas por traza; las trazas truncadas deben quedar en `limitations`.
- Spring AOP, interceptores, filtros, `@Transactional` y eventos (`ApplicationEvent`) no se modelan salvo que aparezcan explícitamente en el código analizado.
- Frameworks reactivos (WebFlux/WebClient) se detectan como integración; el flujo reactivo encadenado no se descompone en pasos.
- La configuración externa (variables de entorno, Config Server) no se resuelve; `.env` no se extrae.

## Interpretación semántica
- La agrupación de operaciones en actividades de negocio la hace un LLM y puede equivocarse; por eso se marca `INFERIDA`, se revisa con `bpmn-reviewer` y con comprobaciones deterministas. Esto **no** equivale a verificación formal.
- El porcentaje de elementos con evidencia es una **cobertura de evidencia**, no una medida de fidelidad funcional. La fidelidad funcional no se verifica automáticamente.
- El pipeline CLI sin LLM produce modelos más técnicos (borrador determinista).

## BPMN
- El layout es propio y horizontal por capas; en procesos grandes puede producir diagramas anchos.
- Advertencia aceptada `UNION_IMPLICITA` (bpmnlint `fake-join`) cuando varias ramas confluyen sin compuerta de unión.
- No se modelan eventos de frontera, subprocesos expandidos ni compensaciones salvo que la definición los incluya; el generador acepta el tipo `subProcess` como elemento sin contenido expandido, pero esa vía **no tiene pruebas** y el borrador determinista nunca la produce. Los flujos de retroceso (bucles) tampoco tienen prueba de integración propia.
- Eventos de error/mensaje/timer: tipos básicos (soportados en el generador; solo se prueban los eventos none en los tests).

## Seguridad de ingesta
Controles implementados (`extract_zip.py`): rechazo del ZIP completo ante `..`, rutas absolutas o con unidad, flujos alternos NTFS (`:`), nombres reservados de Windows, enlaces simbólicos, ZIP corrupto o vacío; límites configurables (20 000 archivos, 500 MB totales, 25 MB por archivo, ratio de compresión 200, profundidad 30); lectura con tope de bytes reales; creación exclusiva (sin sobrescribir); exclusión de binarios y directorios irrelevantes; no extracción de `.env`, claves y keystores; redacción de valores sensibles en configuración. Nada del proyecto se ejecuta ni se instala.

Limitación: la detección de secretos es heurística (nombres de clave y bloques PRIVATE KEY); un secreto incrustado en código fuente con otro formato podría llegar a los reportes y al LLM. Revise los reportes antes de compartirlos.

## Confidencialidad
El código que leen los agentes se envía a los proveedores LLM configurados en OpenCode (actualmente `github-copilot`). Los scripts locales no suben nada. Use el sistema solo con proyectos que puedan procesarse en esos proveedores.

## Permisos
Las reglas de `permissions` de los agentes se probaron mediante `opencode api agent.list` y una ejecución real de `/bpmn-discover`; la semántica exacta de patrones de ruta por plataforma (`workspace/*` frente a rutas absolutas) depende de la versión de OpenCode y debe revisarse al actualizar.

## Referencia Bizagi
El inspector no lee ni reporta datos de usuario del paquete `.bpm`. Solo se probó con un archivo de referencia real (22 KB); otras versiones de Bizagi pueden variar en estructura.
