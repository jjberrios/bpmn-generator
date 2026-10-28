// Revisión determinista de una definición de proceso contra la traza y el código fuente.
// Complementa (no sustituye) la revisión semántica del agente bpmn-reviewer.
import fs from 'node:fs';
import path from 'node:path';
import { validateContract } from './schema-validator.mjs';
import { checkDefinition } from './definition-checks.mjs';

export const REVIEWER_NAME = 'review-checks (determinista)';
const SEVERITIES = ['CRÍTICO', 'ALTO', 'MEDIO', 'BAJO', 'INFORMATIVO'];

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const normOutcome = (s) => norm(String(s ?? '').replace(/\s*\(vía[^)]*\)\s*$/i, ''));
const genericReturn = (s) => /^(?:HTTP\s+)?200\s+OK\s*\(retorno directo(?:; código por defecto de Spring MVC)?\)$/i.test(norm(s));
const httpStatus = (s) => String(s).match(/(?:HTTP\s+)?\b([1-5]\d\d)\b/i)?.[1];
// Un retorno genérico no describe el contenido del audit ni prueba su fidelidad.
const outcomeMatches = (expected, actual) => expected === actual || (genericReturn(expected) && httpStatus(actual) === '200');

function readSourceLines(sourceDir, file, cache) {
  if (!sourceDir) return { error: 'SIN_FUENTE' };
  const root = path.resolve(sourceDir);
  const full = path.resolve(root, file);
  if (full !== root && !full.startsWith(root + path.sep)) return { error: 'RUTA_FUERA_DEL_PROYECTO' };
  if (cache.has(full)) return cache.get(full);
  let result;
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile()) result = { error: 'NO_ES_ARCHIVO' };
    else result = { lines: fs.readFileSync(full, 'utf8').split(/\r?\n/) };
  } catch {
    result = { error: 'ARCHIVO_INEXISTENTE' };
  }
  cache.set(full, result);
  return result;
}

function buildTraceIndex(trace) {
  const nodes = new Map((trace?.nodes ?? []).map((n) => [n.id, n]));
  const out = new Map();
  for (const e of trace?.edges ?? []) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from).push(e);
  }
  return { nodes, out };
}

function traceOutcomesFrom(idx, startId) {
  const result = new Set();
  const seen = new Set();
  const stack = [startId];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const edges = idx.out.get(id) ?? [];
    const node = idx.nodes.get(id);
    if (edges.length === 0 && node?.outcome) result.add(normOutcome(node.outcome));
    for (const e of edges) stack.push(e.to);
  }
  return result;
}

function buildDefIndex(def) {
  const elements = new Map();
  for (const a of def.activities ?? []) elements.set(a.id, { ...a, _kind: 'activity' });
  for (const e of def.events ?? []) elements.set(e.id, { ...e, _kind: 'event' });
  for (const d of def.decisions ?? []) elements.set(d.id, { ...d, _kind: 'decision' });
  const out = new Map();
  for (const f of def.flows ?? []) {
    if (!out.has(f.from)) out.set(f.from, []);
    out.get(f.from).push(f);
  }
  return { elements, out };
}

function defOutcomesFrom(didx, startId) {
  const result = new Set();
  const seen = new Set();
  const stack = [startId];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const el = didx.elements.get(id);
    if (el?._kind === 'event' && el.type === 'end' && el.outcome) result.add(normOutcome(el.outcome));
    for (const f of didx.out.get(id) ?? []) stack.push(f.to);
  }
  return result;
}

