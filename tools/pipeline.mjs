// Operaciones deterministas del flujo BPMN Reverse Engineer (sin LLM).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateContract } from './validation/schema-validator.mjs';
import { workDir, INTERMEDIATE, publishDeliverables } from './layout-paths.mjs';
import { draftProcess, discoverCandidates } from './analysis/draft-process.mjs';
import { functionalServiceView, checkFunctionalCoverage } from './analysis/functional-service-view.mjs';
import { namesTodo } from './validation/name-quality.mjs';
import { generateActivityWord } from './documentation/activity-word.mjs';
import { generateGeneralWord } from './documentation/general-word.mjs';
import { generateBpmn, GenerationError } from './bpmn/generate-bpmn.mjs';
import { renderSvg } from './bpmn/preview-svg.mjs';
import { validateBpmnXml, validateBpmnFile } from './validation/validate-bpmn.mjs';
import { reviewProcess, mergeReports } from './validation/review-checks.mjs';
import { inspectReference } from './reference/inspect-xpdl.mjs';
import { buildNativeProject, validateNativeProject, digest } from './bizagi/native-project.mjs';
import { renderDiscoveryMarkdown, renderValidationMarkdown, renderReviewMarkdown, renderReferenceMarkdown, renderFinalReport } from './report.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_REFERENCE = 'inputs/references/claro-post-consultareclamos.bpm';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

export class UsageError extends Error {}

export function assertId(value, label) {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw new UsageError(`${label} inválido: solo se permiten letras, dígitos, '.', '_' y '-' (máx. 81 caracteres).`);
  }
  return value;
}

export function paths(root = ROOT, projectId = null) {
  const base = projectId ? workDir(root, assertId(projectId, 'project-id')) : path.join(root, 'outputs', '_shared');
  return {
    root,
    workspace: path.join(root, 'workspace'),
    diagrams: path.join(base, 'diagrams'),
    previews: path.join(base, 'previews'),
    reports: path.join(base, 'reports'),
    traces: path.join(base, 'traces'),
  };
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}
function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text, 'utf8');
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Los archivos de entrada se leen, nunca se modifican ni ejecutan; las rutas se pasan como argv (sin shell).
const resolveInput = (root, p) => path.resolve(root, String(p));

export function runPython(script, args, root = ROOT) {
  const exe = process.env.BPMN_RE_PYTHON || 'python';
  const res = spawnSync(exe, [path.join(root, script), ...args], { cwd: root, encoding: 'utf8', shell: false, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  if (res.error) throw new Error(`No se pudo ejecutar Python (${exe}): ${res.error.message}`);
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? 'null');
  } catch {
    /* salida no JSON */
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json: parsed };
}

export function projectDir(projectId, root = ROOT) {
  assertId(projectId, 'project-id');
  return path.join(paths(root).workspace, projectId);
}

function requireProject(projectId, root) {
  const dir = projectDir(projectId, root);
  if (!fs.existsSync(path.join(dir, 'repository-manifest.json'))) throw new UsageError(`El proyecto "${projectId}" no está ingerido. Ejecute primero: ingest.`);
  return dir;
}

export function ingest(zipPath, { projectId, force = false, root = ROOT } = {}) {
  const zip = resolveInput(root, zipPath);
  if (!fs.existsSync(zip) || !fs.statSync(zip).isFile()) throw new UsageError(`No existe el ZIP: ${zipPath}`);
  const id = projectId ?? path.basename(zip).replace(/\.zip$/i, '').replace(/[^A-Za-z0-9._-]/g, '-');
  assertId(id, 'project-id');
  const args = [zip, '--workspace-root', paths(root).workspace, '--project-id', id];
  if (force) args.push('--force');
  const r = runPython('tools/ingestion/extract_zip.py', args, root);
  if (r.status !== 0) {
    const e = new Error(`Ingesta rechazada: ${r.json?.error ?? (r.stderr.trim() || 'error desconocido')}`);
    e.code = 'INGEST_REJECTED';
    throw e;
  }
  return r.json;
}

export function analyze(projectId, { root = ROOT } = {}) {
  const dir = requireProject(projectId, root);
  const r = runPython('tools/analysis/analyze_project.py', [dir], root);
  if (r.status !== 0) throw new Error(`Análisis fallido: ${r.stderr.trim() || r.stdout.trim()}`);
  const base = path.join(dir, 'analysis');
  for (const [contract, file] of [['architecture-map', 'architecture-map.json'], ['execution-trace', 'execution-trace.json']]) {
    const v = validateContract(contract, readJson(path.join(base, file)));
    if (!v.valid) throw new Error(`El artefacto ${file} no cumple su contrato: ${JSON.stringify(v.errors.slice(0, 5))}`);
  }
  return r.json;
}

