// Vista única de actividades funcionales del servicio, derivada de forma determinista de la definición detallada.
// No inventa comportamiento: agrupa operaciones técnicas, conserva decisiones de negocio, resultados finales y toda
// llamada a repositorio/base de datos (como actividad del carril del servicio).
import { normalizeGateways } from './normalize-gateways.mjs';
import { refineDefinition } from './refine-definition.mjs';

const strip = (s) => String(s ?? '').replace(/[¿?]/g, '').replace(/\s+/g, ' ').trim();
const laneRole = (p) => (/controlador|controller|recurso|resource|\bapi\b|rest/i.test(p.name) ? 'controller' : /servicio|service|negocio|domain/i.test(p.name) ? 'service' : 'infra');
const union = (...lists) => [...new Set(lists.flat().filter(Boolean))];
const unnumber = (s) => String(s ?? '').replace(/^\s*\d+\s*[.)-]\s*/, '').trim();

// Nombre funcional corto: sin paréntesis, códigos HTTP, tokens de código (con '.', '(', '/') ni detalle tras ';' o ':'.
export function short(s, max = 60) {
  let t = String(s ?? '').replace(/\([^)]*\)/g, ' ').replace(/\bHTTP\s*\d{3}\b;?/gi, ' ').replace(/codigoRespuesta/gi, ' ');
  const question = /^\s*¿/.test(t);
  t = t.split(/[;:]/)[0];
  t = t.split(/\s+/).filter((w) => w && !/[./(){}[\]]/.test(w.replace(/[.,]$/, ''))).join(' ').replace(/[¿?]/g, '').replace(/[,.]\s*$/, '').trim();
  if (!t) t = 'Actividad';
  if (t.length > max) { t = t.slice(0, max); t = `${t.slice(0, Math.max(t.lastIndexOf(' '), 20)).trim()}…`; }
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return question ? `¿${t}?` : t;
}

