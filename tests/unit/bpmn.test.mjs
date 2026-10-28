import test from 'node:test';
import assert from 'node:assert/strict';
import { BpmnModdle } from 'bpmn-moddle';
import { generateBpmn, GenerationError } from '../../tools/bpmn/generate-bpmn.mjs';
import { layoutProcess } from '../../tools/bpmn/layout.mjs';
import { renderSvg } from '../../tools/bpmn/preview-svg.mjs';
import { validateBpmnXml } from '../../tools/validation/validate-bpmn.mjs';
import { validateContract } from '../../tools/validation/schema-validator.mjs';
import { makeMinimalDef, makeParallelDef } from '../helpers/minimal-process.mjs';

async function parse(xml) {
  const moddle = new BpmnModdle();
  const { rootElement, warnings } = await moddle.fromXML(xml);
  return { moddle, root: rootElement, warnings };
}
const byType = (root, type) => {
  const out = [];
  const walk = (els) => {
    for (const e of els ?? []) {
      if (e.$type === type) out.push(e);
      if (e.flowElements) walk(e.flowElements);
    }
  };
  for (const r of root.rootElements) if (r.$type === 'bpmn:Process') walk(r.flowElements);
  return out;
};

test('la definición mínima cumple el contrato process-definition', () => {
  const r = validateContract('process-definition', makeMinimalDef());
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

test('un contrato inválido se rechaza (falta evidencia, estado desconocido)', () => {
  const d = makeMinimalDef();
  d.evidence[0].status = 'TAL_VEZ';
  assert.equal(validateContract('process-definition', d).valid, false);
  const e = makeMinimalDef();
  delete e.activities;
  assert.equal(validateContract('process-definition', e).valid, false);
});

test('generación: evento inicial, finales, tarea, XOR con dos salidas y condiciones', async () => {
  const gen = await generateBpmn(makeMinimalDef());
  const { root, warnings } = await parse(gen.xml);
  assert.equal(warnings.length, 0, JSON.stringify(warnings.map((w) => w.message)));
  assert.equal(byType(root, 'bpmn:StartEvent').length, 1);
  assert.equal(byType(root, 'bpmn:EndEvent').length, 2);
  assert.equal(byType(root, 'bpmn:Task').length, 1);
  const [gw] = byType(root, 'bpmn:ExclusiveGateway');
  assert.ok(gw);
  assert.equal(gw.outgoing.length, 2);
  assert.ok(gw.default, 'la compuerta debe declarar su flujo por defecto');
  const flows = byType(root, 'bpmn:SequenceFlow');
  assert.equal(flows.length, 4);
  const conditional = flows.filter((f) => f.conditionExpression);
  assert.equal(conditional.length, 1);
  assert.equal(conditional[0].conditionExpression.body, 'ok');
  assert.equal(flows.find((f) => f.id === gw.default.id).conditionExpression, undefined);
});

test('generación: lanes, colaboración y ausencia de referencias rotas', async () => {
  const gen = await generateBpmn(makeMinimalDef());
  const { root } = await parse(gen.xml);
  const collab = root.rootElements.find((r) => r.$type === 'bpmn:Collaboration');
  assert.ok(collab);
  const proc = root.rootElements.find((r) => r.$type === 'bpmn:Process');
  assert.equal(proc.laneSets[0].lanes.length, 2);
  const ids = new Set();
  for (const lane of proc.laneSets[0].lanes) for (const ref of lane.flowNodeRef) ids.add(ref.id);
  assert.equal(ids.size, 5);
});

test('generación: sin lanes cuando no corresponden', async () => {
  const gen = await generateBpmn(makeMinimalDef({ lanes: false }));
  const { root } = await parse(gen.xml);
  const proc = root.rootElements.find((r) => r.$type === 'bpmn:Process');
  assert.equal(proc.laneSets?.length ?? 0, 0);
});

test('BPMN DI: forma por cada nodo, conexión por cada flujo, coordenadas válidas', async () => {
  const gen = await generateBpmn(makeMinimalDef());
  const { root } = await parse(gen.xml);
  const plane = root.diagrams[0].plane;
  const shapes = plane.planeElement.filter((e) => e.$type === 'bpmndi:BPMNShape');
  const edges = plane.planeElement.filter((e) => e.$type === 'bpmndi:BPMNEdge');
  const shaped = new Set(shapes.map((s) => s.bpmnElement.id));
  for (const id of ['START', 'A1', 'D1', 'END_OK', 'END_FAIL']) assert.ok(shaped.has(id), `forma de ${id}`);
  assert.equal(edges.length, 4);
  for (const s of shapes) {
    assert.ok(s.bounds.x >= 0 && s.bounds.y >= 0 && s.bounds.width > 0 && s.bounds.height > 0);
  }
  for (const e of edges) assert.ok(e.waypoint.length >= 2);
});

test('round-trip: importar y exportar con bpmn-moddle conserva ids y estructura', async () => {
  const gen = await generateBpmn(makeMinimalDef());
  const first = await parse(gen.xml);
  const { xml } = await first.moddle.toXML(first.root, { format: true });
  const second = await parse(xml);
  const ids = (r) => byType(r, 'bpmn:SequenceFlow').map((f) => f.id).sort();
  assert.deepEqual(ids(second.root), ids(first.root));
  assert.equal(second.root.diagrams[0].plane.planeElement.length, first.root.diagrams[0].plane.planeElement.length);
});

test('layout: horizontal, sin solapes ni cruces con nodos', () => {
  const lay = layoutProcess(makeMinimalDef());
  assert.equal(lay.metrics.overlaps, 0);
  assert.equal(lay.metrics.edge_crossings_with_nodes, 0);
  const x = (id) => lay.shapes.get(id).x;
  assert.ok(x('START') < x('A1') && x('A1') < x('D1') && x('D1') < x('END_OK'));
  for (const s of lay.shapes.values()) {
    assert.ok(s.x >= lay.pool.x && s.x + s.w <= lay.pool.x + lay.pool.w, `${s.id} dentro del pool`);
  }
  assert.equal(lay.lanes.length, 2);
});

test('compuertas paralelas: fork/join sin condiciones', async () => {
  const gen = await generateBpmn(makeParallelDef());
  const { root } = await parse(gen.xml);
  assert.equal(byType(root, 'bpmn:ParallelGateway').length, 2);
  for (const f of byType(root, 'bpmn:SequenceFlow')) assert.equal(f.conditionExpression, undefined);
  const report = await validateBpmnXml(gen.xml, { definition: makeParallelDef(), sidecar: gen.traceability });
  assert.equal(report.approval, 'APROBADO', JSON.stringify(report.issues));
});

test('validación: el BPMN generado supera todos los controles automáticos', async () => {
  const def = makeMinimalDef();
  const gen = await generateBpmn(def);
  const report = await validateBpmnXml(gen.xml, { definition: def, sidecar: gen.traceability });
  assert.equal(report.approval, 'APROBADO', JSON.stringify(report.issues));
  assert.equal(report.summary.errors, 0);
  for (const [k, v] of Object.entries(report.checks)) assert.equal(v, 'OK', `${k}: ${v}`);
  assert.equal(report.bizagi_compatibility, undefined);
});

test('validación: detecta referencia rota, DI ausente y elemento huérfano', async () => {
  const def = makeMinimalDef();
  const gen = await generateBpmn(def);

  const broken = gen.xml.replace(/targetRef="END_FAIL"/, 'targetRef="NO_EXISTE"');
  const r1 = await validateBpmnXml(broken, { definition: def });
  assert.equal(r1.approval, 'BLOQUEADO');
  assert.ok(r1.issues.some((i) => i.severity === 'ERROR'));

  const noDi = gen.xml.replace(/<bpmndi:BPMNDiagram[\s\S]*<\/bpmndi:BPMNDiagram>/, '');
  const r2 = await validateBpmnXml(noDi, { definition: def });
  assert.equal(r2.approval, 'BLOQUEADO');
  assert.ok(r2.issues.some((i) => i.code === 'SIN_BPMNDI'));

  const r3 = await validateBpmnXml('<bpmn:definitions', {});
  assert.equal(r3.approval, 'BLOQUEADO');
  assert.ok(r3.issues.some((i) => i.code === 'XML_NO_PARSEABLE'));
});

test('validación: la trazabilidad detecta elementos eliminados del BPMN', async () => {
  const def = makeMinimalDef();
  const gen = await generateBpmn(def);
  const smaller = structuredClone(gen.traceability);
  const first = Object.keys(smaller)[0];
  delete smaller[first];
  const report = await validateBpmnXml(gen.xml, { definition: def, sidecar: smaller });
  assert.ok(report.issues.some((i) => i.code.startsWith('TRAZA_')));
});

test('el generador se bloquea ante definiciones inconsistentes', async () => {
  const orphan = makeMinimalDef();
  orphan.activities.push({ id: 'A_HUERFANA', name: 'Huérfana', type: 'task', participant_id: 'LN_B', evidence_ids: ['EV2'], evidence_status: 'CONFIRMADA' });
  await assert.rejects(() => generateBpmn(orphan), (e) => e instanceof GenerationError && e.details.some((d) => d.code === 'ELEMENTO_HUERFANO'));

  const noEnd = makeMinimalDef();
  noEnd.events = noEnd.events.filter((e) => e.type !== 'end');
  await assert.rejects(() => generateBpmn(noEnd), GenerationError);

  const noCond = makeMinimalDef();
  delete noCond.flows[2].condition;
  await assert.rejects(() => generateBpmn(noCond), (e) => e.details.some((d) => d.code === 'FLUJO_SIN_CONDICION'));

  const noEvidence = makeMinimalDef();
  noEvidence.activities[0].evidence_ids = [];
  await assert.rejects(() => generateBpmn(noEvidence), (e) => e.details.some((d) => d.code === 'ELEMENTO_SIN_EVIDENCIA'));
});

test('ids estables: dos generaciones producen el mismo XML', async () => {
  const a = await generateBpmn(makeMinimalDef());
  const b = await generateBpmn(makeMinimalDef());
  assert.equal(a.xml, b.xml);
});

test('la vista previa SVG se renderiza desde el BPMN DI', async () => {
  const gen = await generateBpmn(makeMinimalDef());
  const { svg, width, height } = await renderSvg(gen.xml);
  assert.match(svg, /^<svg[\s\S]*<\/svg>\s*$/);
  assert.ok(width > 100 && height > 100);
  assert.ok(svg.includes('Validar datos'));
});

test('trazabilidad: cada elemento BPMN enlaza a evidencias con estado', async () => {
  const gen = await generateBpmn(makeMinimalDef());
  const entry = gen.traceability.A1;
  assert.ok(entry, 'A1 en el sidecar');
  assert.equal(entry.evidence_status, 'CONFIRMADA');
  assert.equal(entry.evidence[0].file, 'src/Main.java');
  assert.equal(entry.evidence[0].line_start, 2);
});
