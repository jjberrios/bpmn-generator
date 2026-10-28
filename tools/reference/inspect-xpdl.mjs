// Inspector seguro de paquetes nativos Bizagi (.bpm) usados como referencia de convenciones de modelado.
// Solo lectura: nunca extrae a disco, no modifica el archivo, no lee datos de usuario (carpeta Users/).
import fs from 'node:fs';
import crypto from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';

export const DEFAULT_LIMITS = {
  max_file_bytes: 50 * 1024 * 1024,
  max_entries: 200,
  max_entry_bytes: 20 * 1024 * 1024,
  max_total_bytes: 100 * 1024 * 1024,
  max_nesting: 2,
};

export class ReferenceError_ extends Error {}

const SKIPPED_PREFIXES = ['Users/', 'Users\\'];

function safeEntryName(name) {
  const n = name.replace(/\\/g, '/');
  return !(n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..'));
}

function openZip(bytes, limits, state, depth) {
  if (depth > limits.max_nesting) throw new ReferenceError_('Anidamiento de contenedores excesivo.');
  const out = {};
  const skipped = [];
  let count = 0;
  const entries = unzipSync(bytes, {
    filter: (f) => {
      count++;
      if (count > limits.max_entries) throw new ReferenceError_(`Demasiadas entradas en el contenedor (> ${limits.max_entries}).`);
      if (!safeEntryName(f.name)) throw new ReferenceError_(`Entrada con ruta peligrosa rechazada: ${f.name}`);
      if (SKIPPED_PREFIXES.some((p) => f.name.startsWith(p))) {
        skipped.push(f.name);
        return false;
      }
      if (f.originalSize > limits.max_entry_bytes) throw new ReferenceError_(`La entrada ${f.name} supera el tamaño máximo permitido.`);
      state.total += f.originalSize;
      if (state.total > limits.max_total_bytes) throw new ReferenceError_('Se superó el tamaño total expandido permitido.');
      return true;
    },
  });
  Object.assign(out, entries);
  return { entries: out, skipped };
}

function parseXml(text, label) {
  if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) {
    throw new ReferenceError_(`${label}: se rechazó el XML porque contiene DOCTYPE/ENTITY (riesgo XXE/expansión).`);
  }
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    processEntities: false,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    isArray: (name) => ['Pool', 'Lane', 'WorkflowProcess', 'Activity', 'Transition', 'DataStore', 'DataStoreReference', 'Association', 'DataAssociation', 'Coordinates', 'NodeGraphicsInfo', 'ConnectorGraphicsInfo'].includes(name),
  });
  return parser.parse(text);
}

// Solo componentes del formato, nunca Users/, miniaturas ni atributos extendidos de autor.
export function readNativeStructure(file, limits = DEFAULT_LIMITS) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > limits.max_file_bytes) throw new ReferenceError_('Referencia ausente o demasiado grande.');
  const state = { total: 0 };
  const outer = openZip(new Uint8Array(fs.readFileSync(file)), limits, state, 1);
  const diagrams = [];
  const binaryProfile = (data) => ({ bytes: data.length, prefix_hex: Buffer.from(data.subarray(0, 16)).toString('hex'), declaration: strFromU8(data.subarray(0, 100)).match(/<\?xml[^?]*\?>/)?.[0] ?? null });
  const binary = {};
  for (const [name, data] of Object.entries(outer.entries)) {
    if (!name.endsWith('.diag')) continue;
    const inner = openZip(data, limits, state, 2);
    if (inner.entries['Diagram.xml']) {
      const supplemental = {};
      for (const key of ['Actions.xml', 'BPSimData.xml', 'BPSimDataResult.xml', 'ExtendedAttributeValues.xml']) {
        if (inner.entries[key]) supplemental[key] = parseXml(strFromU8(inner.entries[key]), key);
      }
      diagrams.push({ name, files: Object.keys(inner.entries).sort(), binary: Object.fromEntries(Object.entries(inner.entries).filter(([n]) => /\.xml$/.test(n)).map(([n, b]) => [n, binaryProfile(b)])), document: parseXml(strFromU8(inner.entries['Diagram.xml']), name), supplemental });
    }
  }
  const metadata = {};
  for (const name of ['ModelInfo.xml', 'Preferences.bpp', 'Participants.xml']) {
    if (outer.entries[name]) { metadata[name] = parseXml(strFromU8(outer.entries[name]), name); binary[name] = binaryProfile(outer.entries[name]); }
  }
  return { metadata, binary, diagrams, skipped_user_file_types: [...new Set(outer.skipped.map((name) => name.replace(/\\/g, '/').split('/').at(-1)).filter((name) => /\.(xml|bpp|png)$/i.test(name)))] };
}

