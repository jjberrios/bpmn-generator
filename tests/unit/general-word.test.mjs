import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { generateActivityWord, buildNarrativeDocx, validateActivityDocx } from '../../tools/documentation/activity-word.mjs';
import { generalSections, generateGeneralWord, currentGeneralWord } from '../../tools/documentation/general-word.mjs';

const def = { id: 'Query', activities: [{ id: 'A1', name: '1. Consultar stock', evidence_ids: [], description: 'Consulta', data_access: [{ data_store_id: 'DS', access: 'read' }] }], evidence: [], events: [{ id: 'S', type: 'start', name: 'Recibir consulta' }], outcomes: [{ name: 'Stock consultado' }], decisions: [] };
test('Explicación general: prosa editable, todas las etapas, sin tablas de parámetros ni anexos', () => {
  const sections = generalSections(def, { purpose: 'Consultar <stock> & disponibilidad', steps: { A1: 'El servicio consulta el stock.' } });
  const bytes = buildNarrativeDocx(sections);
  assert.equal(validateActivityDocx(bytes, 0).approval, 'APROBADO');
  const xml = strFromU8(unzipSync(bytes)['word/document.xml']);
  assert.match(xml, /Consultar &lt;stock&gt; &amp; disponibilidad/);
  assert.match(xml, /1\. Consultar stock/);
  assert.match(xml, /Qué hace el código/);
  assert.doesNotMatch(xml, /<w:tbl>|Anexo|Ficha reconstruida/);
  assert.throws(() => generalSections(def, { steps: { NO_EXISTE: 'Inventado' } }), /inválida/);
  assert.throws(() => generalSections(def, { purpose: 1 }), /texto/);
});
test('Segundo Word: exige el primero vigente y detecta cambios en BPMN, narrativa y documento', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'general-word-'));
  try {
    const pdir = path.join(root, 'workspace', 'Project', 'processes', 'Query');
    const base = path.join(root, 'outputs', 'Project', 'diagrams', 'Query');
    const reports = path.join(root, 'outputs', 'Project', 'reports');
    for (const folder of [pdir, path.dirname(base), reports, path.join(root, 'workspace', 'Project', 'source')]) fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(`${base}.process.json`, JSON.stringify(def));
    fs.writeFileSync(`${base}.bpmn`, '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"><bpmn:process><bpmn:task id="A1" name="1. Consultar stock"/></bpmn:process></bpmn:definitions>');
    for (const [suffix, value] of [['validation', { approval: 'APROBADO' }], ['review', { verdict: 'APROBADO' }]]) fs.writeFileSync(path.join(reports, `Query.${suffix}.json`), JSON.stringify(value));
    assert.throws(() => generateGeneralWord('Project', 'Query', { root }), /primero/);
    generateActivityWord('Project', 'Query', { root });
    const result = generateGeneralWord('Project', 'Query', { root });
    assert.match(result.file, /outputs\/Project\/documents\/Query.explicacion-general.docx/);
    assert.equal(result.content_status, 'INCOMPLETO');
    assert.equal(currentGeneralWord('Project', 'Query', { root }).approval, 'APROBADO');
    fs.writeFileSync(path.join(pdir, 'process-explanation.json'), JSON.stringify({ purpose: 'Nueva interpretación' }));
    assert.equal(currentGeneralWord('Project', 'Query', { root }).approval, 'DESACTUALIZADO');
    generateGeneralWord('Project', 'Query', { root });
    fs.appendFileSync(path.join(root, result.file), 'alterado');
    assert.equal(currentGeneralWord('Project', 'Query', { root }).approval, 'DESACTUALIZADO');
    generateGeneralWord('Project', 'Query', { root });
    fs.appendFileSync(`${base}.bpmn`, ' ');
    assert.equal(currentGeneralWord('Project', 'Query', { root }).approval, 'DESACTUALIZADO');
    assert.throws(() => generateGeneralWord('Project', 'Query', { root }), /vigente/);
    assert.throws(() => generateGeneralWord('../Project', 'Query', { root }), /inválido/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
