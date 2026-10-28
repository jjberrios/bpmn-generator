import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeMinimalDef } from '../helpers/minimal-process.mjs';
import { checkAbstraction, definitionHash } from '../../tools/validation/abstraction-checks.mjs';
import { compileFunctionalPlan, materializeFunctionalPlan } from '../../tools/analysis/materialize-functional.mjs';

function fixture() {
  const source = makeMinimalDef();
  const view = structuredClone(source);
  view.name = 'Vista por actividades';
  const map = { process_id: source.id, source_sha256: definitionHash(source), view_sha256: definitionHash(view), groups: [...source.activities, ...source.events, ...source.decisions].map((n) => ({ target_id: n.id, source_node_ids: [n.id], reason: 'Misma responsabilidad respaldada por el detalle.' })), outcomes: source.outcomes.map((o) => ({ target_id: o.id, source_outcome_ids: [o.id], description: o.name })) };
  return { source, view, map };
}

test('la vista por actividades conserva la cobertura completa del detalle y su versión', () => {
  const { source, view, map } = fixture();
  assert.equal(checkAbstraction(source, view, map).valid, true);
  map.groups.pop();
  assert.match(checkAbstraction(source, view, map).errors.join('\n'), /sin representación|sin respaldo/);
  const other = fixture();
  other.source.description = 'Otra versión';
  assert.match(checkAbstraction(other.source, other.view, other.map).errors.join('\n'), /otra versión/);
});

test('no permite omitir resultados, cambiar su naturaleza ni inventar evidencia', () => {
  for (const mutation of ['omit', 'kind', 'http', 'evidence']) {
    const { source, view, map } = fixture();
    if (mutation === 'omit') map.outcomes.pop();
    if (mutation === 'kind') view.outcomes[1].kind = 'success';
    if (mutation === 'http') view.outcomes[1].http_status = '500';
    if (mutation === 'evidence') view.evidence[0].snippet = 'inventado';
    map.view_sha256 = definitionHash(view);
    assert.equal(checkAbstraction(source, view, map).valid, false, mutation);
  }
});

test('materializar un plan conserva entrada y evidencias originales, sin tocar la fuente', () => {
  const { source, view, map } = fixture();
  const before = JSON.stringify(source);
  delete view.entry_point;
  delete view.evidence;
  for (const node of [...view.activities, ...view.events, ...view.decisions]) delete node.evidence_ids;
  const plan = { process_id: source.id, definition: view, groups: map.groups, outcomes: map.outcomes };
  const compiled = compileFunctionalPlan(source, plan);
  assert.equal(compiled.validation.valid, true);
  assert.deepEqual(compiled.definition.entry_point, source.entry_point);
  assert.deepEqual(compiled.definition.evidence, source.evidence);
  assert.equal(JSON.stringify(source), before);
  plan.outcomes.pop();
  assert.throws(() => compileFunctionalPlan(source, plan), /Plan funcional inválido/);
});

test('el lote funcional inválido no sustituye vistas existentes ni acepta planes de source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'functional-plan-'));
  const base = path.join(root, 'workspace', 'test');
  const { source, view, map } = fixture();
  const dir = path.join(base, 'processes', source.id);
  fs.mkdirSync(dir, { recursive: true });
  const main = path.join(dir, 'process-definition.json');
  const output = path.join(dir, 'functional-definition.json');
  const file = path.join(base, 'plan.json');
  const plan = { project_id: 'test', processes: [{ process_id: source.id, definition: view, groups: map.groups, outcomes: map.outcomes }] };
  fs.writeFileSync(main, JSON.stringify(source));
  fs.writeFileSync(output, JSON.stringify(view));
  const before = fs.readFileSync(output, 'utf8');
  try {
    const other = structuredClone(plan.processes[0]);
    other.process_id = 'Second';
    other.definition.id = 'Second';
    other.outcomes.pop();
    const secondDir = path.join(base, 'processes', 'Second');
    fs.mkdirSync(secondDir);
    fs.writeFileSync(path.join(secondDir, 'process-definition.json'), JSON.stringify({ ...source, id: 'Second' }));
    fs.writeFileSync(file, JSON.stringify({ ...plan, processes: [...plan.processes, other] }));
    assert.throws(() => materializeFunctionalPlan('test', file, { root }), /Plan funcional inválido/);
    assert.equal(fs.readFileSync(output, 'utf8'), before);
    assert.equal(fs.existsSync(path.join(dir, 'abstraction-map.json')), false);
    fs.mkdirSync(path.join(base, 'source'));
    const untrusted = path.join(base, 'source', 'plan.json');
    fs.writeFileSync(untrusted, JSON.stringify(plan));
    assert.throws(() => materializeFunctionalPlan('test', untrusted, { root }), /fuera de source/);
    fs.writeFileSync(file, JSON.stringify(plan));
    const result = materializeFunctionalPlan('test', file, { root });
    assert.equal(result.processes[0].validation.valid, true);
    assert.equal(fs.readFileSync(main, 'utf8'), JSON.stringify(source));
    assert.equal(fs.existsSync(path.join(dir, 'history', 'functional', definitionHash(view), 'functional-definition.json')), true);
  } finally {
    // Exclusivamente el árbol temporal creado por esta prueba.
    fs.rmSync(root, { recursive: true, force: true });
  }
});