const arr = (v) => (v == null || v === '' ? [] : Array.isArray(v) ? v : [v]);
const num = (v) => (v == null ? null : Number(v));

function bounds(ngi) {
  const info = arr(ngi?.NodeGraphicsInfos?.NodeGraphicsInfo)[0];
  if (!info) return null;
  const c = arr(info.Coordinates)[0];
  return { x: num(c?.['@_XCoordinate']), y: num(c?.['@_YCoordinate']), width: num(info['@_Width']), height: num(info['@_Height']) };
}

function waypoints(tr) {
  const info = arr(tr?.ConnectorGraphicsInfos?.ConnectorGraphicsInfo)[0];
  return arr(info?.Coordinates).map((c) => ({ x: num(c['@_XCoordinate']), y: num(c['@_YCoordinate']) }));
}

function activityKind(a) {
  if (a.Event) {
    const ev = a.Event;
    if (ev.StartEvent !== undefined) return { kind: 'startEvent', subtype: ev.StartEvent?.['@_Trigger'] ?? 'None' };
    if (ev.EndEvent !== undefined) return { kind: 'endEvent', subtype: ev.EndEvent?.['@_Result'] ?? 'None' };
    if (ev.IntermediateEvent !== undefined) return { kind: 'intermediateEvent', subtype: ev.IntermediateEvent?.['@_Trigger'] ?? 'None' };
    return { kind: 'event', subtype: null };
  }
  if (a.Route !== undefined) {
    const g = a.Route?.['@_GatewayType'];
    return { kind: 'gateway', subtype: g ?? 'Exclusive (por defecto de XPDL)' };
  }
  if (a.Implementation) {
    if (a.Implementation.Task !== undefined) return { kind: 'task', subtype: null };
    if (a.Implementation.SubFlow !== undefined) return { kind: 'subProcess', subtype: null };
    return { kind: 'implementation', subtype: null };
  }
  if (a.BlockActivity !== undefined) return { kind: 'subProcess', subtype: null };
  return { kind: 'unknown', subtype: null };
}

export function inspectXpdl(xml, label = 'Diagram.xml') {
  const doc = parseXml(xml, label);
  const pkg = doc.Package;
  if (!pkg) throw new ReferenceError_(`${label}: no contiene un elemento Package XPDL.`);
  return inspectPackage(pkg);
}

