import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, finalReport } from '../../tools/pipeline.mjs';
import { validateContract } from '../../tools/validation/schema-validator.mjs';
import { generateFunctional } from '../../tools/functional-view.mjs';
import { definitionHash } from '../../tools/validation/abstraction-checks.mjs';

const ZIP = 'tests/fixtures/orders-service.zip';
const PID = 'orders-service';

function cli(...args) {
  const r = spawnSync(process.execPath, ['tools/cli.mjs', ...args], { cwd: ROOT, encoding: 'utf8', shell: false });
  let json = null;
  for (const text of [r.stdout, r.stderr]) {
    if (json) break;
    try {
      json = JSON.parse(text);
    } catch {
      /* salida no JSON */
    }
  }
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readJson = (p) => JSON.parse(read(p));

let run;
before(() => {
  run = cli('pipeline', ZIP, '--project-id', PID, '--force', '--bpm');
});

test('el fixture ZIP existe y el pipeline de extremo a extremo termina correctamente', () => {
  assert.ok(fs.existsSync(path.join(ROOT, ZIP)));
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(run.json.project_id, PID);
  assert.equal(run.json.generated.length, 2);
  for (const g of run.json.generated) assert.equal(g.approval, 'APROBADO');
  assert.equal(run.json.bizagi_compatibility, undefined);
});

test('modelo intermedio: manifiesto, mapa de arquitectura y trazas válidos contra sus esquemas', () => {
  const base = `workspace/${PID}`;
  assert.equal(validateContract('repository-manifest', readJson(`${base}/repository-manifest.json`)).valid, true);
  const arch = validateContract('architecture-map', readJson(`${base}/analysis/architecture-map.json`));
  assert.equal(arch.valid, true, JSON.stringify(arch.errors));
  const tr = validateContract('execution-trace', readJson(`${base}/analysis/execution-trace.json`));
  assert.equal(tr.valid, true, JSON.stringify(tr.errors));
  for (const pid of ['OrderController_getStatus', 'OrderController_cancel']) {
    const d = validateContract('process-definition', readJson(`${base}/processes/${pid}/process-definition.json`));
    assert.equal(d.valid, true, JSON.stringify(d.errors));
  }
});

test('sin --bpm el entregable es el BPMN 2.0 por proceso y no se exporta el contenedor', () => {
  const r = cli('generate', PID, '--all');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.native_project, null);
  for (const pid of ['OrderController_getStatus', 'OrderController_cancel']) {
    const xml = read(`workspace/${PID}/_intermedios/diagrams/${pid}.bpmn`);
    assert.match(xml, /http:\/\/www\.omg\.org\/spec\/BPMN\/20100524\/MODEL/);
    assert.match(xml, /BPMNDiagram/);
  }
});

