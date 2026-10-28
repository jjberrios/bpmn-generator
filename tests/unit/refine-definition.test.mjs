import test from 'node:test';
import assert from 'node:assert/strict';
import { refineDefinition } from '../../tools/analysis/refine-definition.mjs';

test('refineDefinition degrada CONFIRMADA sin evidencia confirmada, limpia incertidumbres y es idempotente', () => {
  const def = { evidence: [{ id: 'E1', status: 'INFERIDA' }], participants: [{ id: 'P' }], activities: [{ id: 'A', evidence_status: 'CONFIRMADA', evidence_ids: ['E1'], message_target_participant_id: 'X' }], decisions: [], events: [], uncertainties: [{ id: 'U', element_ids: ['A', 'Z'] }, { id: 'U', element_ids: [] }] };
  const r = refineDefinition(def);
  assert.equal(r.activities[0].evidence_status, 'INFERIDA');
  assert.equal(r.activities[0].message_target_participant_id, undefined);
  assert.deepEqual(r.uncertainties.map((u) => u.element_ids), [['A']]);
  assert.deepEqual(refineDefinition(r), r);
});
