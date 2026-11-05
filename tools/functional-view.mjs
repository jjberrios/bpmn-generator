// La vista por actividades conserva el modelo detallado; no transforma la fuente ni debilita su revisor.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Resvg } from '@resvg/resvg-js';
import { workDir, publishDeliverables } from './layout-paths.mjs';
import { ROOT, assertId, review, exportNativeProject, finalReport } from './pipeline.mjs';
import { checkAbstraction, definitionHash } from './validation/abstraction-checks.mjs';
import { validateContract } from './validation/schema-validator.mjs';
import { reviewProcess, mergeReports } from './validation/review-checks.mjs';
import { generateBpmn } from './bpmn/generate-bpmn.mjs';
import { renderSvg } from './bpmn/preview-svg.mjs';
import { validateBpmnXml } from './validation/validate-bpmn.mjs';
import { renderValidationMarkdown, renderReviewMarkdown } from './report.mjs';

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const json = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

// Identifica exactamente los documentos entregados al revisor; no concede aprobación.
export function functionalReviewContext(projectId, processIds, { root = ROOT } = {}) {
  assertId(projectId, 'project-id');
  return processIds.map((processId) => {
    assertId(processId, 'process-id');
    const dir = path.join(root, 'workspace', projectId, 'processes', processId);
    const source = read(path.join(dir, 'process-definition.json'));
    const view = read(path.join(dir, 'functional-definition.json'));
    const map = read(path.join(dir, 'abstraction-map.json'));
    const checked = checkAbstraction(source, view, map);
    if (!checked.valid) throw new Error(`Abstracción inválida: ${processId}`);
    return { process_id: processId, source_sha256: definitionHash(source), view_sha256: definitionHash(view), map_sha256: definitionHash(map), coverage: checked.coverage };
  });
}

// Reconstruye el informe de la entrega vigente, no el de los intermedios técnicos anteriores.
export function functionalReportResults(projectId, processIds, { root = ROOT } = {}) {
  assertId(projectId, 'project-id');
  const output = path.join(workDir(root, projectId), 'functional');
  const manifestFile = path.join(output, `${projectId}.manifest.json`);
  if (!fs.existsSync(manifestFile)) return null;
  const manifest = read(manifestFile);
  const delivery = path.join(workDir(root, projectId), 'delivery', `${projectId}.bpm`);
  if (manifest.blocked || !manifest.native_project || !fs.existsSync(delivery)) return null;
  const actual = createHash('sha256').update(fs.readFileSync(delivery)).digest('hex');
  if (actual !== manifest.native_project.sha256) return null;
  if (!processIds.every((id) => manifest.generated.some((r) => r.process_id === id))) return null;
  return processIds.map((id) => {
    assertId(id, 'process-id');
    const dir = path.join(root, 'workspace', projectId, 'processes', id);
    const source = read(path.join(dir, 'process-definition.json'));
    const definition = read(path.join(dir, 'functional-definition.json'));
    const mapping = read(path.join(dir, 'abstraction-map.json'));
    const receipt = read(path.join(dir, 'functional-review.json'));
    const checked = checkAbstraction(source, definition, mapping);
    if (!checked.valid || receipt.view_sha256 !== definitionHash(definition) || receipt.source_sha256 !== definitionHash(source) || receipt.map_sha256 !== definitionHash(mapping)) throw new Error(`Revisión funcional obsoleta: ${id}`);
    const base = path.join(output, id);
    if (definitionHash(read(`${base}.process.json`)) !== definitionHash(definition)) throw new Error(`Salida funcional obsoleta: ${id}`);
    const rel = (suffix) => path.relative(root, `${base}.${suffix}`).split(path.sep).join('/');
    return { process_id: id, definition, validation: read(`${base}.validation.json`), review: read(`${base}.review.json`), files: {
      bpmn: rel('bpmn'), definicion: rel('process.json'), trazabilidad: rel('traceability.json'), abstraccion: rel('abstraction.json'),
      svg: rel('svg'), png: rel('png'), validacion: rel('validation.json'), revision: rel('review.json'),
    } };
  });
}

