import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { textIssues, checkNameQuality } from '../../tools/validation/name-quality.mjs';
import { errorHandlingDecisions } from '../../tools/analysis/functional-service-view.mjs';
import { missingNarrative } from '../../tools/documentation/general-word.mjs';
import { publishDeliverables } from '../../tools/layout-paths.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

test('detecta nombres con expresiones Java, genéricos y codificación dañada', () => {
  const bad = ['Evaluar fecha == null', 'Evaluar != null Iteración', 'Validar a && b', 'Invocar consultarCapacidad (no resuelto)', 'Validar par\u00c3\u00a1metros', 'Verificar condiciones técnicas'];
  for (const n of bad) assert.ok(textIssues(n).length > 0, n);
  for (const n of ['Validar parámetros de entrada', 'Consultar capacidad disponible', 'Responder 200 OK']) assert.deepEqual(textIssues(n), [], n);
});

test('checkNameQuality marca actividades y decisiones técnicas', () => {
  const r = checkNameQuality({ activities: [{ id: 'A1', name: 'Evaluar x == null' }, { id: 'A2', name: 'Validar fecha de consulta' }], decisions: [] });
  assert.equal(r.valid, false);
  assert.deepEqual([...new Set(r.issues.map((i) => i.element_id))], ['A1']);
});

test('errorHandlingDecisions solo reconoce decisiones alcanzables únicamente por excepción con el mismo destino', () => {
  const detail = {
    events: [{ id: 'S', type: 'start' }, { id: 'END', type: 'end' }],
    activities: [{ id: 'A', name: 'a' }],
    decisions: [{ id: 'D_ERR' }, { id: 'D_BIZ' }],
    flows: [
      { id: 'F1', from: 'S', to: 'A', branch: 'next' },
      { id: 'F2', from: 'A', to: 'D_BIZ', branch: 'next' },
      { id: 'F3', from: 'D_BIZ', to: 'END', branch: 'true' }, { id: 'F4', from: 'D_BIZ', to: 'END', branch: 'false' },
      { id: 'F5', from: 'A', to: 'D_ERR', branch: 'exception' },
      { id: 'F6', from: 'D_ERR', to: 'END', branch: 'true' }, { id: 'F7', from: 'D_ERR', to: 'END', branch: 'false' },
    ],
  };
  const ids = errorHandlingDecisions(detail).map((d) => d.decision_id);
  assert.deepEqual(ids, ['D_ERR']);
});

test('missingNarrative informa qué apartados faltan y no inventa texto', () => {
  const def = { activities: [{ id: 'A1', name: 'x' }, { id: 'A2', name: 'y' }] };
  const all = missingNarrative(def, {});
  assert.ok(all.includes('purpose') && all.includes('steps.A1') && all.includes('steps.A2'));
  const none = missingNarrative(def, { purpose: 'p', entry: 'e', decisions: 'd', systems: 's', implementation: 'i', steps: { A1: 'a', A2: 'b' } });
  assert.deepEqual(none, []);
});

test('las fuentes del generador no contienen caracteres dañados por doble codificación', () => {
  for (const f of ['tools/analysis/functional-service-view.mjs', 'tools/bpmn/generate-bpmn.mjs', 'tools/validation/name-quality.mjs']) {
    const txt = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (f.endsWith('name-quality.mjs')) continue; // contiene el patrón de detección
    assert.ok(!/[\u00c3\u00c2]|\u00e2\u20ac|\ufffd/.test(txt), f);
  }
});

test('publishDeliverables publica con prefijo BORRADOR_ si falta documentación', () => {
  const id = `qg-test-${process.pid}`;
  const work = path.join(ROOT, 'workspace', id, '_intermedios');
  const out = path.join(ROOT, 'outputs', id);
  try {
    fs.mkdirSync(path.join(work, 'diagrams'), { recursive: true });
    fs.writeFileSync(path.join(work, 'diagrams', 'P_m.bpmn'), '<x/>');
    fs.writeFileSync(path.join(work, 'diagrams', 'P_m.process.json'), JSON.stringify({ id: 'P_m', activities: [{ id: 'A', name: 'Validar parámetros' }], decisions: [] }));
    const published = publishDeliverables(ROOT, id);
    assert.equal(published.quality.status, 'BORRADOR');
    assert.deepEqual(fs.readdirSync(out), ['BORRADOR_P_m.bpmn']);
  } finally {
    fs.rmSync(path.join(ROOT, 'workspace', id), { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});
