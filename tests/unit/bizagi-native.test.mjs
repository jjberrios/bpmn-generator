import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { buildNativeProject, validateNativeProject, nativeId } from '../../tools/bizagi/native-project.mjs';
import { BpmnModdle } from 'bpmn-moddle';
import { generateBpmn } from '../../tools/bpmn/generate-bpmn.mjs';
import { readNativeStructure } from '../../tools/reference/inspect-xpdl.mjs';
import { makeMinimalDef } from '../helpers/minimal-process.mjs';

const defs = () => Array.from({ length: 4 }, (_, i) => {
  const d = makeMinimalDef();
  d.id = `Proceso_${i}`;
  d.name = `Consulta ${i} & <prueba>`;
  d.activities[0].name = 'Validar "datos" & <límites>';
  d.flows[2].condition = 'valor < 4 && texto != "vacío"';
  d.decisions[0].condition_text = d.flows[2].condition;
  d.events[2].definition = 'error';
  return d;
});

test('un solo .bpm contiene cuatro .diag nativos con XPDL, no cuatro BPMN renombrados', () => {
  const definitions = defs();
  const r = buildNativeProject('proyecto', definitions);
  assert.equal(r.validation.approval, 'APROBADO');
  assert.equal(r.validation.diagrams.length, 4);
  const outer = unzipSync(r.bytes);
  assert.equal(Object.keys(outer).filter((p) => p.endsWith('.diag')).length, 4);
  assert.ok(!Object.keys(outer).some((p) => /users|\.bpmn$/i.test(p)));
  const inner = unzipSync(outer[r.diagrams[0].name]);
  assert.deepEqual([...inner['Thumbnail.png'].slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.match(strFromU8(inner['Diagram.xml']), /XPDL2.2/);
  assert.match(strFromU8(inner['Diagram.xml']), /Result="Error"/);
  assert.match(strFromU8(inner['Diagram.xml']), /Type="OTHERWISE"/);
  assert.equal(validateNativeProject(r.bytes, definitions).approval, 'APROBADO');
  assert.equal(r.validation.bizagi_compatibility, undefined);
});

test('el round-trip rechaza referencias, condiciones y eventos nativos alterados', () => {
  const definitions = defs();
  const r = buildNativeProject('proyecto', definitions);
  for (const mutate of [
    (s) => s.replace(/From="[^"]+"/, 'From="inexistente"'),
    (s) => s.replace('Type="OTHERWISE"', 'Type="CONDITION"'),
    (s) => s.replace('Result="Error"', 'Result="None"'),
    (s) => s.replace('<Expression>', '<Expression>alterada'),
    (s) => s.replace('LaneId="', 'LaneId="incorrecta'),
  ]) {
    const outer = unzipSync(r.bytes), name = r.diagrams[0].name;
    const inner = unzipSync(outer[name]);
    inner['Diagram.xml'] = strToU8(mutate(strFromU8(inner['Diagram.xml'])));
    outer[name] = zipSync(inner);
    assert.equal(validateNativeProject(zipSync(outer), definitions).approval, 'BLOQUEADO');
  }
  const changed = structuredClone(definitions); changed[0].description = 'otro origen';
  assert.equal(validateNativeProject(r.bytes, changed).approval, 'BLOQUEADO');
});

test('las etiquetas tienen área visible: tareas locales, eventos/compuertas externos y conectores nombrados', () => {
  const r = buildNativeProject('prueba', defs());
  const outer = unzipSync(r.bytes), name = r.diagrams[0].name, inner = unzipSync(outer[name]);
  const parser = new XMLParser({ ignoreAttributes: false });
  const pkg = parser.parse(strFromU8(inner['Diagram.xml'])).Package;
  const list = (v) => v == null || v === '' ? [] : Array.isArray(v) ? v : [v];
  const wf = list(pkg.WorkflowProcesses.WorkflowProcess).find((v) => v.Activities);
  for (const a of wf.Activities.Activity) {
    const g = a.NodeGraphicsInfos.NodeGraphicsInfo;
    assert.ok(Number(g['@_TextWidth']) > 0 && Number(g['@_TextHeight']) > 0);
    assert.equal(g.Formatting.ColorFont, -16777216);
    assert.equal(g.Formatting.FontName, 'Segoe UI');
    assert.equal(g.Formatting.SizeFont, 8);
    if (a.Implementation !== undefined) {
      assert.equal(g['@_TextX'], '0'); assert.equal(g['@_TextY'], '0');
      assert.equal(g['@_TextWidth'], g['@_Width']); assert.equal(g['@_TextHeight'], g['@_Height']);
    } else {
      assert.ok(Number(g['@_TextX']) > 0 || Number(g['@_TextY']) > 0, 'posición externa absoluta');
    }
  }
  for (const f of wf.Transitions.Transition.filter((v) => v['@_Name'])) {
    assert.ok(Number(f.ConnectorGraphicsInfos.ConnectorGraphicsInfo['@_TextWidth']) > 0);
  }
  const original = strFromU8(inner['Diagram.xml']);
  for (const mutate of [
    (s) => s.replace(/ TextWidth="[^"]+"/g, ''),
    (s) => s.replace(/TextHeight="[^"]+"/g, 'TextHeight="0"'),
    (s) => s.replace(/TextX="[^"]+"/g, 'TextX="NaN"'),
  ]) {
    inner['Diagram.xml'] = strToU8(mutate(original)); outer[name] = zipSync(inner);
    const invalid = validateNativeProject(zipSync(outer));
    assert.equal(invalid.approval, 'BLOQUEADO');
    assert.match(invalid.errors[0], /Área de texto/);
  }
});

test('el formato usa elementos de fuente opaca, no atributos ignorados por Bizagi', () => {
  const definitions = defs(), r = buildNativeProject('prueba', definitions);
  const outer = unzipSync(r.bytes), name = r.diagrams[0].name, inner = unzipSync(outer[name]);
  const original = strFromU8(inner['Diagram.xml']);
  assert.match(original, /<Formatting>\s*<Alignment>Center<\/Alignment>\s*<FontName>Segoe UI<\/FontName>/);
  for (const mutate of [
    (s) => s.replace(/<Formatting>[\s\S]*?<\/Formatting>/g, '<Formatting FontName="Segoe UI" SizeFont="8" ColorFont="-16777216"></Formatting>'),
    (s) => s.replaceAll('<ColorFont>-16777216</ColorFont>', '<ColorFont>0</ColorFont>'),
    (s) => s.replaceAll('<SizeFont>8</SizeFont>', '<SizeFont>0</SizeFont>'),
    (s) => s.replaceAll('<FontName>Segoe UI</FontName>', '<FontName></FontName>'),
  ]) {
    inner['Diagram.xml'] = strToU8(mutate(original)); outer[name] = zipSync(inner);
    const invalid = validateNativeProject(zipSync(outer));
    assert.equal(invalid.approval, 'BLOQUEADO');
    assert.match(invalid.errors[0], /Formato de texto/);
  }
});

test('exportación cerrada: no descarta eventos no implementados, Users ni DTD', () => {
  const d = defs(); d[0].events[0].definition = 'timer';
  assert.throws(() => buildNativeProject('proyecto', d), /no implementado/);
  const r = buildNativeProject('proyecto', defs()), outer = unzipSync(r.bytes);
  outer['Users.xml'] = strToU8('<Users/>');
  assert.equal(validateNativeProject(zipSync(outer)).approval, 'BLOQUEADO');
  delete outer['Users.xml']; outer['ModelInfo.xml'] = strToU8('<!DOCTYPE a [<!ENTITY x "x">]><a/>');
  assert.equal(validateNativeProject(zipSync(outer)).approval, 'BLOQUEADO');
});

test('almacenes y mensajes conservan sus referencias y geometría', () => {
  const d = makeMinimalDef();
  d.participants.push({ id: 'DS', name: 'SP (efectos desconocidos)', kind: 'data_store', justification: 'Lectura inferida', evidence_ids: ['EV2'] }, { id: 'EXT', name: 'Sistema externo', kind: 'external', justification: 'Integración de prueba', evidence_ids: ['EV2'] });
  d.activities[0].data_access = [{ data_store_id: 'DS', access: 'read' }];
  d.message_flows = [{ id: 'M1', from: 'A1', to: 'EXT', name: 'Solicitud', evidence_ids: ['EV2'] }];
  const r = buildNativeProject('prueba', [d]);
  assert.equal(validateNativeProject(r.bytes, [d]).approval, 'APROBADO');
  const outer = unzipSync(r.bytes), name = r.diagrams[0].name, inner = unzipSync(outer[name]);
  assert.doesNotMatch(strFromU8(inner['Diagram.xml']), /AssociationDirection=/);
  inner['Diagram.xml'] = strToU8(strFromU8(inner['Diagram.xml']).replace('<Association ', '<Association AssociationDirection="One" '));
  outer[name] = zipSync(inner);
  const rejected = validateNativeProject(zipSync(outer));
  assert.equal(rejected.approval, 'BLOQUEADO');
  assert.match(rejected.errors[0], /AssociationDirection/);
});

test('ModelInfo usa atributos y el validador rechaza el perfil anterior con elementos', () => {
  const r = buildNativeProject('prueba', defs()), outer = unzipSync(r.bytes);
  const text = strFromU8(outer['ModelInfo.xml']);
  assert.match(text, /FilePersistenceVersion="5"/);
  assert.doesNotMatch(text, /<FilePersistenceVersion>/);
  outer['ModelInfo.xml'] = strToU8(text.replace(' FilePersistenceVersion="5"', '').replace('</BizAgiModelInfo>', '<FilePersistenceVersion>5</FilePersistenceVersion></BizAgiModelInfo>'));
  const invalid = validateNativeProject(zipSync(outer));
  assert.equal(invalid.approval, 'BLOQUEADO');
  assert.match(invalid.errors[0], /ModelInfo.xml/);
});

test('el orden XML de Activity se comprueba además de su buena formación', () => {
  const r = buildNativeProject('prueba', defs()), outer = unzipSync(r.bytes), name = r.diagrams[0].name;
  const inner = unzipSync(outer[name]);
  const text = strFromU8(inner['Diagram.xml']);
  inner['Diagram.xml'] = strToU8(text.replace(/(<Activity\b[^>]*>\s*)(<Description>[\s\S]*?<\/Description>)(\s*<Implementation>[\s\S]*?<\/Implementation>)/, '$1$3$2'));
  outer[name] = zipSync(inner);
  const invalid = validateNativeProject(zipSync(outer));
  assert.equal(invalid.approval, 'BLOQUEADO');
  assert.match(invalid.errors[0], /Orden/);
});

const REFERENCE = 'inputs/references/claro-post-consultareclamos.bpm';
test('las etiquetas compartidas de BPMN y Bizagi no se solapan ni alteran la definición', async () => {
  const d = makeMinimalDef();
  d.decisions[0].name = '¿Cómo termina el manejo?';
  d.flows[1].name = 'NO';
  d.flows[2].name = 'Propagación JSON';
  d.flows[3].name = 'Catch fallido';
  const before = JSON.stringify(d), gen = await generateBpmn(d);
  const { rootElement } = await new BpmnModdle().fromXML(gen.xml);
  const plane = rootElement.diagrams[0].plane.planeElement;
  const r = buildNativeProject('prueba', [d]);
  const outer = unzipSync(r.bytes), inner = unzipSync(outer[r.diagrams[0].name]);
  const pkg = new XMLParser({ ignoreAttributes: false }).parse(strFromU8(inner['Diagram.xml'])).Package;
  const list = (v) => v == null ? [] : Array.isArray(v) ? v : [v];
  const wf = list(pkg.WorkflowProcesses.WorkflowProcess).find((w) => w.Activities);
  const boxes = [...gen.layout.nodeLabels.values(), ...[...gen.layout.flowEdges.values()].flatMap((e) => e.label ? [e.label] : [])];
  assert.equal(gen.layout.metrics.label_overlaps, 0);
  for (let i = 0; i < boxes.length; i++) for (const b of boxes.slice(i + 1)) {
    const a = boxes[i];
    assert.ok(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h), 'sin texto sobre texto');
  }
  for (const [id, box] of gen.layout.nodeLabels) {
    const bpmn = plane.find((e) => e.bpmnElement?.id === id).label.bounds;
    const native = list(wf.Activities.Activity).find((a) => a['@_Id'] === nativeId('prueba', d.id, id)).NodeGraphicsInfos.NodeGraphicsInfo;
    assert.deepEqual([bpmn.x, bpmn.y, bpmn.width, bpmn.height], [box.x, box.y, box.w, box.h].map(Math.round));
    assert.deepEqual(['TextX', 'TextY', 'TextWidth', 'TextHeight'].map((key) => Number(native[`@_${key}`])), [box.x, box.y, box.w, box.h]);
  }
  for (const f of d.flows.filter((v) => v.name)) {
    const box = gen.layout.flowEdges.get(f.id).label;
    const bpmn = plane.find((e) => e.bpmnElement?.id === `Flow_${f.id}`).label.bounds;
    const native = list(wf.Transitions.Transition).find((a) => a['@_Id'] === nativeId('prueba', d.id, f.id)).ConnectorGraphicsInfos.ConnectorGraphicsInfo;
    assert.deepEqual([bpmn.x, bpmn.y, bpmn.width, bpmn.height], [box.x, box.y, box.w, box.h].map(Math.round));
    assert.deepEqual(['TextX', 'TextY', 'TextWidth', 'TextHeight'].map((key) => Number(native[`@_${key}`])), [box.x, box.y, box.w, box.h]);
  }
  assert.equal(JSON.stringify(d), before);
});

test('el perfil se contrasta con la referencia independiente sin copiar sus datos', { skip: !fs.existsSync(REFERENCE) && 'referencia ausente' }, () => {
  const before = fs.readFileSync(REFERENCE);
  const reference = readNativeStructure(REFERENCE);
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false });
  const d = makeMinimalDef();
  d.participants.push({ id: 'DS', kind: 'data_store', name: 'Almacén de prueba', justification: 'Prueba', evidence_ids: ['EV2'] });
  d.activities[0].data_access = [{ data_store_id: 'DS', access: 'read' }];
  const r = buildNativeProject('prueba', [d]), outer = unzipSync(r.bytes);
  const inner = unzipSync(outer[r.diagrams[0].name]);
  assert.deepEqual(Object.keys(inner).sort(), reference.diagrams[0].files, 'mismos documentos por diagrama, incluida miniatura propia');
  const actualMeta = parser.parse(strFromU8(outer['ModelInfo.xml'])).BizAgiModelInfo;
  const referenceMeta = reference.metadata['ModelInfo.xml'].BizAgiModelInfo;
  assert.deepEqual(Object.keys(actualMeta).sort(), Object.keys(referenceMeta).sort());
  for (const key of ['CreationVersion', 'FilePersistenceVersion', 'ModifiedVersion', 'IsInCollaboration']) assert.equal(actualMeta[`@_${key}`], referenceMeta[`@_${key}`]);
  const childKeys = (o) => Object.keys(o).filter((key) => !key.startsWith('@_'));
  const list = (o) => o == null || o === '' ? [] : Array.isArray(o) ? o : [o];
  const ref = reference.diagrams[0].document.Package;
  const generated = parser.parse(strFromU8(unzipSync(outer[r.diagrams[0].name])['Diagram.xml'])).Package;
  assert.deepEqual(childKeys(generated), childKeys(ref));
  const actualWfs = list(generated.WorkflowProcesses.WorkflowProcess), refWfs = list(ref.WorkflowProcesses.WorkflowProcess);
  const defaultPool = list(generated.Pools.Pool).find((p) => p['@_BoundaryVisible'] === 'false');
  const refDefaultPool = list(ref.Pools.Pool).find((p) => p['@_BoundaryVisible'] === 'false');
  assert.equal(defaultPool['@_Name'], refDefaultPool['@_Name']);
  assert.equal(actualWfs.find((w) => w['@_Id'] === defaultPool['@_Process'])['@_Name'], 'Main Process');
  for (let i = 0; i < actualWfs.length; i++) assert.deepEqual(childKeys(actualWfs[i]), childKeys(refWfs[i]));
  const refActivities = refWfs.flatMap((wf) => list(wf.Activities?.Activity));
  const kind = (a) => a.Route !== undefined ? 'route' : a.Event !== undefined ? 'event' : 'task';
  for (const a of actualWfs.flatMap((wf) => list(wf.Activities?.Activity))) {
    const exemplar = refActivities.find((v) => kind(a) === kind(v));
    assert.ok(exemplar, `La referencia contiene ${kind(a)}`);
    assert.deepEqual(childKeys(a), childKeys(exemplar));
    assert.deepEqual(a.NodeGraphicsInfos.NodeGraphicsInfo.Formatting, list(exemplar.NodeGraphicsInfos.NodeGraphicsInfo)[0].Formatting, 'formato tipográfico igual al de la referencia independiente');
    if (a.Route !== undefined) assert.deepEqual(a.Route, exemplar.Route, 'XOR usa Route vacío, como la referencia');
  }
  assert.ok(before.equals(fs.readFileSync(REFERENCE)), 'la referencia se conserva intacta');
});

