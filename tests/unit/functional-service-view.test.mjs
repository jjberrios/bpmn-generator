import test from 'node:test';
import assert from 'node:assert/strict';
import { functionalServiceView, checkFunctionalCoverage } from '../../tools/analysis/functional-service-view.mjs';
import { checkDefinition } from '../../tools/validation/definition-checks.mjs';
import { validateContract } from '../../tools/validation/schema-validator.mjs';

const ev = (id, status = 'CONFIRMADA') => ({ id, status, file: 'A.java', line_start: 1, line_end: 2, class: 'A', method: 'm', snippet: 'x' });
const act = (id, participant_id, extra = {}) => ({ id, name: `Tarea ${id}`, type: 'task', participant_id, description: `d ${id}`, evidence_ids: ['E1'], evidence_status: 'CONFIRMADA', ...extra });
const dec = (id, participant_id) => ({ id, name: `¿${id}?`, gateway: 'exclusive', participant_id, condition_text: `c_${id}`, evidence_ids: ['E1'], evidence_status: 'CONFIRMADA' });
const fl = (id, from, to, branch, extra = {}) => ({ id, from, to, branch, ...extra });

function sample() {
  return {
    schema_version: '1.0', id: 'P', name: 'P', description: 'p', entry_point: { kind: 'rest', class: 'A', method: 'm', file: 'A.java', line: 1 },
    abstraction_level: 'BACKEND_OBSERVABLE', scope_note: 's',
    participants: [
      { id: 'POOL', name: 'App', kind: 'internal', is_pool: true, justification: 'j', evidence_ids: ['E1'] },
      { id: 'L_C', name: 'Controlador', kind: 'internal', justification: 'j', evidence_ids: ['E1'] },
      { id: 'L_S', name: 'Servicio', kind: 'internal', justification: 'j', evidence_ids: ['E1'] },
      { id: 'L_R', name: 'Repositorio', kind: 'internal', justification: 'j', evidence_ids: ['E1'] },
      { id: 'DS', name: 'BD', kind: 'data_store', justification: 'j', evidence_ids: ['E1'] },
    ],
    activities: [
      act('A_IN', 'L_C'), act('A_PREP', 'L_R'),
      act('A_DB', 'L_R', { type: 'serviceTask', data_access: [{ data_store_id: 'DS', access: 'write' }] }),
      act('A_CLOSE', 'L_R'),
    ],
    events: [
      { id: 'S', name: 'Inicio', type: 'start', definition: 'none', participant_id: 'L_C', evidence_ids: ['E1'], evidence_status: 'CONFIRMADA' },
      { id: 'END_OK', name: 'OK', type: 'end', definition: 'none', participant_id: 'L_C', evidence_ids: ['E1'], evidence_status: 'CONFIRMADA' },
      { id: 'END_KO', name: 'KO', type: 'end', definition: 'none', participant_id: 'L_C', evidence_ids: ['E1'], evidence_status: 'CONFIRMADA' },
    ],
    decisions: [dec('D_EXC1', 'L_S'), dec('D_BIZ', 'L_S')],
    flows: [
      fl('F1', 'S', 'A_IN', 'next'), fl('F2', 'A_IN', 'D_EXC1', 'next'),
      fl('F3', 'D_EXC1', 'A_PREP', 'next'), fl('F4', 'D_EXC1', 'END_KO', 'exception', { condition: 'exc' }),
      fl('F5', 'A_PREP', 'A_DB', 'next'), fl('F6', 'A_DB', 'A_CLOSE', 'next'), fl('F7', 'A_CLOSE', 'D_BIZ', 'next'),
      fl('F8', 'D_BIZ', 'END_OK', 'true', { condition: 'c_D_BIZ' }), fl('F9', 'D_BIZ', 'END_KO', 'false'),
    ],
    outcomes: [{ id: 'O1', name: 'ok', kind: 'success', event_id: 'END_OK' }, { id: 'O2', name: 'ko', kind: 'error', event_id: 'END_KO' }],
    exceptions: [], evidence: [ev('E1')], uncertainties: [], review_status: { state: 'PENDIENTE' },
  };
}

test('la vista funcional conserva la llamada a BD como actividad del servicio y agrupa lo técnico', () => {
  const detail = sample();
  assert.equal(validateContract('process-definition', detail).valid, true);
  const { definition: view, map } = functionalServiceView(detail);
  assert.equal(validateContract('process-definition', view).valid, true);
  assert.deepEqual(checkDefinition(view).errors, []);
  const db = view.activities.find((a) => (a.data_access || []).length);
  assert.ok(db, 'la llamada a base de datos debe existir');
  assert.equal(db.participant_id, 'L_S');
  assert.equal(db.data_access[0].data_store_id, 'DS');
  assert.equal(view.decisions.some((d) => d.id === 'D_EXC1'), false);
  assert.ok(view.decisions.some((d) => d.id === 'D_BIZ'));
  assert.deepEqual(view.events.filter((e) => e.type === 'end').map((e) => e.id).sort(), ['END_KO', 'END_OK']);
  assert.equal(checkFunctionalCoverage(detail, view, map).valid, true);
});

test('la cobertura detecta una llamada a BD o un final omitidos', () => {
  const detail = sample();
  const { definition: view, map } = functionalServiceView(detail);
  const broken = structuredClone(view);
  broken.activities.forEach((a) => delete a.data_access);
  broken.events = broken.events.filter((e) => e.id !== 'END_OK');
  const codes = checkFunctionalCoverage(detail, broken, map).errors.map((e) => e.code);
  assert.ok(codes.includes('LLAMADA_BD_OMITIDA'));
  assert.ok(codes.includes('FINAL_OMITIDO'));
});