export function discover(projectId, { root = ROOT } = {}) {
  const dir = requireProject(projectId, root);
  if (!fs.existsSync(path.join(dir, 'analysis', 'execution-trace.json'))) analyze(projectId, { root });
  const candidates = discoverCandidates(dir);
  const manifest = readJson(path.join(dir, 'repository-manifest.json'));
  const architecture = readJson(path.join(dir, 'analysis', 'architecture-map.json'));
  writeJson(path.join(dir, 'discovery.json'), { schema_version: '1.0', project_id: projectId, candidates });
  const md = renderDiscoveryMarkdown({ projectId, manifest, architecture, candidates });
  const reportFile = path.join(paths(root, projectId).reports, `${projectId}-descubrimiento.md`);
  writeText(reportFile, md);
  return { candidates, report: path.relative(root, reportFile), markdown: md };
}

function processDir(projectId, processId, root) {
  return path.join(projectDir(projectId, root), 'processes', assertId(processId, 'process-id'));
}

export function resolveCandidates(projectId, selector, { root = ROOT } = {}) {
  const dir = requireProject(projectId, root);
  const all = discoverCandidates(dir);
  if (selector === '--all' || selector === 'all') return all;
  const sel = String(selector).toLowerCase();
  const hit = all.filter((c) => [c.process_id, c.trace_id, c.entry_point_id, c.entry_point.method].some((v) => String(v).toLowerCase() === sel));
  if (hit.length === 0) throw new UsageError(`No hay un proceso que coincida con "${selector}". Candidatos: ${all.map((c) => c.process_id).join(', ')}`);
  if (hit.length > 1) throw new UsageError(`"${selector}" es ambiguo; use el process_id completo: ${hit.map((c) => c.process_id).join(', ')}`);
  return hit;
}

export function draft(projectId, candidate, { overwrite = false, root = ROOT } = {}) {
  const dir = requireProject(projectId, root);
  const def = draftProcess({ projectDir: dir, traceId: candidate.trace_id, processId: candidate.process_id });
  const v = validateContract('process-definition', def);
  if (!v.valid) throw new Error(`El borrador de ${candidate.process_id} no cumple el contrato: ${JSON.stringify(v.errors.slice(0, 5))}`);
  const pdir = processDir(projectId, candidate.process_id, root);
  writeJson(path.join(pdir, 'process-definition.draft.json'), def);
  const main = path.join(pdir, 'process-definition.json');
  if (overwrite || !fs.existsSync(main)) writeJson(main, def);
  return { definition: def, file: path.relative(root, main) };
}

export function loadTrace(projectId, traceId, root = ROOT, processId = null) {
  const dir = path.join(projectDir(projectId, root), 'analysis');
  const candidates = [
    ...(processId ? [path.join(processDir(projectId, processId, root), 'execution-trace.agent.json')] : []),
    path.join(dir, 'execution-trace.agent.json'),
  ];
  for (const agentFile of candidates) {
    if (!fs.existsSync(agentFile)) continue;
    const agent = readJson(agentFile);
    const v = validateContract('execution-trace', agent);
    if (!v.valid || agent.project_id !== projectId) throw new Error('execution-trace.agent.json inválida o de otro proyecto.');
    const hit = agent.traces.find((t) => t.id === traceId);
    if (hit) return hit;
  }
  const all = readJson(path.join(dir, 'execution-trace.json'));
  return (all.traces ?? []).find((t) => t.id === traceId) ?? null;
}

export function review(projectId, processId, { definition, root = ROOT } = {}) {
  const dir = requireProject(projectId, root);
  const pdir = processDir(projectId, processId, root);
  const def = definition ?? readJson(path.join(pdir, 'process-definition.json'));
  const trace = loadTrace(projectId, def.entry_point?.trace_id, root, processId);
  const auto = reviewProcess({ definition: def, trace, sourceDir: path.join(dir, 'source') });
  writeJson(path.join(pdir, 'review-auto.json'), auto);
  const reports = [auto];
  const agentFile = path.join(pdir, 'review-agent.json');
  if (fs.existsSync(agentFile)) {
    const agent = readJson(agentFile);
    const v = validateContract('review-report', agent);
    if (!v.valid) throw new Error(`review-agent.json no cumple el contrato review-report: ${JSON.stringify(v.errors.slice(0, 5))}`);
    reports.push({ ...agent, findings: agent.findings.map((f) => ({ ...f, source: f.source ?? 'agente' })) });
  }
  const merged = reports.length > 1 ? mergeReports(def.id, reports) : auto;
  const p = paths(root, projectId);
  writeJson(path.join(p.reports, `${def.id}.review.json`), merged);
  writeText(path.join(p.reports, `${def.id}.review.md`), renderReviewMarkdown(merged));
  return merged;
}