export function reviewProcess({ definition, trace = null, sourceDir = null, reviewer = REVIEWER_NAME }) {
  const findings = [];
  const unconfirmed = [];
  const add = (severity, category, element_id, description, recommendation, refs) => {
    findings.push({
      id: `R${findings.length + 1}`,
      severity,
      category,
      ...(element_id ? { element_id } : {}),
      description,
      ...(refs && refs.length ? { evidence_refs: refs } : {}),
      recommendation,
      source: 'automatico',
    });
  };

  const def = definition;
  const evById = new Map((def.evidence ?? []).map((e) => [e.id, e]));
  const traceEv = new Map((trace?.evidence ?? []).map((e) => [e.id, e]));
  const atSameLine = (a, b) => a?.file && a.file === b?.file && a.line_start && b.line_start && a.line_start <= (b.line_end ?? b.line_start) && b.line_start <= (a.line_end ?? a.line_start);
  const backedBy = (el, node) => (el.evidence_ids ?? []).some((id) => atSameLine(evById.get(id), traceEv.get(node.evidence_id)));
  const traceRefs = (n) => {
    const e = traceEv.get(n.evidence_id);
    return e ? [{ file: e.file, line_start: e.line_start, line_end: e.line_end ?? e.line_start }] : [];
  };
  const refsOf = (ids) =>
    (ids ?? [])
      .map((id) => evById.get(id))
      .filter(Boolean)
      .map((e) => ({
        file: e.file,
        ...(e.line_start ? { line_start: e.line_start } : {}),
        ...(e.line_end ? { line_end: e.line_end } : {}),
        ...(e.class ? { class: e.class } : {}),
        ...(e.method ? { method: e.method } : {}),
      }));

  // 1. Contrato y estructura
  const schemaResult = validateContract('process-definition', def);
  if (!schemaResult.valid) {
    for (const err of schemaResult.errors.slice(0, 20)) {
      add('CRÍTICO', 'ESTRUCTURA', undefined, `La definición no cumple el contrato process-definition: ${typeof err === 'string' ? err : JSON.stringify(err)}`, 'Corregir la definición antes de continuar.');
    }
  }
  let structural = { errors: [], warnings: [] };
  try {
    structural = checkDefinition(def);
  } catch (e) {
    add('CRÍTICO', 'ESTRUCTURA', undefined, `No se pudo comprobar la estructura de la definición: ${e.message}`, 'Corregir la definición.');
  }
  for (const err of structural.errors) {
    add('CRÍTICO', 'ESTRUCTURA', err.element_id, `${err.code}: ${err.message}`, 'Corregir la definición del proceso.');
  }

  const didx = buildDefIndex(def);
  const tidx = trace ? buildTraceIndex(trace) : null;

  // 2. Evidencias: existencia de archivo, rango y fragmento
  const cache = new Map();
  let verifiable = true;
  for (const ev of def.evidence ?? []) {
    if (ev.status === 'DESCONOCIDA' && !ev.file) continue;
    if (!ev.file) {
      add('ALTO', 'EVIDENCIA_INEXISTENTE', ev.id, `La evidencia ${ev.id} (${ev.status}) no indica archivo.`, 'Indicar archivo y líneas o marcar el elemento como DESCONOCIDO.');
      continue;
    }
    const src = readSourceLines(sourceDir, ev.file, cache);
    if (src.error === 'SIN_FUENTE') {
      verifiable = false;
      continue;
    }
    if (src.error) {
      add('CRÍTICO', 'EVIDENCIA_INEXISTENTE', ev.id, `La evidencia ${ev.id} apunta a "${ev.file}" que no existe en el proyecto analizado (${src.error}).`, 'Eliminar el elemento o corregir la referencia.', [{ file: ev.file }]);
      continue;
    }
    const total = src.lines.length;
    const start = ev.line_start;
    const end = ev.line_end ?? ev.line_start;
    if (start && (start > total || end > total || end < start)) {
      add('CRÍTICO', 'EVIDENCIA_INEXISTENTE', ev.id, `La evidencia ${ev.id} cita las líneas ${start}-${end} de ${ev.file}, que tiene ${total} líneas.`, 'Corregir las líneas citadas.', refsOf([ev.id]));
      continue;
    }
    if (start && ev.snippet) {
      const slack = 0;
      const text = norm(src.lines.slice(Math.max(0, start - 1 - slack), end + slack).join(' '));
      const snip = norm(ev.snippet);
      if (!text.includes(snip) && !snip.includes(text)) {
        add('ALTO', 'EVIDENCIA_INEXISTENTE', ev.id, `El fragmento citado en ${ev.id} no aparece en ${ev.file}:${start}-${end}.`, 'Verificar la cita contra el código fuente.', refsOf([ev.id]));
      }
    }
  }
  if (!verifiable && sourceDir == null) {
    add('INFORMATIVO', 'OTRO', undefined, 'No se proporcionó el directorio fuente: no se verificaron archivos, líneas ni fragmentos de las evidencias.', 'Ejecutar la revisión indicando el directorio source del proyecto.');
  }

  // 3. Elementos: evidencia presente y consistente
  const elementLabel = (el) => `${el._kind === 'activity' ? 'La actividad' : el._kind === 'event' ? 'El evento' : 'La decisión'} "${el.name}" (${el.id})`;
  for (const el of didx.elements.values()) {
    const ids = el.evidence_ids ?? [];
    const missing = ids.filter((id) => !evById.has(id));
    for (const id of missing) {
      add('ALTO', 'EVIDENCIA_INEXISTENTE', el.id, `${elementLabel(el)} cita la evidencia ${id}, que no está definida.`, 'Definir la evidencia o retirar la referencia.');
    }
    const status = el.evidence_status;
    if (ids.length === 0 && status !== 'DESCONOCIDA') {
      add(status === 'CONFIRMADA' ? 'CRÍTICO' : 'ALTO', 'ACTIVIDAD_SIN_EVIDENCIA', el.id, `${elementLabel(el)} no tiene evidencia y figura como ${status}.`, 'Respaldar el elemento con archivo, clase, método y líneas, o eliminarlo.');
    }
    if (status === 'INFERIDA' || status === 'DESCONOCIDA') {
      unconfirmed.push({
        element_id: el.id,
        status,
        reason: status === 'DESCONOCIDA' ? `No hay evidencia suficiente para resolver ${el.name}.` : `Comportamiento deducido, no confirmado directamente por el código: ${el.name}.`,
      });
      add(status === 'DESCONOCIDA' ? 'MEDIO' : 'BAJO', 'INFERENCIA_NO_CONFIRMADA', el.id, `${elementLabel(el)} está marcado como ${status}.`, 'Verificar manualmente o complementar la evidencia.', refsOf(ids));
    }
    if (tidx && el.trace_nodes) {
      for (const tn of el.trace_nodes) {
        if (!tidx.nodes.has(tn)) {
          add('ALTO', 'ACTIVIDAD_INVENTADA', el.id, `${elementLabel(el)} referencia el nodo de traza ${tn}, que no existe.`, 'Eliminar la actividad o vincularla a un nodo real de la traza.');
        }
      }
    }
    if (tidx && el.trace_node && !tidx.nodes.has(el.trace_node)) {
      add('ALTO', 'ACTIVIDAD_INVENTADA', el.id, `${elementLabel(el)} referencia el nodo de traza ${el.trace_node}, que no existe.`, 'Eliminar el elemento o vincularlo a un nodo real de la traza.');
    }
    if (tidx && el._kind === 'activity' && status === 'CONFIRMADA') {
      const unresolved = (el.trace_nodes ?? []).map((id) => tidx.nodes.get(id)).filter((n) => n && (n.type === 'unresolved_call' || n.resolution === 'NO_RESUELTA'));
      if (unresolved.length) {
        add('ALTO', 'COMPORTAMIENTO_NO_RESUELTO', el.id, `${elementLabel(el)} figura CONFIRMADA pero el análisis estático no pudo resolver su invocación (${unresolved[0].label}).`, 'Marcarla como DESCONOCIDA y registrar la incertidumbre.');
      }
    }
  }

  // 4. Participantes
  for (const p of def.participants ?? []) {
    const hasEv = (p.evidence_ids ?? []).length > 0;
    const hasJust = norm(p.justification).length >= 10;
    if (p.kind === 'external' && !hasEv) {
      add('ALTO', 'PARTICIPANTE_INJUSTIFICADO', p.id, `El participante externo "${p.name}" no tiene evidencia que lo respalde.`, 'Respaldarlo con la integración que lo invoca o eliminarlo.');
    } else if (!hasEv && !hasJust) {
      add('MEDIO', 'PARTICIPANTE_INJUSTIFICADO', p.id, `El participante/carril "${p.name}" no tiene justificación ni evidencia.`, 'Justificar la responsabilidad con código o eliminarlo.');
    }
    if (p.kind === 'data_store') {
      for (const id of p.evidence_ids ?? []) {
        if (!evById.has(id)) add('ALTO', 'EVIDENCIA_INEXISTENTE', p.id, `El almacén "${p.name}" cita la evidencia inexistente ${id}.`, 'Corregir la referencia del almacén.');
      }
      const uncertainties = (def.uncertainties ?? []).filter((u) => u.element_ids?.includes(p.id));
      const statuses = [...(p.evidence_ids ?? []).map((id) => evById.get(id)?.status), ...uncertainties.map((u) => u.status)];
      const status = statuses.includes('DESCONOCIDA') ? 'DESCONOCIDA' : statuses.includes('INFERIDA') ? 'INFERIDA' : null;
      if (status) {
        const reason = uncertainties.map((u) => u.description).join(' ') || p.justification;
        unconfirmed.push({ element_id: p.id, status, reason });
        add(status === 'DESCONOCIDA' ? 'MEDIO' : 'BAJO', 'INFERENCIA_NO_CONFIRMADA', p.id, `El almacén "${p.name}" contiene aspectos ${status === 'DESCONOCIDA' ? 'desconocidos' : 'inferidos'}: ${reason}`, 'No deducir efectos internos ni transaccionales a partir del nombre o de un cursor de salida.', refsOf(p.evidence_ids));
      }
    }
  }

  // 5. Contraste con la traza
  if (tidx) {
    const claimedNodes = new Set();
    for (const n of tidx.nodes.values()) {
      if ([...didx.elements.values()].some((el) => backedBy(el, n))) claimedNodes.add(n.id);
    }
    for (const a of def.activities ?? []) for (const n of a.trace_nodes ?? []) claimedNodes.add(n);
    for (const e of def.events ?? []) if (e.trace_node) claimedNodes.add(e.trace_node);
    for (const d of def.decisions ?? []) if (d.trace_node) claimedNodes.add(d.trace_node);
    const decisionByTrace = new Map();
    for (const d of def.decisions ?? []) if (d.trace_node) decisionByTrace.set(d.trace_node, d);
    for (const n of tidx.nodes.values()) {
      if (n.type !== 'decision' || decisionByTrace.has(n.id)) continue;
      const matches = (def.decisions ?? []).filter((d) => backedBy(d, n));
      // Una evidencia amplia de try/catch puede solaparse con varias decisiones.
      // Priorizar la expresión literal; no adjudicar arbitrariamente la primera.
      const exact = matches.filter((d) => norm(d.condition_text) === norm(n.condition));
      const d = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : null;
      if (d) decisionByTrace.set(n.id, d);
    }
    const uncertaintyEls = new Set((def.uncertainties ?? []).flatMap((u) => u.element_ids ?? []));

    // 5a. Operaciones importantes omitidas y comportamiento no resuelto
    for (const n of tidx.nodes.values()) {
      if (['persistence', 'external_call', 'async', 'retry'].includes(n.type) && !claimedNodes.has(n.id)) {
        add('ALTO', 'OPERACION_OMITIDA', n.id, `La traza contiene la operación "${n.label}" (${n.type}, nodo ${n.id}) que no está representada en el proceso.`, 'Incorporar una actividad que la represente.', traceRefs(n));
      }
      if (n.type !== 'catch' && (n.type === 'unresolved_call' || n.resolution === 'NO_RESUELTA')) {
        const owner = (def.activities ?? []).find((a) => (a.trace_nodes ?? []).includes(n.id)) ?? (def.events ?? []).find((e) => e.trace_node === n.id);
        const registered = owner && (owner.evidence_status === 'DESCONOCIDA' || uncertaintyEls.has(owner.id));
        if (!owner) {
          add('ALTO', 'COMPORTAMIENTO_NO_RESUELTO', n.id, `La llamada no resuelta "${n.label}" no aparece en el proceso ni en las incertidumbres.`, 'Registrar la llamada como actividad DESCONOCIDA con su incertidumbre.');
        } else if (registered) {
          add('INFORMATIVO', 'COMPORTAMIENTO_NO_RESUELTO', owner.id, `Comportamiento no resuelto estáticamente y correctamente declarado como incierto: ${n.label}.`, 'Verificar la implementación real (inyección de dependencias, perfiles).');
        }
      }
    }

    // 5b. Decisiones y ramas
    for (const [tid, node] of tidx.nodes) {
      if (node.type !== 'decision') continue;
      // Guardas técnicas de cierre pueden quedar agrupadas, no se exige una XOR por close.
      const technicalClose = /^(?:\()?\s*\w+\s*!=\s*null\s*(?:\))?$/.test(node.condition ?? '') && (traceEv.get(node.evidence_id)?.snippet ?? '').includes('!= null');
      if (technicalClose && (def.activities ?? []).some((a) => backedBy(a, node))) continue;
      if (!decisionByTrace.has(tid)) {
        add('ALTO', 'RAMA_OMITIDA', tid, `La decisión de código "${node.condition ?? node.label}" (nodo ${tid}) no está representada como compuerta.`, 'Agregar la compuerta con todas sus ramas.', traceRefs(node));
      }
    }
    for (const [traceNodeId, d] of decisionByTrace) {
      const tnode = tidx.nodes.get(traceNodeId);
      if (!tnode) continue;
      const tedges = tidx.out.get(traceNodeId) ?? [];
      const dflows = didx.out.get(d.id) ?? [];
      const refs = refsOf(d.evidence_ids);

      if (tnode.type === 'decision' && tnode.condition && norm(d.condition_text) !== norm(tnode.condition)) {
        add('ALTO', 'DECISION_MAL_INTERPRETADA', d.id, `La condición de ${d.id} ("${d.condition_text}") no coincide con la del código ("${tnode.condition}").`, 'Corregir la condición según el código fuente.', refs);
      }
      // Una excepción puede separarse antes de evaluar el predicado de negocio.
      // Admitir sólo un corredor entrante único, por la salida normal de una XOR
      // respaldada por la misma evidencia, hacia el catch también respaldado.
      let wrappedException = null;
      let cursor = d.id;
      const visited = new Set();
      while (!visited.has(cursor)) {
        visited.add(cursor);
        const incoming = (def.flows ?? []).filter((f) => f.to === cursor);
        if (incoming.length !== 1) break;
        const normal = incoming[0];
        const owner = didx.elements.get(normal.from);
        const outputs = didx.out.get(normal.from) ?? [];
        if (outputs.length > 1) {
          if (owner?._kind !== 'decision' || normal.id !== owner.default_flow_id) break;
          if (backedBy(owner, tnode)) {
            const te = tedges.find((e) => e.kind === 'exception');
            wrappedException = outputs.find((f) => f.branch === 'exception' && te && backedBy(didx.elements.get(f.to) ?? {}, tidx.nodes.get(te.to)));
            if (wrappedException) break;
          }
        }
        cursor = normal.from;
      }
      const branchFlow = (kind) => {
        const normalized = kind === 'loop_body' ? 'true' : kind === 'loop_exit' ? 'false' : kind;
        return dflows.find((f) => f.branch === normalized || (['false', 'next', 'default'].includes(normalized) && (['false', 'default', 'next'].includes(f.branch) || f.id === d.default_flow_id))) ?? (kind === 'exception' ? wrappedException : null);
      };
      for (const edge of tedges) {
        if (!branchFlow(edge.kind)) add('ALTO', 'RAMA_OMITIDA', d.id, `${d.id} no representa la salida ${edge.kind} del código, ni directamente ni mediante un corredor excepcional respaldado.`, 'Representar la rama y su destino con evidencia.', refs);
      }
      const side = (kinds) => {
        const edge = tedges.find((e) => kinds.includes(e.kind));
        return edge ? traceOutcomesFrom(tidx, edge.to) : null;
      };
      const flowSide = (pred) => {
        const flow = dflows.find(pred);
        return flow ? defOutcomesFrom(didx, flow.to) : null;
      };
      const pairs = [
        ['verdadera', side(['true']), flowSide((f) => f.branch === 'true')],
        ['falsa/alternativa', side(['false', 'next', 'default']), flowSide((f) => ['false', 'default', 'next'].includes(f.branch) || f.id === d.default_flow_id)],
        ['excepcional', side(['exception']), branchFlow('exception') ? defOutcomesFrom(didx, branchFlow('exception').to) : null],
      ];
      for (const [label, expected, actual] of pairs) {
        if (!expected || !actual) continue;
        // Comparación exacta cuando la traza describe resultados específicos; no exigir
        // igualdad de cardinalidad al refinar un retorno genérico en varios audit.
        const differ = [...expected].some((o) => ![...actual].some((a) => outcomeMatches(o, a))) || [...actual].some((a) => ![...expected].some((o) => outcomeMatches(o, a)));
        if (differ) {
          add('ALTO', 'DECISION_MAL_INTERPRETADA', d.id, `En ${d.id} la rama ${label} conduce a [${[...actual].join(' | ') || 'ningún resultado'}] pero el código conduce a [${[...expected].join(' | ') || 'ningún resultado'}].`, 'Revisar el sentido de las ramas (posible inversión) y los resultados alcanzables.', refs);
        }
      }
    }

    // 5c. Resultados (rutas terminales) y eventos finales
    const traceOutcomes = new Set();
    for (const p of trace.paths ?? []) {
      const t = tidx.nodes.get(p.terminal);
      if (t?.outcome) traceOutcomes.add(normOutcome(t.outcome));
    }
    const defOutcomes = new Set((def.events ?? []).filter((e) => e.type === 'end' && e.outcome).map((e) => normOutcome(e.outcome)));
    for (const o of traceOutcomes) {
      if (![...defOutcomes].some((a) => outcomeMatches(o, a))) {
        add('ALTO', 'RAMA_OMITIDA', undefined, `El código puede terminar con el resultado "${o}" y el proceso no tiene un evento final que lo represente.`, 'Agregar la ruta y el evento final correspondientes.');
      }
    }
    for (const e of def.events ?? []) {
      if (e.type === 'end' && e.outcome && traceOutcomes.size && ![...traceOutcomes].some((o) => outcomeMatches(o, normOutcome(e.outcome)))) {
        add('ALTO', 'EVENTO_INCOHERENTE', e.id, `El evento final ${e.id} declara el resultado "${e.outcome}", que no existe entre los resultados del código.`, 'Eliminar el evento o respaldarlo con evidencia.', refsOf(e.evidence_ids));
      }
    }
  } else {
    add('INFORMATIVO', 'OTRO', undefined, 'No se proporcionó la traza de ejecución: no se contrastaron ramas, decisiones ni operaciones omitidas.', 'Ejecutar la revisión indicando execution-trace.json.');
  }

  return finalizeReport({ process_id: def.id, reviewer, findings, unconfirmed_inferences: unconfirmed });
}

