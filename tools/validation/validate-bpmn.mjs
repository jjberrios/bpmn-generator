// Validador BPMN determinista: XML + semántica + BPMN DI + trazabilidad + bpmnlint + round-trip.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { BpmnModdle } from 'bpmn-moddle';

const require = createRequire(import.meta.url);
const { Linter } = require('bpmnlint');
const StaticResolver = require('bpmnlint/lib/resolver/static-resolver');
const recommended = require('bpmnlint/config/recommended');


const FLOW_NODE_TYPES = ['bpmn:Task', 'bpmn:ServiceTask', 'bpmn:SendTask', 'bpmn:ReceiveTask', 'bpmn:ScriptTask', 'bpmn:UserTask', 'bpmn:ManualTask', 'bpmn:BusinessRuleTask', 'bpmn:SubProcess', 'bpmn:StartEvent', 'bpmn:EndEvent', 'bpmn:IntermediateCatchEvent', 'bpmn:IntermediateThrowEvent', 'bpmn:BoundaryEvent', 'bpmn:ExclusiveGateway', 'bpmn:ParallelGateway', 'bpmn:InclusiveGateway', 'bpmn:EventBasedGateway', 'bpmn:ComplexGateway', 'bpmn:CallActivity'];
const isFlowNode = (e) => FLOW_NODE_TYPES.includes(e.$type);
const isGateway = (e) => e.$type.endsWith('Gateway');

function lintRulesCache() {
  const cache = {};
  for (const name of Object.keys(recommended.rules)) cache[`rule:bpmnlint/${name}`] = require(`bpmnlint/rules/${name}`);
  return cache;
}

async function runBpmnlint(rootElement) {
  const linter = new Linter({ config: { rules: recommended.rules }, resolver: new StaticResolver(lintRulesCache()) });
  const reports = await linter.lint(rootElement);
  const out = [];
  for (const [rule, items] of Object.entries(reports)) {
    for (const r of items) out.push({ rule, id: r.id, message: r.message, category: r.category });
  }
  return out;
}

function boundaryContains(pt, b, tol = 3) {
  const onX = Math.abs(pt.x - b.x) <= tol || Math.abs(pt.x - (b.x + b.width)) <= tol;
  const onY = Math.abs(pt.y - b.y) <= tol || Math.abs(pt.y - (b.y + b.height)) <= tol;
  const inX = pt.x >= b.x - tol && pt.x <= b.x + b.width + tol;
  const inY = pt.y >= b.y - tol && pt.y <= b.y + b.height + tol;
  return (onX && inY) || (onY && inX);
}
const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const inside = (inner, outer, tol = 1) => inner.x >= outer.x - tol && inner.y >= outer.y - tol && inner.x + inner.width <= outer.x + outer.width + tol && inner.y + inner.height <= outer.y + outer.height + tol;

function collectFlowElements(container, acc = { nodes: [], flows: [], containers: [] }) {
  acc.containers.push(container);
  for (const el of container.flowElements || []) {
    if (el.$type === 'bpmn:SequenceFlow') acc.flows.push({ el, container });
    else if (isFlowNode(el)) { acc.nodes.push({ el, container }); if (el.$type === 'bpmn:SubProcess') collectFlowElements(el, acc); }
  }
  return acc;
}

/**
 * Valida un BPMN (XML en texto). `definition` (process-definition) es opcional y activa la comprobación de trazabilidad.
 * @returns {Promise<object>} informe de validación
 */
