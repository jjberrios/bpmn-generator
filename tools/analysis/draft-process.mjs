// Borrador determinista: traza de ejecución -> process-definition.
// Es una línea base reproducible; el agente process-analyst puede refinarla semánticamente,
// pero siempre debe validarse contra schemas/process-definition.schema.json.
import fs from 'node:fs';
import path from 'node:path';
import { validateContract } from '../validation/schema-validator.mjs';
import { normalizeGateways } from './normalize-gateways.mjs';
import { refineDefinition } from './refine-definition.mjs';

const ROLE_LABEL = {
  controller: 'Controlador',
  service: 'Servicio',
  client: 'Cliente',
  repository: 'Repositorio',
  handler: 'Manejador',
  configuration: 'Configuración',
  other: 'Componente',
};

const slug = (s) => String(s).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'X';
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

export function processIdFor(entry, traceId, used = new Set()) {
  let id = `${entry.class}_${entry.method}`;
  if (used.has(id)) id = `${id}_${traceId}`;
  used.add(id);
  return id;
}

function outcomeKindFromStatus(outcome) {
  const m = /^(\d{3})\b/.exec(outcome || '');
  if (!m) return 'unknown';
  const c = Number(m[1]);
  if (c >= 200 && c < 400) return 'success';
  if (c >= 400 && c < 500) return 'rejection';
  if (c >= 500) return 'error';
  return 'unknown';
}

export function loadAnalysis(projectDir) {
  const dir = path.join(projectDir, 'analysis');
  const traces = readJson(path.join(dir, 'execution-trace.json'));
  const agentFile = path.join(dir, 'execution-trace.agent.json');
  if (fs.existsSync(agentFile)) {
    const agent = readJson(agentFile);
    const v = validateContract('execution-trace', agent);
    if (!v.valid || agent.project_id !== traces.project_id) throw new Error('execution-trace.agent.json inválida o de otro proyecto.');
    const merged = new Map(traces.traces.map((t) => [t.id, t]));
    for (const t of agent.traces) merged.set(t.id, t);
    traces.traces = [...merged.values()];
  }
  return {
    architecture: readJson(path.join(dir, 'architecture-map.json')),
    traces,
    manifestPath: path.join(projectDir, 'repository-manifest.json'),
  };
}

