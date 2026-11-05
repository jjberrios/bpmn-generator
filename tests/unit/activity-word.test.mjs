import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { buildActivityDocx, validateActivityDocx, generateActivityWord, currentActivityWord } from '../../tools/documentation/activity-word.mjs';

const definition = { id: 'Stock_query', activities: [{ id: 'A1', name: '1. Validar parámetros', evidence_ids: ['EV1'], description: 'Validar oficina', type: 'task' }], evidence: [{ id: 'EV1', file: 'Stock.java', line_start: 1, line_end: 1 }] };
const annotation = { activities: { A1: { type: 'Servicio', operation: 'Validar <oficina> & material', location: 'No aplica', input: [['oficina', 'Request', '-', 'Obligatorio']], output: [['faltantes', 'List<String>', 'Servicio', 'Lista']], considerations: 'No trim.\nSin BD.', properties: 'No aplica', query: 'No aplica', evidence: [{ file: 'Stock.java', line_start: 1, line_end: 1 }] } } };

test('Word editable: estructura de las imágenes, bordes, cabeceras grises y Unicode/XML escapado', () => {
  const { bytes, fichas } = buildActivityDocx(definition, annotation);
  assert.equal(validateActivityDocx(bytes, 1).approval, 'APROBADO');
  const xml = strFromU8(unzipSync(bytes)['word/document.xml']);
  for (const label of ['Tipo', 'Nombre', 'Operación', 'URL / TNSNAMES / JNDI', 'INPUT', 'OUTPUT', 'Transformación', 'CONSIDERACIONES', 'VARIABLES PROPERTIES', 'Query - Script']) assert.ok(xml.includes(label));
  assert.match(xml, /&lt;oficina&gt; &amp; material/);
  assert.match(xml, /w:fill="D9D9D9"/);
  assert.match(xml, /w:tblBorders/);
  assert.doesNotMatch(xml, /Ficha reconstruida|Anexo de evidencias|alcance|Stock\.java/);
  assert.equal(fichas.length, definition.activities.length);
  assert.equal(fichas[0].status, 'INFERIDA');
  assert.throws(() => validateActivityDocx(bytes, 2), /Cantidad/);
});

