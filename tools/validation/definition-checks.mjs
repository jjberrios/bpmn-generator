// Comprobaciones semánticas del modelo intermedio (process-definition) que JSON Schema no puede expresar.
// Se ejecutan antes de generar BPMN: el generador se niega a trabajar con un modelo con errores.

export function checkDefinition(def) {
  const errors = [];
  const warnings = [];
  const err = (code, element_id, message) => errors.push({ code, element_id, message });
  const warn = (code, element_id, message) => warnings.push({ code, element_id, message });

  const all = [
    ...def.participants.map((x) => ['participante', x.id]),
    ...def.activities.map((x) => ['actividad', x.id]),
    ...def.events.map((x) => ['evento', x.id]),
    ...def.decisions.map((x) => ['decisión', x.id]),
    ...def.flows.map((x) => ['flujo', x.id]),
    ...(def.message_flows || []).map((x) => ['flujo de mensaje', x.id]),
  ];
  const seen = new Map();
  for (const [kind, id] of all) {
    if (seen.has(id)) err('ID_DUPLICADO', id, `El identificador ${id} se repite (${seen.get(id)} y ${kind}).`);
    else seen.set(id, kind);
  }

  const parts = new Map(def.participants.map((p) => [p.id, p]));
  const pools = def.participants.filter((p) => p.kind === 'internal' && p.is_pool);
  if (pools.length !== 1) err('POOL_PRINCIPAL', null, `Debe existir exactamente un participante interno con is_pool=true (hay ${pools.length}).`);
  const lanes = def.participants.filter((p) => p.kind === 'internal' && !p.is_pool);
  const hasLanes = lanes.length > 0;

  const nodes = new Map();
  for (const x of def.activities) nodes.set(x.id, { ...x, nodeKind: 'activity' });
  for (const x of def.events) nodes.set(x.id, { ...x, nodeKind: 'event' });
  for (const x of def.decisions) nodes.set(x.id, { ...x, nodeKind: 'decision' });

  for (const n of nodes.values()) {
    const p = parts.get(n.participant_id);
    if (!p) err('PARTICIPANTE_INEXISTENTE', n.id, `El participante ${n.participant_id} no existe.`);
    else if (p.kind !== 'internal') err('PARTICIPANTE_INVALIDO', n.id, `El elemento ${n.id} debe pertenecer a un participante interno.`);
    else if (hasLanes && p.is_pool) err('ELEMENTO_FUERA_DE_CARRIL', n.id, `El proceso define carriles: ${n.id} debe asignarse a un carril, no al pool.`);
    else if (!hasLanes && !p.is_pool) err('ELEMENTO_FUERA_DE_POOL', n.id, `Sin carriles, ${n.id} debe asignarse al pool principal.`);
  }

  const incoming = new Map([...nodes.keys()].map((k) => [k, []]));
  const outgoing = new Map([...nodes.keys()].map((k) => [k, []]));
  for (const f of def.flows) {
    if (!nodes.has(f.from)) err('REFERENCIA_ROTA', f.id, `El flujo ${f.id} parte de ${f.from}, que no existe.`);
    if (!nodes.has(f.to)) err('REFERENCIA_ROTA', f.id, `El flujo ${f.id} llega a ${f.to}, que no existe.`);
    if (nodes.has(f.from) && nodes.has(f.to)) { outgoing.get(f.from).push(f); incoming.get(f.to).push(f); }
  }

  const starts = def.events.filter((e) => e.type === 'start');
  const ends = def.events.filter((e) => e.type === 'end');
  if (!starts.length) err('SIN_EVENTO_INICIAL', null, 'El proceso no tiene evento inicial.');
  if (!ends.length) err('SIN_EVENTO_FINAL', null, 'El proceso no tiene evento final.');
  for (const s of starts) if (incoming.get(s.id)?.length) err('INICIO_CON_ENTRADA', s.id, 'Un evento inicial no puede tener flujos entrantes.');
  for (const e of ends) if (outgoing.get(e.id)?.length) err('FINAL_CON_SALIDA', e.id, 'Un evento final no puede tener flujos salientes.');

  for (const n of nodes.values()) {
    const isStart = n.nodeKind === 'event' && n.type === 'start';
    const isEnd = n.nodeKind === 'event' && n.type === 'end';
    if (!isStart && !incoming.get(n.id).length) err('ELEMENTO_HUERFANO', n.id, `${n.id} no tiene flujos entrantes.`);
    if (!isEnd && !outgoing.get(n.id).length) err('ELEMENTO_HUERFANO', n.id, `${n.id} no tiene flujos salientes.`);
    if (n.nodeKind !== 'decision' && !isEnd && outgoing.get(n.id).length > 1) err('DIVISION_IMPLICITA', n.id, `${n.id} tiene varias salidas sin compuerta; use una compuerta explícita.`);
    if (n.nodeKind !== 'decision' && !isStart && incoming.get(n.id).length > 1 && n.nodeKind === 'activity') warn('UNION_IMPLICITA', n.id, `${n.id} recibe varios flujos sin compuerta de unión (permitido, pero revisar).`);
  }

  for (const d of def.decisions) {
    const outs = outgoing.get(d.id) || [];
    const ins = incoming.get(d.id) || [];
    if (outs.length < 2 && !(outs.length === 1 && ins.length >= 2)) err('COMPUERTA_SIN_BIFURCACION', d.id, `La compuerta ${d.id} debe bifurcar (≥2 salidas) o unir (≥2 entradas y 1 salida).`);
    if (d.gateway === 'parallel') {
      for (const f of outs) if (f.condition) err('CONDICION_EN_PARALELA', f.id, 'Una compuerta paralela no admite condiciones.');
    } else {
      if (d.default_flow_id && !outs.some((f) => f.id === d.default_flow_id)) err('DEFAULT_INVALIDO', d.id, `default_flow_id ${d.default_flow_id} no es una salida de ${d.id}.`);
      for (const f of outs) {
        if (outs.length < 2 || f.id === d.default_flow_id) continue;
        if (!f.condition) err('FLUJO_SIN_CONDICION', f.id, `La salida ${f.id} de la compuerta ${d.id} requiere condición (o ser el flujo predeterminado).`);
      }
      if (!d.default_flow_id && outs.length >= 2 && d.gateway === 'exclusive') warn('SIN_FLUJO_PREDETERMINADO', d.id, `La compuerta ${d.id} no define flujo predeterminado.`);
    }
  }
  for (const f of def.flows) {
    const from = nodes.get(f.from);
    if (f.condition && from && from.nodeKind !== 'decision') warn('CONDICION_FUERA_DE_COMPUERTA', f.id, 'Una condición fuera de una compuerta se interpreta como flujo condicional.');
  }

  // alcanzabilidad desde los eventos iniciales
  const reach = new Set();
  const stack = starts.map((s) => s.id);
  while (stack.length) {
    const id = stack.pop();
    if (reach.has(id)) continue;
    reach.add(id);
    for (const f of outgoing.get(id) || []) stack.push(f.to);
  }
  for (const id of nodes.keys()) if (!reach.has(id)) err('NO_ALCANZABLE', id, `${id} no es alcanzable desde ningún evento inicial.`);

  // mensajes y datos
  for (const a of def.activities) {
    if (a.message_target_participant_id) {
      const p = parts.get(a.message_target_participant_id);
      if (!p || p.kind !== 'external') err('MENSAJE_SIN_EXTERNO', a.id, `message_target_participant_id debe ser un participante externo existente.`);
    }
    for (const da of a.data_access || []) {
      const p = parts.get(da.data_store_id);
      if (!p || p.kind !== 'data_store') err('ALMACEN_INEXISTENTE', a.id, `data_store_id ${da.data_store_id} debe ser un participante data_store.`);
    }
  }
  for (const m of def.message_flows || []) {
    const fromNode = nodes.has(m.from), toNode = nodes.has(m.to);
    const fromExt = parts.get(m.from)?.kind === 'external', toExt = parts.get(m.to)?.kind === 'external';
    if (!((fromNode && toExt) || (fromExt && toNode))) err('FLUJO_MENSAJE_INVALIDO', m.id, 'Un flujo de mensaje debe unir un elemento del proceso con un participante externo.');
  }
  for (const o of def.outcomes) if (!nodes.has(o.event_id)) err('RESULTADO_SIN_EVENTO', o.id, `El resultado ${o.id} referencia un evento inexistente.`);

  // evidencias y trazabilidad
  const ev = new Map(def.evidence.map((e) => [e.id, e]));
  const evIds = new Set();
  for (const e of def.evidence) { if (evIds.has(e.id)) err('EVIDENCIA_DUPLICADA', e.id, 'Identificador de evidencia duplicado.'); evIds.add(e.id); }
  const checkRefs = (id, ids) => { for (const r of ids || []) if (!ev.has(r)) err('EVIDENCIA_INEXISTENTE_EN_MODELO', id, `Referencia a evidencia ${r} que no está en evidence[].`); };
  for (const n of nodes.values()) {
    checkRefs(n.id, n.evidence_ids);
    if (!n.evidence_ids?.length && n.evidence_status !== 'DESCONOCIDA') err('ELEMENTO_SIN_EVIDENCIA', n.id, `${n.id} no tiene evidencias asociadas.`);
    if (n.evidence_status === 'CONFIRMADA' && n.evidence_ids?.length && !n.evidence_ids.some((r) => ev.get(r)?.status === 'CONFIRMADA')) err('ESTADO_INCONSISTENTE', n.id, `${n.id} se marca CONFIRMADA pero ninguna evidencia lo es.`);
    if (n.evidence_status === 'INFERIDA') warn('INFERENCIA_NO_CONFIRMADA', n.id, `${n.id} es una inferencia y debe quedar visible en la revisión.`);
    if (n.evidence_status === 'DESCONOCIDA') warn('COMPORTAMIENTO_DESCONOCIDO', n.id, `${n.id} no puede resolverse con la evidencia disponible.`);
  }
  for (const p of def.participants) checkRefs(p.id, p.evidence_ids);
  for (const f of def.flows) checkRefs(f.id, f.evidence_ids);
  for (const m of def.message_flows || []) checkRefs(m.id, m.evidence_ids);
  for (const x of def.exceptions) checkRefs(x.id, x.evidence_ids);
  for (const p of def.participants) if (p.kind === 'internal' && !p.evidence_ids?.length) err('PARTICIPANTE_SIN_EVIDENCIA', p.id, `El participante ${p.id} no tiene justificación evidenciada.`);

  return { errors, warnings };
}
