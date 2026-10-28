// Refinamiento determinista, idempotente y reutilizable de una process-definition.
// No cambia la estructura del flujo: solo coherencia de estados, referencias y metadatos.
export function refineDefinition(definition) {
  const def = structuredClone(definition);
  const evStatus = new Map((def.evidence || []).map((e) => [e.id, e.status]));
  const elements = [...(def.activities || []), ...(def.decisions || []), ...(def.events || [])];

  // CONFIRMADA exige al menos una evidencia CONFIRMADA; si no, es una inferencia.
  for (const el of elements) {
    if (el.evidence_status === 'CONFIRMADA' && !(el.evidence_ids || []).some((i) => evStatus.get(i) === 'CONFIRMADA')) el.evidence_status = 'INFERIDA';
  }

  // Las incertidumbres solo pueden referenciar elementos existentes y no se duplican.
  const ids = new Set([...elements.map((e) => e.id), ...(def.participants || []).map((p) => p.id)]);
  const seen = new Set();
  def.uncertainties = (def.uncertainties || []).filter((u) => (seen.has(u.id) ? false : seen.add(u.id)));
  for (const u of def.uncertainties) u.element_ids = (u.element_ids || []).filter((x) => ids.has(x));

  // Un destino sin resolver nunca se modela como llamada confirmada.
  for (const a of def.activities || []) {
    if (a.message_target_participant_id && !(def.participants || []).some((p) => p.id === a.message_target_participant_id)) delete a.message_target_participant_id;
  }

  if (!def.scope_note) def.scope_note = 'Comportamiento backend observable respaldado por el código (BACKEND_OBSERVABLE). No se asumen pasos de usuario, aprobaciones ni tareas manuales.';
  return def;
}