async function writePng(svg, file) {
  try {
    const { Resvg } = await import('@resvg/resvg-js');
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1800 }, font: { loadSystemFonts: true } }).render().asPng();
    fs.writeFileSync(file, png);
    return true;
  } catch {
    return false;
  }
}

function writeNamesTodo(pdir, detail, view, viewMap, funcNames, methodOf) {
  const file = path.join(pdir, 'functional-names.todo.json');
  const items = namesTodo(detail, view, viewMap, funcNames, methodOf);
  if (!items.length) { fs.rmSync(file, { force: true }); return; }
  writeJson(file, { process_id: detail.id, instruction: 'Proponer en functional-names.json { "<id>": "Verbo + objeto funcional en español" } solo para operaciones respaldadas por los métodos/condiciones listados; si no hay evidencia suficiente, no inventar: dejar el elemento sin nombre y documentar la incertidumbre.', pending: items });
}

export async function generate(projectId, processId, { root = ROOT, preview = true } = {}) {
  requireProject(projectId, root);
  const pdir = processDir(projectId, processId, root);
  const defFile = path.join(pdir, 'process-definition.json');
  if (!fs.existsSync(defFile)) throw new UsageError(`No existe la definición del proceso: ${path.relative(root, defFile)}. Ejecute draft o cree la definición.`);
  const def = readJson(defFile);
  const schema = validateContract('process-definition', def);
  const p = paths(root, projectId);
  if (!schema.valid) {
    writeJson(path.join(p.reports, `${processId}.generation-error.json`), { stage: 'process-definition', errors: schema.errors });
    throw new GenerationError('La definición no cumple el contrato process-definition.', schema.errors);
  }
  const namesFile = path.join(pdir, 'functional-names.json');
  const funcNames = fs.existsSync(namesFile) ? readJson(namesFile) : {};
  const traceForView = loadTrace(projectId, def.entry_point?.trace_id, root, processId);
  const methodByNode = new Map((traceForView?.nodes || []).map((n) => [n.id, n.class && n.method ? `${n.class}.${n.method}` : null]));
  const { definition: view, map: viewMap } = functionalServiceView(def, { names: funcNames, methodOf: (id) => methodByNode.get(id) });
  const coverage = checkFunctionalCoverage(def, view, viewMap);
  writeNamesTodo(pdir, def, view, viewMap, funcNames, (id) => methodByNode.get(id));
  if (!coverage.valid) {
    writeJson(path.join(p.reports, `${processId}.generation-error.json`), { stage: 'vista-funcional', errors: coverage.errors });
    throw new GenerationError('La vista funcional omite elementos obligatorios.', coverage.errors);
  }
  let gen;
  try {
    gen = await generateBpmn(view);
  } catch (e) {
    if (e instanceof GenerationError) writeJson(path.join(p.reports, `${def.id}.generation-error.json`), { stage: 'generacion', message: e.message, details: e.details });
    throw e;
  }
  const base = path.join(p.diagrams, def.id);
  fs.rmSync(path.join(p.reports, `${def.id}.generation-error.json`), { force: true });
  ensureDir(p.diagrams);
  writeText(`${base}.bpmn`, gen.xml);
  writeJson(`${base}.traceability.json`, gen.traceability);
  const trace = loadTrace(projectId, def.entry_point?.trace_id, root, processId);
  if (trace) writeJson(path.join(p.traces, `${def.id}.trace.json`), trace);

  const rel = (f) => path.relative(root, f).split(path.sep).join('/');
  const files = { bpmn: rel(`${base}.bpmn`), definicion: rel(`${base}.process.json`), trazabilidad: rel(`${base}.traceability.json`) };
  if (preview) {
    const { svg } = await renderSvg(gen.xml);
    ensureDir(p.previews);
    writeText(path.join(p.previews, `${def.id}.svg`), svg);
    files.svg = rel(path.join(p.previews, `${def.id}.svg`));
    if (await writePng(svg, path.join(p.previews, `${def.id}.png`))) files.png = rel(path.join(p.previews, `${def.id}.png`));
  }

  // La definición se guarda junto al BPMN antes de validar (la validación la usa para la trazabilidad).
  writeJson(`${base}.process.json`, view);
  writeJson(`${base}.abstraction.json`, { ...viewMap, coverage: coverage.coverage });
  files.abstraccion = rel(`${base}.abstraction.json`);
  const validation = await validateBpmnXml(gen.xml, { definition: view, sidecar: gen.traceability });
  validation.file = files.bpmn;
  writeJson(path.join(p.reports, `${def.id}.validation.json`), validation);
  writeText(path.join(p.reports, `${def.id}.validation.md`), renderValidationMarkdown(validation));
  files.validacion = rel(path.join(p.reports, `${def.id}.validation.json`));

  const rev = review(projectId, processId, { definition: def, root });
  files.revision = rel(path.join(p.reports, `${def.id}.review.json`));

  view.review_status = { state: rev.verdict, report: files.revision, reviewed_by: rev.reviewer };
  writeJson(`${base}.process.json`, view);
  let documentation = { approval: 'BLOQUEADO', content_status: 'PENDIENTE', reason: 'BPMN no aprobado o revisión rechazada.' };
  if (validation.approval === 'APROBADO' && rev.verdict !== 'RECHAZADO') {
    try {
      documentation = generateActivityWord(projectId, processId, { root, definition: view });
      files.word = documentation.file;
      files.documentacion = documentation.file.replace(/\.docx$/, '.documentation.json');
      try {
        documentation.general = generateGeneralWord(projectId, processId, { root });
        files.word_general = documentation.general.file;
      } catch (error) {
        documentation.general = { approval: 'BLOQUEADO', reason: error.message };
      }
    } catch (error) {
      documentation = { approval: 'BLOQUEADO', content_status: 'PENDIENTE', reason: error.message };
    }
  }
  writeJson(path.join(p.reports, `${def.id}.documentation-status.json`), documentation);
  return { process_id: def.id, definition: view, validation, review: rev, documentation, files, warnings: gen.warnings };
}

