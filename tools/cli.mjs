#!/usr/bin/env node
// CLI determinista de BPMN Reverse Engineer. No llama a ningún LLM ni a servicios externos.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  ROOT, UsageError, ingest, analyze, discover, resolveCandidates, draft, generate, review, validateBpmnPath,
  inspectReferenceFile, finalReport, pipeline, assertId, DEFAULT_REFERENCE, exportNativeProject, validateNativePath,
} from './pipeline.mjs';
import { validateContractFile, CONTRACTS } from './validation/schema-validator.mjs';
import { readNativeStructure, analyzeReferenceStyle } from './reference/inspect-xpdl.mjs';
import { diagnoseLoader, loadedFontReadable, loadedFontContrast } from './bizagi/diagnose-loader.mjs';
import { generateFunctional, functionalReportResults, functionalReviewContext } from './functional-view.mjs';
import { materializeFunctionalPlan } from './analysis/materialize-functional.mjs';
import { relabelFunctional } from './analysis/relabel-functional.mjs';
import { generateActivityWord, currentActivityWord } from './documentation/activity-word.mjs';
import { generateGeneralWord, currentGeneralWord } from './documentation/general-word.mjs';

const HELP = `BPMN Reverse Engineer — CLI determinista

Uso: node tools/cli.mjs <comando> [argumentos]

Comandos:
  ingest <zip> [--project-id ID] [--force]          Extrae el ZIP de forma segura a workspace/<id>/source
  analyze <project-id>                              Análisis estructural (architecture-map + execution-trace)
  discover <project-id>                             Lista los procesos candidatos
  draft <project-id> --process <id|método|--all>    Borrador determinista de process-definition.json
  generate <project-id> (--process <id> | --all)    Genera BPMN, vista previa, validación y revisión automática
  document <project-id> (--process <id> | --all)    Genera Word por actividad del BPMN existente
  generate-functional <project-id> --all           Vista por actividades; conserva el detalle y exige revisión independiente
  materialize-functional <project-id> <plan.json>  Materializa un plan analítico validado sin alterar el detalle
  functional-review-context <project-id> --all     Huellas de los documentos para revisión independiente
  validate-bpmn <archivo.bpmn> [--definition f] [--sidecar f]
  validate-bizagi <archivo.bpm>                    Valida el contenedor XPDL nativo
  diagnose-bizagi <archivo.bpm> --installation <ruta> --mode <deserialize|load> [--project-id ID]
  review-check <project-id> --process <id>          Revisión determinista (+ review-agent.json si existe)
  validate-schema <contrato> <archivo.json>         Contratos: ${Object.keys(CONTRACTS).join(', ')}
  inspect-reference [archivo.bpm]                   Inspecciona la referencia Bizagi (por defecto ${DEFAULT_REFERENCE})
  reference-style <referencia.bpm> ...              Compara todos los diagramas y su estilo (sin Users/)
  report <project-id> [--process <id>|--all]        Informe final consolidado
  pipeline <zip|project-id> [--process <id>|--all]  ingest + analyze + discover + generate + report (sin LLM)

Todas las salidas son JSON salvo error (código de salida distinto de 0).`;

const out = (obj) => console.log(JSON.stringify(obj, null, 2));

