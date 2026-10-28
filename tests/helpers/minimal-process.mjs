// Definición mínima, conocida y válida para las pruebas del motor BPMN.
// START -> Validar -> ¿válido? -(SI: cond)-> END_OK / -(NO: por defecto)-> END_FAIL
export const SRC_FILE = 'src/Main.java';

export function evidence(id, line, snippet, extra = {}) {
  return { id, status: 'CONFIRMADA', file: SRC_FILE, line_start: line, line_end: line, class: 'Main', method: 'run', snippet, ...extra };
}

export function makeMinimalDef({ lanes = true } = {}) {
  const lane = (id, name) => ({ id, name, kind: 'internal', justification: `Responsabilidad ${name} (prueba)`, evidence_ids: ['EV1'] });
  const inA = lanes ? 'LN_A' : 'PL_main';
  const inB = lanes ? 'LN_B' : 'PL_main';
  const participants = [{ id: 'PL_main', name: 'servicio-prueba', kind: 'internal', is_pool: true, justification: 'Módulo de prueba', evidence_ids: ['EV1'] }];
  if (lanes) participants.push(lane('LN_A', 'Controlador'), lane('LN_B', 'Servicio'));
  return {
    schema_version: '1.0',
    id: 'proceso_minimo',
    name: 'Proceso mínimo',
    description: 'Definición mínima para pruebas',
    entry_point: { class: 'Main', method: 'run', kind: 'rest', http_method: 'GET', path: '/x', file: SRC_FILE, line: 1, trace_id: 'TR_X' },
    abstraction_level: 'BACKEND_OBSERVABLE',
    scope_note: 'Prueba',
    participants,
    activities: [{ id: 'A1', name: 'Validar datos', type: 'task', participant_id: inB, description: 'Valida', evidence_ids: ['EV2'], evidence_status: 'CONFIRMADA' }],
    events: [
      { id: 'START', name: 'Recibir GET /x', type: 'start', definition: 'none', participant_id: inA, evidence_ids: ['EV1'], evidence_status: 'CONFIRMADA' },
      { id: 'END_OK', name: 'Respuesta 200 OK', type: 'end', definition: 'none', participant_id: inA, evidence_ids: ['EV3'], evidence_status: 'CONFIRMADA', outcome: '200 OK' },
      { id: 'END_FAIL', name: 'Respuesta 400 BAD_REQUEST', type: 'end', definition: 'none', participant_id: inA, evidence_ids: ['EV4'], evidence_status: 'CONFIRMADA', outcome: '400 BAD_REQUEST' },
    ],
    decisions: [{ id: 'D1', name: '¿válido?', gateway: 'exclusive', participant_id: inB, condition_text: 'ok', evidence_ids: ['EV3'], evidence_status: 'CONFIRMADA', default_flow_id: 'F4' }],
    flows: [
      { id: 'F1', from: 'START', to: 'A1', branch: 'next', evidence_ids: ['EV1'] },
      { id: 'F2', from: 'A1', to: 'D1', branch: 'next', evidence_ids: ['EV2'] },
      { id: 'F3', from: 'D1', to: 'END_OK', branch: 'true', name: 'SI', condition: 'ok', evidence_ids: ['EV3'] },
      { id: 'F4', from: 'D1', to: 'END_FAIL', branch: 'false', name: 'NO', evidence_ids: ['EV3'] },
    ],
    outcomes: [
      { id: 'OUT1', name: '200 OK', kind: 'success', event_id: 'END_OK' },
      { id: 'OUT2', name: '400 BAD_REQUEST', kind: 'rejection', event_id: 'END_FAIL' },
    ],
    exceptions: [],
    evidence: [evidence('EV1', 1, 'class Main'), evidence('EV2', 2, 'validate()'), evidence('EV3', 3, 'if (ok)'), evidence('EV4', 4, 'return 400')],
    uncertainties: [],
    review_status: { state: 'PENDIENTE' },
  };
}

// Variante con compuertas paralelas (fork/join) sin condiciones.
export function makeParallelDef() {
  const d = makeMinimalDef({ lanes: false });
  d.id = 'proceso_paralelo';
  d.activities = [
    { id: 'A1', name: 'Tarea 1', type: 'task', participant_id: 'PL_main', evidence_ids: ['EV2'], evidence_status: 'CONFIRMADA' },
    { id: 'A2', name: 'Tarea 2', type: 'task', participant_id: 'PL_main', evidence_ids: ['EV2'], evidence_status: 'CONFIRMADA' },
  ];
  d.events = [
    { id: 'START', name: 'Inicio', type: 'start', definition: 'none', participant_id: 'PL_main', evidence_ids: ['EV1'], evidence_status: 'CONFIRMADA' },
    { id: 'END_OK', name: 'Fin', type: 'end', definition: 'none', participant_id: 'PL_main', evidence_ids: ['EV3'], evidence_status: 'CONFIRMADA', outcome: '200 OK' },
  ];
  d.decisions = [
    { id: 'FORK', name: 'Bifurcar', gateway: 'parallel', participant_id: 'PL_main', evidence_ids: ['EV2'], evidence_status: 'CONFIRMADA' },
    { id: 'JOIN', name: 'Unir', gateway: 'parallel', participant_id: 'PL_main', evidence_ids: ['EV2'], evidence_status: 'CONFIRMADA' },
  ];
  d.flows = [
    { id: 'F1', from: 'START', to: 'FORK', branch: 'next', evidence_ids: ['EV1'] },
    { id: 'F2', from: 'FORK', to: 'A1', branch: 'next', evidence_ids: ['EV2'] },
    { id: 'F3', from: 'FORK', to: 'A2', branch: 'next', evidence_ids: ['EV2'] },
    { id: 'F4', from: 'A1', to: 'JOIN', branch: 'next', evidence_ids: ['EV2'] },
    { id: 'F5', from: 'A2', to: 'JOIN', branch: 'next', evidence_ids: ['EV2'] },
    { id: 'F6', from: 'JOIN', to: 'END_OK', branch: 'next', evidence_ids: ['EV3'] },
  ];
  d.outcomes = [{ id: 'OUT1', name: '200 OK', kind: 'success', event_id: 'END_OK' }];
  return d;
}
