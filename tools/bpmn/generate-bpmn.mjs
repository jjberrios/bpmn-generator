// Generador determinista: process-definition (JSON validado) -> BPMN 2.0 XML con BPMN DI.
import { BpmnModdle } from 'bpmn-moddle';
import { checkDefinition } from '../validation/definition-checks.mjs';
import { layoutProcess } from './layout.mjs';

export const EXPORTER = 'BPMN Reverse Engineer';
export const EXPORTER_VERSION = '1.0.0';

const TASK_TYPES = {
  task: 'bpmn:Task',
  serviceTask: 'bpmn:ServiceTask',
  sendTask: 'bpmn:SendTask',
  receiveTask: 'bpmn:ReceiveTask',
  scriptTask: 'bpmn:ScriptTask',
  subProcess: 'bpmn:SubProcess',
};
const GATEWAY_TYPES = {
  exclusive: 'bpmn:ExclusiveGateway',
  parallel: 'bpmn:ParallelGateway',
  inclusive: 'bpmn:InclusiveGateway',
};

export class GenerationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'GenerationError';
    this.details = details;
  }
}

function evidenceText(ev) {
  if (!ev) return '';
  const loc = ev.file ? `${ev.file}${ev.line_start ? ':' + ev.line_start + (ev.line_end && ev.line_end !== ev.line_start ? '-' + ev.line_end : '') : ''}` : '(sin ubicación)';
  const who = [ev.class, ev.method].filter(Boolean).join('.');
  return `[${ev.status}] ${loc}${who ? ' ' + who : ''}`;
}

/**
 * Genera el BPMN. Aborta con GenerationError si la definición no supera checkDefinition.
 * @returns {Promise<{xml:string, layout:object, traceability:object, warnings:object[]}>}
 */
