// Cambia exclusivamente rótulos; conserva condiciones, destinos y resultados.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, assertId } from '../pipeline.mjs';
import { materializeFunctionalPlan } from './materialize-functional.mjs';

export function relabelFunctional(projectId, vocabularyFile, { root = ROOT } = {}) {
  assertId(projectId, 'project-id');
  const base = fs.realpathSync(path.join(root, 'workspace', projectId));
  const file = fs.realpathSync(path.resolve(root, vocabularyFile));
  if (!file.startsWith(`${base}${path.sep}`) || path.relative(base, file).split(path.sep).includes('source')) throw new Error('Vocabulario fuera del workspace analítico.');
  const vocabulary = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Object.values(vocabulary).some((v) => typeof v !== 'string' || !v.trim())) throw new Error('Rótulos inválidos.');
  const planFile = path.join(base, 'analysis', 'functional-plan.json');
  const original = fs.readFileSync(planFile, 'utf8'), plan = JSON.parse(original);
  let changed = 0;
  for (const item of plan.processes) {
    const d = item.definition;
    for (const n of [...d.activities, ...d.events, ...d.decisions, ...d.flows, ...d.outcomes, ...d.participants]) {
      if (Object.hasOwn(vocabulary, n.name)) { n.name = vocabulary[n.name]; changed++; }
    }
  }
  // Materializar valida el lote completo antes de sustituir vistas.
  const candidate = path.join(base, 'analysis', 'functional-plan-relabeled.json');
  fs.writeFileSync(candidate, `${JSON.stringify(plan, null, 2)}\n`);
  const result = materializeFunctionalPlan(projectId, candidate, { root });
  const history = path.join(base, 'history', 'presentation');
  fs.mkdirSync(history, { recursive: true });
  if (!fs.existsSync(path.join(history, 'functional-plan-before-labels.json'))) fs.writeFileSync(path.join(history, 'functional-plan-before-labels.json'), original);
  fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
  return { changed, ...result };
}
