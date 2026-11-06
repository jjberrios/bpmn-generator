// Comprobación mínima de calidad de nombres del diagrama funcional. No sustituye la validación estructural BPMN
// ni demuestra fidelidad funcional: solo detecta nombres evidentemente técnicos, genéricos o con codificación dañada.
const CODE = /[=!<>]=|&&|\|\||->|=>|\s[<>]\s|\b\w+\.\w+\(|\(\)|\bnull\b|\bisBlank\b|\b[a-z]+[A-Z]\w*\b/;
const MOJIBAKE = /[ÃÂ][\u0080-\u00BF\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u02C6\u02DC\u2018-\u201D\u2020-\u2022\u2026\u2030\u2039\u203A\u20AC\u2122]|â€|\uFFFD/;
const TECHNICAL_PREFIX = /^\s*(\d+\s*[.)-]\s*)?¿?\s*(Evaluar|Retorno anticipado|Acceso a datos|Captura|Lanza)\b/i;
const UNRESOLVED_LABEL = /\(no resuelto\)|implementaci[oó]n no resuelta/i;
const GENERIC = /^\s*(\d+\s*[.)-]\s*)?¿?\s*(Actividad|Tarea|Paso|Proceso|Validar condiciones técnicas|Verificar condiciones técnicas)\s*\??\s*$|Cumple la condici[oó]n de\b/i;

export function textIssues(text) {
  const t = String(text ?? '');
  const issues = [];
  if (MOJIBAKE.test(t)) issues.push({ code: 'CODIFICACION_DANADA', message: 'El texto contiene caracteres con codificación dañada.' });
  if (CODE.test(t)) issues.push({ code: 'NOMBRE_EXPRESION_CODIGO', message: 'El nombre reproduce una expresión o llamada de código (operadores, null, llamadas con punto).' });
  if (TECHNICAL_PREFIX.test(t)) issues.push({ code: 'NOMBRE_TECNICO', message: 'El nombre describe una instrucción técnica (Evaluar, Retorno anticipado, Acceso a datos) y no una operación funcional.' });
  if (UNRESOLVED_LABEL.test(t)) issues.push({ code: 'NOMBRE_SIN_SIGNIFICADO', message: 'El nombre expone una limitación de análisis en lugar de describir la operación; la incertidumbre se conserva en el estado de evidencia.' });
  if (GENERIC.test(t)) issues.push({ code: 'NOMBRE_GENERICO', message: 'El nombre es genérico y no describe una operación funcional.' });
  return issues;
}

export function checkNameQuality(definition) {
  const issues = [];
  for (const [kind, list] of [['actividad', definition.activities || []], ['decisión', definition.decisions || []]]) {
    for (const o of list) for (const i of textIssues(o.name)) issues.push({ element_id: o.id, kind, name: o.name, ...i });
  }
  return { valid: !issues.length, issues };
}

// Pendientes de nombre funcional: elementos de la vista sin nombre aprobado en functional-names.json que lo necesitan
// (nombre técnico/genérico, grupo sintético o llamada de comportamiento desconocido). Lo consume el orquestador.
export function namesTodo(detail, view, viewMap, funcNames, methodOf) {
  const traceNodes = new Map([...detail.activities, ...detail.decisions, ...detail.events].map((o) => [o.id, o.trace_node ? [o.trace_node] : o.trace_nodes || []]));
  const byId = new Map([...detail.activities, ...detail.decisions].map((o) => [o.id, o]));
  const items = [];
  for (const [kind, list] of [['actividad', view.activities || []], ['decisión', view.decisions || []]]) {
    for (const o of list) {
      const covered = viewMap.covers?.[o.id] || [o.id];
      if (funcNames[o.id] || covered.some((c) => funcNames[c])) continue;
      const issues = textIssues(o.name).map((i) => i.code);
      const synthetic = /^AF_|^D_VAL_/.test(o.id);
      const unresolved = o.evidence_status === 'DESCONOCIDA';
      if (!issues.length && !synthetic && !unresolved) continue;
      const methods = [...new Set(covered.flatMap((c) => traceNodes.get(c) || []).map((t) => methodOf?.(t)).filter(Boolean))].slice(0, 12);
      const conditions = covered.map((c) => byId.get(c)?.condition_text).filter(Boolean).slice(0, 10);
      items.push({ id: o.id, kind, current_name: o.name, evidence_status: o.evidence_status || null, issues, methods, conditions, description: String(o.description || '').slice(0, 400) });
    }
  }
  return items;
}