function selectorOf(values, positionals) {
  if (values.all) return '--all';
  if (values.process) return values.process;
  throw new UsageError('Indique --process <id> o --all.');
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    console.log(HELP);
    return 0;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      'project-id': { type: 'string' },
      process: { type: 'string' },
      all: { type: 'boolean' },
      force: { type: 'boolean' },
      bpm: { type: 'boolean' },
      definition: { type: 'string' },
      sidecar: { type: 'string' },
      details: { type: 'boolean' },
      installation: { type: 'string' },
      mode: { type: 'string' },
      pattern: { type: 'string' },
    },
  });

  switch (cmd) {
    case 'document': {
      const id = assertId(positionals[0], 'project-id');
      out({ documents: resolveCandidates(id, selectorOf(values)).map((c) => ({ ...generateActivityWord(id, c.process_id, { root: ROOT }), general: generateGeneralWord(id, c.process_id, { root: ROOT }) })) });
      return 0;
    }
    case 'relabel-functional': {
      out(relabelFunctional(assertId(positionals[0], 'project-id'), positionals[1]));
      return 0;
    }
    case 'functional-review-context': {
      const id = assertId(positionals[0], 'project-id');
      out(functionalReviewContext(id, resolveCandidates(id, selectorOf(values)).map((c) => c.process_id)));
      return 0;
    }
    case 'materialize-functional': {
      out(materializeFunctionalPlan(assertId(positionals[0], 'project-id'), positionals[1]));
      return 0;
    }
    case 'generate-functional': {
      const id = assertId(positionals[0], 'project-id');
      const selected = resolveCandidates(id, selectorOf(values));
      const result = await generateFunctional(id, selected.map((c) => c.process_id));
      out(result);
      return result.blocked ? 1 : 0;
    }
    case 'reference-style': {
      if (!positionals.length) throw new UsageError('Indique referencias bajo inputs/references/.');
      const base = fs.realpathSync(path.join(ROOT, 'inputs', 'references'));
      const reports = positionals.map((file) => {
        const full = fs.realpathSync(path.resolve(ROOT, file));
        if (!full.startsWith(`${base}${path.sep}`) || !/\.bpm$/i.test(full)) throw new UsageError('Referencia fuera de inputs/references o extensión inválida.');
        return { ...analyzeReferenceStyle(full), file: path.relative(ROOT, full).split(path.sep).join('/') };
      });
      const report = { references: reports, diagrams: reports.reduce((n, r) => n + r.diagrams.length, 0) };
      const file = 'outputs/_shared/reports/reference-style-analysis.json';
      fs.mkdirSync(path.dirname(path.join(ROOT, file)), { recursive: true });
      fs.writeFileSync(path.join(ROOT, file), JSON.stringify(report, null, 2));
      out({ ...report, report: file });
      return 0;
    }
    case 'diagnose-bizagi': {
      if (!values.installation) throw new UsageError('Indique --installation con la ruta de Bizagi.');
      const result = diagnoseLoader(values.installation, values.mode, values.pattern, positionals[0]);
      const loading = ['deserialize', 'load'].includes(values.mode);
      const items = Array.isArray(result) ? result : [result];
      const visibleLabels = (r) => Array.isArray(r.labels) && r.labels.length === r.activities && r.labels.every((label) => label.name_preserved && label.graphical_properties_present && label.text_width > 0 && label.text_height > 0 && Number.isFinite(label.text_x) && Number.isFinite(label.text_y));
      const readableFonts = (r) => Array.isArray(r.labels) && r.labels.length > 0 && r.labels.every(loadedFontReadable);
      const blocked = loading && (!items.length || items.some((r) => r.error || !r.workflows || r.unknown_elements?.length || (values.mode === 'load' && (!r.collaboration_loaded || !visibleLabels(r) || !readableFonts(r)))));
      if (values['project-id']) {
        const id = assertId(values['project-id'], 'project-id');
        if (!loading) throw new UsageError('Solo se persisten diagnósticos de deserialización/carga.');
        const file = `outputs/${id}/reports/${id}.bizagi-provider-${values.mode}.json`;
        const contrasts = items.flatMap((r) => (r.labels ?? []).map(loadedFontContrast));
        const report = { approval: blocked ? 'BLOQUEADO' : 'APROBADO', mode: values.mode, file: positionals[0], sha256: createHash('sha256').update(fs.readFileSync(positionals[0])).digest('hex'), generated_at: new Date().toISOString(), diagrams: items, ...(values.mode === 'load' ? { labels: { total: items.reduce((n, r) => n + (r.labels?.length ?? 0), 0), visible_area_and_names_preserved: items.every(visibleLabels), readable_fonts_and_opaque_contrast: items.every(readableFonts), minimum_contrast: contrasts.length ? Math.min(...contrasts) : null } } : {}), limitation: 'Carga del modelo y verificación de nombres, áreas, fuente, tamaño, opacidad y contraste con DLL del proveedor; no es una comprobación visual de la interfaz de Bizagi.' };
        fs.mkdirSync(path.dirname(path.join(ROOT, file)), { recursive: true });
        fs.writeFileSync(path.join(ROOT, file), JSON.stringify(report, null, 2));
        out({ ...report, report: file });
      } else out(result);
      return blocked ? 1 : 0;
    }
    case 'ingest': {
      if (!positionals[0]) throw new UsageError('Falta la ruta del ZIP.');
      out(ingest(positionals[0], { projectId: values['project-id'], force: !!values.force }));
      return 0;
    }
    case 'analyze': {
      out(analyze(assertId(positionals[0], 'project-id')));
      return 0;
    }
    case 'discover': {
      const r = discover(assertId(positionals[0], 'project-id'));
      out({ report: r.report, candidates: r.candidates });
      return 0;
    }
    case 'draft': {
      const id = assertId(positionals[0], 'project-id');
      const selected = resolveCandidates(id, selectorOf(values));
      out(selected.map((c) => ({ process_id: c.process_id, ...draft(id, c, { overwrite: !!values.force }), definition: undefined })));
      return 0;
    }
    case 'generate': {
      const id = assertId(positionals[0], 'project-id');
      const selected = resolveCandidates(id, selectorOf(values));
      if (!selected.length) throw new UsageError('No hay procesos descubiertos; no se generó ningún archivo Bizagi. Revise el análisis y los puntos de entrada.');
      const insufficient = selected.filter((c) => c.evidence_sufficiency === 'INSUFICIENTE');
      if (insufficient.length) throw new UsageError(`Evidencia insuficiente para generar: ${insufficient.map((c) => c.process_id).join(', ')}. Refine las trazas antes de exportar.`);
      const summaries = [];
      const results = [];
      let blocked = false;
      for (const c of selected) {
        if (!fs.existsSync(path.join(ROOT, 'workspace', id, 'processes', c.process_id, 'process-definition.json'))) draft(id, c);
        const r = await generate(id, c.process_id);
        results.push(r);
        if (r.validation.approval !== 'APROBADO' || r.review.verdict === 'RECHAZADO') blocked = true;
        summaries.push({ process_id: r.process_id, validation: r.validation.approval, review: r.review.verdict, errors: r.validation.summary.errors, warnings: r.validation.summary.warnings, documentation: r.documentation, files: r.files });
      }
      const nativeProject = values.bpm && !blocked && results.length ? exportNativeProject(id, results) : null;
      out({ generated: summaries, native_project: nativeProject, bpmn_deliverable: summaries.map((s) => s.files) });
      return blocked ? 1 : 0;
    }
    case 'validate-bizagi': {
      const report = validateNativePath(positionals[0]);
      out(report);
      return report.approval === 'APROBADO' ? 0 : 1;
    }
    case 'validate-bpmn': {
      if (!positionals[0]) throw new UsageError('Falta la ruta del archivo .bpmn.');
      const r = await validateBpmnPath(positionals[0], { definitionPath: values.definition, sidecarPath: values.sidecar });
      out(r);
      return r.approval === 'APROBADO' ? 0 : 1;
    }
    case 'review-check': {
      const id = assertId(positionals[0], 'project-id');
      const sel = selectorOf(values);
      const selected = resolveCandidates(id, sel);
      const reports = selected.map((c) => review(id, c.process_id));
      out(reports.map((r) => ({ process_id: r.process_id, verdict: r.verdict, counts: r.counts })));
      return reports.some((r) => r.verdict === 'RECHAZADO') ? 1 : 0;
    }
    case 'validate-schema': {
      const [contract, file] = positionals;
      if (!contract || !file) throw new UsageError('Uso: validate-schema <contrato> <archivo.json>');
      if (!CONTRACTS[contract]) throw new UsageError(`Contrato desconocido: ${contract}`);
      const r = validateContractFile(contract, path.resolve(ROOT, file));
      out(r);
      return r.valid ? 0 : 1;
    }
    case 'inspect-reference': {
      if (values.details) {
        const ref = readNativeStructure(path.resolve(ROOT, positionals[0] ?? DEFAULT_REFERENCE));
        const pkg = ref.diagrams[0]?.document.Package;
        const list = (v) => v == null || v === '' ? [] : Array.isArray(v) ? v : [v];
        const fields = (v) => typeof v === 'object' && v ? Object.keys(v) : [];
        const workflows = list(pkg?.WorkflowProcesses?.WorkflowProcess);
        const nodes = workflows.flatMap((w) => list(w.Activities?.Activity));
        const transitions = workflows.flatMap((w) => list(w.Transitions?.Transition));
        // Solo nombres de campos y enumeraciones de formato: no autores ni texto del modelo.
        const sample = (values) => [...new Set(values.map((v) => JSON.stringify(fields(v))))].map((v) => JSON.parse(v));
        const extendedProfile = (o) => list(o?.ExtendedAttributes?.ExtendedAttribute).map((e) => {
          const name = e['@_Name'];
          if (name !== 'RuntimeProperties') return { name };
           try {
             const runtime = JSON.parse(e['@_Value'].replace(/&(quot|apos|lt|gt|amp);/g, (_, key) => ({ quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' })[key]));
             const shape = (v, depth = 0) => depth > 6 ? 'depth-limit' : v === null ? null : Array.isArray(v) ? { array: v.map((item) => shape(item, depth + 1)) } : typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([key, item]) => [key, shape(item, depth + 1)])) : typeof v === 'string' ? (v === '' ? 'empty-string' : 'string') : v;
             return { name, shape: shape(runtime) };
           } catch { return { name, valid_json: false, fields: fields(e) }; }
        });
        out({ metadata: ref.metadata, binary: ref.binary, diagram_binary: ref.diagrams[0]?.binary, skipped_user_file_types: ref.skipped_user_file_types, namespace: pkg?.['@_xmlns'], supplemental: ref.diagrams[0]?.supplemental,
          serialization_profile: { package: fields(pkg), workflows: sample(workflows), activities: sample(nodes),
            routes: nodes.filter((n) => n.Route !== undefined).map((n) => n.Route),
            tasks: sample(nodes.filter((n) => n.Implementation).map((n) => n.Implementation.Task)),
            transitions: sample(transitions), graphics: sample(nodes.flatMap((n) => list(n.NodeGraphicsInfos?.NodeGraphicsInfo))),
            association: sample(list(pkg?.Associations?.Association)), extended: { package: extendedProfile(pkg), workflows: workflows.map(extendedProfile), nodes: nodes.map(extendedProfile) },
            pool_fields: sample(list(pkg?.Pools?.Pool)), header_fields: fields(pkg?.PackageHeader) } });
        return 0;
      }
      const r = inspectReferenceFile(positionals[0] ?? DEFAULT_REFERENCE);
      if (!r.executed) {
        out(r);
        return 0;
      }
      const { activities, transitions, pools, ...summary } = r.report;
      out({ ...summary, pools: pools.map((p) => ({ name: p.name, lanes: p.lanes.map((l) => l.name) })), activities: activities.map((a) => ({ kind: a.kind, name: a.name })), transitions: transitions.map((t) => ({ from: t.from, to: t.to, name: t.name })), report: 'outputs/_shared/reports/reference-inspection.md' });
      return 0;
    }
    case 'report': {
      const id = assertId(positionals[0], 'project-id');
      const selected = resolveCandidates(id, values.process ?? '--all');
      const functional = functionalReportResults(id, selected.map((c) => c.process_id));
      if (functional) {
        out({ report: finalReport(id, functional), view: 'POR_ACTIVIDADES', processes: functional.map((r) => r.process_id) });
        return 0;
      }
      const results = [];
      for (const c of selected) {
        const base = path.join(ROOT, 'outputs', id, 'diagrams', c.process_id);
        if (!fs.existsSync(`${base}.process.json`)) continue;
        const def = JSON.parse(fs.readFileSync(`${base}.process.json`, 'utf8'));
        const rd = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'outputs', id, 'reports', `${c.process_id}.${n}.json`), 'utf8'));
        const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
        const documentation = currentActivityWord(id, c.process_id, { root: ROOT });
        documentation.general = currentGeneralWord(id, c.process_id, { root: ROOT });
        results.push({
          documentation, process_id: c.process_id, definition: def, validation: rd('validation'), review: rd('review'),
          files: {
            bpmn: rel(`${base}.bpmn`), definicion: rel(`${base}.process.json`), trazabilidad: rel(`${base}.traceability.json`),
            ...(documentation.approval === 'APROBADO' ? { word: documentation.file } : {}),
            ...(documentation.general.approval === 'APROBADO' ? { word_general: documentation.general.file } : {}),
            validacion: `outputs/${id}/reports/${c.process_id}.validation.json`, revision: `outputs/${id}/reports/${c.process_id}.review.json`,
            ...Object.fromEntries(['svg', 'png'].filter((ext) => fs.existsSync(path.join(ROOT, 'outputs', id, 'previews', `${c.process_id}.${ext}`))).map((ext) => [ext, `outputs/${id}/previews/${c.process_id}.${ext}`])),
            ...(fs.existsSync(path.join(ROOT, 'outputs', id, 'traces', `${c.process_id}.trace.json`)) ? { traza: `outputs/${id}/traces/${c.process_id}.trace.json` } : {}),
          },
        });
      }
      out({ report: finalReport(id, results), processes: results.map((r) => r.process_id) });
      return 0;
    }
    case 'pipeline': {
      if (!positionals[0]) throw new UsageError('Indique un ZIP o un project-id.');
      const r = await pipeline(positionals[0], { selector: selectorOf({ all: values.all || !values.process, process: values.process }), projectId: values['project-id'], bpm: !!values.bpm });
      out(r);
      return r.generated.some((g) => g.approval !== 'APROBADO' || g.verdict === 'RECHAZADO') ? 1 : 0;
    }
    default:
      throw new UsageError(`Comando desconocido: ${cmd}\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    const usage = err instanceof UsageError;
    console.error(JSON.stringify({ ok: false, error: err.message, tipo: usage ? 'uso' : 'error', detalles: err.details }, null, 2));
    process.exit(usage ? 64 : 2);
  },
);
