// Separar unión y bifurcación sin modificar predicados ni rutas observables.
export function normalizeGateways(definition) {
  const def = structuredClone(definition);
  const ids = new Set([...def.activities, ...def.events, ...def.decisions, ...def.flows, ...def.uncertainties].map((x) => x.id));
  const unique = (base) => { let id = base, i = 2; while (ids.has(id)) id = `${base}_${i++}`; ids.add(id); return id; };
  for (const d of [...def.decisions]) {
    const incoming = def.flows.filter((f) => f.to === d.id);
    const outgoing = def.flows.filter((f) => f.from === d.id);
    if (incoming.length < 2 || outgoing.length < 2) continue;
    const joinId = unique(`${d.id}_JOIN`);
    def.decisions.push({ id: joinId, name: 'Converger rutas alternativas', gateway: d.gateway,
      participant_id: d.participant_id, condition_text: 'Unión estructural sin predicado adicional', evidence_ids: [...d.evidence_ids], evidence_status: 'INFERIDA' });
    for (const f of incoming) f.to = joinId;
    def.flows.push({ id: unique(`F_${joinId}`), from: joinId, to: d.id, branch: 'next', evidence_ids: [...d.evidence_ids] });
    def.uncertainties.push({ id: unique(`U_${joinId}`), element_ids: [joinId], status: 'INFERIDA',
      description: 'Unión estructural separada de la bifurcación BPMN: conserva las entradas alternativas y los predicados originales; no añade una decisión de negocio.' });
  }
  return def;
}