export async function generateBpmn(def) {
  const checks = checkDefinition(def);
  if (checks.errors.length) {
    throw new GenerationError(`La definición del proceso ${def.id} no es válida (${checks.errors.length} errores)`, checks.errors);
  }
  const layout = layoutProcess(def);
  const moddle = new BpmnModdle();
  const create = (type, props) => moddle.create(type, props);

  const evById = new Map((def.evidence || []).map((e) => [e.id, e]));
  const traceability = {};
  const docFor = (id, description, evidenceIds, status) => {
    const evs = (evidenceIds || []).map((i) => evById.get(i)).filter(Boolean);
    traceability[id] = { evidence_status: status || null, evidence: evs.map((e) => ({ id: e.id, status: e.status, file: e.file || null, line_start: e.line_start || null, line_end: e.line_end || null, class: e.class || null, method: e.method || null })) };
    const lines = [];
    if (description) lines.push(description);
    if (status) lines.push(`Estado de evidencia: ${status}`);
    for (const e of evs) lines.push(`Evidencia: ${evidenceText(e)}`);
    return lines.length ? [create('bpmn:Documentation', { text: lines.join('\n') })] : undefined;
  };

  const pid = def.id;
  const mainParticipant = def.participants.find((p) => p.kind === 'internal' && p.is_pool);
  const laneParticipants = layout.lanes.map((l) => def.participants.find((p) => p.id === l.id));
  const externals = def.participants.filter((p) => p.kind === 'external');
  const stores = def.participants.filter((p) => p.kind === 'data_store');

  // ---------- elementos de proceso ----------
  const nodes = new Map();
  const flowElements = [];
  const mk = (type, props) => { const el = create(type, props); return el; };

  for (const a of def.activities) {
    const el = mk(TASK_TYPES[a.type] || 'bpmn:Task', { id: a.id, name: a.name });
    el.documentation = docFor(a.id, a.description, a.evidence_ids, a.evidence_status);
    nodes.set(a.id, { el, ref: a });
  }
  for (const e of def.events) {
    let type;
    const props = { id: e.id, name: e.name };
    if (e.type === 'start') type = 'bpmn:StartEvent';
    else if (e.type === 'end') type = 'bpmn:EndEvent';
    else if (e.type === 'intermediate_catch') type = 'bpmn:IntermediateCatchEvent';
    else type = 'bpmn:IntermediateThrowEvent';
    const el = mk(type, props);
    const defMap = { error: 'bpmn:ErrorEventDefinition', message: 'bpmn:MessageEventDefinition', timer: 'bpmn:TimerEventDefinition', terminate: 'bpmn:TerminateEventDefinition' };
    if (e.definition && e.definition !== 'none' && defMap[e.definition]) {
      el.eventDefinitions = [mk(defMap[e.definition], { id: `${e.id}_def` })];
    }
    el.documentation = docFor(e.id, e.outcome ? `Resultado: ${e.outcome}` : undefined, e.evidence_ids, e.evidence_status);
    nodes.set(e.id, { el, ref: e });
  }
  for (const d of def.decisions) {
    const el = mk(GATEWAY_TYPES[d.gateway] || 'bpmn:ExclusiveGateway', { id: d.id, name: d.name });
    el.documentation = docFor(d.id, d.condition_text ? `Condición evaluada: ${d.condition_text}` : undefined, d.evidence_ids, d.evidence_status);
    nodes.set(d.id, { el, ref: d });
  }

  // secuencias
  const flowEls = new Map();
  const incoming = new Map();
  const outgoing = new Map();
  for (const f of def.flows) {
    const sf = mk('bpmn:SequenceFlow', { id: `Flow_${f.id}`, name: f.name, sourceRef: nodes.get(f.from).el, targetRef: nodes.get(f.to).el });
    if (f.condition) sf.conditionExpression = mk('bpmn:FormalExpression', { body: f.condition });
    sf.documentation = docFor(`Flow_${f.id}`, undefined, f.evidence_ids, null);
    flowEls.set(f.id, sf);
    (outgoing.get(f.from) || outgoing.set(f.from, []).get(f.from)).push(sf);
    (incoming.get(f.to) || incoming.set(f.to, []).get(f.to)).push(sf);
  }
  for (const [id, { el, ref }] of nodes) {
    el.incoming = incoming.get(id) || [];
    el.outgoing = outgoing.get(id) || [];
    if (el.$type !== 'bpmn:StartEvent' && el.$type !== 'bpmn:EndEvent') {/* sin cambios */}
    if (el.$type.endsWith('Gateway')) {
      const nin = el.incoming.length, nout = el.outgoing.length;
      el.gatewayDirection = nin > 1 && nout > 1 ? 'Mixed' : nin > 1 ? 'Converging' : 'Diverging';
      if (ref.default_flow_id && flowEls.has(ref.default_flow_id)) el.default = flowEls.get(ref.default_flow_id);
    }
  }

  // almacenes de datos (raíz) y referencias en el proceso
  const dataStoreEls = new Map();
  for (const s of stores) {
    const ds = mk('bpmn:DataStore', { id: s.id, name: s.name });
    ds.documentation = docFor(s.id, s.justification, s.evidence_ids, null);
    dataStoreEls.set(s.id, ds);
  }
  const refEls = new Map();
  for (const r of layout.dsRefs) {
    const ref = mk('bpmn:DataStoreReference', { id: r.id, name: def.participants.find((p) => p.id === r.store)?.name, dataStoreRef: dataStoreEls.get(r.store) });
    refEls.set(r.id, ref);
  }
  // asociaciones de datos con ioSpecification (válido XSD)
  const dataEdgeIds = new Map();
  const perActivity = new Map();
  for (const r of layout.dsRefs) (perActivity.get(r.activity) || perActivity.set(r.activity, []).get(r.activity)).push(r);
  for (const [actId, refs] of perActivity) {
    const el = nodes.get(actId).el;
    const inputs = [], outputs = [];
    const dIn = [], dOut = [];
    refs.forEach((r, i) => {
      if (r.access === 'read') {
        const di = mk('bpmn:DataInput', { id: `${actId}_in${i}`, name: refEls.get(r.id).name });
        inputs.push(di);
        const assoc = mk('bpmn:DataInputAssociation', { id: `DIA_${r.id}`, sourceRef: [refEls.get(r.id)], targetRef: di });
        dIn.push(assoc);
        dataEdgeIds.set(r.id, assoc.id);
      } else {
        const dO = mk('bpmn:DataOutput', { id: `${actId}_out${i}`, name: refEls.get(r.id).name });
        outputs.push(dO);
        const assoc = mk('bpmn:DataOutputAssociation', { id: `DOA_${r.id}`, sourceRef: [dO], targetRef: refEls.get(r.id) });
        dOut.push(assoc);
        dataEdgeIds.set(r.id, assoc.id);
      }
    });
    const io = mk('bpmn:InputOutputSpecification', { id: `${actId}_io` });
    io.dataInputs = inputs;
    io.dataOutputs = outputs;
    io.inputSets = [mk('bpmn:InputSet', { id: `${actId}_is`, dataInputRefs: inputs })];
    io.outputSets = [mk('bpmn:OutputSet', { id: `${actId}_os`, dataOutputRefs: outputs })];
    el.ioSpecification = io;
    el.dataInputAssociations = dIn;
    el.dataOutputAssociations = dOut;
  }

  // lanes
  let laneSets;
  if (layout.lanes.length) {
    const lanes = laneParticipants.map((p) => {
      const lane = mk('bpmn:Lane', { id: p.id, name: p.name });
      lane.documentation = docFor(p.id, p.justification, p.evidence_ids, null);
      lane.flowNodeRef = [...nodes.values()].filter(({ ref }) => ref.participant_id === p.id).map(({ el }) => el);
      return lane;
    });
    laneSets = [mk('bpmn:LaneSet', { id: `LaneSet_${pid}`, lanes })];
  }

  const ordered = [...nodes.values()].map((n) => n.el).sort((a, b) => (layout.shapes.get(a.id)?.x ?? 0) - (layout.shapes.get(b.id)?.x ?? 0));
  flowElements.push(...ordered, ...flowEls.values(), ...refEls.values());

  const process = mk('bpmn:Process', { id: `Process_${pid}`, name: def.name, isExecutable: false, flowElements });
  if (laneSets) process.laneSets = laneSets;
  process.documentation = docFor(`Process_${pid}`, [def.description, def.scope_note].filter(Boolean).join('\n'), (def.evidence || []).slice(0, 0).map((e) => e.id), null);

  // ---------- colaboración ----------
  const mainP = mk('bpmn:Participant', { id: mainParticipant.id, name: mainParticipant.name, processRef: process });
  mainP.documentation = docFor(mainParticipant.id, mainParticipant.justification, mainParticipant.evidence_ids, null);
  const extPs = new Map();
  for (const x of externals) {
    const p = mk('bpmn:Participant', { id: x.id, name: x.name });
    p.documentation = docFor(x.id, x.justification, x.evidence_ids, null);
    extPs.set(x.id, p);
  }
  const msgFlows = [];
  for (const m of def.message_flows || []) {
    const src = nodes.has(m.from) ? nodes.get(m.from).el : extPs.get(m.from);
    const tgt = nodes.has(m.to) ? nodes.get(m.to).el : extPs.get(m.to);
    msgFlows.push(mk('bpmn:MessageFlow', { id: `Msg_${m.id}`, name: m.name, sourceRef: src, targetRef: tgt }));
  }
  const collab = mk('bpmn:Collaboration', { id: `Collaboration_${pid}`, participants: [mainP, ...extPs.values()], messageFlows: msgFlows });

  // ---------- BPMN DI ----------
  const bounds = (x, y, w, h) => mk('dc:Bounds', { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
  const wps = (pts) => pts.map((p) => mk('dc:Point', { x: Math.round(p.x), y: Math.round(p.y) }));
  const planeEls = [];
  const labelOf = (r) => mk('bpmndi:BPMNLabel', { bounds: bounds(r.x, r.y, r.w, r.h) });

  planeEls.push(mk('bpmndi:BPMNShape', { id: `Shape_${mainP.id}`, bpmnElement: mainP, isHorizontal: true, bounds: bounds(layout.pool.x, layout.pool.y, layout.pool.w, layout.pool.h) }));
  for (const l of layout.lanes) {
    const laneEl = laneSets[0].lanes.find((x) => x.id === l.id);
    planeEls.push(mk('bpmndi:BPMNShape', { id: `Shape_${l.id}`, bpmnElement: laneEl, isHorizontal: true, bounds: bounds(l.x, l.y, l.w, l.h) }));
  }
  for (const g of layout.externals) {
    planeEls.push(mk('bpmndi:BPMNShape', { id: `Shape_${g.id}`, bpmnElement: extPs.get(g.id), isHorizontal: true, bounds: bounds(g.x, g.y, g.w, g.h) }));
  }
  for (const [id, s] of layout.shapes) {
    let bpmnElement, props = {};
    if (nodes.has(id)) bpmnElement = nodes.get(id).el;
    else if (refEls.has(id)) bpmnElement = refEls.get(id);
    else continue;
    if (bpmnElement.$type === 'bpmn:ExclusiveGateway') props.isMarkerVisible = true;
    const shape = mk('bpmndi:BPMNShape', { id: `Shape_${id}`, bpmnElement, bounds: bounds(s.x, s.y, s.w, s.h), ...props });
    if (s.kind === 'event' || s.kind === 'gateway' || s.kind === 'dataStore') {
      const text = bpmnElement.name || '';
      if (text) shape.label = labelOf(layout.nodeLabels.get(id));
    }
    planeEls.push(shape);
  }
  for (const [fid, e] of layout.flowEdges) {
    const sf = flowEls.get(fid);
    const edge = mk('bpmndi:BPMNEdge', { id: `Edge_${sf.id}`, bpmnElement: sf, waypoint: wps(e.points) });
    if (sf.name && e.label) edge.label = labelOf(e.label);
    planeEls.push(edge);
  }
  for (const [mid, e] of layout.messageEdges) {
    const mf = msgFlows.find((m) => m.id === `Msg_${mid}`);
    if (!mf) continue;
    const edge = mk('bpmndi:BPMNEdge', { id: `Edge_${mf.id}`, bpmnElement: mf, waypoint: wps(e.points) });
    if (mf.name && e.label) edge.label = labelOf(e.label);
    planeEls.push(edge);
  }
  for (const d of layout.dataEdges) {
    const assocId = dataEdgeIds.get(d.id);
    const act = nodes.get(d.activity).el;
    const assoc = [...(act.dataInputAssociations || []), ...(act.dataOutputAssociations || [])].find((a) => a.id === assocId);
    planeEls.push(mk('bpmndi:BPMNEdge', { id: `Edge_${assocId}`, bpmnElement: assoc, waypoint: wps(d.points) }));
  }

  const plane = mk('bpmndi:BPMNPlane', { id: `Plane_${pid}`, bpmnElement: collab, planeElement: planeEls });
  const diagram = mk('bpmndi:BPMNDiagram', { id: `Diagram_${pid}`, name: def.name, plane });

  const defs = mk('bpmn:Definitions', {
    id: `Definitions_${pid}`,
    name: def.name,
    targetNamespace: 'http://bpmn.io/schema/bpmn',
    exporter: EXPORTER,
    exporterVersion: EXPORTER_VERSION,
    rootElements: [...dataStoreEls.values(), process, collab].sort((a, b) => rootOrder(a) - rootOrder(b)),
    diagrams: [diagram],
  });
  const { xml } = await moddle.toXML(defs, { format: true });
  return { xml, layout, traceability, warnings: [...checks.warnings, ...layout.warnings.map((m) => ({ code: 'LAYOUT', message: m }))] };
}

function rootOrder(el) {
  if (el.$type === 'bpmn:Collaboration') return 0;
  if (el.$type === 'bpmn:Process') return 1;
  return 2;
}