export async function validateBpmnPath(file, { root = ROOT, definitionPath, sidecarPath } = {}) {
  const full = resolveInput(root, file);
  if (!/\.(bpmn|xml)$/i.test(full) || !fs.existsSync(full)) throw new UsageError(`Archivo BPMN no encontrado o con extensión no admitida: ${file}`);
  const report = await validateBpmnFile(full, { definitionPath, sidecarPath });
  const relative = path.relative(path.join(root, 'workspace'), full).split(path.sep);
  const p = paths(root, relative.length === 4 && relative[1] === INTERMEDIATE && ['diagrams', 'functional'].includes(relative[2]) && !relative[0].startsWith('..') ? relative[0] : null);
  const name = path.basename(full).replace(/\.(bpmn|xml)$/i, '');
  writeJson(path.join(p.reports, `${name}.validation.json`), report);
  writeText(path.join(p.reports, `${name}.validation.md`), renderValidationMarkdown(report));
  return report;
}

export function inspectReferenceFile(file = DEFAULT_REFERENCE, { root = ROOT } = {}) {
  const full = resolveInput(root, file);
  if (!fs.existsSync(full)) {
    return { executed: false, message: `El archivo de referencia no está presente (${file}); la prueba con la referencia Bizagi no se ejecutó.` };
  }
  const report = inspectReference(full);
  report.file = path.relative(root, full).split(path.sep).join('/');
  const p = paths(root);
  writeJson(path.join(p.reports, 'reference-inspection.json'), report);
  writeText(path.join(p.reports, 'reference-inspection.md'), renderReferenceMarkdown(report));
  return { executed: true, report };
}

export function exportNativeProject(projectId, results, { root = ROOT } = {}) {
  assertId(projectId, 'project-id');
  if (!results.length || results.some((r) => r.validation.approval !== 'APROBADO' || r.review.verdict === 'RECHAZADO')) throw new Error('La entrega nativa requiere modelos validados y sin revisión rechazada.');
  const native = buildNativeProject(projectId, results.map((r) => r.definition));
  const filename = path.join(workDir(root, projectId), 'delivery', `${projectId}.bpm`);
  const validationFile = path.join(paths(root, projectId).reports, `${projectId}.bizagi-validation.json`);
  // Conservar la entrega anterior para diagnosticar errores de apertura reales.
  if (fs.existsSync(filename)) {
    const previous = fs.readFileSync(filename);
    const hash = digest(previous);
    if (hash !== native.validation.sha256) {
      const history = path.join(requireProject(projectId, root), 'history', 'native');
      ensureDir(history);
      const archived = path.join(history, `${hash}.bpm`);
      if (!fs.existsSync(archived)) fs.writeFileSync(archived, previous);
      if (fs.existsSync(validationFile) && !fs.existsSync(`${archived}.validation.json`)) fs.copyFileSync(validationFile, `${archived}.validation.json`);
    }
  }
  ensureDir(path.dirname(filename));
  fs.writeFileSync(filename, native.bytes);
  const report = { ...native.validation, file: path.relative(root, filename).split(path.sep).join('/'), generated_at: new Date().toISOString() };
  writeJson(validationFile, report);
  return { ...report, validation_report: path.relative(root, validationFile).split(path.sep).join('/') };
}