function inspectPackage(pkg) {
  const header = pkg.PackageHeader ?? {};
  const processes = arr(pkg.WorkflowProcesses?.WorkflowProcess);
  const procById = new Map(processes.map((p) => [p['@_Id'], p]));

  const pools = arr(pkg.Pools?.Pool).map((p) => {
    const pb = bounds(p);
    const lanes = arr(p.Lanes?.Lane).map((l) => {
      const lb = bounds(l);
      return { id: l['@_Id'], name: l['@_Name'], bounds: lb, absolute_y: pb && lb ? { top: pb.y + lb.y, bottom: pb.y + lb.y + lb.height } : null };
    });
    return { id: p['@_Id'], name: p['@_Name'], process_id: p['@_Process'] ?? null, boundary_visible: p['@_BoundaryVisible'] !== 'false', bounds: pb, lanes };
  });
  const poolByProcess = new Map(pools.filter((p) => p.process_id).map((p) => [p.process_id, p]));

  const activities = [];
  const idToName = new Map();
  const processSummaries = [];
  for (const proc of processes) {
    const pool = poolByProcess.get(proc['@_Id']);
    const acts = arr(proc.Activities?.Activity);
    for (const a of acts) {
      const { kind, subtype } = activityKind(a);
      const b = bounds(a);
      let lane = null;
      if (pool?.lanes.length && b) {
        const cy = b.y + (b.height ?? 0) / 2;
        lane = pool.lanes.find((l) => l.absolute_y && cy >= l.absolute_y.top && cy < l.absolute_y.bottom)?.name ?? null;
      }
      activities.push({ id: a['@_Id'], name: a['@_Name'] ?? '', kind, subtype, process: proc['@_Name'], pool: pool?.name ?? null, lane_by_geometry: lane, bounds: b });
      idToName.set(a['@_Id'], a['@_Name'] ?? '');
    }
    processSummaries.push({ id: proc['@_Id'], name: proc['@_Name'], pool: pool?.name ?? null, activities: acts.length, transitions: arr(proc.Transitions?.Transition).length });
  }

  const dataStores = arr(pkg.DataStores?.DataStore).map((d) => ({ id: d['@_Id'], name: d['@_Name'] }));
  const dsById = new Map(dataStores.map((d) => [d.id, d.name]));
  const dataStoreReferences = [];
  const links = [];
  for (const a of arr(pkg.Associations?.Association)) links.push([a['@_Source'], a['@_Target']]);
  for (const proc of processes) {
    for (const a of arr(proc.DataAssociations?.DataAssociation)) links.push([a['@_From'], a['@_To']]);
  }
  for (const proc of processes) {
    for (const r of arr(proc.DataStoreReferences?.DataStoreReference)) {
      const related = [];
      for (const [from, to] of links) {
        const other = to === r['@_Id'] ? from : from === r['@_Id'] ? to : null;
        if (other && idToName.has(other) && !related.some((x) => x.id === other)) related.push({ id: other, name: idToName.get(other) });
      }
      dataStoreReferences.push({ id: r['@_Id'], data_store: dsById.get(r['@_DataStoreRef']) ?? null, associated_activities: related, bounds: bounds(r) });
    }
  }

  const transitions = [];
  for (const proc of processes) {
    for (const t of arr(proc.Transitions?.Transition)) {
      const cond = t.Condition;
      transitions.push({
        id: t['@_Id'],
        from_id: t['@_From'],
        to_id: t['@_To'],
        from: idToName.get(t['@_From']) ?? null,
        to: idToName.get(t['@_To']) ?? null,
        name: t['@_Name'] ?? null,
        condition_type: cond && typeof cond === 'object' ? cond['@_Type'] ?? null : null,
        condition_expression: cond && typeof cond === 'object' && typeof cond.Expression === 'string' && cond.Expression ? cond.Expression : null,
        waypoints: waypoints(t),
      });
    }
  }

  const tasks = activities.filter((a) => a.kind === 'task');
  const gateways = activities.filter((a) => a.kind === 'gateway');
  const ends = activities.filter((a) => a.kind === 'endEvent');
  const named = transitions.filter((t) => t.name);
  const conventions = {
    tareas_numeradas: tasks.length > 0 && tasks.every((t) => /^\d+\./.test(t.name)),
    flujos_de_decision_etiquetados: named.length > 0 ? [...new Set(named.map((t) => t.name))] : [],
    eventos_finales: ends.map((e) => e.name),
    multiples_eventos_finales_por_resultado: ends.length > 1,
    compuertas_nombradas_con_condicion: gateways.map((g) => g.name),
    pool_con_nombre_del_servicio: pools.filter((p) => p.boundary_visible && p.lanes.length).map((p) => p.name),
    carriles: pools.flatMap((p) => p.lanes.map((l) => l.name)),
    almacenes_de_datos: dataStores.map((d) => d.name),
    pool_por_defecto_vacio: pools.filter((p) => !p.lanes.length && !activities.some((a) => a.pool === p.name)).map((p) => p.name),
    nota: 'Convenciones observadas en un único archivo de referencia; sirven para comprobar el estilo de modelado, no como fuente de comportamiento de otros proyectos.',
  };

  return {
    package: {
      name: pkg['@_Name'] ?? null,
      id: pkg['@_Id'] ?? null,
      xpdl_version: header.XPDLVersion ?? null,
      vendor: header.Vendor ?? null,
      bizagi_creation_version: header.CreationVersion ?? null,
      bizagi_version: header.Version ?? null,
      namespace: pkg['@_xmlns'] ?? null,
    },
    pools,
    processes: processSummaries,
    activities,
    transitions,
    data_stores: dataStores,
    data_store_references: dataStoreReferences,
    conventions,
    counts: {
      pools: pools.length,
      lanes: pools.reduce((n, p) => n + p.lanes.length, 0),
      processes: processes.length,
      activities: activities.length,
      tasks: tasks.length,
      gateways: gateways.length,
      start_events: activities.filter((a) => a.kind === 'startEvent').length,
      end_events: ends.length,
      transitions: transitions.length,
    },
  };
}

