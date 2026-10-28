import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { draftProcess } from '../../tools/analysis/draft-process.mjs';
import { reviewProcess, finalizeReport, mergeReports } from '../../tools/validation/review-checks.mjs';
import { validateContract } from '../../tools/validation/schema-validator.mjs';
import { prepareFixtureProject, loadTrace, PROJECT_DIR } from '../helpers/fixture-project.mjs';

let trace;
const base = () => draftProcess({ projectDir: PROJECT_DIR, traceId: 'TR_EP2' });
const review = (def) => reviewProcess({ definition: def, trace, sourceDir: path.join(PROJECT_DIR, 'source') });
const has = (report, category, severity) => report.findings.some((f) => f.category === category && (!severity || f.severity === severity));

before(() => {
  prepareFixtureProject();
  trace = loadTrace('TR_EP2');
});

test('línea base: el borrador determinista no produce hallazgos ALTO/CRÍTICO y expone la inferencia', () => {
  const r = review(base());
  assert.equal(validateContract('review-report', r).valid, true);
  assert.ok(!r.findings.some((f) => ['CRÍTICO', 'ALTO'].includes(f.severity)), JSON.stringify(r.findings));
  assert.equal(r.verdict, 'APROBADO_CON_OBSERVACIONES');
  assert.ok(r.unconfirmed_inferences.length >= 1, 'las inferencias no confirmadas deben ser visibles');
  assert.ok(has(r, 'COMPORTAMIENTO_NO_RESUELTO') || has(r, 'INFERENCIA_NO_CONFIRMADA'));
});

test('detecta una tarea sin evidencia', () => {
  const d = base();
  d.activities.push({ id: 'A_X', name: 'Aprobar solicitud', type: 'task', participant_id: d.activities[0].participant_id, evidence_ids: [], evidence_status: 'CONFIRMADA' });
  const r = review(d);
  assert.ok(has(r, 'ACTIVIDAD_SIN_EVIDENCIA', 'CRÍTICO'));
  assert.equal(r.verdict, 'RECHAZADO');
});

test('incluye almacenes con efectos desconocidos en el inventario de inferencias', () => {
  const d = base();
  d.participants.push({ id: 'DS_UNKNOWN', name: 'SP configurado', kind: 'data_store', justification: 'Nombre inferido de configuración; efectos internos no disponibles.', evidence_ids: ['EV2'] });
  d.uncertainties.push({ id: 'UNC_DS', description: 'La presencia de un cursor no demuestra lectura exclusiva ni efectos transaccionales.', element_ids: ['DS_UNKNOWN'], status: 'DESCONOCIDA' });
  const r = review(d);
  assert.ok(r.unconfirmed_inferences.some((u) => u.element_id === 'DS_UNKNOWN' && u.status === 'DESCONOCIDA'));
  assert.ok(r.findings.some((f) => f.element_id === 'DS_UNKNOWN' && f.severity === 'MEDIO'));
  d.participants.at(-1).evidence_ids = ['EV_MISSING'];
  assert.ok(review(d).findings.some((f) => f.element_id === 'DS_UNKNOWN' && f.category === 'EVIDENCIA_INEXISTENTE' && f.severity === 'ALTO'));
});

test('detecta una rama omitida', () => {
  const d = base();
  d.flows.splice(d.flows.findIndex((f) => f.id === 'F2'), 1);
  const r = review(d);
  assert.ok(has(r, 'RAMA_OMITIDA'));
  assert.equal(r.verdict, 'RECHAZADO');
});

test('detecta una decisión mal interpretada (ramas invertidas)', () => {
  const d = base();
  const f2 = d.flows.find((f) => f.id === 'F2');
  const f3 = d.flows.find((f) => f.id === 'F3');
  [f2.to, f3.to] = [f3.to, f2.to];
  assert.ok(has(review(d), 'DECISION_MAL_INTERPRETADA'));
});

test('detecta una decisión con condición distinta a la del código', () => {
  const d = base();
  d.decisions[0].condition_text = 'orderId == 0';
  assert.ok(has(review(d), 'DECISION_MAL_INTERPRETADA'));
});

test('detecta evidencias inexistentes (archivo, líneas y fragmento)', () => {
  const noFile = base();
  noFile.evidence.push({ id: 'EVX', status: 'CONFIRMADA', file: 'src/Foo.java', line_start: 1, line_end: 1 });
  noFile.activities[0].evidence_ids = ['EVX'];
  assert.ok(has(review(noFile), 'EVIDENCIA_INEXISTENTE', 'CRÍTICO'));

  const badLines = base();
  const e = badLines.evidence.find((x) => x.id === 'EV2');
  e.line_start = 999;
  e.line_end = 999;
  assert.ok(has(review(badLines), 'EVIDENCIA_INEXISTENTE', 'CRÍTICO'));

  const badSnippet = base();
  badSnippet.evidence.find((x) => x.id === 'EV2').snippet = 'algo que no está en el código';
  assert.ok(has(review(badSnippet), 'EVIDENCIA_INEXISTENTE'));

  const traversal = base();
  traversal.evidence.find((x) => x.id === 'EV2').file = '../../package.json';
  assert.ok(has(review(traversal), 'EVIDENCIA_INEXISTENTE'));
});