test('miniatura propia obligatoria: rechaza ausencia, corrupción y proceso por defecto alterado', () => {
  const definitions = defs(), r = buildNativeProject('prueba', definitions);
  for (const mutation of ['missing', 'corrupt', 'default']) {
    const outer = unzipSync(r.bytes), name = r.diagrams[0].name, inner = unzipSync(outer[name]);
    if (mutation === 'missing') delete inner['Thumbnail.png'];
    else if (mutation === 'corrupt') inner['Thumbnail.png'][inner['Thumbnail.png'].length - 1] ^= 1;
    else inner['Diagram.xml'] = strToU8(strFromU8(inner['Diagram.xml']).replaceAll('Name="Main Process"', 'Name="MainProcess"'));
    outer[name] = zipSync(inner);
    const report = validateNativeProject(zipSync(outer), definitions);
    assert.equal(report.approval, 'BLOQUEADO');
    assert.match(report.errors[0], mutation === 'default' ? /Proceso por defecto/ : /Thumbnail.png/);
  }
  const one = buildNativeProject('prueba', [definitions[0]]), two = buildNativeProject('prueba', [definitions[0]]);
  const image = (result) => unzipSync(unzipSync(result.bytes)[result.diagrams[0].name])['Thumbnail.png'];
  assert.deepEqual(image(one), image(two), 'miniatura determinista, no depende de usuarios ni metadatos de fecha');
  const changed = structuredClone(definitions[0]);
  changed.activities.push({ ...changed.activities[0], id: 'EXTRA', name: 'Otra actividad' });
  const f = changed.flows.find((v) => v.from === changed.activities[0].id);
  const target = f.to; f.to = 'EXTRA';
  changed.flows.push({ id: 'F_EXTRA', from: 'EXTRA', to: target, branch: 'next' });
  assert.notDeepEqual(image(one), image(buildNativeProject('prueba', [changed])), 'la miniatura procede del diagrama actual');
});