export async function validateBpmnXml(xml, { definition = null, sidecar = null } = {}) {
  const issues = [];
  const add = (severity, code, element_id, message) => issues.push({ severity, code, element_id: element_id || null, message });
  const checks = {};
  const mark = (name, startLen) => { checks[name] = issues.slice(startLen).some((i) => i.severity === 'ERROR') ? 'FALLO' : issues.slice(startLen).some((i) => i.severity === 'ADVERTENCIA') ? 'ADVERTENCIA' : 'OK'; };

  const moddle = new BpmnModdle();
  let parsed;
  let n0 = issues.length;
  try {
    parsed = await moddle.fromXML(xml);
  } catch (e) {
    add('ERROR', 'XML_NO_PARSEABLE', null, `El XML no se puede interpretar como BPMN 2.0: ${e.message}`);
    mark('xml_parseable', n0);
    return finish(issues, checks, null);
  }
  const root = parsed.rootElement;
  for (const w of parsed.warnings || []) add('ERROR', /unresolved reference/i.test(w.message) ? 'REFERENCIA_ROTA' : 'XML_ADVERTENCIA_PARSER', w.element?.id, w.message);
  mark('xml_parseable', n0);

  // ---- ids únicos ----
  n0 = issues.length;
  const idCounts = new Map();
  for (const m of xml.matchAll(/\sid="([^"]+)"/g)) idCounts.set(m[1], (idCounts.get(m[1]) || 0) + 1);
  for (const [id, c] of idCounts) if (c > 1) add('ERROR', 'ID_DUPLICADO', id, `El identificador ${id} aparece ${c} veces`);
  mark('ids_unicos', n0);

  // ---- estructura ----
  n0 = issues.length;
  const processes = (root.rootElements || []).filter((r) => r.$type === 'bpmn:Process');
  const collab = (root.rootElements || []).find((r) => r.$type === 'bpmn:Collaboration');
  if (!processes.length) add('ERROR', 'SIN_PROCESO', null, 'El BPMN no contiene ningún proceso');
  const allNodes = [], allFlows = [];
  const nodeOwner = new Map();
  for (const p of processes) {
    const acc = collectFlowElements(p);
    allNodes.push(...acc.nodes);
    allFlows.push(...acc.flows);
    for (const c of acc.containers) {
      const nodes = acc.nodes.filter((n) => n.container === c).map((n) => n.el);
      const starts = nodes.filter((n) => n.$type === 'bpmn:StartEvent');
      const ends = nodes.filter((n) => n.$type === 'bpmn:EndEvent');
      if (!starts.length) add('ERROR', 'SIN_EVENTO_INICIAL', c.id, `${c.id} no tiene evento de inicio`);
      if (!ends.length) add('ERROR', 'SIN_EVENTO_FINAL', c.id, `${c.id} no tiene evento de fin`);
    }
    for (const n of acc.nodes) nodeOwner.set(n.el.id, p);
  }
  const nodeIds = new Set(allNodes.map((n) => n.el.id));
  for (const { el: n, container } of allNodes) {
    const inc = (n.incoming || []).length, out = (n.outgoing || []).length;
    const t = n.$type;
    if (t === 'bpmn:StartEvent' && inc > 0) add('ERROR', 'INICIO_CON_ENTRADA', n.id, `El evento de inicio ${n.id} tiene flujos de entrada`);
    if (t === 'bpmn:EndEvent' && out > 0) add('ERROR', 'FINAL_CON_SALIDA', n.id, `El evento final ${n.id} tiene flujos de salida`);
    if (t !== 'bpmn:StartEvent' && t !== 'bpmn:BoundaryEvent' && inc === 0) add('ERROR', 'ELEMENTO_HUERFANO', n.id, `${n.id} no tiene flujos de entrada`);
    if (t !== 'bpmn:EndEvent' && out === 0) add('ERROR', 'ELEMENTO_HUERFANO', n.id, `${n.id} no tiene flujos de salida`);
    if (isGateway(n)) {
      if (inc <= 1 && out <= 1) add('ERROR', 'COMPUERTA_SIN_BIFURCACION', n.id, `La compuerta ${n.id} no bifurca ni une flujos`);
      const outs = n.outgoing || [];
      if (outs.length > 1 && (t === 'bpmn:ExclusiveGateway' || t === 'bpmn:InclusiveGateway')) {
        for (const f of outs) {
          if (n.default && n.default.id === f.id) continue;
          if (!f.conditionExpression) add('ERROR', 'FLUJO_SIN_CONDICION', f.id, `El flujo ${f.id} sale de la compuerta ${n.id} sin condición ni ser el flujo predeterminado`);
        }
        if (!n.default) add('ADVERTENCIA', 'SIN_FLUJO_PREDETERMINADO', n.id, `La compuerta ${n.id} no define flujo predeterminado`);
      }
      if (n.default && !outs.some((f) => f.id === n.default.id)) add('ERROR', 'DEFAULT_INVALIDO', n.id, `El flujo predeterminado de ${n.id} no sale de ella`);
      if (t === 'bpmn:ParallelGateway') for (const f of outs) if (f.conditionExpression) add('ERROR', 'CONDICION_EN_PARALELA', f.id, `Un flujo de una compuerta paralela no puede tener condición`);
    } else {
      if (out > 1 && !['bpmn:EndEvent'].includes(t)) add('ADVERTENCIA', 'DIVISION_IMPLICITA', n.id, `${n.id} tiene ${out} salidas sin compuerta (división implícita)`);
    }
    void container;
  }
  for (const { el: f, container } of allFlows) {
    if (!f.sourceRef || !f.targetRef) { add('ERROR', 'FLUJO_SIN_EXTREMO', f.id, `El flujo ${f.id} no tiene origen o destino`); continue; }
    const sc = allNodes.find((n) => n.el === f.sourceRef)?.container, tc = allNodes.find((n) => n.el === f.targetRef)?.container;
    if (sc !== container || tc !== container) add('ERROR', 'FLUJO_CRUZA_CONTENEDOR', f.id, `El flujo de secuencia ${f.id} cruza los límites de un proceso/subproceso`);
    if (f.conditionExpression && f.sourceRef && !isGateway(f.sourceRef) && !f.sourceRef.$type.endsWith('Task')) add('ADVERTENCIA', 'CONDICION_FUERA_DE_COMPUERTA', f.id, `Condición en flujo cuyo origen no es compuerta ni tarea`);
  }
  // alcanzabilidad desde inicios
  for (const p of processes) {
    const nodes = allNodes.filter((n) => n.container === p).map((n) => n.el);
    const seen = new Set();
    const stack = nodes.filter((n) => n.$type === 'bpmn:StartEvent');
    while (stack.length) { const n = stack.pop(); if (seen.has(n.id)) continue; seen.add(n.id); for (const f of n.outgoing || []) if (f.targetRef) stack.push(f.targetRef); }
    for (const n of nodes) if (!seen.has(n.id)) add('ERROR', 'NO_ALCANZABLE', n.id, `${n.id} no es alcanzable desde ningún evento de inicio`);
  }
  mark('estructura_bpmn', n0);

  // ---- carriles y participantes ----
  n0 = issues.length;
  const lanesAll = [];
  for (const p of processes) for (const ls of p.laneSets || []) for (const l of ls.lanes || []) lanesAll.push({ lane: l, process: p });
  for (const p of processes) {
    if (!(p.laneSets || []).length) continue;
    const counts = new Map();
    for (const { lane, process } of lanesAll) if (process === p) for (const r of lane.flowNodeRef || []) counts.set(r.id, (counts.get(r.id) || 0) + 1);
    for (const { el } of allNodes.filter((n) => n.container === p)) {
      const c = counts.get(el.id) || 0;
      if (c === 0) add('ERROR', 'ELEMENTO_FUERA_DE_CARRIL', el.id, `${el.id} no pertenece a ningún carril`);
      if (c > 1) add('ERROR', 'ELEMENTO_EN_VARIOS_CARRILES', el.id, `${el.id} pertenece a más de un carril`);
    }
  }
  const participants = collab?.participants || [];
  const partOfNode = (n) => participants.find((pa) => pa.processRef && pa.processRef === nodeOwner.get(n.id));
  for (const mf of collab?.messageFlows || []) {
    const s = mf.sourceRef, t = mf.targetRef;
    if (!s || !t) { add('ERROR', 'FLUJO_MENSAJE_INVALIDO', mf.id, `El flujo de mensaje ${mf.id} no tiene origen o destino`); continue; }
    const sp = s.$type === 'bpmn:Participant' ? s : partOfNode(s), tp = t.$type === 'bpmn:Participant' ? t : partOfNode(t);
    if (!sp || !tp) add('ERROR', 'FLUJO_MENSAJE_INVALIDO', mf.id, `El flujo de mensaje ${mf.id} referencia elementos fuera de la colaboración`);
    else if (sp === tp) add('ERROR', 'FLUJO_MENSAJE_MISMO_POOL', mf.id, `El flujo de mensaje ${mf.id} conecta elementos del mismo participante`);
  }
  for (const pa of participants) if (!pa.processRef && !(collab.messageFlows || []).some((m) => m.sourceRef === pa || m.targetRef === pa)) add('ADVERTENCIA', 'POOL_SIN_MENSAJES', pa.id, `El participante colapsado ${pa.id} no intercambia mensajes`);
  mark('carriles_y_participantes', n0);

  // ---- BPMN DI ----
  n0 = issues.length;
  const diagram = (root.diagrams || [])[0];
  const metrics = { shapes: 0, edges: 0, overlaps: 0, diagonal_segments: 0 };
  if (!diagram) add('ERROR', 'SIN_BPMNDI', null, 'El BPMN no contiene BPMN Diagram Interchange (BPMNDiagram)');
  else {
    const planeEls = diagram.plane?.planeElement || [];
    if (diagram.plane?.bpmnElement && diagram.plane.bpmnElement !== collab && !processes.includes(diagram.plane.bpmnElement)) add('ERROR', 'DI_PLANO_INVALIDO', diagram.plane.id, 'El plano BPMNPlane referencia un elemento que no es proceso ni colaboración');
    const shapes = new Map(), edges = new Map();
    for (const pe of planeEls) {
      if (!pe.bpmnElement) { add('ERROR', 'DI_SIN_ELEMENTO', pe.id, `El elemento DI ${pe.id} no referencia ningún elemento del modelo`); continue; }
      if (pe.$type === 'bpmndi:BPMNShape') {
        metrics.shapes++;
        const b = pe.bounds;
        if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width <= 0 || b.height <= 0) add('ERROR', 'DI_BOUNDS_INVALIDOS', pe.id, `La forma ${pe.id} tiene dimensiones inválidas`);
        else if (b.x < 0 || b.y < 0) add('ERROR', 'DI_COORDENADAS_NEGATIVAS', pe.id, `La forma ${pe.id} tiene coordenadas negativas`);
        if (shapes.has(pe.bpmnElement.id)) add('ERROR', 'DI_DUPLICADO', pe.id, `Hay más de una forma para ${pe.bpmnElement.id}`);
        shapes.set(pe.bpmnElement.id, pe);
      } else if (pe.$type === 'bpmndi:BPMNEdge') {
        metrics.edges++;
        const w = pe.waypoint || [];
        if (w.length < 2) add('ERROR', 'DI_WAYPOINTS_INSUFICIENTES', pe.id, `La conexión ${pe.id} tiene menos de 2 puntos`);
        else if (!w.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0)) add('ERROR', 'DI_COORDENADAS_INVALIDAS', pe.id, `La conexión ${pe.id} tiene coordenadas inválidas`);
        else {
          for (let i = 0; i < w.length - 1; i++) if (w[i].x !== w[i + 1].x && w[i].y !== w[i + 1].y) { metrics.diagonal_segments++; add('ADVERTENCIA', 'DI_SEGMENTO_DIAGONAL', pe.id, `La conexión ${pe.id} tiene un segmento no ortogonal`); break; }
        }
        edges.set(pe.bpmnElement.id, pe);
      }
    }
    const needShape = [...allNodes.map((n) => n.el), ...participants, ...lanesAll.map((l) => l.lane)];
    for (const el of needShape) if (!shapes.has(el.id)) add('ERROR', 'DI_FALTA_FORMA', el.id, `El elemento ${el.id} no tiene forma en el diagrama`);
    for (const { el } of allFlows) if (!edges.has(el.id)) add('ERROR', 'DI_FALTA_CONEXION', el.id, `El flujo ${el.id} no tiene conexión en el diagrama`);
    for (const mf of collab?.messageFlows || []) if (!edges.has(mf.id)) add('ERROR', 'DI_FALTA_CONEXION', mf.id, `El flujo de mensaje ${mf.id} no tiene conexión en el diagrama`);
    // extremos de conexiones sobre el borde de las formas
    for (const [id, e] of edges) {
      const el = e.bpmnElement;
      if (el.$type !== 'bpmn:SequenceFlow' && el.$type !== 'bpmn:MessageFlow') continue;
      const sh = shapes.get(el.sourceRef?.id), th = shapes.get(el.targetRef?.id);
      const w = e.waypoint || [];
      if (w.length < 2 || !sh?.bounds || !th?.bounds) continue;
      if (!boundaryContains(w[0], sh.bounds)) add('ERROR', 'DI_EXTREMO_DESCONECTADO', id, `El inicio de ${id} no toca la forma de origen ${el.sourceRef.id}`);
      if (!boundaryContains(w[w.length - 1], th.bounds)) add('ERROR', 'DI_EXTREMO_DESCONECTADO', id, `El final de ${id} no toca la forma de destino ${el.targetRef.id}`);
    }
    // superposiciones y contención
    const nodeShapes = [...allNodes.map((n) => n.el), ...(processes.flatMap((p) => (p.flowElements || []).filter((x) => x.$type === 'bpmn:DataStoreReference')))].map((el) => ({ el, b: shapes.get(el.id)?.bounds })).filter((x) => x.b);
    for (let i = 0; i < nodeShapes.length; i++) for (let j = i + 1; j < nodeShapes.length; j++) if (overlap(nodeShapes[i].b, nodeShapes[j].b)) { metrics.overlaps++; add('ERROR', 'DI_SUPERPOSICION', nodeShapes[i].el.id, `Las formas ${nodeShapes[i].el.id} y ${nodeShapes[j].el.id} se superponen`); }
    for (const pa of participants) {
      if (!pa.processRef) continue;
      const pb = shapes.get(pa.id)?.bounds;
      if (!pb) continue;
      for (const { el } of allNodes.filter((n) => nodeOwner.get(n.el.id) === pa.processRef)) {
        const b = shapes.get(el.id)?.bounds;
        if (b && !inside(b, pb)) add('ERROR', 'DI_FUERA_DEL_POOL', el.id, `${el.id} queda fuera de los límites del participante ${pa.id}`);
      }
    }
    for (const { lane } of lanesAll) {
      const lb = shapes.get(lane.id)?.bounds;
      if (!lb) continue;
      for (const r of lane.flowNodeRef || []) {
        const b = shapes.get(r.id)?.bounds;
        if (b && !inside(b, lb)) add('ERROR', 'DI_FUERA_DEL_CARRIL', r.id, `${r.id} queda fuera del carril ${lane.id} al que pertenece`);
      }
    }
  }
  mark('bpmn_di', n0);

  // ---- bpmnlint ----
  n0 = issues.length;
  try {
    const reports = await runBpmnlint(root);
    for (const r of reports) add(r.category === 'error' ? 'ERROR' : 'ADVERTENCIA', `LINT_${r.rule}`, r.id, `bpmnlint ${r.rule}: ${r.message}`);
  } catch (e) {
    add('ADVERTENCIA', 'LINT_NO_EJECUTADO', null, `bpmnlint no pudo ejecutarse: ${e.message}`);
  }
  mark('bpmnlint', n0);

  // ---- round-trip ----
  n0 = issues.length;
  try {
    const { xml: xml2 } = await moddle.toXML(root, { format: true });
    const again = await new BpmnModdle().fromXML(xml2);
    const sig = (r) => {
      const ids = [];
      const walk = (o) => { if (o && typeof o === 'object') { if (o.id) ids.push(`${o.$type}#${o.id}`); for (const k of Object.keys(o)) { if (k === '$parent') continue; const v = o[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object' && v.$type && !k.endsWith('Ref')) walk(v); } } };
      walk(r);
      return ids.sort().join('|');
    };
    if (sig(root) !== sig(again.rootElement)) add('ERROR', 'ROUNDTRIP_DIFERENTE', null, 'La importación y reexportación con bpmn-moddle altera los elementos del modelo');
    if ((again.warnings || []).length) add('ERROR', 'ROUNDTRIP_ADVERTENCIAS', null, `La reexportación genera advertencias: ${again.warnings.map((w) => w.message).join('; ')}`);
  } catch (e) {
    add('ERROR', 'ROUNDTRIP_FALLO', null, `Round-trip fallido: ${e.message}`);
  }
  mark('round_trip', n0);

  // ---- trazabilidad ----
  n0 = issues.length;
  const traceability = { checked: false, elements: 0, with_evidence: 0, without_evidence: [], unconfirmed: [] };
  const evidenceOf = (el) => /Evidencia:/.test((el.documentation || []).map((d) => d.text).join('\n'));
  if (definition) {
    traceability.checked = true;
    const defEls = [...definition.activities, ...definition.events, ...definition.decisions];
    for (const d of defEls) {
      traceability.elements++;
      if (!nodeIds.has(d.id)) { add('ERROR', 'TRAZA_ELEMENTO_AUSENTE', d.id, `El elemento ${d.id} de la definición no existe en el BPMN`); continue; }
      const bel = allNodes.find((n) => n.el.id === d.id).el;
      if (d.name && bel.name !== d.name) add('ERROR', 'TRAZA_NOMBRE_DIFERENTE', d.id, `El nombre de ${d.id} difiere entre definición y BPMN`);
      if (d.evidence_status === 'DESCONOCIDA') { traceability.unconfirmed.push({ id: d.id, status: d.evidence_status }); add('ADVERTENCIA', 'TRAZA_ELEMENTO_DESCONOCIDO', d.id, `${d.id} se basa en comportamiento no resuelto (DESCONOCIDA)`); continue; }
      if (d.evidence_status === 'INFERIDA') { traceability.unconfirmed.push({ id: d.id, status: d.evidence_status }); add('ADVERTENCIA', 'TRAZA_INFERENCIA', d.id, `${d.id} es una inferencia no confirmada (INFERIDA)`); }
      if (evidenceOf(bel)) traceability.with_evidence++;
      else { traceability.without_evidence.push(d.id); add('ERROR', 'TRAZA_SIN_EVIDENCIA', d.id, `${d.id} no tiene evidencia en el BPMN`); }
    }
    for (const f of definition.flows) if (!allFlows.some((x) => x.el.id === `Flow_${f.id}`)) add('ERROR', 'TRAZA_FLUJO_AUSENTE', f.id, `El flujo ${f.id} de la definición no existe en el BPMN`);
    if (allFlows.length !== definition.flows.length) add('ERROR', 'TRAZA_FLUJOS_DISTINTOS', null, `El BPMN tiene ${allFlows.length} flujos y la definición ${definition.flows.length}`);
    if (sidecar) {
      for (const d of defEls) if (!sidecar[d.id]) add('ERROR', 'TRAZA_SIDECAR_INCOMPLETO', d.id, `El archivo de trazabilidad no incluye ${d.id}`);
    }
  }
  mark('trazabilidad', n0);

  return finish(issues, checks, { metrics, traceability, stats: { nodes: allNodes.length, sequence_flows: allFlows.length, message_flows: (collab?.messageFlows || []).length, participants: participants.length, lanes: lanesAll.length } });
}

function finish(issues, checks, extra) {
  const errors = issues.filter((i) => i.severity === 'ERROR').length;
  const warnings = issues.filter((i) => i.severity === 'ADVERTENCIA').length;
  return {
    valid: errors === 0,
    approval: errors === 0 ? 'APROBADO' : 'BLOQUEADO',
    summary: { errors, warnings },
    checks,
    issues,
    ...(extra || {}),
  };
}

export async function validateBpmnFile(file, { definitionPath, sidecarPath } = {}) {
  const xml = fs.readFileSync(file, 'utf8');
  const defPath = definitionPath || file.replace(/\.bpmn$/i, '.process.json');
  const scPath = sidecarPath || file.replace(/\.bpmn$/i, '.traceability.json');
  const definition = fs.existsSync(defPath) ? JSON.parse(fs.readFileSync(defPath, 'utf8')) : null;
  const sidecar = fs.existsSync(scPath) ? JSON.parse(fs.readFileSync(scPath, 'utf8')) : null;
  const report = await validateBpmnXml(xml, { definition, sidecar });
  return { file: path.resolve(file), definition_file: definition ? path.resolve(defPath) : null, traceability_file: sidecar ? path.resolve(scPath) : null, ...report };
}