export function draftProcess({ projectDir, traceId, allTraces = null, processId = null }) {
  const { architecture, traces } = loadAnalysis(projectDir);
  let trace = traces.traces.find((t) => t.id === traceId);
  if (processId) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(processId)) throw new Error('process-id inválido.');
    const localFile = path.join(projectDir, 'processes', processId, 'execution-trace.agent.json');
    if (fs.existsSync(localFile)) {
      const local = readJson(localFile);
      const v = validateContract('execution-trace', local);
      if (!v.valid || local.project_id !== traces.project_id) throw new Error('execution-trace.agent.json inválida o de otro proyecto.');
      trace = local.traces.find((t) => t.id === traceId) || trace;
    }
  }
  if (!trace) throw new Error(`Traza no encontrada: ${traceId}`);
  const sourceDir = path.join(projectDir, 'source');
  const nodes = new Map(trace.nodes.map((n) => [n.id, n]));
  const out = new Map();
  for (const e of trace.edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from).push(e);
  }
  const outEdges = (id) => out.get(id) || [];
  const evById = new Map(trace.evidence.map((e) => [e.id, e]));
  const compByClass = new Map(architecture.components.map((c) => [c.class, c]));
  const ep = architecture.entry_points.find((x) => x.id === trace.entry_point_id) || {};

  const isHandlerCatch = (n) => n.type === 'catch' && (n.resolution === 'INDIRECTA' || compByClass.get(n.class)?.kind === 'handler');
  const hasHandlerTarget = (n) => outEdges(n.id).some((e) => nodes.get(e.to) && isHandlerCatch(nodes.get(e.to)));

  function roleOf(n) {
    switch (n.type) {
      case 'entry': return 'start';
      case 'decision': case 'loop': return 'gateway';
      case 'persistence': case 'external_call': case 'unresolved_call': case 'retry': case 'async': case 'action': return 'task';
      case 'return': return n.outcome ? 'end' : (outEdges(n.id).length ? 'task' : 'end');
      case 'throw': return hasHandlerTarget(n) || outEdges(n.id).length ? 'skip' : n.outcome ? 'end' : 'end-unhandled';
      case 'catch': return isHandlerCatch(n) ? 'handler' : 'skip';
      // No contraer una llamada con corredor excepcional: se perdería la
      // separación entre la ejecución normal y la captura del llamador.
      case 'call': return outEdges(n.id).some((e) => e.kind === 'exception') ? 'task' : 'skip';
      default: return 'skip';
    }
  }

  // Claves de fusión: terminales con el mismo resultado y manejadores iguales comparten elemento.
  function keyOf(n) {
    const role = roleOf(n);
    if (role === 'handler') return `H_${slug(n.class)}_${slug(n.method)}`;
    if (role === 'end') return n.outcome ? `END_${slug(n.outcome)}` : `END_${n.id}`;
    if (role === 'end-unhandled') return `END_${slug(n.exception_type || n.id)}_NO_CONTROLADA`;
    if (role === 'start') return `START_${slug(trace.id)}`;
    if (role === 'gateway') return `D_${n.id}`;
    return `A_${n.id}`;
  }

  // Resuelve un nodo hacia los elementos retenidos alcanzados atravesando nodos "skip".
  function resolve(id, via = null, seen = new Set()) {
    const n = nodes.get(id);
    if (!n || seen.has(id)) return [];
    const role = roleOf(n);
    if (role !== 'skip') return [{ node: n, via }];
    seen.add(id);
    const nextVia = n.type === 'throw' ? (n.exception_type || via) : via;
    return outEdges(id).flatMap((e) => resolve(e.to, nextVia, seen));
  }

  const spec = {
    elements: new Map(), // key -> {key, kind, node, nodes[], class}
    flows: [],
    order: [],
    messages: [],
    exceptions: [],
    uncertainties: [],
  };
  const flowKeys = new Set();

  function ensure(node, overrideKey = null) {
    const key = overrideKey || keyOf(node);
    if (!spec.elements.has(key)) {
      spec.elements.set(key, { key, role: roleOf(node), node, trace_nodes: [], classes: [] });
      spec.order.push(key);
    }
    const el = spec.elements.get(key);
    if (!el.trace_nodes.includes(node.id)) el.trace_nodes.push(node.id);
    if (!el.classes.includes(node.class)) el.classes.push(node.class);
    return el;
  }

  function addFlow(from, to, extra = {}) {
    const k = `${from}|${to}|${extra.branch || ''}|${extra.condition || ''}`;
    if (flowKeys.has(k)) return;
    flowKeys.add(k);
    spec.flows.push({ from, to, ...extra });
  }

  const startNode = trace.nodes.find((n) => n.type === 'entry');
  if (!startNode) throw new Error(`La traza ${traceId} no tiene nodo de entrada`);
  const visited = new Set();
  const queue = [startNode];
  ensure(startNode);

  function branchLabel(kind) {
    return kind === 'true' ? 'SI' : kind === 'false' ? 'NO' : kind === 'default' ? 'OTRO CASO' : null;
  }

  while (queue.length) {
    const n = queue.shift();
    if (visited.has(n.id)) continue;
    visited.add(n.id);
    const el = ensure(n);
    const edges = outEdges(n.id);

    if (el.role === 'gateway') {
      for (const e of edges) {
        const branch = e.kind === 'loop_body' ? 'true' : e.kind === 'loop_exit' ? 'false' : e.kind;
        for (const t of resolve(e.to)) {
          const tel = ensure(t.node);
          addFlow(el.key, tel.key, {
            branch,
            condition: branch === 'true' || branch === 'case' ? (e.condition || n.condition) : branch === 'exception' ? `excepción ${e.condition || 'capturada'}` : undefined,
            name: branch === 'case' ? `CASO: ${e.condition}` : branch === 'exception' ? 'EXCEPCIÓN' : branchLabel(branch),
            via: t.via,
            evidence: n.evidence_id,
          });
          queue.push(t.node);
        }
      }
      continue;
    }

    if (el.role === 'end' || el.role === 'end-unhandled') continue;

    if (el.role === 'handler') {
      const endNode = { id: `OUT_${n.id}`, type: 'return', outcome: n.outcome, class: n.class, method: n.method, evidence_id: n.evidence_id, resolution: n.resolution };
      const eel = ensure(endNode, `END_${slug(n.outcome || n.id)}`);
      addFlow(el.key, eel.key, { branch: 'next', evidence: n.evidence_id });
      continue;
    }

    // start / task: flujos normales y excepciones
    const normal = edges.filter((e) => e.kind !== 'exception');
    const excs = edges.filter((e) => e.kind === 'exception');
    const normalTargets = normal.flatMap((e) => resolve(e.to));
    const normalIds = new Set(normalTargets.map((t) => keyOf(t.node)));
    const excBranches = [];
    for (const e of excs) {
      const c = nodes.get(e.to);
      if (!c) continue;
      if (isHandlerCatch(c)) {
        excBranches.push({ catchNode: n, label: e.condition, targets: resolve(c.id), edge: e });
        continue;
      }
      // Una arista excepcional también puede terminar en una acción de limpieza
      // o un error propagado, no exclusivamente en un nodo catch.
      const cont = c.type === 'catch' ? outEdges(c.id).flatMap((x) => resolve(x.to)) : resolve(c.id);
      const contIds = cont.map((t) => keyOf(t.node));
      const swallowed = contIds.length > 0 && contIds.every((k) => normalIds.has(k));
      if (swallowed) {
        spec.exceptions.push({
          trace_node: n.id,
          exception_type: c.exception_type || (c.label || '').replace(/^Captura\s+/, ''),
          description: `Excepción capturada en ${c.class}.${c.method} (línea ${evById.get(c.evidence_id)?.line_start ?? '?'}): el análisis estático encuentra una continuación hacia el flujo normal, pero no garantiza que el catch no relance la excepción (p. ej. mediante un método auxiliar que lanza). Verificar con las limitaciones de la traza.`,
          handled_by: `${c.class}.${c.method}`,
          evidence_id: c.evidence_id,
        });
      } else {
        excBranches.push({ catchNode: c, label: c.exception_type || (c.label || '').replace(/^Captura\s+/, ''), targets: cont, edge: e });
      }
    }

    if (excBranches.length) {
      const gwKey = `D_${n.id}_EXC`;
      const gwNode = { id: `${n.id}_EXC`, type: 'decision', class: n.class, method: n.method, evidence_id: excBranches[0].catchNode.evidence_id, resolution: 'DIRECTA', condition: `excepción ${excBranches.map((b) => b.label).join(' | ')}`, synthetic_from: n.id };
      const gel = ensure(gwNode, gwKey);
      gel.synthetic = true;
      gel.source_task = el.key;
      addFlow(el.key, gel.key, { branch: 'next', evidence: n.evidence_id });
      for (const t of normalTargets) {
        const tel = ensure(t.node);
        addFlow(gel.key, tel.key, { branch: 'next', name: 'NO', evidence: n.evidence_id, synthetic_default: true });
        queue.push(t.node);
      }
      for (const b of excBranches) {
        for (const t of b.targets) {
          const tel = ensure(t.node);
          addFlow(gel.key, tel.key, { branch: 'exception', name: 'SI', condition: `excepción ${b.label}`, evidence: b.catchNode.evidence_id, via: t.via || b.label });
          queue.push(t.node);
        }
      }
    } else {
      for (const t of normalTargets) {
        const tel = ensure(t.node);
        addFlow(el.key, tel.key, { branch: 'next', evidence: n.evidence_id });
        queue.push(t.node);
      }
    }
  }

  // ---------- Evidencias ----------
  const evidence = new Map();
  const addEv = (id) => {
    const e = evById.get(id);
    if (e && !evidence.has(id)) evidence.set(id, e);
    return id;
  };

  function classEvidence(cls) {
    const id = `EVC_${slug(cls)}`;
    if (evidence.has(id)) return id;
    const comp = compByClass.get(cls);
    if (!comp) return null;
    let snippet = '';
    try {
      const lines = fs.readFileSync(path.join(sourceDir, comp.file), 'utf8').split(/\r?\n/);
      snippet = (lines[comp.line - 1] || '').trim().slice(0, 400);
    } catch { /* sin snippet */ }
    evidence.set(id, { id, status: 'CONFIRMADA', file: comp.file, line_start: comp.line, line_end: comp.line, class: cls, ...(snippet ? { snippet } : {}) });
    return id;
  }

  // ---------- Participantes ----------
  const classOrder = [];
  for (const k of spec.order) for (const c of spec.elements.get(k).classes) if (!classOrder.includes(c)) classOrder.push(c);
  const entryModule = (architecture.modules || [])
    .filter((m) => !m.path || m.path === '.' || String(ep.file || '').startsWith(`${m.path}/`))
    .sort((a, b) => String(b.path || '').length - String(a.path || '').length)[0];
  const moduleName = entryModule?.name || architecture.modules?.[0]?.name || path.basename(projectDir);
  const poolId = `PL_${slug(moduleName)}`;
  const participants = [];
  let poolEvidence = [];
  const buildFile = architecture.build_files?.find((b) => (typeof b === 'string' ? b : b.path || b.file) === `${entryModule?.path && entryModule.path !== '.' ? `${entryModule.path}/` : ''}pom.xml`) || architecture.build_files?.[0];
  if (buildFile) {
    const bf = typeof buildFile === 'string' ? buildFile : buildFile.path || buildFile.file;
    try {
      const lines = fs.readFileSync(path.join(sourceDir, bf), 'utf8').split(/\r?\n/);
      const idx = lines.findIndex((l) => l.includes(`<artifactId>${moduleName}</artifactId>`));
      if (idx >= 0) {
        const id = 'EVC_BUILD';
        evidence.set(id, { id, status: 'CONFIRMADA', file: bf, line_start: idx + 1, line_end: idx + 1, snippet: lines[idx].trim().slice(0, 400) });
        poolEvidence = [id];
      }
    } catch { /* sin build */ }
  }
  if (!poolEvidence.length) poolEvidence = [classEvidence(classOrder[0])].filter(Boolean);
  participants.push({
    id: poolId, name: moduleName, kind: 'internal', is_pool: true,
    justification: `Módulo de la aplicación analizada (${moduleName}) que contiene el punto de entrada ${ep.class || ''}.${ep.method || ''}.`,
    evidence_ids: poolEvidence,
  });
  const useLanes = classOrder.length >= 2;
  const laneOf = new Map();
  if (useLanes) {
    for (const cls of classOrder) {
      const comp = compByClass.get(cls);
      const lid = `LN_${slug(cls)}`;
      laneOf.set(cls, lid);
      participants.push({
        id: lid, name: `${ROLE_LABEL[comp?.kind] || ROLE_LABEL.other} ${cls}`, kind: 'internal',
        justification: `Responsabilidad ejecutada por la clase ${cls}${comp ? ` (${comp.kind}, ${comp.file}:${comp.line})` : ''} en este proceso.`,
        evidence_ids: [classEvidence(cls)].filter(Boolean),
      });
    }
  }
  const participantFor = (cls) => (useLanes ? laneOf.get(cls) : poolId);

  // ---------- Elementos ----------
  const activities = [];
  const events = [];
  const decisions = [];
  const idOf = new Map();
  const dataStores = new Map();
  const externals = new Map();

  for (const key of spec.order) {
    const el = spec.elements.get(key);
    const n = el.node;
    const evIds = [...new Set(el.trace_nodes.map((tn) => nodes.get(tn)?.evidence_id || (tn.startsWith('OUT_') ? n.evidence_id : null)).filter(Boolean).concat(n.evidence_id ? [n.evidence_id] : []))].map(addEv);
    const participant_id = participantFor(el.classes[0]);
    idOf.set(key, key);
    const realNodes = el.trace_nodes.filter((t) => nodes.has(t));

    if (el.role === 'start') {
      events.push({ id: key, name: `Recibir ${ep.http_method ? `${ep.http_method} ${ep.path}` : `${ep.class}.${ep.method}`}`, type: 'start', definition: 'none', participant_id, evidence_ids: evIds, evidence_status: 'CONFIRMADA', trace_node: n.id });
    } else if (el.role === 'end' || el.role === 'end-unhandled') {
      const outcome = el.role === 'end-unhandled' ? `Excepción no controlada: ${n.exception_type || 'desconocida'}` : n.outcome ? n.outcome : 'Retorno sin resultado determinado';
      const unresolvedEnd = n.resolution === 'NO_RESUELTA';
      events.push({ id: key, name: el.role === 'end' && n.outcome ? `Respuesta ${n.outcome}` : outcome, type: 'end', definition: 'none', participant_id, evidence_ids: evIds, evidence_status: unresolvedEnd ? 'DESCONOCIDA' : (evById.get(n.evidence_id)?.status || 'CONFIRMADA'), ...(realNodes[0] ? { trace_node: realNodes[0] } : {}), outcome });
      if (unresolvedEnd) {
        const lim = (trace.limitations || []).find((l) => l.node_id === n.id);
        spec.uncertainties.push({ description: lim ? lim.description : `El resultado de ${n.label} no puede resolverse estáticamente (p. ej. estado HTTP de una excepción propagada).`, element_ids: [key], status: 'DESCONOCIDA' });
      }
    } else if (el.role === 'gateway') {
      const cond = n.condition || (n.label || '').replace(/^Decisión:\s*/, '');
      const srcType = spec.elements.get(el.source_task)?.node.type;
      const synthName = srcType === 'external_call' ? '¿Falla la llamada HTTP?' : srcType === 'persistence' ? '¿Falla la persistencia?' : '¿Se produjo una excepción?';
      const rawLabel = (n.label || '').replace(/^Decisión:\s*/, '');
      decisions.push({
        id: key, name: el.synthetic ? synthName : (rawLabel.startsWith('¿') ? rawLabel : `¿${rawLabel}?`),
        gateway: 'exclusive', participant_id, condition_text: cond, evidence_ids: evIds, evidence_status: el.synthetic ? 'INFERIDA' : (evById.get(n.evidence_id)?.status || 'CONFIRMADA'),
        trace_node: el.synthetic ? n.synthetic_from : n.id,
      });
      if (el.synthetic) spec.uncertainties.push({ description: 'Compuerta BPMN deducida del corredor try/catch de la llamada; no es un predicado literal de negocio ni prueba que la excepción ocurra.', element_ids: [key], status: 'INFERIDA' });
    } else if (el.role === 'handler') {
      const types = [...new Set(spec.flows.filter((f) => f.to === key && f.via).map((f) => f.via).concat(nodes.get(realNodes[0])?.exception_type ? [nodes.get(realNodes[0]).exception_type] : []))];
      activities.push({
        id: key, name: `Manejar ${types.length ? types.join(', ') : 'excepción'}`, type: 'task', participant_id,
        description: `Manejador ${n.class}.${n.method} que traduce ${types.join(', ') || 'la excepción'} en la respuesta ${n.outcome || 'HTTP'}.`,
        evidence_ids: evIds, evidence_status: 'CONFIRMADA', trace_nodes: realNodes,
      });
    } else {
      // task
      const a = { id: key, name: (n.label || key).replace(/^Retorno anticipado:\s*/, 'Retorno anticipado: '), type: 'task', participant_id, description: n.label || '', evidence_ids: evIds, evidence_status: 'CONFIRMADA', trace_nodes: realNodes };
      if (n.type === 'persistence') {
        const dsId = `DS_${slug(n.target || 'datos')}`;
        if (!dataStores.has(dsId)) dataStores.set(dsId, { id: dsId, name: `Almacén de datos: ${n.target || 'desconocido'}`, evidence: [] });
        dataStores.get(dsId).evidence.push(...evIds);
        a.type = 'serviceTask';
        a.data_access = [{ data_store_id: dsId, access: n.operation === 'read' ? 'read' : 'write' }];
      } else if (n.type === 'external_call') {
        a.type = 'serviceTask';
        let host = 'destino no resuelto';
        try { host = new URL(String(n.target).replace(/\{[^}]*\}/g, 'x')).host || host; } catch { /* destino dinámico */ }
        const exId = `EXT_${slug(host)}`;
        if (!externals.has(exId)) externals.set(exId, { id: exId, name: `Servicio externo ${host}`, evidence: [], target: n.target });
        externals.get(exId).evidence.push(...evIds);
        a.message_target_participant_id = exId;
        a.name = `Llamar ${n.operation === 'http_get' ? 'GET' : n.operation || 'HTTP'} ${n.target || ''}`.trim();
        let rpath = '';
        try { rpath = decodeURIComponent(new URL(String(n.target)).pathname); } catch { rpath = n.target || ''; }
        spec.messages.push({ activity: key, ext: exId, name: `${n.operation === 'http_get' ? 'GET' : n.operation || 'HTTP'} ${rpath}`, evidence: evIds });
      } else if (n.type === 'unresolved_call') {
        const m = /:\s*([\w.]+\(\))/.exec(n.label || '');
        a.name = `Invocar ${m ? m[1] : 'llamada'} (implementación no resuelta)`;
        a.evidence_status = 'DESCONOCIDA';
        const lim = (trace.limitations || []).find((l) => l.node_id === n.id);
        spec.uncertainties.push({ description: lim ? lim.description : `La llamada ${n.label} no puede resolverse estáticamente.`, element_ids: [key], status: 'DESCONOCIDA' });
        a.description = `Llamada confirmada en el código (${n.label}); su efecto concreto no se puede determinar estáticamente.`;
      }
      activities.push(a);
    }
  }

  for (const ds of dataStores.values()) {
    participants.push({ id: ds.id, name: ds.name, kind: 'data_store', justification: 'Acceso mediante repositorio de persistencia detectado en el código.', evidence_ids: [...new Set(ds.evidence)] });
  }
  for (const ex of externals.values()) {
    participants.push({ id: ex.id, name: ex.name, kind: 'external', justification: `Servicio invocado mediante llamada HTTP en el código (destino ${ex.target}). Se modela como caja negra: no se analiza su comportamiento interno.`, evidence_ids: [...new Set(ex.evidence)] });
  }

  // ---------- Flujos ----------
  const flows = [];
  const flowIdByKey = new Map();
  let fn = 1;
  const decisionByKey = new Map(decisions.map((d) => [d.id, d]));
  for (const f of spec.flows) {
    const id = `F${fn++}`;
    const fl = { id, from: f.from, to: f.to, branch: f.branch };
    if (f.name) fl.name = f.name;
    if (f.condition) fl.condition = f.condition;
    const ev = f.evidence ? [addEv(f.evidence)] : [];
    fl.evidence_ids = ev;
    flows.push(fl);
    const d = decisionByKey.get(f.from);
    if (d && (f.branch === 'false' || f.branch === 'default' || f.synthetic_default)) d.default_flow_id = id;
  }

  const messageFlows = [];
  let mn = 1;
  for (const m of spec.messages) {
    messageFlows.push({ id: `M${mn++}`, from: m.activity, to: m.ext, name: m.name, evidence_ids: m.evidence });
    messageFlows.push({ id: `M${mn++}`, from: m.ext, to: m.activity, name: 'Respuesta', evidence_ids: m.evidence });
  }

  // ---------- Resultados / excepciones ----------
  const termKind = new Map();
  for (const p of trace.paths || []) {
    const t = nodes.get(p.terminal);
    if (!t) continue;
    const key = t.outcome ? t.outcome.replace(/\s*\(.*$/, '') : null;
    if (key && !termKind.has(key)) termKind.set(key, p.kind);
  }
  const outcomes = events.filter((e) => e.type === 'end').map((e, i) => {
    const key = (e.outcome || '').replace(/\s*\(.*$/, '');
    const status = /^(\d{3})/.exec(key)?.[1];
    return { id: `OUT${i + 1}`, name: e.outcome || e.name, kind: termKind.get(key) || outcomeKindFromStatus(key), event_id: e.id, ...(status ? { http_status: key } : {}) };
  });

  const exceptions = [];
  const seenEx = new Set();
  for (const k of spec.order) {
    const el = spec.elements.get(k);
    if (el.role !== 'handler') continue;
    const types = [...new Set(spec.flows.filter((f) => f.to === k && f.via).map((f) => f.via))];
    for (const t of types.length ? types : [el.node.exception_type].filter(Boolean)) {
      const id = `EXC_${slug(t)}_${slug(k)}`;
      if (seenEx.has(id)) continue;
      seenEx.add(id);
      exceptions.push({ id, exception_type: t, description: `La excepción ${t} se traduce en la respuesta ${el.node.outcome || 'HTTP'}.`, handled_by: `${el.node.class}.${el.node.method}`, evidence_ids: [addEv(el.node.evidence_id)] });
    }
  }
  spec.exceptions.forEach((x, i) => exceptions.push({ id: `EXC_CAPTURADA_${i + 1}`, exception_type: x.exception_type, description: x.description, handled_by: x.handled_by, evidence_ids: [addEv(x.evidence_id)] }));

  // ---------- Procesos relacionados ----------
  const sig = (t) => {
    const s = new Set();
    for (const n of t.nodes) {
      if (n.type === 'persistence' && n.target) s.add(`datos:${n.target}`);
      if (n.type === 'external_call' && n.target) s.add(`externo:${n.target}`);
    }
    return s;
  };
  const mySig = sig(trace);
  const used = new Set();
  const related = [];
  const idByTrace = new Map();
  for (const t of traces.traces) idByTrace.set(t.id, processIdFor(t.entry, t.id, used));
  for (const t of traces.traces) {
    if (t.id === trace.id) continue;
    const shared = [...sig(t)].filter((x) => mySig.has(x));
    if (shared.length) related.push({ process_id: idByTrace.get(t.id), relation: `Comparte ${shared.map((x) => x.replace(':', ' ')).join(', ')}` });
  }

  const pid = processId || idByTrace.get(trace.id);
  const label = ep.http_method ? `${ep.http_method} ${ep.path}` : `${ep.class}.${ep.method}`;
  const unresolvedCount = spec.uncertainties.length;

  const def = {
    schema_version: '1.0',
    id: pid,
    name: `${trace.entry.method} — ${label}`,
    description: `Comportamiento observable de ${label} implementado en ${trace.entry.class}.${trace.entry.method}, reconstruido desde el análisis estático del código.`,
    entry_point: {
      entry_point_id: trace.entry_point_id, kind: ep.kind || trace.entry.kind, ...(ep.http_method ? { http_method: ep.http_method } : {}), ...(ep.path ? { path: ep.path } : {}),
      class: trace.entry.class, method: trace.entry.method, ...(ep.file ? { file: ep.file } : {}), ...(ep.line ? { line: ep.line } : {}), trace_id: trace.id,
    },
    abstraction_level: 'BACKEND_OBSERVABLE',
    scope_note: 'Solo se modela el comportamiento observable del backend sustentado por el código analizado. No se asumen actividades de usuarios, aprobaciones ni operaciones manuales. Los servicios externos se representan como cajas negras. Los métodos internos de simple delegación se agrupan y no aparecen como tareas.',
    participants,
    activities,
    events,
    decisions,
    flows,
    ...(messageFlows.length ? { message_flows: messageFlows } : {}),
    outcomes,
    exceptions,
    ...(related.length ? { related_processes: related } : {}),
    evidence: [...evidence.values()],
    uncertainties: spec.uncertainties.map((u, i) => ({ id: `U${i + 1}`, ...u })),
    review_status: { state: 'PENDIENTE' },
  };
  if (unresolvedCount === 0) def.uncertainties = [];
  return refineDefinition(normalizeGateways(def));
}

export function discoverCandidates(projectDir) {
  const { architecture, traces } = loadAnalysis(projectDir);
  const used = new Set();
  const out = [];
  const compByClass = new Map(architecture.components.map((c) => [c.class, c]));
  for (const t of traces.traces) {
    const processId = processIdFor(t.entry, t.id, used);
    const ep = architecture.entry_points.find((x) => x.id === t.entry_point_id) || {};
    const classes = [...new Set(t.nodes.map((n) => n.class).filter(Boolean))];
    const packages = [...new Set(classes.map((c) => compByClass.get(c)?.package).filter(Boolean))];
    const decisionsN = t.nodes.filter((n) => n.type === 'decision').length;
    const integr = [...new Set(t.nodes.filter((n) => n.type === 'external_call' || n.type === 'persistence').map((n) => `${n.type === 'persistence' ? 'BD' : 'HTTP'}: ${n.target || n.mechanism}`))];
    const unresolved = t.nodes.filter((n) => n.type === 'unresolved_call' || n.resolution === 'NO_RESUELTA').length;
    const substantive = t.nodes.filter((n) => ['decision', 'persistence', 'external_call', 'return', 'throw'].includes(n.type)).length;
    let sufficiency = 'SUFICIENTE';
    let reason = 'Ruta de ejecución reconstruida con evidencias directas.';
    if (substantive < 2) { sufficiency = 'INSUFICIENTE'; reason = 'La traza no contiene suficientes operaciones observables para un proceso.'; }
    else if (unresolved) { sufficiency = 'PARCIAL'; reason = `${unresolved} llamada(s) no resueltas estáticamente; se modelan como desconocidas.`; }
    else if (t.limitations?.length || /^NO_RESUELTA:/.test(ep.path || '')) {
      sufficiency = 'PARCIAL';
      reason = `La traza conserva ${t.limitations?.length || 0} limitación(es) de análisis${/^NO_RESUELTA:/.test(ep.path || '') ? ' y una ruta REST simbólica' : ''}; no se afirma reconstrucción exhaustiva.`;
    }
    out.push({
      process_id: processId, trace_id: t.id, entry_point_id: t.entry_point_id, name: `${t.entry.method} — ${ep.http_method ? `${ep.http_method} ${ep.path}` : `${t.entry.class}.${t.entry.method}`}`,
      entry_point: { class: t.entry.class, method: t.entry.method, kind: ep.kind, http_method: ep.http_method, path: ep.path, file: ep.file, line: ep.line },
      description: `Backend observable iniciado en ${t.entry.class}.${t.entry.method}.`,
      classes, packages, decisions: decisionsN, paths: (t.paths || []).length, outcomes: [...new Set(t.nodes.filter((n) => ['return', 'catch', 'throw'].includes(n.type) && n.outcome).map((n) => n.outcome))],
      integrations: integr, unresolved_calls: unresolved, evidence_sufficiency: sufficiency, sufficiency_reason: reason,
    });
  }
  return out;
}