test('el pipeline entrega un único .bpm nativo con todos los diagramas y el CLI lo valida', () => {
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(run.json.native_project.diagrams.length, 2);
  assert.equal(run.json.native_project.approval, 'APROBADO');
  const result = cli('validate-bizagi', `workspace/${PID}/_intermedios/delivery/${PID}.bpm`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.json.diagrams.length, 2);
  assert.equal(result.json.bizagi_compatibility, undefined);
  assert.match(read(`workspace/${PID}/_intermedios/reports/${PID}-informe-final.md`), /Opcional:\*\* `outputs\/orders-service\/orders-service\.bpm/);
  const published = fs.readdirSync(path.join(ROOT, `outputs/${PID}`), { withFileTypes: true });
  assert.ok(published.every((e) => e.isFile() && /\.(bpm|bpmn|docx)$/.test(e.name)), published.map((e) => e.name).join(", "));
  // Sin fichas ni explicación redactadas la entrega no es final: se publica como borrador identificado.
  assert.equal(run.json.delivery.status, 'BORRADOR');
  assert.ok(published.every((e) => e.name.startsWith('BORRADOR_')), published.map((e) => e.name).join(", "));
  assert.ok(published.some((e) => e.name === `BORRADOR_${PID}.bpm`) && published.some((e) => e.name.endsWith(".bpmn")));
});

test('el informe solo muestra la carga del proveedor correspondiente al hash de la entrega', () => {
  const providerFile = path.join(ROOT, `workspace/${PID}/_intermedios/reports/${PID}.bizagi-provider-load.json`);
  const previous = fs.existsSync(providerFile) ? fs.readFileSync(providerFile) : null;
  const results = run.json.generated.map(({ process_id, files }) => ({
    process_id, files,
    definition: readJson(`workspace/${PID}/_intermedios/diagrams/${process_id}.process.json`),
    validation: readJson(`workspace/${PID}/_intermedios/reports/${process_id}.validation.json`),
    review: readJson(`workspace/${PID}/_intermedios/reports/${process_id}.review.json`),
  }));
  const reportFile = `workspace/${PID}/_intermedios/reports/${PID}-informe-final.md`;
  try {
    const provider = { approval: 'APROBADO', mode: 'load', sha256: run.json.native_project.sha256,
      diagrams: [{ collaboration_loaded: true }, { collaboration_loaded: true }] };
    fs.writeFileSync(providerFile, JSON.stringify(provider));
    finalReport(PID, results);
    assert.match(read(reportFile), /Carga con el adaptador real/);
    fs.writeFileSync(providerFile, JSON.stringify({ ...provider, sha256: '0'.repeat(64) }));
    finalReport(PID, results);
    assert.doesNotMatch(read(reportFile), /Carga con el adaptador real/);
  } finally {
    if (previous) fs.writeFileSync(providerFile, previous);
    else fs.unlinkSync(providerFile);
    finalReport(PID, results);
  }
});

test('rutas principales y alternativas de getStatus reconstruidas en el modelo', () => {
  const def = readJson(`workspace/${PID}/_intermedios/diagrams/OrderController_getStatus.process.json`);
  const outcomes = def.outcomes.map((o) => o.name).sort();
  assert.deepEqual(outcomes, ['200 OK', '400 BAD_REQUEST', '404 NOT_FOUND', '502 BAD_GATEWAY']);
  const conds = def.decisions.map((d) => d.condition_text);
  for (const c of ['orderId == null || orderId.isBlank()', 'found.isEmpty()', '"CANCELLED".equals(order.getStatus())', 'info.getCode() != 0']) {
    assert.ok(conds.some((x) => x && x.includes(c)), `decisión ${c}`);
  }
  assert.ok(def.participants.some((p) => p.kind === 'external'), 'servicio externo como participante');
  assert.ok(def.participants.some((p) => p.kind === 'data_store'), 'almacén de datos');
  assert.ok(def.uncertainties.length >= 1, 'la llamada no resoluble debe figurar como incertidumbre');
  const cancel = readJson(`workspace/${PID}/_intermedios/diagrams/OrderController_cancel.process.json`);
  assert.deepEqual(cancel.outcomes.map((o) => o.name).sort(), ['204 NO_CONTENT', '404 NOT_FOUND', '409 CONFLICT']);
});

test('se generan archivos .bpmn reales con BPMN DI, validación y vistas previas', () => {
  for (const pid of ['OrderController_getStatus', 'OrderController_cancel']) {
    const xml = read(`workspace/${PID}/_intermedios/diagrams/${pid}.bpmn`);
    assert.match(xml, /<bpmn:definitions|<definitions/);
    assert.match(xml, /BPMNDiagram/);
    assert.match(xml, /BPMNShape/);
    assert.match(xml, /BPMNEdge/);
    assert.match(xml, /<dc:Bounds|<omgdc:Bounds/);
    const v = readJson(`workspace/${PID}/_intermedios/reports/${pid}.validation.json`);
    assert.equal(v.approval, 'APROBADO');
    assert.equal(v.summary.errors, 0);
    assert.equal(v.bizagi_compatibility, undefined);
    assert.ok(fs.statSync(path.join(ROOT, `workspace/${PID}/_intermedios/previews/${pid}.svg`)).size > 1000);
    assert.ok(fs.statSync(path.join(ROOT, `workspace/${PID}/_intermedios/previews/${pid}.png`)).size > 1000);
    const side = readJson(`workspace/${PID}/_intermedios/diagrams/${pid}.traceability.json`);
    assert.ok(Object.keys(side).length >= 5);
  }
});

test('trazabilidad: cada actividad BPMN enlaza a líneas reales del código fuente', () => {
  const side = readJson(`workspace/${PID}/_intermedios/diagrams/OrderController_getStatus.traceability.json`);
  const src = path.join(ROOT, 'workspace', PID, 'source');
  let checked = 0;
  for (const entry of Object.values(side)) {
    for (const ev of entry.evidence ?? []) {
      const lines = fs.readFileSync(path.join(src, ev.file), 'utf8').split(/\r?\n/);
      assert.ok(ev.line_start >= 1 && ev.line_start <= lines.length, `${ev.file}:${ev.line_start}`);
      checked++;
    }
  }
  assert.ok(checked > 10);
});

test('la revisión y el informe final distinguen evidencia confirmada, inferida y desconocida', () => {
  const review = readJson('workspace/orders-service/_intermedios/reports/OrderController_getStatus.review.json');
  assert.equal(validateContract('review-report', review).valid, true);
  assert.ok(review.unconfirmed_inferences.length >= 1);
  const final = read(`workspace/${PID}/_intermedios/reports/${PID}-informe-final.md`);
  assert.match(final, /CONFIRMADA/);
  assert.match(final, /DESCONOCIDA/);
  assert.match(final, /Fidelidad funcional: no verificada/);
  assert.doesNotMatch(final, /VALIDACIÓN MANUAL/);
  assert.match(final, /proveedores LLM/);
});

test('discover lista candidatos sin generar diagramas', () => {
  const r = cli('discover', PID);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const ids = (r.json.candidates ?? r.json.report?.candidates ?? []).map((c) => c.process_id).sort();
  assert.deepEqual(ids, ['OrderController_cancel', 'OrderController_getStatus']);
});

test('generate acepta un proceso concreto por nombre de método', () => {
  const r = cli('generate', PID, '--process', 'cancel');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(ROOT, `workspace/${PID}/_intermedios/diagrams/OrderController_cancel.bpmn`)));
});

test('generate reutiliza una definición refinada sin reconstruir el borrador', () => {
  const draftFile = path.join(ROOT, `workspace/${PID}/processes/OrderController_cancel/process-definition.draft.json`);
  const defFile = path.join(ROOT, `workspace/${PID}/processes/OrderController_cancel/process-definition.json`);
  const originalDraft = fs.readFileSync(draftFile, 'utf8');
  const originalDef = fs.readFileSync(defFile, 'utf8');
  try {
    const sentinel = JSON.stringify({ note: 'Borrador conservado; la definición refinada ya existe.' });
    fs.writeFileSync(draftFile, sentinel);
    const r = cli('generate', PID, '--process', 'cancel');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(defFile, 'utf8'), originalDef);
    assert.equal(fs.readFileSync(draftFile, 'utf8'), sentinel);
  } finally {
    fs.writeFileSync(draftFile, originalDraft);
  }
});

test('vista por actividades: no entrega sin revisión independiente ni acepta una revisión obsoleta', async () => {
  const id = 'OrderController_cancel';
  const dir = path.join(ROOT, `workspace/${PID}/processes/${id}`);
  const sourceFile = path.join(dir, 'process-definition.json');
  const original = fs.readFileSync(sourceFile);
  const source = JSON.parse(original);
  const nodes = [...source.activities, ...source.events, ...source.decisions];
  const mapping = { process_id: id, source_sha256: definitionHash(source), view_sha256: definitionHash(source),
    groups: nodes.map((n) => ({ target_id: n.id, source_node_ids: [n.id], reason: 'Identidad usada exclusivamente para probar el mecanismo de entrega.' })),
    outcomes: source.outcomes.map((o) => ({ target_id: o.id, source_outcome_ids: [o.id], description: o.name })) };
  const files = ['functional-definition.json', 'abstraction-map.json', 'functional-review.json'];
  const saved = files.map((f) => fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f)) : null);
  const delivery = path.join(ROOT, `workspace/${PID}/_intermedios/delivery/${PID}.bpm`);
  const previousDelivery = fs.readFileSync(delivery);
  const nativeReport = path.join(ROOT, `workspace/${PID}/_intermedios/reports/${PID}.bizagi-validation.json`);
  const previousNativeReport = fs.readFileSync(nativeReport);
  try {
    fs.writeFileSync(path.join(dir, files[0]), JSON.stringify(source));
    fs.writeFileSync(path.join(dir, files[1]), JSON.stringify(mapping));
    const context = cli('functional-review-context', PID, '--process', 'cancel');
    assert.equal(context.status, 0, context.stderr);
    assert.deepEqual(context.json[0], { process_id: id, source_sha256: definitionHash(source), view_sha256: definitionHash(source), map_sha256: definitionHash(mapping), coverage: { source_nodes: nodes.length, covered_nodes: nodes.length, source_outcomes: source.outcomes.length, covered_outcomes: source.outcomes.length } });
    if (fs.existsSync(path.join(dir, files[2]))) fs.unlinkSync(path.join(dir, files[2]));
    const preview = await generateFunctional(PID, [id]);
    assert.equal(preview.blocked, true);
    assert.equal(preview.pending_independent_review, true);
    assert.equal(preview.native_project, null);
    assert.deepEqual(fs.readFileSync(delivery), previousDelivery);
    fs.writeFileSync(path.join(dir, files[2]), JSON.stringify({ view_sha256: '0'.repeat(64), source_sha256: definitionHash(source), map_sha256: definitionHash(mapping) }));
    const previewFile = path.join(ROOT, `workspace/${PID}/_intermedios/functional/${id}.process.json`);
    const previousPreview = fs.readFileSync(previewFile);
    await assert.rejects(generateFunctional(PID, [id]), /Revisión funcional obsoleta/);
    assert.deepEqual(fs.readFileSync(previewFile), previousPreview, 'Una revisión obsoleta no sustituye previews previas.');
    await assert.rejects(generateFunctional(PID, []), /procesos únicos/);
    await assert.rejects(generateFunctional(PID, [id, id]), /procesos únicos/);
    assert.deepEqual(fs.readFileSync(sourceFile), original);
    const report = { schema_version: '1.0', process_id: id, reviewer: 'fixture de prueba; no revisión real de usuario', verdict: 'APROBADO', findings: [], unconfirmed_inferences: [], summary: 'Sólo ejercita el contrato del recibo en el fixture sintético.' };
    fs.writeFileSync(path.join(dir, files[2]), JSON.stringify({ view_sha256: definitionHash(source), source_sha256: definitionHash(source), map_sha256: definitionHash(mapping), report }));
    const approved = await generateFunctional(PID, [id]);
    assert.equal(approved.blocked, false);
    assert.equal(approved.native_project.diagrams.length, 1);
    assert.deepEqual(fs.readFileSync(sourceFile), original);
    const refreshed = cli('report', PID, '--process', 'cancel');
    assert.equal(refreshed.status, 0, refreshed.stderr);
    assert.equal(refreshed.json.view, 'POR_ACTIVIDADES');
    assert.match(read(`workspace/${PID}/_intermedios/reports/${PID}-informe-final.md`), /Vista por actividades/);
    assert.match(read(`workspace/${PID}/_intermedios/reports/${PID}-informe-final.md`), /workspace\/orders-service\/_intermedios\/functional\/OrderController_cancel/);
  } finally {
    fs.writeFileSync(delivery, previousDelivery);
    fs.writeFileSync(nativeReport, previousNativeReport);
    files.forEach((f, i) => { if (saved[i]) fs.writeFileSync(path.join(dir, f), saved[i]); else if (fs.existsSync(path.join(dir, f))) fs.unlinkSync(path.join(dir, f)); });
  }
});

test('validate-bpmn por CLI aprueba el BPMN generado y bloquea uno alterado', () => {
  const ok = cli('validate-bpmn', `workspace/${PID}/_intermedios/diagrams/OrderController_cancel.bpmn`);
  assert.equal(ok.status, 0);
  assert.equal(ok.json.approval, 'APROBADO');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bpmn-re-val-'));
  const bad = path.join(tmp, 'roto.bpmn');
  fs.writeFileSync(bad, read(`workspace/${PID}/_intermedios/diagrams/OrderController_cancel.bpmn`).replace(/targetRef="[^"]+"/, 'targetRef="NO_EXISTE"'));
  const r = cli('validate-bpmn', bad);
  assert.equal(r.status, 1);
  assert.equal(r.json.approval, 'BLOQUEADO');
});

test('argumentos peligrosos o inválidos se rechazan sin ejecutar nada', () => {
  for (const bad of ['a;b', '..', 'a b', '$(calc)', 'x`y']) {
    const r = cli('discover', bad);
    assert.notEqual(r.status, 0, bad);
    assert.equal(r.json?.ok, false);
  }
  assert.notEqual(cli('generate', PID, '--process', 'no_existe').status, 0);
  assert.notEqual(cli('ingest', '..\\..\\Windows\\win.ini').status, 0);
  assert.notEqual(cli('comando-inexistente').status, 0);
});

test('inspect-reference funciona o registra explícitamente que no se ejecutó', () => {
  const r = cli('inspect-reference');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  if (fs.existsSync(path.join(ROOT, 'inputs/references/claro-post-consultareclamos.bpm'))) {
    assert.equal(r.json.counts.activities, 8);
    assert.ok(fs.existsSync(path.join(ROOT, 'outputs/_shared/reports/reference-inspection.md')));
  } else {
    assert.equal(r.json.executed, false);
  }
});

test('el ZIP original no se modifica ni se ejecuta contenido extraído (no hay .env en la extracción)', () => {
  const src = path.join(ROOT, 'workspace', PID, 'source');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = walk(src);
  assert.ok(files.length > 10);
  assert.ok(!files.some((f) => path.basename(f) === '.env'));
  assert.ok(!files.some((f) => /node_modules|target[\\/]/.test(f)));
});
