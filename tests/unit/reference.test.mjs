import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { inspectReference, inspectXpdl, analyzeReferenceStyle, ReferenceError_ } from '../../tools/reference/inspect-xpdl.mjs';

const REFERENCE = 'inputs/references/claro-post-consultareclamos.bpm';
const NS = 'http://www.wfmc.org/2009/XPDL2.2';

const XPDL = `<?xml version="1.0"?>
<Package xmlns="${NS}" Id="p1" Name="demo">
  <PackageHeader><XPDLVersion>2.2</XPDLVersion><Vendor>Bizagi Process Modeler.</Vendor></PackageHeader>
  <Pools><Pool Id="pool1" Name="servicio" Process="wp1" BoundaryVisible="true">
    <Lanes><Lane Id="l1" Name="Carril A"><NodeGraphicsInfos><NodeGraphicsInfo Width="800" Height="200"><Coordinates XCoordinate="0" YCoordinate="0"/></NodeGraphicsInfo></NodeGraphicsInfos></Lane></Lanes>
    <NodeGraphicsInfos><NodeGraphicsInfo Width="800" Height="200"><Coordinates XCoordinate="0" YCoordinate="0"/></NodeGraphicsInfo></NodeGraphicsInfos>
  </Pool></Pools>
  <WorkflowProcesses><WorkflowProcess Id="wp1" Name="servicio">
    <Activities>
      <Activity Id="a1" Name="Inicio"><Event><StartEvent Trigger="None"/></Event><NodeGraphicsInfos><NodeGraphicsInfo Width="30" Height="30"><Coordinates XCoordinate="20" YCoordinate="50"/></NodeGraphicsInfo></NodeGraphicsInfos></Activity>
      <Activity Id="a2" Name="1.Validar"><Implementation><Task/></Implementation><NodeGraphicsInfos><NodeGraphicsInfo Width="90" Height="60"><Coordinates XCoordinate="100" YCoordinate="40"/></NodeGraphicsInfo></NodeGraphicsInfos></Activity>
      <Activity Id="a3" Name="Fin"><Event><EndEvent Result="None"/></Event><NodeGraphicsInfos><NodeGraphicsInfo Width="30" Height="30"><Coordinates XCoordinate="300" YCoordinate="50"/></NodeGraphicsInfo></NodeGraphicsInfos></Activity>
    </Activities>
    <Transitions>
      <Transition Id="t1" From="a1" To="a2"/>
      <Transition Id="t2" From="a2" To="a3" Name="SI"><Condition Type="CONDITION"><Expression/></Condition></Transition>
    </Transitions>
  </WorkflowProcess></WorkflowProcesses>
</Package>`;

function tmpFile(name, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpmn-re-ref-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}
const diag = (xml) => zipSync({ 'Diagram.xml': strToU8(xml), 'Actions.xml': strToU8('<a/>') });
const bpm = (entries) => zipSync(entries);

test('inspectXpdl extrae pools, lanes, actividades y transiciones', () => {
  const r = inspectXpdl(XPDL, 'demo');
  assert.equal(r.package.name, 'demo');
  assert.equal(r.counts.pools, 1);
  assert.equal(r.counts.lanes, 1);
  assert.equal(r.counts.transitions, 2);
  const kinds = r.activities.map((a) => a.kind).sort();
  assert.deepEqual(kinds, ['endEvent', 'startEvent', 'task']);
  assert.equal(r.transitions.find((t) => t.name === 'SI').condition_type, 'CONDITION');
});

test('inspectReference abre el contenedor y el .diag anidado sintético', () => {
  const file = tmpFile('demo.bpm', bpm({ 'abc.diag': diag(XPDL), 'ModelInfo.xml': strToU8('<BizAgiModelInfo CreationVersion="1"/>') }));
  const r = inspectReference(file);
  assert.equal(r.counts.activities, 3);
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
});

test('el análisis de estilo recorre todos los diagramas sin modificar la referencia', () => {
  const file = tmpFile('multiple.bpm', bpm({ 'a.diag': diag(XPDL), 'b.diag': diag(XPDL.replace('Name="demo"', 'Name="segundo"')) }));
  const before = fs.readFileSync(file);
  const r = analyzeReferenceStyle(file);
  assert.equal(r.diagrams.length, 2);
  assert.deepEqual(r.diagrams.map((d) => d.name).sort(), ['demo', 'segundo']);
  assert.ok(r.diagrams.every((d) => d.tasks.length === 1));
  assert.ok(before.equals(fs.readFileSync(file)));
  assert.ok(!JSON.stringify(r).includes('UserInfo'));
});

test('rechaza XML con DOCTYPE / entidades (XXE)', () => {
  const evil = XPDL.replace('<?xml version="1.0"?>', '<?xml version="1.0"?><!DOCTYPE p [<!ENTITY x SYSTEM "file:///c:/windows/win.ini">]>');
  const file = tmpFile('evil.bpm', bpm({ 'abc.diag': diag(evil) }));
  assert.throws(() => inspectReference(file), ReferenceError_);
});

test('rechaza rutas peligrosas dentro del contenedor y archivos que no son ZIP', () => {
  const trav = tmpFile('trav.bpm', bpm({ '../evil.diag': diag(XPDL) }));
  assert.throws(() => inspectReference(trav), ReferenceError_);
  const notZip = tmpFile('x.bpm', Buffer.from('no soy un zip'));
  assert.throws(() => inspectReference(notZip), ReferenceError_);
});

test('rechaza contenedores sin Diagram.xml y aplica límites', () => {
  const none = tmpFile('none.bpm', bpm({ 'abc.diag': zipSync({ 'Actions.xml': strToU8('<a/>') }) }));
  assert.throws(() => inspectReference(none), ReferenceError_);
  const ok = tmpFile('limit.bpm', bpm({ 'abc.diag': diag(XPDL) }));
  assert.throws(() => inspectReference(ok, { max_entries: 1, max_total_bytes: 10 }), ReferenceError_);
});

test('referencia real de Bizagi (si está presente): estructura conocida', { skip: !fs.existsSync(REFERENCE) && 'referencia ausente: prueba no ejecutada' }, () => {
  const before = fs.readFileSync(REFERENCE);
  const r = inspectReference(REFERENCE);
  assert.equal(r.package.name, 'consultarReclamos');
  assert.ok(r.pools.some((p) => p.name === 'claro-post-atencion'));
  const lanes = r.pools.flatMap((p) => p.lanes ?? []).map((l) => l.name);
  assert.ok(lanes.includes('consultarCheckNotifica') && lanes.includes('BUS DATOS'));
  const names = r.activities.map((a) => a.name);
  assert.ok(names.some((n) => /Validar parametros de entrada/.test(n)));
  assert.ok(names.some((n) => /Obtener check notificacion/.test(n)));
  assert.equal(r.counts.transitions, 7);
  assert.ok(r.transitions.some((t) => t.name === 'SI') && r.transitions.some((t) => t.name === 'NO'));
  assert.ok(!JSON.stringify(r).includes('UserInfo'), 'no se debe leer información de usuario');
  assert.ok(before.equals(fs.readFileSync(REFERENCE)), 'el archivo original no debe modificarse');
});