export async function generateFunctional(projectId, processIds, { root = ROOT } = {}) {
  assertId(projectId, 'project-id');
  if (!processIds.length || new Set(processIds).size !== processIds.length) throw new Error('Seleccione procesos únicos para la vista por actividades.');
  // Comprueba el lote completo antes de sustituir previews previamente revisadas.
  const inputs = processIds.map((processId) => {
    assertId(processId, 'process-id');
    const dir = path.join(root, 'workspace', projectId, 'processes', processId);
    const source = read(path.join(dir, 'process-definition.json'));
    const definition = read(path.join(dir, 'functional-definition.json'));
    const mapping = read(path.join(dir, 'abstraction-map.json'));
    const abstraction = checkAbstraction(source, definition, mapping);
    if (!abstraction.valid) throw new Error(`Abstracción inválida de ${processId}: ${JSON.stringify(abstraction.errors)}`);
    const receiptFile = path.join(dir, 'functional-review.json');
    const receipt = fs.existsSync(receiptFile) ? read(receiptFile) : null;
    if (receipt) {
      if (receipt.view_sha256 !== definitionHash(definition) || receipt.source_sha256 !== definitionHash(source) || receipt.map_sha256 !== definitionHash(mapping)) throw new Error(`Revisión funcional obsoleta: ${processId}`);
      const contract = validateContract('review-report', receipt.report);
      if (!contract.valid || receipt.report.process_id !== processId) throw new Error(`Revisión funcional inválida: ${processId}`);
    }
    return { processId, definition, mapping, abstraction, receipt };
  });
  const output = path.join(workDir(root, projectId), 'functional');
  fs.mkdirSync(output, { recursive: true });
  const results = [];
  let pending = false;
  for (const { processId, definition, mapping, abstraction, receipt } of inputs) {
    const technical = review(projectId, processId, { root });
    if (technical.verdict === 'RECHAZADO') throw new Error(`El modelo detallado ${processId} sigue rechazado; no se puede ocultar mediante una vista.`);
    const gen = await generateBpmn(definition);
    const base = path.join(output, processId);
    fs.writeFileSync(`${base}.bpmn`, gen.xml);
    json(`${base}.process.json`, definition);
    json(`${base}.traceability.json`, gen.traceability);
    json(`${base}.abstraction.json`, { ...mapping, validation: abstraction });
    const { svg } = await renderSvg(gen.xml);
    fs.writeFileSync(`${base}.svg`, svg);
    fs.writeFileSync(`${base}.png`, new Resvg(svg, { fitTo: { mode: 'width', value: 1800 } }).render().asPng());
    const validation = await validateBpmnXml(gen.xml, { definition, sidecar: gen.traceability });
    json(`${base}.validation.json`, validation);
    fs.writeFileSync(`${base}.validation.md`, renderValidationMarkdown(validation));
    // Evidencias contra la fuente, sin exigir isomorfismo con los nodos de la traza técnica.
    // La cobertura del detalle se verifica arriba, la equivalencia funcional la revisa un agente independiente.
    const auto = reviewProcess({ definition, trace: null, sourceDir: path.join(root, 'workspace', projectId, 'source') });
    auto.summary += ' Vista resumida: comprobación documental de abstracción y evidencia; no se verificó automáticamente la equivalencia de rutas.';
    const reports = [auto];
    if (receipt) reports.push(receipt.report);
    else pending = true;
    const rev = mergeReports(processId, reports);
    json(`${base}.review.json`, rev);
    fs.writeFileSync(`${base}.review.md`, renderReviewMarkdown(rev));
    const rel = (suffix) => path.relative(root, `${base}.${suffix}`).split(path.sep).join('/');
    const files = { bpmn: rel('bpmn'), definicion: rel('process.json'), trazabilidad: rel('traceability.json'), abstraccion: rel('abstraction.json'), svg: rel('svg'), png: rel('png'), validacion: rel('validation.json'), revision: rel('review.json') };
    results.push({ process_id: processId, definition, validation, review: rev, files });
  }
  const blocked = pending || results.some((r) => r.validation.approval !== 'APROBADO' || r.review.verdict === 'RECHAZADO');
  const native = blocked ? null : exportNativeProject(projectId, results, { root });
  const report = finalReport(projectId, results, { root });
  const manifest = { project_id: projectId, view: 'POR_ACTIVIDADES', pending_independent_review: pending, blocked, native_project: native, report, generated: results.map((r) => ({ process_id: r.process_id, activities: r.definition.activities.length, decisions: r.definition.decisions.length, events: r.definition.events.length, validation: r.validation.approval, review: r.review.verdict, files: r.files })) };
  json(path.join(output, `${projectId}.manifest.json`), manifest);
  if (!blocked) manifest.published = publishDeliverables(root, projectId);
  return manifest;
}