test('Word vinculado al BPMN final: cobertura exacta, fuentes y detección de obsolescencia', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'word-final-'));
  try {
    const source = path.join(root, 'workspace', 'Project', 'source');
    const pdir = path.join(root, 'workspace', 'Project', 'processes', definition.id);
    const base = path.join(root, 'workspace', 'Project', '_intermedios', 'diagrams', definition.id);
    const reports = path.join(root, 'workspace', 'Project', '_intermedios', 'reports');
    for (const dir of [source, pdir, path.dirname(base), reports]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(source, 'Stock.java'), 'class Stock {}');
    fs.writeFileSync(path.join(pdir, 'activity-documentation.json'), JSON.stringify(annotation));
    fs.writeFileSync(`${base}.process.json`, JSON.stringify(definition));
    const xml = '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"><bpmn:process><bpmn:task id="A1" name="1. Validar parámetros"/></bpmn:process></bpmn:definitions>';
    fs.writeFileSync(`${base}.bpmn`, xml);
    const validation = path.join(reports, `${definition.id}.validation.json`);
    const review = path.join(reports, `${definition.id}.review.json`);
    fs.writeFileSync(validation, JSON.stringify({ approval: 'BLOQUEADO' }));
    fs.writeFileSync(review, JSON.stringify({ verdict: 'APROBADO' }));
    assert.throws(() => generateActivityWord('Project', definition.id, { root }), /bloqueado/);
    fs.writeFileSync(validation, JSON.stringify({ approval: 'APROBADO' }));
    const result = generateActivityWord('Project', definition.id, { root });
    assert.equal(result.content_status, 'DOCUMENTADO_CON_EVIDENCIA');
    assert.deepEqual(result.coverage.map(f => [f.activity_id, f.name]), definition.activities.map(a => [a.id, a.name]));
    assert.equal(currentActivityWord('Project', definition.id, { root }).approval, 'APROBADO');
    fs.writeFileSync(`${base}.bpmn`, xml + '\n');
    assert.equal(currentActivityWord('Project', definition.id, { root }).approval, 'DESACTUALIZADO');
    fs.writeFileSync(`${base}.bpmn`, xml.replace('id="A1"', 'id="A2"'));
    assert.throws(() => generateActivityWord('Project', definition.id, { root }), /actividades del BPMN/);
    fs.writeFileSync(`${base}.bpmn`, xml);
    fs.writeFileSync(path.join(source, 'Stock.java'), 'class Changed {}');
    assert.throws(() => generateActivityWord('Project', definition.id, { root }), /fuentes documentadas cambiaron/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Regresión: nombres con «&&», «>=» y «<» serializados como entidades numéricas o con nombre coinciden con el BPMN', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'word-entities-'));
  try {
    const name = '76. Evaluar != null && >= x & y < z';
    const def = { id: 'Ent_proc', activities: [{ id: 'A1', name, evidence_ids: [], description: 'x', type: 'task' }], evidence: [] };
    const base = path.join(root, 'workspace', 'Project', '_intermedios', 'diagrams', def.id);
    fs.mkdirSync(path.dirname(base), { recursive: true });
    fs.mkdirSync(path.join(root, 'workspace', 'Project', 'source'), { recursive: true });
    fs.mkdirSync(path.join(root, 'workspace', 'Project', 'processes', def.id), { recursive: true });
    fs.writeFileSync(`${base}.process.json`, JSON.stringify(def));
    const wrap = (n) => `<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"><bpmn:process><bpmn:task id="A1" name="${n}"/></bpmn:process></bpmn:definitions>`;
    for (const encoded of ['76. Evaluar != null &#38;&#38; &#62;= x &#38; y &#60; z', '76. Evaluar != null &amp;&amp; &gt;= x &amp; y &lt; z']) {
      fs.writeFileSync(`${base}.bpmn`, wrap(encoded));
      const result = generateActivityWord('Project', def.id, { root, definition: def });
      assert.equal(result.approval, 'APROBADO');
    }
    fs.writeFileSync(`${base}.bpmn`, wrap('76. Evaluar != null &amp;#38;&amp;#38; &gt;= x &amp; y &lt; z'));
    assert.throws(() => generateActivityWord('Project', def.id, { root, definition: def }), /actividades del BPMN/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('No inventa entradas para otras actividades ni admite fichas huérfanas o sin evidencia', () => {
  assert.match(buildActivityDocx(definition).fichas[0].input[0][3], /No determinado/);
  assert.throws(() => buildActivityDocx(definition, { activities: { OTRO: {} } }), /inexistente/);
  assert.throws(() => buildActivityDocx(definition, { activities: { A1: { ...annotation.activities.A1, evidence: [] } } }), /evidencias/);
  assert.throws(() => buildActivityDocx(definition, { activities: { A1: { ...annotation.activities.A1, input: [['una columna']] } } }), /cuatro textos/);
});

test('Generación agrupada por proyecto, evidencia local y protección de rutas y rangos', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'word-activity-'));
  try {
    const source = path.join(root, 'workspace', 'Project', 'source');
    const pdir = path.join(root, 'workspace', 'Project', 'processes', definition.id);
    fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(source, 'Stock.java'), 'class Stock {}');
    const file = path.join(pdir, 'activity-documentation.json');
    fs.writeFileSync(file, JSON.stringify(annotation));
    const result = generateActivityWord('Project', definition.id, { root, definition });
    assert.equal(result.annotated_activities, 1);
    assert.equal(result.file, 'workspace/Project/_intermedios/documents/Stock_query.docx');
    assert.ok(fs.existsSync(path.join(root, result.file)));
    const bad = structuredClone(annotation);
    bad.activities.A1.evidence[0].file = '../Stock.java';
    fs.writeFileSync(file, JSON.stringify(bad));
    assert.throws(() => generateActivityWord('Project', definition.id, { root, definition }), /Ruta/);
    bad.activities.A1.evidence[0] = { file: 'Stock.java', line_start: 1, line_end: 300 };
    fs.writeFileSync(file, JSON.stringify(bad));
    assert.throws(() => generateActivityWord('Project', definition.id, { root, definition }), /Rango/);
    assert.throws(() => generateActivityWord('../Project', definition.id, { root, definition }), /inválido/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
