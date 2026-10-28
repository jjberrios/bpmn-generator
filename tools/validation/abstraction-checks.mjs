// Contrato determinista de una vista resumida. No sustituye la revisión funcional contra el código.
import { createHash } from 'node:crypto';
import { checkDefinition } from './definition-checks.mjs';
import { validateContract } from './schema-validator.mjs';

export const definitionHash = (definition) => createHash('sha256').update(JSON.stringify(definition)).digest('hex');
const nodesOf = (d) => [...d.activities, ...d.events, ...d.decisions];

export function checkAbstraction(source, view, map) {
  const errors = [];
  const fail = (message) => errors.push(message);
  const schema = validateContract('process-definition', view);
  if (!schema.valid) return { valid: false, errors: schema.errors };
  errors.push(...checkDefinition(view).errors.map((e) => `${e.code}: ${e.message}`));
  if (source.id !== view.id || map.process_id !== source.id) fail('La vista y el mapa deben conservar el identificador del proceso fuente.');
  if (map.source_sha256 !== definitionHash(source)) fail('El mapa de abstracción pertenece a otra versión del modelo detallado.');
  if (map.view_sha256 !== definitionHash(view)) fail('El mapa de abstracción pertenece a otra versión de la vista funcional.');
  if (JSON.stringify(source.entry_point) !== JSON.stringify(view.entry_point)) fail('La vista no puede cambiar el punto de entrada.');
  const sourceNodes = new Map(nodesOf(source).map((n) => [n.id, n]));
  const viewNodes = new Map(nodesOf(view).map((n) => [n.id, n]));
  const sourceEvidence = new Map(source.evidence.map((e) => [e.id, e]));
  const viewEvidence = new Map(view.evidence.map((e) => [e.id, e]));
  const covered = new Set();
  const targets = new Set();
  for (const group of map.groups ?? []) {
    const target = viewNodes.get(group.target_id);
    if (!target) { fail(`Destino de abstracción inexistente: ${group.target_id}`); continue; }
    if (!group.reason?.trim() || !group.source_node_ids?.length) fail(`Agrupación sin justificación o nodos fuente: ${group.target_id}`);
    targets.add(target.id);
    for (const id of group.source_node_ids ?? []) {
      const node = sourceNodes.get(id);
      if (!node) { fail(`Nodo detallado inexistente: ${id}`); continue; }
      covered.add(id);
      for (const eid of node.evidence_ids ?? []) {
        if (!viewEvidence.has(eid) || JSON.stringify(viewEvidence.get(eid)) !== JSON.stringify(sourceEvidence.get(eid))) fail(`La evidencia ${eid} no se conservó literalmente.`);
      }
    }
    if (target.evidence_status === 'CONFIRMADA' && group.source_node_ids.length > 1) fail(`La agrupación ${target.id} debe distinguirse de un hecho directo (INFERIDA).`);
  }
  for (const id of sourceNodes.keys()) if (!covered.has(id)) fail(`Nodo técnico sin representación ni documentación de abstracción: ${id}`);
  for (const id of viewNodes.keys()) if (!targets.has(id)) fail(`Elemento funcional sin respaldo en el modelo detallado: ${id}`);
  for (const e of view.evidence) if (!sourceEvidence.has(e.id) || JSON.stringify(e) !== JSON.stringify(sourceEvidence.get(e.id))) fail(`Evidencia nueva o alterada en la vista: ${e.id}`);
  const outcomes = new Map(source.outcomes.map((o) => [o.id, o]));
  const targetOutcomes = new Map(view.outcomes.map((o) => [o.id, o]));
  const outcomesCovered = new Set();
  const targetOutcomesCovered = new Set();
  for (const row of map.outcomes ?? []) {
    const target = targetOutcomes.get(row.target_id);
    if (!target) { fail(`Resultado funcional inexistente: ${row.target_id}`); continue; }
    targetOutcomesCovered.add(target.id);
    if (!row.source_outcome_ids?.length || !row.description?.trim()) fail(`Resultado agrupado sin desglose: ${row.target_id}`);
    for (const id of row.source_outcome_ids ?? []) {
      const item = outcomes.get(id);
      if (!item) { fail(`Resultado detallado inexistente: ${id}`); continue; }
      if (outcomesCovered.has(id)) fail(`Resultado detallado duplicado: ${id}`);
      outcomesCovered.add(id);
      if (item.kind !== target.kind) fail(`No puede confundirse éxito, rechazo, error o desconocido: ${id}`);
      if (item.http_status !== target.http_status) fail(`No puede cambiarse el HTTP inferido/desconocido de ${id}`);
    }
  }
  for (const id of outcomes.keys()) if (!outcomesCovered.has(id)) fail(`Resultado detallado omitido: ${id}`);
  for (const id of targetOutcomes.keys()) if (!targetOutcomesCovered.has(id)) fail(`Resultado funcional sin origen: ${id}`);
  return { valid: errors.length === 0, errors, coverage: { source_nodes: sourceNodes.size, covered_nodes: covered.size, source_outcomes: outcomes.size, covered_outcomes: outcomesCovered.size }, limitation: 'Cobertura documental de la abstracción; no demuestra equivalencia de rutas ni fidelidad funcional. Requiere revisión independiente contra el código.' };
}