const ACCENTS = [[/parametros/gi, 'parámetros'], [/codigo/gi, 'código'], [/numero/gi, 'número'], [/telefono/gi, 'teléfono'], [/categoria/gi, 'categoría'], [/linea/gi, 'línea'], [/(\w)cion\b/gi, '$1ción'], [/(\w)sion\b/gi, '$1sión']];
const NOISE = /^(escribirLog|log\w*|checkStr|check\w*|format\w*|get\w*|set\w*|is\w*|create\w*|execute|call|to\w+|map\w*|build\w*|agregar\w*|obtenerValor\w*)$/;
export function humanize(method) {
  let t = String(method ?? '').split('.').pop().replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  for (const [re, to] of ACCENTS) t = t.replace(re, to);
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function functionalServiceView(detail, opts = {}) {
  const nameOv = opts.names || {};
  const traceNum = (t) => Number(String(t).replace(/\D/g, '')) || 0;
  const traceNodesOf = (o) => (o.trace_node ? [o.trace_node] : o.trace_nodes || []);
  const methodsOfSet = (set, { strict = true } = {}) => {
    if (!opts.methodOf) return [];
    const pairs = [];
    for (const o of [...detail.activities, ...detail.decisions, ...detail.events]) {
      if (!set.has(o.id)) continue;
      for (const tn of traceNodesOf(o)) { const m = opts.methodOf(tn); if (m) pairs.push([traceNum(tn), m]); }
    }
    pairs.sort((a, b) => a[0] - b[0]);
    const uniq = [...new Set(pairs.map((p) => p[1]))];
    const good = uniq.filter((m) => !NOISE.test(m.split('.').pop()));
    return strict ? good : (good.length ? good : uniq);
  };
  opts.methodsOf = opts.methodsOf || methodsOfSet;
  const def = structuredClone(detail);
  const N = new Map();
  for (const a of def.activities) N.set(a.id, { t: 'activity', o: a });
  for (const d of def.decisions) N.set(d.id, { t: 'decision', o: d });
  for (const e of def.events) N.set(e.id, { t: 'event', o: e });
  let F = def.flows.map((f) => ({ ...f }));
  const cover = new Map([...N.keys()].map((k) => [k, new Set([k])]));
  const omitted = new Set();
  const synthetic = new Set();
  const names = new Map();
  const ids = new Set([...N.keys(), ...F.map((f) => f.id), ...def.uncertainties.map((u) => u.id)]);
  const uid = (base) => { let id = base, i = 2; while (ids.has(id)) id = `${base}_${i++}`; ids.add(id); return id; };
  const out = (id) => F.filter((f) => f.from === id);
  const inn = (id) => F.filter((f) => f.to === id);
  const isAct = (id) => N.get(id)?.t === 'activity';
  const isDec = (id) => N.get(id)?.t === 'decision';
  const isData = (id) => isAct(id) && (N.get(id).o.data_access || []).length > 0;
  const remove = (id) => { F = F.filter((f) => f.from !== id && f.to !== id); N.delete(id); };
  const bypass = (id, target) => {
    for (const f of inn(id)) if (f.from !== id) f.to = target;
    F = F.filter((f) => f.from !== id);
    N.delete(id);
  };
  const coverOf = (id) => cover.get(id) || new Set([id]);

  const excIn = new Map();
  for (const f of F) if (f.branch === 'exception') excIn.set(f.to, (excIn.get(f.to) || 0) + 1);
  const hasTF = (id) => out(id).some((f) => ['true', 'false', 'case'].includes(f.branch));

  // 1-2. Compuertas de excepción: se omiten; las salidas de excepción de las de negocio se retiran.
  // Se registra el origen real (quién lanza) y el manejador (a dónde va) para dibujarlo después.
  const excEdges = [];
  for (const d of [...def.decisions]) {
    if (!N.has(d.id)) continue;
    const outs = out(d.id);
    if (!outs.some((f) => f.branch === 'exception')) continue;
    if (hasTF(d.id)) {
      for (const f of outs.filter((x) => x.branch === 'exception')) excEdges.push({ from: d.id, to: f.to });
      F = F.filter((f) => !(f.from === d.id && f.branch === 'exception'));
      continue;
    }
    let normal = outs.find((f) => f.branch !== 'exception');
    if (!normal) normal = [...outs].sort((a, b) => (excIn.get(a.to) || 0) - (excIn.get(b.to) || 0))[0];
    for (const f of outs.filter((x) => x.id !== normal.id)) for (const p of inn(d.id)) excEdges.push({ from: p.from, to: f.to });
    omitted.add(d.id);
    F = F.filter((f) => !(f.from === d.id && f.id !== normal.id));
    if (normal.to === d.id) { remove(d.id); continue; }
    bypass(d.id, normal.to);
  }

  // 2b. Final de excepción propagada (HTTP desconocido) que solo se alcanzaba por corredores de excepción: se omite del diagrama
  // funcional y se informa en map.omitted_outcomes (la excepción se conserva en la definición detallada y en las incertidumbres).
  const omittedOutcomes = [];
  for (const e of def.events.filter((x) => x.type === 'end' && (x.evidence_status === 'DESCONOCIDA' || /propagad/i.test(x.name)))) {
    if (!N.has(e.id)) continue;
    for (let i = excEdges.length - 1; i >= 0; i--) if (excEdges[i].to === e.id) excEdges.splice(i, 1);
    if (inn(e.id).length) continue;
    const oc = (def.outcomes || []).find((o) => o.event_id === e.id);
    omittedOutcomes.push({ event_id: e.id, outcome_id: oc?.id || null, reason: 'Excepción propagada con estado HTTP desconocido: solo se alcanza por corredores de excepción técnicos; se conserva en la definición detallada.' });
    remove(e.id);
    omitted.add(e.id);
  }

  // 3. Uniones y compuertas sin bifurcación; compuertas sin entradas.
  let changed = true;
  while (changed) {
    changed = false;
    for (const d of def.decisions) {
      if (!N.has(d.id)) continue;
      const outs = out(d.id);
      if (outs.length === 1 && outs[0].to !== d.id) { omitted.add(d.id); bypass(d.id, outs[0].to); changed = true; }
    }
  }

  // 3b. Pasos técnicos que no son actividades de negocio: llamadas no resueltas de infraestructura (timeouts, conexiones,
  // accesores) y traducción/manejo de errores. Se omiten del diagrama funcional; permanecen en la definición detallada.
  const TECH_CALL = /^(set|get|is|close|open|init|log|escribirLog)\w*$|timeout|connection|login/i;
  const ERR_STEP = /^\s*(Manejar|Traducir|Capturar|Tratar|Retorno anticipado|Registrar error|Lanzar)\b|traduc\w*\s+(el\s+)?error|manejador de excepci/i;
  for (const a of def.activities) {
    if (!N.has(a.id)) continue;
    const m = /Invocar\s+([\w.]+)\(\)/.exec(a.name || '');
    const techUnresolved = a.evidence_status === 'DESCONOCIDA' && m && TECH_CALL.test(m[1].split('.').pop());
    const errStep = ERR_STEP.test(a.name || '');
    if (!techUnresolved && !errStep) continue;
    const outs = out(a.id);
    if (outs.length === 1 && outs[0].to !== a.id) { omitted.add(a.id); bypass(a.id, outs[0].to); }
    else if (!outs.length && !inn(a.id).some((f) => f.branch !== 'exception')) { omitted.add(a.id); remove(a.id); }
  }

  // 4. Regiones de decisión sin efecto funcional diferenciado (validaciones, formateos, guardas técnicas):
  // si todas las ramas de una decisión convergen en un único paso significativo (acceso a datos, llamada externa,
  // resultado final, comportamiento desconocido o unión compartida) y no contienen nada significativo, toda la
  // región se agrupa en una actividad funcional (INFERIDA). Las decisiones que sí cambian el resultado se conservan.
  const significant = (id) => {
    const n = N.get(id);
    if (!n) return true;
    if (n.t === 'event') return true;
    if (n.t === 'decision') return false;
    const a = n.o;
    return isData(id) || a.evidence_status === 'DESCONOCIDA' || !!a.message_target_participant_id || a.type === 'serviceTask' || a.type === 'sendTask' || /^Manejar\b/.test(a.name);
  };
  const orderFromStart = () => {
    const st = [...N.values()].filter((n) => n.t === 'event' && n.o.type === 'start').map((n) => n.o.id);
    const order = [], q = [...st], mark = new Set();
    while (q.length) { const x = q.shift(); if (mark.has(x) || !N.has(x)) continue; mark.add(x); order.push(x); for (const f of out(x)) q.push(f.to); }
    for (const k of N.keys()) if (!mark.has(k)) order.push(k);
    return order;
  };
  const findRegion = (d) => {
    const bfs = [], seenB = new Set([d]), q = out(d).map((f) => f.to);
    while (q.length) { const x = q.shift(); if (seenB.has(x) || !N.has(x)) continue; seenB.add(x); bfs.push(x); for (const f of out(x)) q.push(f.to); }
    const sinkAvoiding = (c) => {
      const seen = new Set([d, c]), st = out(d).map((f) => f.to);
      while (st.length) {
        const x = st.pop();
        if (seen.has(x) || !N.has(x)) continue;
        seen.add(x);
        const o = out(x);
        if (!o.length) return true;
        for (const f of o) st.push(f.to);
      }
      return false;
    };
    let P = null;
    for (const c of bfs.slice(0, 600)) if (!sinkAvoiding(c)) { P = c; break; }
    if (!P) return null;
    const R = new Set(), st = out(d).map((f) => f.to);
    while (st.length) {
      const x = st.pop();
      if (x === d || x === P || R.has(x) || !N.has(x)) continue;
      R.add(x);
      for (const f of out(x)) st.push(f.to);
    }
    if ([...R].some((x) => significant(x) || inn(x).some((f) => f.from !== d && !R.has(f.from)))) return null;
    return { R, P };
  };
  const LOOSE_NOISE = /^(escribirLog|log\w*|checkStr|check\w*|get\w*|set\w*|is\w*|create\w*|execute|call|to\w+|format\w*Log)$/;
  const regionName = (set) => {
    const ms = opts.methodsOf ? opts.methodsOf(set) : [];
    if (ms.length) return ms.slice(0, 2).map(humanize).join(' y ');
    // Sin métodos funcionales: se usan los métodos con significado propio (p. ej. mapearRequest) en lugar de la expresión Java.
    const loose = opts.methodsOf ? opts.methodsOf(set, { strict: false }).filter((m) => !LOOSE_NOISE.test(m.split('.').pop())) : [];
    return loose.length ? loose.slice(0, 2).map(humanize).join(' y ') : '';
  };
  changed = true;
  while (changed) {
    changed = false;
    for (const d of orderFromStart()) {
      if (!N.has(d) || !isDec(d) || out(d).length < 2) continue;
      const reg = findRegion(d);
      if (!reg) continue;
      const T = reg.P;
      const members = new Set([d, ...reg.R]);
      if ([...members].some((m) => out(m).some((f) => f.to !== T && !members.has(f.to)))) continue;
      const id = uid(`AF_${d}`);
      const group = [...members].map((m) => N.get(m).o);
      const allCover = new Set([...members].flatMap((m) => [...coverOf(m)]));
      const conds = group.map((g) => g.condition_text || g.description).filter(Boolean);
      const nm = regionName(allCover) || 'Verificar condiciones técnicas';
      const act = {
        id, name: nm, type: 'task', participant_id: N.get(d).o.participant_id,
        description: `Agrupa verificaciones técnicas sin efecto diferenciado en el flujo funcional. Detalle técnico (condiciones evaluadas): ${conds.slice(0, 12).join('; ')}${conds.length > 12 ? ' …' : ''}.`.slice(0, 1500),
        evidence_ids: union(...group.map((g) => g.evidence_ids || [])), evidence_status: 'INFERIDA',
        trace_nodes: union(...group.map((g) => (g.trace_node ? [g.trace_node] : g.trace_nodes || []))),
      };
      const ins = inn(d).filter((f) => !members.has(f.from));
      N.set(id, { t: 'activity', o: act });
      synthetic.add(id);
      names.set(id, [act.name]);
      cover.set(id, allCover);
      for (const f of ins) f.to = id;
      for (const m of members) { F = F.filter((f) => f.from !== m); N.delete(m); if (m !== d) omitted.add(m); }
      F = F.filter((f) => !(f.to === d || members.has(f.to)));
      F.push({ id: uid(`FV_${id}`), from: id, to: T, branch: 'next', evidence_ids: act.evidence_ids });
      changed = true;
    }
  }

  // 5. Absorción de pasos técnicos de infraestructura en la actividad de acceso a datos y fusión de tramos lineales.
  const parts = new Map(def.participants.map((p) => [p.id, p]));
  const lanes = def.participants.filter((p) => p.kind === 'internal' && !p.is_pool);
  const pool = def.participants.find((p) => p.kind === 'internal' && p.is_pool);
  const serviceLane = lanes.find((p) => laneRole(p) === 'service') || lanes.find((p) => laneRole(p) === 'controller') || lanes[0] || pool;
  const infra = (id) => { const p = parts.get(N.get(id).o.participant_id); return !!p && !p.is_pool && laneRole(p) === 'infra'; };
  const mergeInto = (keep, gone) => {
    const k = N.get(keep).o, g = N.get(gone).o;
    names.set(keep, [...(names.get(keep) || [k.name]), ...(names.get(gone) || [g.name])]);
    k.evidence_ids = union(k.evidence_ids, g.evidence_ids);
    k.trace_nodes = union(k.trace_nodes || [], g.trace_nodes || []);
    k.data_access = [...(k.data_access || []), ...(g.data_access || [])].filter((x, i, arr) => arr.findIndex((y) => y.data_store_id === x.data_store_id && y.access === x.access) === i);
    if (!k.data_access.length) delete k.data_access;
    k.description = `${k.description} ${g.description}`.trim();
    if (!synthetic.has(keep) || g.evidence_status !== 'CONFIRMADA' || k.evidence_status !== 'CONFIRMADA') k.evidence_status = 'INFERIDA';
    cover.set(keep, new Set([...coverOf(keep), ...coverOf(gone)]));
    N.delete(gone);
  };
  const mergeable = (id) => isAct(id) && N.get(id).o.evidence_status !== 'DESCONOCIDA' && !N.get(id).o.message_target_participant_id;
  for (const id of [...N.keys()].filter(isData)) {
    for (let guard = 0; guard < 50 && N.has(id); guard++) {
      const ins = inn(id);
      const pred = ins.length === 1 ? ins[0].from : null;
      if (pred && pred !== id && mergeable(pred) && !isData(pred) && infra(pred) && out(pred).length === 1) {
        for (const f of inn(pred)) f.to = id;
        F = F.filter((f) => f.from !== pred);
        mergeInto(id, pred);
        continue;
      }
      const outs = out(id);
      const succ = outs.length === 1 ? outs[0].to : null;
      if (succ && succ !== id && mergeable(succ) && !isData(succ) && infra(succ) && inn(succ).length === 1) {
        F = F.filter((f) => f.id !== outs[0].id);
        for (const f of out(succ)) f.from = id;
        mergeInto(id, succ);
        continue;
      }
      break;
    }
  }
  changed = true;
  while (changed) {
    changed = false;
    for (const id of [...N.keys()]) {
      if (!N.has(id) || !mergeable(id) || isData(id)) continue;
      const outs = out(id);
      if (outs.length !== 1) continue;
      const nx = outs[0].to;
      if (nx === id || !mergeable(nx) || isData(nx) || inn(nx).length !== 1) continue;
      F = F.filter((f) => f.id !== outs[0].id);
      for (const f of out(nx)) f.from = id;
      mergeInto(id, nx);
      changed = true;
    }
  }

  // 5b. Actividades de "armar respuesta" cuya única salida es un final: se absorben en el resultado (nombre funcional del final).
  const isEnd = (id) => N.get(id)?.t === 'event' && N.get(id).o.type === 'end';
  const ovName = (id) => {
    if (nameOv[id]) return nameOv[id];
    for (const c of coverOf(id)) if (nameOv[c]) return nameOv[c];
    return null;
  };
  for (const id of [...N.keys()]) {
    if (!isAct(id) || isData(id) || ovName(id)) continue;
    const a = N.get(id).o;
    const outs = out(id);
    if (a.evidence_status === 'DESCONOCIDA' || a.message_target_participant_id || outs.length !== 1 || !isEnd(outs[0].to)) continue;
    if (!/^\s*(arma|armar|respuesta|registrar respuesta|construir respuesta)/i.test(a.name)) continue;
    const end = outs[0].to;
    for (const f of inn(id)) f.to = end;
    F = F.filter((f) => f.from !== id);
    const eo = N.get(end).o;
    eo.evidence_ids = union(eo.evidence_ids, a.evidence_ids);
    cover.set(end, new Set([...coverOf(end), ...coverOf(id)]));
    N.delete(id);
  }

  // 5c. Finales con el mismo nombre funcional y la misma clase de resultado se fusionan en uno solo.
  const outcomeOf = (eid) => (def.outcomes || []).find((o) => o.event_id === eid);
  const finalName = (id) => ovName(id) || short(outcomeOf(id)?.name || N.get(id).o.name);
  const finalGroups = new Map();
  for (const id of [...N.keys()].filter(isEnd)) {
    const key = `${finalName(id)}|${outcomeOf(id)?.kind || ''}`;
    finalGroups.set(key, [...(finalGroups.get(key) || []), id]);
  }
  const eventRemap = new Map();
  for (const list of finalGroups.values()) {
    const keep = list[0];
    for (const gone of list.slice(1)) {
      for (const f of inn(gone)) f.to = keep;
      const ko = N.get(keep).o, go = N.get(gone).o;
      ko.evidence_ids = union(ko.evidence_ids, go.evidence_ids);
      if (go.evidence_status !== ko.evidence_status) ko.evidence_status = 'INFERIDA';
      cover.set(keep, new Set([...coverOf(keep), ...coverOf(gone)]));
      eventRemap.set(gone, keep);
      N.delete(gone);
      F = F.filter((f) => f.from !== gone);
    }
  }

  // 5d. Cadenas de validación (guardas): decisiones consecutivas cuya rama de rechazo (pasos técnicos lineales)
  // termina en el mismo final se agrupan en una sola decisión de validación; el detalle queda en cobertura y descripción.
  const linearStep = (id) => isAct(id) && !isData(id) && mergeable(id) && inn(id).length === 1 && out(id).length === 1;
  const guardOf = (d) => {
    if (!isDec(d) || N.get(d).o.gateway === 'parallel') return null;
    const outs = out(d);
    if (outs.length !== 2) return null;
    const sides = outs.map((f, i) => {
      const chain = [];
      let cur = f.to;
      while (linearStep(cur)) { chain.push(cur); cur = out(cur)[0].to; }
      return { f, other: outs[1 - i], chain, end: isEnd(cur) && inn(cur).length > 0 ? cur : null };
    });
    const errs = sides.filter((s) => s.end);
    if (errs.length !== 1) return null;
    return { err: errs[0], cont: errs[0].other };
  };
  for (const head of orderFromStart()) {
    if (!N.has(head)) continue;
    const g0 = guardOf(head);
    if (!g0) continue;
    const guards = [head], extra = [], errChains = [...g0.err.chain], errFlows = [g0.err.f.id];
    const E = g0.err.end;
    let cur = g0.cont.to, curFlow = g0.cont;
    for (;;) {
      let nxt = cur;
      const pass = [];
      while (linearStep(nxt) && guardOf(out(nxt)[0].to)?.err.end === E && inn(out(nxt)[0].to).length === 1) { pass.push(nxt); nxt = out(nxt)[0].to; }
      const g = guardOf(nxt);
      if (!g || g.err.end !== E || inn(nxt).length !== 1 || guards.includes(nxt)) break;
      guards.push(nxt); extra.push(...pass); errChains.push(...g.err.chain);
      curFlow = g.cont; cur = curFlow.to;
    }
    if (guards.length < 2) continue;
    const members = [...guards, ...extra, ...errChains];
    const group = members.map((m) => N.get(m).o);
    const id = uid(`D_VAL_${head}`);
    const conds = group.map((x) => x.condition_text).filter(Boolean);
    const gate = {
      id, name: '¿Cumple las validaciones previas?', gateway: 'exclusive', participant_id: N.get(head).o.participant_id,
      condition_text: `Agrupa validaciones consecutivas con el mismo resultado de rechazo: ${conds.slice(0, 12).join('; ')}${conds.length > 12 ? ' …' : ''}`.slice(0, 1500),
      evidence_ids: union(...group.map((x) => x.evidence_ids || [])), evidence_status: 'INFERIDA',
    };
    const headTrace = N.get(head).o.trace_node;
    if (headTrace) gate.trace_node = headTrace;
    const ins = inn(head);
    const contTo = curFlow.to;
    const allCover = new Set(members.flatMap((m) => [...coverOf(m)]));
    N.set(id, { t: 'decision', o: gate });
    cover.set(id, allCover);
    for (const f of ins) f.to = id;
    for (const m of members) { F = F.filter((f) => f.from !== m); N.delete(m); omitted.add(m); }
    F = F.filter((f) => !members.includes(f.to));
    const ok = { id: uid(`FV_${id}_OK`), from: id, to: contTo, branch: 'default', name: 'SÍ', evidence_ids: gate.evidence_ids };
    F.push(ok, { id: uid(`FV_${id}_KO`), from: id, to: E, branch: 'false', name: 'NO', condition: 'alguna validación previa no se cumple', evidence_ids: gate.evidence_ids });
    gate.default_flow_id = ok.id;
  }

  // 6. Corredores de excepción: una sola compuerta agrupada hacia los manejadores que quedaron sin entrada.
  const starts = [...N.values()].filter((n) => n.t === 'event' && n.o.type === 'start').map((n) => n.o.id);
  const reach = (from) => { const seen = new Set(); const st = [...from]; while (st.length) { const x = st.pop(); if (seen.has(x) || !N.has(x)) continue; seen.add(x); for (const f of out(x)) st.push(f.to); } return seen; };
  let seen = reach(starts);
  // 6a. Excepciones con origen conocido: cada actividad que puede lanzar se conecta a su manejador real.
  const viewOf = (id) => { if (N.has(id)) return id; for (const [vid, set] of cover) if (N.has(vid) && set.has(id)) return vid; return null; };
  const bySrc = new Map();
  for (const e of excEdges) {
    const s = viewOf(e.from), t = viewOf(e.to);
    if (!s || !t || s === t || out(s).some((f) => f.to === t)) continue;
    if (!bySrc.set(s, bySrc.get(s) || new Set()).get(s).add(t)) continue;
  }
  const excGateIds = [];
  const excGateSrc = new Map();
  if (opts.drawExceptions && bySrc.size && bySrc.size <= 8) {
    for (const [s, targets] of bySrc) {
      const so = N.get(s);
      if (!so) continue;
      const cond = (t) => `excepción capturada o propagada que conduce a: ${strip(N.get(t).o.name)}`;
      if (so.t === 'activity' && out(s).length === 1) {
        const a = so.o, e0 = out(s)[0];
        const id = uid(`D_EXC_${s}`);
        const gate = { id, name: `¿Falla ${strip(a.name).slice(0, 70)}?`, gateway: 'exclusive', participant_id: a.participant_id, condition_text: `Excepción durante: ${strip(a.name)}`, evidence_ids: [...a.evidence_ids], evidence_status: 'INFERIDA' };
        N.set(id, { t: 'decision', o: gate });
        excGateSrc.set(id, s);
        const next = e0.to;
        e0.to = id;
        const normal = { id: uid(`FV_${id}_NO`), from: id, to: next, branch: 'default', name: 'NO', evidence_ids: [...a.evidence_ids] };
        F.push(normal);
        gate.default_flow_id = normal.id;
        for (const t of targets) if (N.has(t)) F.push({ id: uid(`FV_${id}_${t}`), from: id, to: t, branch: 'exception', name: 'SI', condition: cond(t), evidence_ids: [...(N.get(t).o.evidence_ids || [])] });
        cover.set(id, new Set());
        excGateIds.push(id);
      } else if (so.t === 'decision') {
        for (const t of targets) if (N.has(t)) F.push({ id: uid(`FV_${s}_${t}`), from: s, to: t, branch: 'exception', name: 'EXCEPCIÓN', condition: cond(t), evidence_ids: [...(N.get(t).o.evidence_ids || [])] });
      }
    }
    seen = reach(starts);
  }
  const orphans = [...N.keys()].filter((k) => !seen.has(k));
  const entries = orphans.filter((k) => !inn(k).length);
  let excGate = null;
  if (opts.drawExceptions && entries.length) {
    const order = [], q = [...starts], mark = new Set();
    while (q.length) { const x = q.shift(); if (mark.has(x) || !N.has(x)) continue; mark.add(x); order.push(x); for (const f of out(x)) q.push(f.to); }
    const anchor = order.find((x) => isAct(x) && isData(x) && out(x).length === 1) || order.find((x) => isAct(x) && out(x).length === 1);
    if (anchor) {
      const a = N.get(anchor).o;
      const id = uid('D_FUNC_EXC');
      excGate = {
        id, name: '¿Falla el procesamiento?', gateway: 'exclusive', participant_id: a.participant_id,
        condition_text: 'Excepción capturada o propagada durante el procesamiento (agrupa los corredores try/catch del detalle)',
        evidence_ids: [...a.evidence_ids], evidence_status: 'INFERIDA',
      };
      N.set(id, { t: 'decision', o: excGate });
      const e0 = out(anchor)[0];
      const next = e0.to;
      e0.to = id;
      const normal = { id: uid(`FV_${id}_NO`), from: id, to: next, branch: 'default', name: 'NO', evidence_ids: [...a.evidence_ids] };
      F.push(normal);
      excGate.default_flow_id = normal.id;
      for (const en of entries) {
        F.push({ id: uid(`FV_${id}_${en}`), from: id, to: en, branch: 'exception', name: 'SI', condition: `excepción que conduce a: ${strip(N.get(en).o.name)}`, evidence_ids: [...(N.get(en).o.evidence_ids || [])] });
      }
      cover.set(id, new Set());
    }
  }
  seen = reach(starts);
  for (const k of [...N.keys()]) if (!seen.has(k)) { remove(k); omitted.add(k); }

  // 7. Carriles: la actividad funcional pertenece al servicio; se retiran carriles sin elementos.
  for (const n of N.values()) n.o.participant_id = serviceLane.id;
  for (const [id, list] of names) {
    const o = N.get(id)?.o;
    if (!o || list.length < 2) continue;
    const fnName = opts.methodsOf(coverOf(id)).slice(0, 2).map(humanize).join(' y ');
    if (isData(id)) {
      const dataName = (detail.activities.find((a) => a.id === [...coverOf(id)].find((c) => detail.activities.some((x) => x.id === c && (x.data_access || []).length)))?.name) || list[0];
      o.name = fnName || dataName;
      o.description = `Llamada al repositorio/base de datos. Agrupa: ${list.map(strip).join('; ')}. ${o.description}`.slice(0, 1500);
    } else if (!synthetic.has(id)) {
      const uniq = [...new Set(list.map(strip))];
      o.name = fnName || (uniq.slice(0, 3).join('; ') + (uniq.length > 3 ? ' …' : ''));
      o.description = `Agrupa: ${uniq.join('; ')}. ${o.description}`.slice(0, 1500);
    }
    if (isData(id)) o.type = 'serviceTask';
  }
  for (const n of N.values()) if (n.t === 'activity' && (n.o.data_access || []).length) n.o.participant_id = serviceLane.id;

  // 7b. Nombres funcionales cortos (el detalle técnico queda en la descripción, la definición y la trazabilidad).
  {
    const order = [], q = [...starts], mark = new Set();
    while (q.length) { const x = q.shift(); if (mark.has(x) || !N.has(x)) continue; mark.add(x); order.push(x); for (const f of out(x)) q.push(f.to); }
    for (const k of N.keys()) if (!mark.has(k)) order.push(k);
    let num = 0;
    const note = (o, old) => { if (old && old !== o.name && !String(o.description || '').includes(old)) o.description = `${o.description || ''} Detalle técnico: ${old}.`.trim().slice(0, 1500); };
    for (const id of order) {
      const node = N.get(id);
      if (!node) continue;
      const o = node.o, old = o.name;
      if (node.t === 'activity') {
        const unres = o.evidence_status === 'DESCONOCIDA' && /Invocar\s+([\w.]+)\(\)/.exec(old);
        const base = ovName(id) || (unres ? humanize(unres[1].split('.').pop()) : short(unnumber(old)));
        o.name = /^\d/.test(base) ? base : `${++num}. ${base}`;
      } else if (node.t === 'decision') {
        const src = excGateSrc.get(id);
        if (nameOv[id]) o.name = nameOv[id];
        else if (src && N.get(src)) { const b = short(unnumber(N.get(src).o.name)); o.name = `¿Error en ${b.charAt(0).toLowerCase()}${b.slice(1)}?`; }
        else o.name = ovName(id) || (/^[¿]?Actividad\??$/.test(short(old)) ? `¿Cumple la condición de ${humanize((opts.methodsOf(coverOf(id), { strict: false })[0]) || 'la validación').toLowerCase()}?` : short(old));
      } else if (o.type === 'end') o.name = finalName(id);
      else o.name = ovName(id) || short(old);
      if (node.t === 'activity') note(o, old);
      if (node.t === 'activity' && o.evidence_status === 'DESCONOCIDA' && !/implementación no resuelta/.test(o.description || '')) o.description = `${o.description || ''} Su implementación no está en el repositorio (comportamiento desconocido).`.trim().slice(0, 1500);
    }
  }

  // 8. Coherencia de compuertas.
  for (const n of N.values()) {
    if (n.t !== 'decision') continue;
    const d = n.o, outs = out(d.id);
    if (d.default_flow_id && !outs.some((f) => f.id === d.default_flow_id)) delete d.default_flow_id;
    if (outs.length < 2 || d.gateway === 'parallel') continue;
    if (!d.default_flow_id) { const def0 = outs.find((f) => f.branch === 'default') || outs.find((f) => f.branch === 'false'); if (def0) d.default_flow_id = def0.id; }
    for (const f of outs) if (f.id !== d.default_flow_id && !f.condition) f.condition = f.branch === 'true' ? d.condition_text : (f.name || 'otro caso');
  }

  const used = new Set([...N.values()].filter((n) => n.t !== 'event' || true).map((n) => n.o.participant_id));
  for (const a of N.values()) for (const da of a.o.data_access || []) used.add(da.data_store_id);
  for (const m of def.message_flows || []) { used.add(m.from); used.add(m.to); }
  def.participants = def.participants.filter((p) => p.is_pool || p.kind !== 'internal' || used.has(p.id));
  def.activities = [...N.values()].filter((n) => n.t === 'activity').map((n) => n.o);
  def.decisions = [...N.values()].filter((n) => n.t === 'decision').map((n) => n.o);
  def.events = [...N.values()].filter((n) => n.t === 'event').map((n) => n.o);
  def.flows = F;
  for (const p of def.participants) if (nameOv[p.id]) p.name = nameOv[p.id];
  {
    const seenEv = new Set();
    def.outcomes = (def.outcomes || []).map((o) => ({ ...o, event_id: eventRemap.get(o.event_id) || o.event_id })).filter((o) => {
      if (!N.has(o.event_id) || seenEv.has(o.event_id)) return false;
      seenEv.add(o.event_id);
      o.name = N.get(o.event_id).o.name;
      return true;
    });
  }
  if (omittedOutcomes.length) def.uncertainties.push({ id: uid('U_FUNC_PROPAGADA'), status: 'DESCONOCIDA', element_ids: [], description: 'Excepciones no absorbidas que salen del servicio (estado HTTP desconocido, sin manejador propio identificado) no se dibujan como final de la vista funcional; se conservan en la definición detallada y en sus excepciones.' });
  def.message_flows = (def.message_flows || []).filter((m) => (N.has(m.from) || parts.has(m.from)) && (N.has(m.to) || parts.has(m.to)));
  const covering = new Map();
  for (const [vid, set] of cover) if (N.has(vid)) for (const c of set) covering.set(c, [...(covering.get(c) || []), vid]);
  for (const u of def.uncertainties) u.element_ids = union(...(u.element_ids || []).map((x) => (N.has(x) ? [x] : covering.get(x) || [])));
  if (excGate) def.uncertainties.push({ id: uid('U_FUNC_EXC'), status: 'INFERIDA', element_ids: [excGate.id], description: 'Las excepciones del detalle técnico (try/catch por método) se agrupan en una sola compuerta; no indica el punto exacto donde ocurre cada una. El detalle completo se conserva en la definición y la traza.' });
  if (excGateIds.length) def.uncertainties.push({ id: uid('U_FUNC_EXC_SRC'), status: 'INFERIDA', element_ids: [...excGateIds], description: 'Compuertas de excepción deducidas de los corredores try/catch del detalle: conectan cada actividad con su manejador; no son predicados de negocio ni prueban que la excepción ocurra. Los pasos técnicos intermedios están agrupados.' });
  const kept = new Set(N.keys());
  for (const x of def.exceptions) if (x.handled_by && !kept.has(x.handled_by)) delete x.handled_by;
  def.scope_note = `${def.scope_note || ''} Vista de actividades funcionales del servicio derivada de la definición detallada: las llamadas a repositorio y base de datos se muestran como actividades del servicio; logs, cierres de recursos, uniones y corredores de excepción técnicos se agrupan.`.trim();

  const map = Object.fromEntries([...cover].filter(([k]) => N.has(k)).map(([k, v]) => [k, [...v]]));
  const covered = new Set(Object.values(map).flat());
  const view = refineDefinition(normalizeGateways(def));
  return { definition: view, map: { view_of: detail.id, covers: map, omitted_technical: [...omitted].filter((x) => !covered.has(x)), omitted_outcomes: omittedOutcomes, omitted_error_handling: errorHandlingDecisions(detail).filter((x) => !covered.has(x.decision_id)) } };
}

// Decisiones de traducción de errores: solo se alcanzan a través de aristas 'exception' (nunca por el flujo normal desde el inicio)
// y todas sus ramas conducen al mismo conjunto de resultados finales, por lo que no cambian el resultado observable.
// Criterio estructural (no léxico); cada decisión eximida se registra con su motivo en el mapa.
export function errorHandlingDecisions(detail) {
  const out = new Map();
  for (const f of detail.flows) out.set(f.from, [...(out.get(f.from) || []), f]);
  const endIds = new Set(detail.events.filter((e) => e.type === 'end').map((e) => e.id));
  const starts = detail.events.filter((e) => e.type === 'start').map((e) => e.id);
  const normal = new Set();
  const st = [...starts];
  while (st.length) {
    const x = st.pop();
    if (normal.has(x)) continue;
    normal.add(x);
    for (const f of out.get(x) || []) if (f.branch !== 'exception') st.push(f.to);
  }
  const finalsFrom = (id) => {
    const seen = new Set(), res = new Set(), s = [id];
    while (s.length) {
      const x = s.pop();
      if (seen.has(x)) continue;
      seen.add(x);
      if (endIds.has(x)) res.add(x);
      for (const f of out.get(x) || []) s.push(f.to);
    }
    return [...res].sort().join('|');
  };
  const result = [];
  for (const d of detail.decisions) {
    const outs = out.get(d.id) || [];
    if (normal.has(d.id) || outs.length < 2) continue;
    const sets = new Set(outs.map((f) => finalsFrom(f.to)));
    if (sets.size === 1) result.push({ decision_id: d.id, reason: 'Decisión alcanzable solo desde ramas de excepción; todas sus ramas terminan en el mismo resultado final (traducción de error técnico, sin efecto diferenciado en el resultado).' });
  }
  return result;
}

// Comprueba que la vista no oculte resultados, decisiones de negocio ni llamadas a repositorio/base de datos.
export function checkFunctionalCoverage(detail, view, map) {
  const errors = [];
  const viewIds = new Set([...view.activities, ...view.decisions, ...view.events].map((n) => n.id));
  const coveredBy = new Map();
  for (const [vid, list] of Object.entries(map.covers)) if (viewIds.has(vid)) for (const c of list) coveredBy.set(c, vid);
  const omittedEv = new Set((map.omitted_outcomes || []).map((o) => o.event_id));
  for (const e of detail.events.filter((x) => x.type === 'end')) if (!viewIds.has(e.id) && !coveredBy.has(e.id) && !omittedEv.has(e.id)) errors.push({ code: 'FINAL_OMITIDO', element_id: e.id, message: `El resultado final ${e.id} no está en la vista.` });
  for (const a of detail.activities.filter((x) => (x.data_access || []).length)) {
    const v = view.activities.find((x) => x.id === coveredBy.get(a.id));
    if (!v || !(v.data_access || []).some((d) => a.data_access.some((o) => o.data_store_id === d.data_store_id))) errors.push({ code: 'LLAMADA_BD_OMITIDA', element_id: a.id, message: `La llamada a base de datos ${a.id} no aparece como actividad de la vista.` });
  }
  const exempt = new Set(errorHandlingDecisions(detail).map((x) => x.decision_id));
  const registered = new Set((map.omitted_error_handling || []).map((x) => x.decision_id));
  for (const d of detail.decisions) {
    const outs = detail.flows.filter((f) => f.from === d.id);
    // Una decisión con una sola salida no bifurca (la vista la absorbe, igual que las uniones); no es una decisión omitida.
    // Solo se exime la traducción de errores verificada estructuralmente Y registrada en el mapa.
    if (exempt.has(d.id) && registered.has(d.id)) continue;
    if (outs.length >= 2 && outs.some((f) => ['true', 'false', 'case'].includes(f.branch)) && !coveredBy.has(d.id)) errors.push({ code: 'DECISION_OMITIDA', element_id: d.id, message: `La decisión ${d.id} no está cubierta por la vista.` });
  }
  return { valid: !errors.length, errors, coverage: { detail_nodes: detail.activities.length + detail.decisions.length + detail.events.length, view_nodes: viewIds.size } };
}