test('distingue el comportamiento no resuelto: DESCONOCIDA declarada vs. presentada como CONFIRMADA', () => {
  const honest = review(base());
  assert.ok(honest.unconfirmed_inferences.some((u) => u.status === 'DESCONOCIDA'));
  assert.ok(!has(honest, 'COMPORTAMIENTO_NO_RESUELTO', 'ALTO'));

  const d = base();
  const a = d.activities.find((x) => x.evidence_status === 'DESCONOCIDA');
  assert.ok(a, 'el borrador debe contener una actividad DESCONOCIDA (StatusAuditor)');
  a.evidence_status = 'CONFIRMADA';
  assert.ok(has(review(d), 'COMPORTAMIENTO_NO_RESUELTO', 'ALTO'));
});

test('detecta una operación importante omitida (persistencia/servicio externo)', () => {
  const d = base();
  d.activities[0].trace_nodes = [];
  d.activities[0].evidence_ids = [];
  assert.ok(has(review(d), 'OPERACION_OMITIDA', 'ALTO'));
});

test('correlaciona evidencias aunque cambien los IDs de nodos y detecta condición alterada', () => {
  const d = base();
  for (const a of d.activities) delete a.trace_nodes;
  for (const e of d.events) delete e.trace_node;
  for (const g of d.decisions) delete g.trace_node;
  assert.ok(!has(review(d), 'OPERACION_OMITIDA', 'ALTO'));
  assert.ok(!has(review(d), 'RAMA_OMITIDA', 'ALTO'));
  d.decisions[0].condition_text = 'orderId == 0';
  assert.ok(has(review(d), 'DECISION_MAL_INTERPRETADA', 'ALTO'));
});

test('detecta un evento final con resultado inexistente y resultados sin evento final', () => {
  const d = base();
  const end = d.events.find((e) => e.type === 'end');
  end.outcome = '418 I_AM_A_TEAPOT';
  assert.ok(has(review(d), 'EVENTO_INCOHERENTE'));
});

test('un retorno HTTP genérico admite audit refinados sin aceptar otro estado HTTP', () => {
  const d = base();
  const generic = structuredClone(trace);
  for (const n of generic.nodes) if (n.outcome) n.outcome = '200 OK (retorno directo; código por defecto de Spring MVC)';
  for (const e of d.events) if (e.type === 'end') e.outcome = `HTTP 200 con responseAudit de ${e.id}`;
  const check = () => reviewProcess({ definition: d, trace: generic, sourceDir: path.join(PROJECT_DIR, 'source') });
  assert.ok(!has(check(), 'EVENTO_INCOHERENTE'));
  assert.ok(!has(check(), 'DECISION_MAL_INTERPRETADA'));
  d.events.find((e) => e.type === 'end').outcome = '418 I_AM_A_TEAPOT';
  assert.ok(has(check(), 'EVENTO_INCOHERENTE', 'ALTO'));
});

test('la revisión de un agente se fusiona sin degradar los hallazgos automáticos', () => {
  const auto = review(base());
  const agent = finalizeReport({
    process_id: auto.process_id,
    reviewer: 'bpmn-reviewer',
    findings: [{ severity: 'ALTO', category: 'OPERACION_OMITIDA', element_id: 'A_N14', description: 'Falta reintento', evidence_refs: [], recommendation: 'Revisar', source: 'agente' }],
    unconfirmed_inferences: [],
  });
  assert.equal(validateContract('review-report', agent).valid, true);
  const merged = mergeReports(auto.process_id, [auto, agent], 'combinado');
  assert.equal(merged.verdict, 'RECHAZADO');
  assert.ok(merged.findings.length >= auto.findings.length + 1);
  assert.ok(merged.unconfirmed_inferences.length >= auto.unconfirmed_inferences.length);
});

test('una excepción previa necesita corredor normal, evidencia y destino; no basta contar salidas', () => {
  const d = base();
  const t = structuredClone(trace);
  const g = d.decisions.find((x) => x.trace_node);
  const target = d.events.find((e) => e.type === 'end' && e.outcome && e.evidence_ids.length);
  const evidence = d.evidence.find((e) => e.id === target.evidence_ids[0]);
  t.evidence.push({ ...evidence, id: 'TRACE_EXCEPTION_EV' });
  t.nodes.push({ id: 'TRACE_EXCEPTION', type: 'catch', label: 'Excepción agrupada', evidence_id: 'TRACE_EXCEPTION_EV', outcome: target.outcome });
  t.edges.push({ id: 'TRACE_EXCEPTION_EDGE', from: g.trace_node, to: 'TRACE_EXCEPTION', kind: 'exception' });
  const incoming = d.flows.filter((f) => f.to === g.id);
  assert.equal(incoming.length, 1);
  incoming[0].to = 'WRAPPER';
  d.decisions.push({ ...g, id: 'WRAPPER', trace_node: undefined, condition_text: 'Excepción antes del predicado', default_flow_id: 'WRAPPER_NORMAL' });
  d.flows.push({ id: 'WRAPPER_NORMAL', from: 'WRAPPER', to: g.id, branch: 'default' });
  const exceptional = { id: 'WRAPPER_EXCEPTION', from: 'WRAPPER', to: target.id, branch: 'exception', condition: 'Lanza excepción' };
  d.flows.push(exceptional);
  const check = () => reviewProcess({ definition: d, trace: t, sourceDir: path.join(PROJECT_DIR, 'source') });
  assert.ok(!has(check(), 'RAMA_OMITIDA', 'ALTO'), JSON.stringify(check().findings));
  d.flows.pop();
  assert.ok(has(check(), 'RAMA_OMITIDA', 'ALTO'));
  d.flows.push(exceptional);
  d.decisions.find((x) => x.id === 'WRAPPER').evidence_ids = [];
  assert.ok(has(check(), 'RAMA_OMITIDA', 'ALTO'));
});

test('un informe no declara fidelidad funcional', () => {
  assert.match(review(base()).summary, /fidelidad/i);
});
