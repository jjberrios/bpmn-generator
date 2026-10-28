// Serializador local del contenedor .bpm observado en la referencia Bizagi.
// El XML se construye desde objetos, nunca desde texto XML aportado por un LLM.
// No lee ni copia modelos, autores, usuarios o configuración de la referencia.
import crypto from 'node:crypto';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import { Resvg } from '@resvg/resvg-js';
import { layoutProcess } from '../bpmn/layout.mjs';
import { checkDefinition } from '../validation/definition-checks.mjs';
import { validateContract } from '../validation/schema-validator.mjs';

const NS = 'http://www.wfmc.org/2009/XPDL2.2';
const XSD = 'http://www.w3.org/2001/XMLSchema';
const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const arr = (v) => v == null || v === '' ? [] : Array.isArray(v) ? v : [v];
const attrs = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [`@_${k}`, String(v)]));
const ea = (values) => ({ ExtendedAttribute: Object.entries(values).map(([Name, Value]) => attrs({ Name, Value: typeof Value === 'string' ? Value : JSON.stringify(Value) })) });
const ext = (obj) => Object.fromEntries(arr(obj?.ExtendedAttributes?.ExtendedAttribute).map((e) => [e['@_Name'], e['@_Value']]));
const xml = (obj) => new XMLBuilder({ ignoreAttributes: false, format: true, suppressEmptyNode: false, suppressBooleanAttributes: false }).build({ '?xml': attrs({ version: '1.0', encoding: 'utf-8' }), ...obj });
export const digest = (v) => crypto.createHash('sha256').update(typeof v === 'string' || v instanceof Uint8Array ? v : JSON.stringify(v)).digest('hex');
export function nativeId(...parts) {
  const h = digest(JSON.stringify(parts));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const coords = (p) => attrs({ XCoordinate: p.x, YCoordinate: p.y });
// XPDL22.Font del proveedor expone campos públicos sin XmlAttribute:
// Formatting se deserializa desde ELEMENTOS, no desde atributos. Estos últimos
// se ignoran y dejan fuente nula, tamaño 0 y Color.Empty (alfa 0).
const formatting = () => ({ Alignment: 'Center', FontName: 'Segoe UI', SizeFont: 8, Bold: false, Italic: false, Strikeout: false, Underline: false, ColorFont: -16777216 });
const textBounds = (box) => attrs({ TextX: box.x, TextY: box.y, TextWidth: box.w, TextHeight: box.h });
function nodeGraphics(box, laneId, kind = 'task', label = null) {
  const colors = { start: [-10311914, -1638505], end: [-6750208, -1135958], gateway: [-5855715, -52], task: [-16553830, -1249281], store: [-10066330, -986896] };
  const [BorderColor, FillColor] = colors[kind] ?? colors.task;
  return { NodeGraphicsInfo: {
    ...attrs({ ToolId: 'BizAgi_Process_Modeler', Width: box.w, Height: box.h, BorderColor, FillColor, BorderVisible: true, ...(laneId ? { LaneId: laneId } : {}) }),
    // Bizagi no deriva el área de texto del tamaño de la figura: sin estos
    // atributos el adaptador conserva TextSize=0x0 y la etiqueta es invisible.
    // Tareas: área local; eventos/compuertas: etiqueta externa en coordenadas absolutas.
    ...textBounds(label ?? { x: 0, y: 0, w: box.w, h: box.h }),
    Coordinates: coords(box),
    Formatting: formatting(),
    TextDirection: attrs({ 'xsi:nil': true }),
  } };
}
function connector(points, label = null) {
  return { ConnectorGraphicsInfo: { ...attrs({ ToolId: 'BizAgi_Process_Modeler', BorderColor: -16777216 }), ...(label ? textBounds(label) : {}), Coordinates: points.map(coords), Formatting: formatting() } };
}

function externalLabel(box, text, layout) {
  return layout.nodeLabels.get(box.id);
}

// Miniatura nueva del propio modelo; nunca se reutiliza la imagen de referencia.
// Se renderiza desde el mismo layout utilizado para el XPDL.
function thumbnail(layout, nodes) {
  const width = Math.max(1, layout.size.width), height = Math.max(1, layout.size.height);
  const scale = Math.min(1, 640 / width, 480 / height);
  const box = (b) => attrs({ x: b.x, y: b.y, width: b.w, height: b.h, fill: '#ffffff', stroke: '#334155', 'stroke-width': 1.5 });
   const svg = { ...attrs({ xmlns: 'http://www.w3.org/2000/svg', width: Math.min(640, Math.max(1, Math.ceil(width * scale))), height: Math.min(480, Math.max(1, Math.ceil(height * scale))), viewBox: `0 0 ${width} ${height}` }),
    rect: [attrs({ width, height, fill: '#ffffff' }), box(layout.pool), ...layout.lanes.map(box), ...layout.externals.map(box)],
    polyline: [...layout.flowEdges.values(), ...layout.messageEdges.values(), ...layout.dataEdges].map((e) => attrs({ points: e.points.map((p) => `${p.x},${p.y}`).join(' '), fill: 'none', stroke: '#475569', 'stroke-width': 1.5 })),
    g: nodes.map((n) => {
      const b = layout.shapes.get(n.id), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      if (n.gateway) return { polygon: attrs({ points: `${cx},${b.y} ${b.x + b.w},${cy} ${cx},${b.y + b.h} ${b.x},${cy}`, fill: '#fff3c4', stroke: '#334155' }) };
      if (['start', 'end'].includes(n.type)) return { circle: attrs({ cx, cy, r: b.w / 2, fill: n.type === 'start' ? '#dcfce7' : '#fee2e2', stroke: '#334155', 'stroke-width': n.type === 'end' ? 3 : 1.5 }) };
      return { rect: { ...box(b), ...attrs({ rx: 8, fill: '#e0edff' }) } };
    }),
  };
  svg.rect.push(...layout.dsRefs.map((ref) => box(layout.shapes.get(ref.id))));
  return new Resvg(xml({ svg }), { font: { loadSystemFonts: false } }).render().asPng();
}

function checkThumbnail(bytes) {
  if (!bytes || bytes.length < 45 || ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) throw new Error('Thumbnail.png ausente o no es PNG.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  if (strFromU8(bytes.slice(12, 16)) !== 'IHDR' || !width || !height || width > 640 || height > 480) throw new Error('Thumbnail.png tiene dimensiones inválidas.');
  let offset = 8, imageData = false, ended = false;
  while (offset + 12 <= bytes.length) {
    const size = view.getUint32(offset), type = strFromU8(bytes.slice(offset + 4, offset + 8));
    if (offset + size + 12 > bytes.length) throw new Error('Thumbnail.png truncado.');
    let crc = 0xffffffff;
    for (const value of bytes.subarray(offset + 4, offset + 8 + size)) {
      crc ^= value;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    if (((crc ^ 0xffffffff) >>> 0) !== view.getUint32(offset + 8 + size)) throw new Error('Thumbnail.png tiene CRC inválido.');
    if (type === 'IDAT' && size) imageData = true;
    offset += size + 12;
    if (type === 'IEND') { ended = size === 0 && offset === bytes.length; break; }
  }
  if (!imageData || !ended) throw new Error('Thumbnail.png incompleto.');
}

function definitionSupported(d) {
  const schema = validateContract('process-definition', d);
  if (!schema.valid) throw new Error(`Contrato inválido: ${JSON.stringify(schema.errors)}`);
  const check = checkDefinition(d);
  if (check.errors.length) throw new Error(`Definición inválida: ${JSON.stringify(check.errors)}`);
  for (const a of d.activities) if (!['task', 'serviceTask', 'sendTask', 'receiveTask', 'scriptTask'].includes(a.type)) throw new Error(`Exportación nativa no implementada para ${a.type} (${a.id}); no se descarta contenido.`);
  for (const e of d.events) {
    if (!['start', 'end'].includes(e.type) || !['none', 'error', 'terminate'].includes(e.definition ?? 'none') || (e.type === 'start' && (e.definition ?? 'none') !== 'none')) throw new Error(`Evento nativo no implementado: ${e.id} (${e.type}/${e.definition}).`);
  }
}

function diagram(projectId, d, timestamp) {
  definitionSupported(d);
  const id = (key) => nativeId(projectId, d.id, key);
  const layout = layoutProcess(d);
  const packageId = id('package');
  const workflowId = id('workflow');
  const main = d.participants.find((p) => p.is_pool && p.kind === 'internal');
  const poolId = id(main?.id ?? 'pool');
  const nodes = [...d.activities, ...d.events, ...d.decisions];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const evidence = new Map(d.evidence.map((e) => [e.id, e]));
  const provenance = (n) => ea({ SourceId: n.id, EvidenceStatus: n.evidence_status ?? 'INFERIDA', Evidence: (n.evidence_ids ?? []).map((key) => evidence.get(key)), BPMNType: n.gateway ?? n.type ?? n.kind, ...(n.outcome ? { Outcome: n.outcome } : {}) });
  const activities = nodes.map((n) => {
    const obj = { ...attrs({ Id: id(n.id), Name: n.name }), Description: n.description ?? n.condition_text ?? n.outcome ?? '' };
    let kind = 'task';
    if (n.gateway) {
      kind = 'gateway';
      // La referencia omite GatewayType para XOR (valor predeterminado XPDL).
      obj.Route = n.gateway === 'exclusive' ? '' : attrs({ GatewayType: { parallel: 'Parallel', inclusive: 'Inclusive' }[n.gateway] });
    } else if (n.type === 'start' || n.type === 'end') {
      kind = n.type;
      obj.Event = n.type === 'start' ? { StartEvent: attrs({ Trigger: 'None' }) } : { EndEvent: attrs({ Result: { none: 'None', error: 'Error', terminate: 'Terminate' }[n.definition ?? 'none'] }) };
    } else {
      const taskTypes = { serviceTask: 'TaskService', sendTask: 'TaskSend', receiveTask: 'TaskReceive', scriptTask: 'TaskScript' };
      obj.Implementation = { Task: taskTypes[n.type] ? { [taskTypes[n.type]]: '' } : '' };
      obj.Performers = '';
    }
    obj.Documentation = '';
    if (!n.gateway && !['start', 'end'].includes(n.type)) {
      obj.InputSets = ''; obj.OutputSets = ''; obj.Loop = attrs({ LoopType: 'None' });
    }
    const box = layout.shapes.get(n.id);
    obj.NodeGraphicsInfos = nodeGraphics(box, layout.lanes.some((l) => l.id === n.participant_id) ? id(n.participant_id) : null, kind, kind === 'task' ? null : externalLabel(box, n.name, layout));
    obj.ExtendedAttributes = provenance(n);
    return obj;
  });
  const transitions = d.flows.map((f) => {
    const isDefault = byId.get(f.from)?.default_flow_id === f.id;
    return { ...attrs({ Id: id(f.id), From: id(f.from), To: id(f.to), ...(f.name ? { Name: f.name } : {}) }),
      Condition: isDefault ? attrs({ Type: 'OTHERWISE' }) : f.condition ? { ...attrs({ Type: 'CONDITION' }), Expression: f.condition } : '',
      Description: '', ConnectorGraphicsInfos: connector(layout.flowEdges.get(f.id).points, f.name ? layout.flowEdges.get(f.id).label : null), ExtendedAttributes: ea({ SourceId: f.id, Branch: f.branch ?? 'next', Evidence: (f.evidence_ids ?? []).map((key) => evidence.get(key)) }),
    };
  });
  const pool = { ...attrs({ Id: poolId, Name: main?.name ?? d.name, Process: workflowId, BoundaryVisible: true }),
    Lanes: { Lane: layout.lanes.map((l) => ({ ...attrs({ Id: id(l.id), Name: d.participants.find((p) => p.id === l.id)?.name ?? l.id, ParentPool: poolId }), NodeGraphicsInfos: nodeGraphics({ ...l, x: l.x - layout.pool.x, y: l.y - layout.pool.y }), ExtendedAttributes: ea({ SourceId: l.id }) })) },
    NodeGraphicsInfos: nodeGraphics(layout.pool), ExtendedAttributes: ea({ SourceId: main?.id ?? 'pool' }),
  };
  // Nombre del proceso por defecto observado en la referencia de la misma versión.
  const hiddenWorkflow = id('main-workflow');
  const hiddenPool = { ...attrs({ Id: id('main-pool'), Name: 'Main Process', Process: hiddenWorkflow, BoundaryVisible: false }), Lanes: '', NodeGraphicsInfos: nodeGraphics({ x: 30, y: 30, w: 700, h: 350 }) };
  const externalPools = layout.externals.map((p) => ({ ...attrs({ Id: id(p.id), Name: d.participants.find((v) => v.id === p.id).name, Process: '', BoundaryVisible: true }), Lanes: '', NodeGraphicsInfos: nodeGraphics(p), ExtendedAttributes: ea({ SourceId: p.id }) }));
  const stores = d.participants.filter((p) => p.kind === 'data_store');
  const associations = layout.dataEdges.map((edge) => ({ ...attrs({ Id: id(`association:${edge.id}`), Source: id(edge.access === 'read' ? edge.id : edge.activity), Target: id(edge.access === 'read' ? edge.activity : edge.id) }), ConnectorGraphicsInfos: connector(edge.points), ExtendedAttributes: ea({ SourceId: edge.id, DataAccess: edge.access }) }));
  const pkg = { ...attrs({ xmlns: NS, 'xmlns:xsi': XSI, 'xmlns:xsd': XSD, Id: packageId, Name: d.entry_point.method ?? d.name, OnlyOneProcess: false }),
    PackageHeader: { XPDLVersion: '2.2', Vendor: 'Bizagi Process Modeler.', Created: timestamp, ModificationDate: timestamp, Description: d.description, Documentation: '', CreationVersion: '2.9.0.4', Version: '4.3.0.008' },
    RedefinableHeader: { Author: '', Version: '1.0' }, ExternalPackages: '',
    DataStores: { DataStore: stores.map((p) => ({ ...attrs({ Id: id(p.id), Name: p.name, IsUnlimited: true }), ObjectDocumentation: p.justification ?? '', ExtendedAttributes: provenance(p) })) },
    Pools: { Pool: [hiddenPool, pool, ...externalPools] },
    ...((d.message_flows ?? []).length ? { MessageFlows: { MessageFlow: d.message_flows.map((m) => ({ ...attrs({ Id: id(m.id), Source: id(m.from), Target: id(m.to), Name: m.name ?? '' }), ConnectorGraphicsInfos: connector(layout.messageEdges.get(m.id).points, m.name ? layout.messageEdges.get(m.id).label : null), ExtendedAttributes: ea({ SourceId: m.id }) })) } } : {}),
    Associations: { Association: associations },
    WorkflowProcesses: { WorkflowProcess: [
      { ...attrs({ Id: hiddenWorkflow, Name: 'Main Process' }), ProcessHeader: { Created: timestamp }, RedefinableHeader: { Author: '', Version: '' }, ActivitySets: '', DataInputOutputs: '', ExtendedAttributes: '' },
      { ...attrs({ Id: workflowId, Name: d.name }), ProcessHeader: { Created: timestamp, Description: d.description }, RedefinableHeader: { Author: '', Version: '' }, ActivitySets: '', DataInputOutputs: '',
        Activities: { Activity: activities },
        DataStoreReferences: { DataStoreReference: layout.dsRefs.map((ref) => ({ ...attrs({ Id: id(ref.id), DataStoreRef: id(ref.store), State: '' }), NodeGraphicsInfos: nodeGraphics(layout.shapes.get(ref.id), null, 'store', externalLabel(layout.shapes.get(ref.id), stores.find((p) => p.id === ref.store).name, layout)), ExtendedAttributes: ea({ SourceId: ref.id }) })) },
        Transitions: { Transition: transitions }, DataAssociations: '', ExtendedAttributes: '',
      },
    ] },
    ExtendedAttributes: ea({ Generator: 'BPMN Reverse Engineer', ProjectId: projectId, ProcessId: d.id, DefinitionSHA256: digest(d), ProcessDefinition: d }),
  };
  const files = {
    'Thumbnail.png': thumbnail(layout, nodes),
    'Diagram.xml': strToU8(xml({ Package: pkg })),
    'Actions.xml': strToU8(xml({ DiagramActions: attrs({ 'xmlns:xsd': XSD, 'xmlns:xsi': XSI }) })),
    'BPSimData.xml': strToU8(xml({ 'ns1:BPSimData': { ...attrs({ 'xmlns:ns1': 'http://www.bpsim.org/schemas/1.0', simulationLevel: 'LevelOne' }), 'ns1:Scenario': { ...attrs({ id: `Scenario_${id('simulation')}`, name: 'Scenario 1', author: '', version: '1.0' }), 'ns1:ScenarioParameters': { 'ns1:Duration': { 'ns1:DurationParameter': attrs({ value: 'P30D' }) }, 'ns1:PropertyParameters': '' } } } })),
    'BPSimDataResult.xml': strToU8(xml({ ScenarioResults: attrs({ 'xmlns:xsd': XSD, 'xmlns:xsi': XSI }) })),
    'ExtendedAttributeValues.xml': strToU8(xml({ DiagramAttributeValues: { ...attrs({ 'xmlns:xsd': XSD, 'xmlns:xsi': XSI }), ElementAttributeValues: { ...attrs({ ElementId: packageId }), Values: '' } } })),
  };
  return { name: `${packageId}.diag`, bytes: zipSync(files), process_id: d.id, definition_sha256: digest(d), package_id: packageId, nodes: nodes.length, flows: d.flows.length };
}

export function buildNativeProject(projectId, definitions, { generatedAt = new Date().toISOString() } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(projectId)) throw new Error('ID de proyecto inválido.');
  if (!definitions.length || new Set(definitions.map((d) => d.id)).size !== definitions.length) throw new Error('Se requieren diagramas con IDs únicos.');
  const diagrams = definitions.map((d) => diagram(projectId, d, generatedAt));
  const files = {
    'ModelInfo.xml': strToU8(xml({ BizAgiModelInfo: attrs({ 'xmlns:xsd': XSD, 'xmlns:xsi': XSI, CreationVersion: '2.9.0.4', FilePersistenceVersion: 5, ModifiedVersion: '4.3.0.008', ModifiedDate: generatedAt, IsInCollaboration: false }) })),
    'Participants.xml': strToU8(xml({ Participants: attrs({ xmlns: NS, 'xmlns:xsd': XSD, 'xmlns:xsi': XSI }) })),
    'Preferences.bpp': strToU8(xml({ ProjectPreferences: { VersionFile: attrs({ version: 3 }) } })),
    ...Object.fromEntries(diagrams.map((d) => [d.name, d.bytes])),
  };
  const bytes = zipSync(files);
  const validation = validateNativeProject(bytes, definitions);
  if (validation.approval !== 'APROBADO') throw new Error(`El contenedor nativo no supera su validación: ${JSON.stringify(validation.errors)}`);
  return { bytes, validation: { ...validation, project_id: projectId }, diagrams: diagrams.map(({ bytes: _, ...d }) => d) };
}

function safeZip(bytes, state) {
  if (bytes.length > 50 * 1024 * 1024) throw new Error('Contenedor demasiado grande.');
  return unzipSync(bytes, { filter: (f) => {
    if (++state.entries > 200 || f.originalSize > 20 * 1024 * 1024 || (state.total += f.originalSize) > 100 * 1024 * 1024) throw new Error('Límites ZIP excedidos.');
    if (!/^[A-Za-z0-9._-]+$/.test(f.name) || /users/i.test(f.name)) throw new Error('Ruta no autorizada en contenedor nativo.');
    return true;
  } });
}
function parse(bytes) {
  if (!bytes) throw new Error('Falta un archivo obligatorio.');
  const text = strFromU8(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('DOCTYPE/ENTITY rechazado.');
  const valid = XMLValidator.validate(text);
  if (valid !== true) throw new Error(`XML inválido: ${valid.err.msg}`);
  return new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, trimValues: false }).parse(text);
}

// Perfil observado, no sustituto del XSD del proveedor. El orden se conserva
// también en el validador para no aceptar una permutación XML bien formada.
function childOrder(obj, sequence, label) {
  if (typeof obj === 'object' && obj !== null && String(obj['#text'] ?? '').trim()) throw new Error(`Texto inesperado en ${label}`);
  const keys = Object.keys(obj ?? {}).filter((key) => !key.startsWith('@_') && key !== '#text');
  let previous = -1;
  for (const key of keys) {
    const current = sequence.indexOf(key);
    if (current < 0 || current <= previous) throw new Error(`Orden/elemento fuera del perfil Bizagi en ${label}: ${key}`);
    previous = current;
  }
}

// Round-trip del contrato embebido y comprobaciones de su proyección gráfica XPDL.
// No sustituye la apertura en Bizagi ni una validación XSD del proveedor.
export function validateNativeProject(bytes, expectedDefinitions = null) {
  const errors = [], diagrams = [];
  try {
    const state = { entries: 0, total: 0 };
    const outer = safeZip(bytes, state);
    const modelInfo = parse(outer['ModelInfo.xml']).BizAgiModelInfo;
    if (!modelInfo || !parse(outer['Participants.xml']).Participants || !parse(outer['Preferences.bpp']).ProjectPreferences) throw new Error('Metadatos Bizagi incompletos.');
    if (['CreationVersion', 'FilePersistenceVersion', 'ModifiedVersion', 'ModifiedDate', 'IsInCollaboration'].some((key) => !Object.hasOwn(modelInfo, `@_${key}`) || Object.hasOwn(modelInfo, key)) || modelInfo['@_FilePersistenceVersion'] !== '5' || !['true', 'false'].includes(modelInfo['@_IsInCollaboration']) || !Number.isFinite(Date.parse(modelInfo['@_ModifiedDate']))) throw new Error('ModelInfo.xml: versiones, fecha y colaboración deben ser atributos del perfil Bizagi, no elementos.');
    const seenProcesses = new Set();
    for (const [name, data] of Object.entries(outer).filter(([n]) => n.endsWith('.diag'))) {
      const inner = safeZip(data, state);
      checkThumbnail(inner['Thumbnail.png']);
      const pkg = parse(inner['Diagram.xml']).Package;
      for (const f of ['Actions.xml', 'BPSimData.xml', 'BPSimDataResult.xml', 'ExtendedAttributeValues.xml']) parse(inner[f]);
      if (!pkg || pkg['@_xmlns'] !== NS || `${pkg['@_Id']}.diag` !== name) throw new Error('Paquete XPDL/ID inválido.');
      childOrder(pkg, ['PackageHeader', 'RedefinableHeader', 'ExternalPackages', 'DataStores', 'Pools', 'MessageFlows', 'Associations', 'WorkflowProcesses', 'ExtendedAttributes'], 'Package');
      const attributes = ext(pkg);
      const def = JSON.parse(attributes.ProcessDefinition);
      const schema = validateContract('process-definition', def);
      if (!schema.valid || attributes.DefinitionSHA256 !== digest(def) || attributes.ProcessId !== def.id || seenProcesses.has(def.id)) throw new Error('Definición/trazabilidad alterada o duplicada.');
      seenProcesses.add(def.id);
      if (expectedDefinitions) {
        const expected = expectedDefinitions.find((d) => d.id === def.id);
        if (!expected || digest(expected) !== digest(def)) throw new Error(`Definición de origen no coincide: ${def.id}`);
      }
      const id = (key) => nativeId(attributes.ProjectId, def.id, key);
      const pools = arr(pkg.Pools?.Pool);
      const processes = arr(pkg.WorkflowProcesses?.WorkflowProcess);
      const defaultPool = pools.find((p) => p['@_BoundaryVisible'] === 'false');
      const defaultProcess = processes.find((p) => p['@_Id'] === defaultPool?.['@_Process']);
      if (defaultPool?.['@_Name'] !== 'Main Process' || defaultProcess?.['@_Name'] !== 'Main Process' || arr(defaultProcess.Activities?.Activity).length) throw new Error('Proceso por defecto fuera del perfil Bizagi observado.');
      for (const process of processes) childOrder(process, ['ProcessHeader', 'RedefinableHeader', 'ActivitySets', 'DataInputOutputs', 'Activities', 'DataStoreReferences', 'Transitions', 'DataAssociations', 'ExtendedAttributes'], 'WorkflowProcess');
      const wf = processes.find((p) => arr(p.Activities?.Activity).length);
      const activities = arr(wf?.Activities?.Activity), transitions = arr(wf?.Transitions?.Transition);
      const nodes = [...def.activities, ...def.events, ...def.decisions];
      if (activities.length !== nodes.length || transitions.length !== def.flows.length) throw new Error(`Conteos de nodos/flujos incorrectos: ${def.id}`);
      const identifiers = [...pools, ...processes, ...activities, ...transitions, ...pools.flatMap((p) => arr(p.Lanes?.Lane)), ...arr(pkg.DataStores?.DataStore), ...arr(wf?.DataStoreReferences?.DataStoreReference), ...arr(pkg.Associations?.Association), ...arr(pkg.MessageFlows?.MessageFlow)].map((o) => o['@_Id']);
      if (identifiers.some((v) => !v) || new Set(identifiers).size !== identifiers.length) throw new Error('IDs ausentes o duplicados.');
      const actual = new Map(activities.map((a) => [ext(a).SourceId, a]));
      const laneIds = new Set(pools.flatMap((p) => arr(p.Lanes?.Lane).map((l) => l['@_Id'])));
      const evidence = new Map(def.evidence.map((e) => [e.id, e]));
      const evidenceOf = (o) => JSON.stringify((o.evidence_ids ?? []).map((key) => evidence.get(key)));
      const graphics = (o, edge = false) => {
        const gi = arr(edge ? o.ConnectorGraphicsInfos?.ConnectorGraphicsInfo : o.NodeGraphicsInfos?.NodeGraphicsInfo)[0];
        const points = arr(gi?.Coordinates);
        if (!gi || points.length < (edge ? 2 : 1) || points.some((p) => !Number.isFinite(Number(p['@_XCoordinate'])) || !Number.isFinite(Number(p['@_YCoordinate'])))) throw new Error('Geometría ausente/inválida.');
        if (!edge && (!(Number(gi['@_Width']) > 0) || !(Number(gi['@_Height']) > 0))) throw new Error('Dimensiones inválidas.');
        if (!edge || o['@_Name']) {
          if (['TextX', 'TextY', 'TextWidth', 'TextHeight'].some((key) => gi[`@_${key}`] === undefined || !Number.isFinite(Number(gi[`@_${key}`]))) || Number(gi['@_TextWidth']) <= 0 || Number(gi['@_TextHeight']) <= 0 || Number(gi['@_TextX']) < 0 || Number(gi['@_TextY']) < 0) throw new Error('Área de texto ausente/inválida: la etiqueta sería invisible en Bizagi.');
          const font = gi.Formatting;
          if (!font || Object.keys(font).some((key) => key.startsWith('@_')) || !String(font.FontName ?? '').trim() || !(Number(font.SizeFont) >= 8) || Number(font.ColorFont) !== -16777216) throw new Error('Formato de texto inválido: se requieren elementos de fuente, tamaño positivo y negro opaco; los atributos se ignoran en Bizagi.');
          childOrder(font, ['Alignment', 'FontName', 'SizeFont', 'Bold', 'Italic', 'Strikeout', 'Underline', 'ColorFont'], 'Formatting');
        }
        return gi;
      };
      for (const n of nodes) {
        const a = actual.get(n.id);
        if (!a || a['@_Id'] !== id(n.id) || a['@_Name'] !== n.name || ext(a).EvidenceStatus !== n.evidence_status || ext(a).BPMNType !== (n.gateway ?? n.type) || ext(a).Evidence !== evidenceOf(n)) throw new Error(`Nodo o evidencia no conservados: ${n.id}`);
        childOrder(a, ['Description', ...(n.gateway ? ['Route'] : ['start', 'end'].includes(n.type) ? ['Event'] : ['Implementation', 'Performers']), 'Documentation', ...(!n.gateway && !['start', 'end'].includes(n.type) ? ['InputSets', 'OutputSets', 'Loop'] : []), 'NodeGraphicsInfos', 'ExtendedAttributes'], `Activity ${n.id}`);
        const gi = graphics(a);
        if (def.participants.some((p) => p.id === n.participant_id && p.kind === 'internal' && !p.is_pool) && (!laneIds.has(gi['@_LaneId']) || gi['@_LaneId'] !== id(n.participant_id))) throw new Error(`Carril ausente o alterado: ${n.id}`);
        if (def.activities.some((v) => v.id === n.id)) {
          const task = a.Implementation?.Task;
          const subtype = { serviceTask: 'TaskService', sendTask: 'TaskSend', receiveTask: 'TaskReceive', scriptTask: 'TaskScript' }[n.type];
          if (task === undefined || (subtype && !Object.hasOwn(task, subtype)) || (!subtype && typeof task === 'object' && Object.keys(task).length)) throw new Error(`Implementación de tarea alterada: ${n.id}`);
        }
        if (n.gateway && (a.Route === undefined || (a.Route?.['@_GatewayType'] ?? 'Exclusive') !== { exclusive: 'Exclusive', parallel: 'Parallel', inclusive: 'Inclusive' }[n.gateway])) throw new Error('Tipo de compuerta alterado.');
        if (n.type === 'end' && a.Event?.EndEvent?.['@_Result'] !== { none: 'None', error: 'Error', terminate: 'Terminate' }[n.definition ?? 'none']) throw new Error('Evento final alterado.');
        if (n.type === 'start' && a.Event?.StartEvent?.['@_Trigger'] !== 'None') throw new Error('Evento inicial alterado.');
      }
      const flowMap = new Map(transitions.map((t) => [ext(t).SourceId, t]));
      for (const f of def.flows) {
        const t = flowMap.get(f.id);
        childOrder(t, ['Condition', 'Description', 'ConnectorGraphicsInfos', 'ExtendedAttributes'], `Transition ${f.id}`);
        if (!t || t['@_Id'] !== id(f.id) || t['@_From'] !== actual.get(f.from)?.['@_Id'] || t['@_To'] !== actual.get(f.to)?.['@_Id'] || (t['@_Name'] ?? '') !== (f.name ?? '') || ext(t).Evidence !== evidenceOf(f) || ext(t).Branch !== (f.branch ?? 'next')) throw new Error(`Referencia de transición alterada: ${f.id}`);
        const defaultFlow = def.decisions.some((g) => g.default_flow_id === f.id);
        if (defaultFlow ? t.Condition?.['@_Type'] !== 'OTHERWISE' : f.condition ? t.Condition?.['@_Type'] !== 'CONDITION' || t.Condition.Expression !== f.condition : !!t.Condition) throw new Error(`Condición/default alterado: ${f.id}`);
        graphics(t, true);
      }
      const stores = arr(pkg.DataStores?.DataStore), refs = arr(wf?.DataStoreReferences?.DataStoreReference), associations = arr(pkg.Associations?.Association);
      if (stores.length !== def.participants.filter((p) => p.kind === 'data_store').length || refs.length !== def.activities.reduce((n, a) => n + (a.data_access?.length ?? 0), 0) || associations.length !== refs.length) throw new Error('Almacenes/asociaciones no conservados.');
      for (const p of def.participants.filter((p) => p.kind === 'data_store')) {
        const store = stores.find((s) => s['@_Id'] === id(p.id));
        if (!store || store['@_Name'] !== p.name || ext(store).Evidence !== evidenceOf(p)) throw new Error(`Almacén alterado: ${p.id}`);
      }
      const endpoints = new Set([...activities, ...refs, ...pools].map((p) => p['@_Id']));
      // Perfil nativo comprobado con XmlSerializer de Bizagi 4.3: no emitir
      // AssociationDirection="One" (no pertenece al enum del proveedor).
      if (associations.some((a) => a['@_AssociationDirection'] !== undefined)) throw new Error('AssociationDirection no pertenece al perfil nativo exportado; la dirección se conserva con Source/Target.');
      const messages = arr(pkg.MessageFlows?.MessageFlow);
      if (messages.length !== (def.message_flows?.length ?? 0)) throw new Error('Mensajes no conservados.');
      for (const edge of [...associations, ...messages]) { if (!endpoints.has(edge['@_Source']) || !endpoints.has(edge['@_Target'])) throw new Error('Asociación/mensaje con referencia rota.'); graphics(edge, true); }
      for (const r of refs) { if (!stores.some((s) => s['@_Id'] === r['@_DataStoreRef'])) throw new Error('Referencia de almacén rota.'); graphics(r); }
      diagrams.push({ process_id: def.id, file: name, nodes: nodes.length, flows: def.flows.length, definition_sha256: digest(def) });
    }
    if (!diagrams.length || (expectedDefinitions && diagrams.length !== expectedDefinitions.length)) throw new Error('Cantidad de diagramas incorrecta.');
  } catch (e) { errors.push(e.message); }
  return { approval: errors.length ? 'BLOQUEADO' : 'APROBADO', format: 'Bizagi .bpm / ZIP anidado con XPDL 2.2', sha256: digest(bytes), diagrams, errors, checks: ['ZIP limitado y sin Users', 'XML sin DTD/entidades', 'metadatos y paquetes', 'round-trip del contrato completo y huellas', 'nodos, flujos, condiciones y defaults', 'eventos, carriles, asociaciones y geometría'] };
}
