import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { draftProcess, loadAnalysis, discoverCandidates } from '../../tools/analysis/draft-process.mjs';
import { loadTrace } from '../../tools/pipeline.mjs';
import { validateContract } from '../../tools/validation/schema-validator.mjs';
import { renderFinalReport } from '../../tools/report.mjs';
import { normalizeGateways } from '../../tools/analysis/normalize-gateways.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bpmn-analysis-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'workspace', 'test');
  const dir = path.join(project, 'analysis');
  fs.mkdirSync(dir, { recursive: true });
  const evidence = [{ id: 'EV1', status: 'CONFIRMADA', file: 'Test.java', line_start: 1, snippet: 'class Test {}' }];
  const trace = {
    id: 'TR_EP1', entry_point_id: 'EP1', entry: { class: 'Test', method: 'run', kind: 'rest' },
    nodes: [
      { id: 'N1', type: 'entry', label: 'Inicio', class: 'Test', evidence_id: 'EV1' },
      { id: 'N2', type: 'loop', label: 'Leer filas', condition: 'rs.next()', class: 'Test', evidence_id: 'EV1' },
      { id: 'N3', type: 'action', label: 'Mapear fila', class: 'Test', evidence_id: 'EV1' },
      { id: 'N4', type: 'return', label: 'Retornar', outcome: '200 OK', class: 'Test', evidence_id: 'EV1' },
    ],
    edges: [
      { id: 'E1', from: 'N1', to: 'N2', kind: 'next' },
      { id: 'E2', from: 'N2', to: 'N3', kind: 'loop_body', condition: 'rs.next()' },
      { id: 'E3', from: 'N3', to: 'N2', kind: 'next' },
      { id: 'E4', from: 'N2', to: 'N4', kind: 'loop_exit' },
    ], evidence, paths: [], limitations: [],
  };
  const doc = { schema_version: '1.0', project_id: 'test', traces: [trace] };
  const write = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
  write('execution-trace.json', doc);
  write('architecture-map.json', { components: [{ class: 'Test', file: 'Test.java', line: 1 }], entry_points: [{ id: 'EP1', class: 'Test', method: 'run', kind: 'rest' }] });
  fs.mkdirSync(path.join(project, 'source'));
  fs.writeFileSync(path.join(project, 'source', 'Test.java'), 'class Test {}');
  return { root, project, write, doc };
}

test('el borrador normaliza loop_body/loop_exit al contrato sin perder el ciclo', (t) => {
  const { project } = fixture(t);
  const def = draftProcess({ projectDir: project, traceId: 'TR_EP1' });
  const v = validateContract('process-definition', def);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.ok(def.flows.some((f) => f.from === 'D_N2' && f.branch === 'true' && f.condition === 'rs.next()'));
  assert.ok(def.flows.some((f) => f.from === 'D_N2' && f.branch === 'false'));
  assert.ok(def.flows.some((f) => f.from === 'A_N3' && f.to === 'D_N2_JOIN'));
  assert.ok(def.flows.some((f) => f.from === 'D_N2_JOIN' && f.to === 'D_N2'));
});

test('separar unión/bifurcación conserva condiciones, ciclo, evidencia e idempotencia', (t) => {
  const { project } = fixture(t);
  const def = draftProcess({ projectDir: project, traceId: 'TR_EP1' });
  assert.equal(validateContract('process-definition', def).valid, true);
  for (const d of def.decisions) {
    assert.ok(!(def.flows.filter((f) => f.to === d.id).length > 1 && def.flows.filter((f) => f.from === d.id).length > 1));
  }
  assert.equal(def.decisions.find((d) => d.id === 'D_N2').trace_node, 'N2');
  assert.equal(def.decisions.find((d) => d.id === 'D_N2_JOIN').trace_node, undefined);
  assert.deepEqual(normalizeGateways(def), def);
});