export function validateNativePath(file, { root = ROOT } = {}) {
  if (!file) throw new UsageError('Indique un archivo .bpm existente.');
  const full = path.resolve(root, file);
  if (!/\.bpm$/i.test(full) || !fs.existsSync(full)) throw new UsageError('Indique un archivo .bpm existente.');
  if (fs.statSync(full).size > 50 * 1024 * 1024) throw new UsageError('Contenedor demasiado grande.');
  return validateNativeProject(fs.readFileSync(full));
}

export function finalReport(projectId, results, { root = ROOT } = {}) {
  const dir = requireProject(projectId, root);
  const manifest = readJson(path.join(dir, 'repository-manifest.json'));
  const architecture = readJson(path.join(dir, 'analysis', 'architecture-map.json'));
  const candidates = discoverCandidates(dir);
  const ref = fs.existsSync(path.join(root, DEFAULT_REFERENCE)) ? 'archivo presente; ejecute inspect-reference para el informe (outputs/_shared/reports/reference-inspection.md)' : 'no ejecutada: referencia ausente';
  let nativeProject = null;
  const nativeFile = path.join(workDir(root, projectId), 'delivery', `${projectId}.bpm`);
  if (fs.existsSync(nativeFile)) {
    const checked = validateNativeProject(fs.readFileSync(nativeFile), results.map((r) => r.definition));
    if (checked.approval === 'APROBADO') {
      nativeProject = { ...checked, file: `workspace/${projectId}/_intermedios/delivery/${projectId}.bpm`, validation_report: `workspace/${projectId}/_intermedios/reports/${projectId}.bizagi-validation.json` };
      const providerFile = path.join(paths(root, projectId).reports, `${projectId}.bizagi-provider-load.json`);
      if (fs.existsSync(providerFile)) {
        const provider = readJson(providerFile);
        if (provider.sha256 === checked.sha256 && provider.mode === 'load') nativeProject.provider_load = { ...provider, report: `workspace/${projectId}/_intermedios/reports/${projectId}.bizagi-provider-load.json` };
      }
    }
  }
  const md = renderFinalReport({ projectId, manifest, architecture, candidates, processes: results, referenceStatus: ref, nativeProject });
  const file = path.join(paths(root, projectId).reports, `${projectId}-informe-final.md`);
  writeText(file, md);
  return path.relative(root, file).split(path.sep).join('/');
}

export async function pipeline(zipOrProject, { selector = '--all', force = true, root = ROOT, projectId, bpm = false } = {}) {
  let id = projectId;
  let ingestResult = null;
  if (/\.zip$/i.test(zipOrProject)) {
    ingestResult = ingest(zipOrProject, { projectId, force, root });
    id = ingestResult.project_id;
  } else id = assertId(zipOrProject, 'project-id');
  const analysis = analyze(id, { root });
  const disc = discover(id, { root });
  const selected = resolveCandidates(id, selector, { root });
  const results = [];
  const skipped = [];
  for (const c of selected) {
    if (c.evidence_sufficiency === 'INSUFICIENTE') {
      skipped.push({ process_id: c.process_id, reason: c.sufficiency_reason });
      continue;
    }
    if (!fs.existsSync(path.join(processDir(id, c.process_id, root), 'process-definition.json'))) draft(id, c, { root });
    results.push(await generate(id, c.process_id, { root }));
  }
  const nativeProject = bpm && results.length && results.every((r) => r.validation.approval === 'APROBADO' && r.review.verdict !== 'RECHAZADO') ? exportNativeProject(id, results, { root }) : null;
  const report = finalReport(id, results, { root });
  const published = publishDeliverables(root, id);
  return {
    project_id: id,
    published,
    delivery: published.quality,
    analysis,
    discovery: disc.report,
    generated: results.map((r) => ({ process_id: r.process_id, approval: r.validation.approval, verdict: r.review.verdict, documentation: r.documentation, files: r.files })),
    skipped,
    native_project: nativeProject,
    report,
  };
}