export function finalizeReport({ process_id, reviewer, findings, unconfirmed_inferences = [] }) {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  const renumbered = findings.map((f, i) => ({ ...f, id: `R${i + 1}` }));
  for (const f of renumbered) counts[f.severity]++;
  let verdict = 'APROBADO';
  if (counts['CRÍTICO'] > 0 || counts['ALTO'] > 0) verdict = 'RECHAZADO';
  else if (counts['MEDIO'] > 0 || unconfirmed_inferences.length > 0) verdict = 'APROBADO_CON_OBSERVACIONES';
  const summary =
    `Veredicto ${verdict}. Hallazgos: ${SEVERITIES.map((s) => `${s}=${counts[s]}`).join(', ')}. ` +
    `Inferencias o comportamientos no confirmados: ${unconfirmed_inferences.length}. ` +
    'Este recuento mide trazabilidad y consistencia con el código; no es una medida de fidelidad funcional comprobada.';
  return { schema_version: '1.0', process_id, reviewer, verdict, findings: renumbered, unconfirmed_inferences, counts, summary };
}

export function mergeReports(process_id, reports, reviewer = 'bpmn-orchestrator (consolidado)') {
  const findings = reports.flatMap((r) => r.findings);
  const seen = new Set();
  const unconfirmed = [];
  for (const r of reports) {
    for (const u of r.unconfirmed_inferences ?? []) {
      const key = `${u.element_id}|${u.status}`;
      if (!seen.has(key)) {
        seen.add(key);
        unconfirmed.push(u);
      }
    }
  }
  return finalizeReport({ process_id, reviewer, findings, unconfirmed_inferences: unconfirmed });
}

export function reviewFiles({ definitionPath, tracePath = null, sourceDir = null }) {
  const definition = JSON.parse(fs.readFileSync(definitionPath, 'utf8'));
  let trace = null;
  if (tracePath) {
    const all = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
    const wanted = definition.entry_point?.trace_id;
    trace = (all.traces ?? []).find((t) => t.id === wanted) ?? null;
  }
  return reviewProcess({ definition, trace, sourceDir });
}