test('loadTrace prefiere la traza agente validada, conserva la determinista y falla cerrado', (t) => {
  const { root, write, doc } = fixture(t);
  assert.equal(loadTrace('test', 'TR_EP1', root).nodes[0].label, 'Inicio');
  const agent = structuredClone(doc);
  agent.traces[0].nodes[0].label = 'Entrada verificada';
  write('execution-trace.agent.json', agent);
  assert.equal(loadTrace('test', 'TR_EP1', root).nodes[0].label, 'Entrada verificada');
  const processDir = path.join(root, 'workspace', 'test', 'processes', 'Test_run');
  fs.mkdirSync(processDir, { recursive: true });
  const local = structuredClone(agent);
  local.traces[0].nodes[0].label = 'Entrada verificada del proceso';
  fs.writeFileSync(path.join(processDir, 'execution-trace.agent.json'), JSON.stringify(local));
  assert.equal(loadTrace('test', 'TR_EP1', root, 'Test_run').nodes[0].label, 'Entrada verificada del proceso');
  agent.project_id = 'otro';
  write('execution-trace.agent.json', agent);
  assert.throws(() => loadTrace('test', 'TR_EP1', root), /inválida o de otro proyecto/);
  assert.equal(doc.traces[0].nodes[0].label, 'Inicio');
});

test('descubrimiento y borrador consumen la traza agente sin sobrescribir el análisis original', (t) => {
  const { project, write, doc } = fixture(t);
  const agent = structuredClone(doc);
  agent.traces[0].nodes[3].outcome = '201 CREATED';
  write('execution-trace.agent.json', agent);
  assert.equal(loadAnalysis(project).traces.traces[0].nodes[3].outcome, '201 CREATED');
  assert.ok(draftProcess({ projectDir: project, traceId: 'TR_EP1' }).events.some((e) => e.outcome === '201 CREATED'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(project, 'analysis', 'execution-trace.json'))).traces[0].nodes[3].outcome, '200 OK');
  agent.project_id = 'otro';
  write('execution-trace.agent.json', agent);
  assert.throws(() => loadAnalysis(project), /inválida o de otro proyecto/);
});

test('el informe sin procesos no declara validaciones BPMN ejecutadas', () => {
  const report = renderFinalReport({ projectId: 'test', manifest: {}, architecture: {}, candidates: [], processes: [] });
  assert.match(report, /no consta validación de definiciones, BPMN, DI, bpmnlint, round-trip ni revisión/);
  assert.doesNotMatch(report, /BPMN 2\.0: XML parseable/);
  assert.doesNotMatch(report, /VALIDACIÓN MANUAL/);
});

test('descubrimiento no oculta resultados propagados ni declara suficiencia con limitaciones', (t) => {
  const { project, write, doc } = fixture(t);
  doc.traces[0].nodes.push({ id: 'N5', type: 'throw', label: 'Propagar', outcome: 'HTTP desconocido', evidence_id: 'EV1' });
  doc.traces[0].limitations.push({ description: 'Enumeración de rutas limitada.' });
  write('execution-trace.json', doc);
  const [candidate] = discoverCandidates(project);
  assert.equal(candidate.evidence_sufficiency, 'PARCIAL');
  assert.ok(candidate.outcomes.includes('HTTP desconocido'));
});

test('el borrador conserva destinos excepcionales que no son catch y el resultado del throw', (t) => {
  const { project, write, doc } = fixture(t);
  const trace = doc.traces[0];
  trace.nodes.push({ id: 'N5', type: 'throw', label: 'Propagar', outcome: 'HTTP desconocido fuera del recurso', exception_type: 'Exception', class: 'Test', evidence_id: 'EV1' });
  trace.edges.push({ id: 'E5', from: 'N3', to: 'N5', kind: 'exception', condition: 'Exception durante ejecución' });
  write('execution-trace.json', doc);
  const def = draftProcess({ projectDir: project, traceId: 'TR_EP1' });
  assert.ok(def.events.some((e) => e.outcome === 'HTTP desconocido fuera del recurso'));
  assert.ok(def.flows.some((f) => f.from === 'D_N3_EXC' && f.branch === 'exception'));
  assert.equal(validateContract('process-definition', def).valid, true);
});

test('el pool se atribuye al módulo del punto de entrada, no al primer módulo inventariado', (t) => {
  const { project, write } = fixture(t);
  write('architecture-map.json', { modules: [{ name: 'integration', path: 'integration' }, { name: 'resource', path: 'resource' }], components: [{ class: 'Test', file: 'Test.java', line: 1 }], entry_points: [{ id: 'EP1', class: 'Test', method: 'run', kind: 'rest', file: 'resource/Test.java' }] });
  const def = draftProcess({ projectDir: project, traceId: 'TR_EP1' });
  assert.equal(def.participants.find((p) => p.is_pool).name, 'resource');
});