// Analiza TODOS los diagramas, no sólo el primero del contenedor. Sólo devuelve
// convenciones y datos del modelo, nunca Users/, autores ni RuntimeProperties.
export function analyzeReferenceStyle(file) {
  const native = readNativeStructure(file);
  return {
    file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    diagrams: native.diagrams.map(({ name, document }) => {
      const pkg = document.Package, summary = inspectPackage(pkg);
      const nodes = arr(pkg.WorkflowProcesses?.WorkflowProcess).flatMap((w) => arr(w.Activities?.Activity));
      const styles = nodes.map((n) => {
        const gi = arr(n.NodeGraphicsInfos?.NodeGraphicsInfo)[0];
        const f = gi?.Formatting;
        return { kind: activityKind(n).kind, width: num(gi?.['@_Width']), height: num(gi?.['@_Height']), border: num(gi?.['@_BorderColor']), fill: num(gi?.['@_FillColor']), font: f?.FontName ?? null, size: num(f?.SizeFont), color: num(f?.ColorFont) };
      });
      return { file: name, name: summary.package.name, counts: summary.counts, conventions: summary.conventions,
        tasks: summary.activities.filter((a) => ['task', 'subProcess'].includes(a.kind)).map((a) => ({ name: a.name, lane: a.lane_by_geometry, bounds: a.bounds })),
        decisions: summary.activities.filter((a) => a.kind === 'gateway').map((a) => a.name),
        styles: [...new Map(styles.map((s) => [JSON.stringify(s), s])).values()],
        lanes: summary.pools.filter((p) => p.boundary_visible).map((p) => ({ name: p.name, bounds: p.bounds, lanes: p.lanes })),
      };
    }),
    limitations: ['Las referencias orientan presentación y abstracción, no comportamiento de otros proyectos.', 'No se copian usuarios, autores, sistemas externos, aprobaciones ni códigos de negocio de las referencias.'],
  };
}

export function inspectReference(file, limits = DEFAULT_LIMITS) {
  const warnings = [];
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new ReferenceError_('La ruta no es un archivo.');
  if (stat.size > limits.max_file_bytes) throw new ReferenceError_('El archivo supera el tamaño máximo permitido.');
  const buf = fs.readFileSync(file);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) throw new ReferenceError_('El archivo no es un contenedor ZIP (.bpm nativo de Bizagi).');

  const state = { total: 0 };
  const outer = openZip(new Uint8Array(buf), limits, state, 1);
  const container = { entries: Object.entries(outer.entries).map(([name, data]) => ({ name, bytes: data.length })), skipped: outer.skipped.length ? [`${outer.skipped.length} entrada(s) de datos de usuario no leídas (Users/)`] : [] };

  let modelInfo = null;
  if (outer.entries['ModelInfo.xml']) {
    const mi = parseXml(strFromU8(outer.entries['ModelInfo.xml']), 'ModelInfo.xml');
    const attrs = mi.BizAgiModelInfo ?? {};
    modelInfo = Object.fromEntries(Object.entries(attrs).filter(([k]) => k.startsWith('@_') && !k.startsWith('@_xmlns')).map(([k, v]) => [k.slice(2), v]));
  } else warnings.push('El paquete no contiene ModelInfo.xml.');

  let diagramXml = null;
  let diagramSource = null;
  if (outer.entries['Diagram.xml']) {
    diagramXml = strFromU8(outer.entries['Diagram.xml']);
    diagramSource = 'Diagram.xml';
  } else {
    for (const [name, data] of Object.entries(outer.entries)) {
      if (!name.toLowerCase().endsWith('.diag')) continue;
      const nested = openZip(data, limits, state, 2);
      container.nested = { name, entries: Object.entries(nested.entries).map(([n, d]) => ({ name: n, bytes: d.length })) };
      if (nested.entries['Diagram.xml']) {
        diagramXml = strFromU8(nested.entries['Diagram.xml']);
        diagramSource = `${name}!Diagram.xml`;
        break;
      }
    }
  }
  if (!diagramXml) throw new ReferenceError_('No se encontró Diagram.xml (XPDL) dentro del paquete.');

  const xpdl = inspectXpdl(diagramXml, diagramSource);
  if (xpdl.package.xpdl_version && xpdl.package.xpdl_version !== '2.2') warnings.push(`Versión XPDL inesperada: ${xpdl.package.xpdl_version}`);

  return {
    file,
    size_bytes: stat.size,
    sha256,
    inspected_at: new Date().toISOString(),
    container,
    model_info: modelInfo,
    diagram_source: diagramSource,
    ...xpdl,
    warnings,
    notes: [
      'El archivo original no se modificó; el contenido se leyó en memoria.',
      'No se leyeron ni se informan datos de usuario (carpeta Users/).',
      'La inspección describe la estructura del contenedor; no demuestra su apertura ni compatibilidad con Bizagi Modeler.',
    ],
  };
}
