// Materializa un plan JSON revisable; no interpreta código ni inventa agrupaciones.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, assertId } from '../pipeline.mjs';
import { checkAbstraction, definitionHash } from '../validation/abstraction-checks.mjs';

export function compileFunctionalPlan(source, item) {
  if (item.process_id !== source.id) throw new Error('El plan no corresponde al proceso fuente.');
  const specification = structuredClone(item.definition);
  if (!specification || specification.id !== source.id) throw new Error('Definición funcional sin identificador fuente.');
  // Estos datos proceden siempre del análisis conservado, no de una nueva transcripción.
  const definition = { ...specification, schema_version: '1.0', entry_point: structuredClone(source.entry_point), evidence: structuredClone(source.evidence), review_status: { state: 'PENDIENTE' } };
  const sourceNodes = new Map([...source.activities, ...source.events, ...source.decisions].map((n) => [n.id, n]));
  for (const node of [...definition.activities, ...definition.events, ...definition.decisions]) {
    const groups = (item.groups ?? []).filter((g) => g.target_id === node.id);
    if (!node.evidence_ids) node.evidence_ids = [...new Set(groups.flatMap((g) => g.source_node_ids.flatMap((id) => sourceNodes.get(id)?.evidence_ids ?? [])))];
    // Una agrupación es una interpretación explícita, no una afirmación nueva de certeza.
    node.evidence_status ??= 'INFERIDA';
  }
  const mapping = { process_id: source.id, source_sha256: definitionHash(source), view_sha256: definitionHash(definition), groups: structuredClone(item.groups), outcomes: structuredClone(item.outcomes) };
  const validation = checkAbstraction(source, definition, mapping);
  if (!validation.valid) throw new Error(`Plan funcional inválido de ${source.id}: ${JSON.stringify(validation.errors)}`);
  return { definition, mapping, validation };
}

export function materializeFunctionalPlan(projectId, file, { root = ROOT } = {}) {
  assertId(projectId, 'project-id');
  const base = fs.realpathSync(path.join(root, 'workspace', projectId));
  const full = fs.realpathSync(path.resolve(root, file));
  if (!full.startsWith(`${base}${path.sep}`) || path.relative(base, full).split(path.sep).includes('source')) throw new Error('El plan debe estar en el workspace analítico del proyecto, fuera de source/.');
  const plan = JSON.parse(fs.readFileSync(full, 'utf8'));
  if (plan.project_id !== projectId || !Array.isArray(plan.processes) || !plan.processes.length) throw new Error('Plan funcional vacío o de otro proyecto.');
  const ids = plan.processes.map((p) => assertId(p.process_id, 'process-id'));
  if (new Set(ids).size !== ids.length) throw new Error('El plan repite procesos.');
  // Preflight completo: un elemento inválido no sustituye las otras vistas ya revisadas.
  const compiled = plan.processes.map((item) => {
    const dir = path.join(base, 'processes', item.process_id);
    const source = JSON.parse(fs.readFileSync(path.join(dir, 'process-definition.json'), 'utf8'));
    return { dir, ...compileFunctionalPlan(source, item) };
  });
  for (const { dir, definition, mapping } of compiled) {
    for (const [name, value] of [['functional-definition.json', definition], ['abstraction-map.json', mapping]]) {
      const target = path.join(dir, name);
      if (fs.existsSync(target)) {
        const previous = fs.readFileSync(target);
        const history = path.join(dir, 'history', 'functional', definitionHash(JSON.parse(previous)));
        fs.mkdirSync(history, { recursive: true });
        if (!fs.existsSync(path.join(history, name))) fs.writeFileSync(path.join(history, name), previous);
      }
      fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
    }
  }
  return { processes: compiled.map(({ definition, validation }) => ({ process_id: definition.id, activities: definition.activities.length, decisions: definition.decisions.length, events: definition.events.length, validation })), review: 'PENDIENTE; no sustituye la entrega nativa.' };
}
