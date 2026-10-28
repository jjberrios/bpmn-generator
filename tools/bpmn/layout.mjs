// Layout por capas (horizontal) con carriles, ruteo ortogonal con detección de colisiones.
// bpmn-auto-layout no se usa porque no soporta carriles/colaboraciones con pools colapsados.
// Ver docs/architecture.md (decisión técnica).

export const SIZES = {
  event: { w: 36, h: 36 },
  task: { w: 120, h: 80 },
  gateway: { w: 50, h: 50 },
  dataStore: { w: 50, h: 50 },
};

const CFG = {
  colW: 140,
  gap: 70,
  rowH: 110,
  headerW: 30,
  padX: 40,
  lanePadY: 10,
  poolX: 40,
  poolY: 40,
  externalH: 60,
  externalGap: 70,
  margin: 4,
};

const rect = (x, y, w, h) => ({ x, y, w, h });

function segHitsRect(a, b, r, m = CFG.margin) {
  const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
  return maxX > r.x - m && minX < r.x + r.w + m && maxY > r.y - m && minY < r.y + r.h + m;
}

export function pathHits(points, rects) {
  const hits = new Set();
  for (let i = 0; i < points.length - 1; i++) {
    for (const [id, r] of rects) if (segHitsRect(points[i], points[i + 1], r)) hits.add(id);
  }
  return [...hits];
}

const bends = (pts) => Math.max(0, pts.length - 2);
const length = (pts) => pts.reduce((s, p, i) => (i ? s + Math.abs(p.x - pts[i - 1].x) + Math.abs(p.y - pts[i - 1].y) : 0), 0);

function dedupe(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    out.push(p);
  }
  // elimina puntos colineales intermedios
  const res = [out[0]];
  for (let i = 1; i < out.length - 1; i++) {
    const a = res[res.length - 1], b = out[i], c = out[i + 1];
    if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) continue;
    res.push(b);
  }
  res.push(out[out.length - 1]);
  return res;
}

export function labelLines(text, maxChars) {
  const words = String(text || '').split(/\s+/).filter(Boolean).flatMap((w) => {
    if (w.length <= maxChars) return [w];
    const parts = w.split(/(?<=[.(,\/])/);
    const out = [];
    let cur = '';
    for (const p of parts) { if ((cur + p).length > maxChars && cur) { out.push(cur); cur = p; } else cur += p; }
    if (cur) out.push(cur);
    return out;
  });
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}

export function layoutProcess(def) {
  const warnings = [];
  const parts = new Map(def.participants.map((p) => [p.id, p]));
  const pool = def.participants.find((p) => p.kind === 'internal' && p.is_pool);
  let lanesDef = def.participants.filter((p) => p.kind === 'internal' && !p.is_pool);
  const externals = def.participants.filter((p) => p.kind === 'external');

  // ---- nodos de flujo ----
  const nodes = new Map();
  for (const e of def.events) nodes.set(e.id, { id: e.id, kind: 'event', def: e, lane: e.participant_id });
  for (const a of def.activities) nodes.set(a.id, { id: a.id, kind: 'task', def: a, lane: a.participant_id });
  for (const d of def.decisions) nodes.set(d.id, { id: d.id, kind: 'gateway', def: d, lane: d.participant_id });
  const flows = def.flows.filter((f) => nodes.has(f.from) && nodes.has(f.to));
  const succ = new Map([...nodes.keys()].map((k) => [k, []]));
  const pred = new Map([...nodes.keys()].map((k) => [k, []]));
  for (const f of flows) { succ.get(f.from).push(f); pred.get(f.to).push(f); }

  // ---- rangos (longest path ignorando aristas de retroceso) ----
  const state = new Map();
  const back = new Set();
  const starts = [...nodes.values()].filter((n) => !pred.get(n.id).length || n.def.type === 'start').map((n) => n.id);
  const dfs = (id) => {
    state.set(id, 1);
    for (const f of succ.get(id)) {
      const s = state.get(f.to);
      if (s === 1) back.add(f.id);
      else if (!s) dfs(f.to);
    }
    state.set(id, 2);
  };
  for (const s of starts) if (!state.get(s)) dfs(s);
  for (const id of nodes.keys()) if (!state.get(id)) dfs(id);
  const rank = new Map();
  const forward = flows.filter((f) => !back.has(f.id));
  const indeg = new Map([...nodes.keys()].map((k) => [k, 0]));
  for (const f of forward) indeg.set(f.to, indeg.get(f.to) + 1);
  const q = [...nodes.keys()].filter((k) => indeg.get(k) === 0);
  q.forEach((k) => rank.set(k, 0));
  while (q.length) {
    const k = q.shift();
    for (const f of forward.filter((x) => x.from === k)) {
      rank.set(f.to, Math.max(rank.get(f.to) ?? 0, rank.get(k) + 1));
      indeg.set(f.to, indeg.get(f.to) - 1);
      if (indeg.get(f.to) === 0) q.push(f.to);
    }
  }
  for (const id of nodes.keys()) if (!rank.has(id)) rank.set(id, 0);
  const maxRank = Math.max(0, ...rank.values());

  // altura restante hasta un sumidero (prioriza la ruta principal en la fila del predecesor)
  const remain = new Map();
  const rem = (id, seen = new Set()) => {
    if (remain.has(id)) return remain.get(id);
    if (seen.has(id)) return 0;
    seen.add(id);
    const v = 1 + Math.max(0, ...succ.get(id).filter((f) => !back.has(f.id)).map((f) => rem(f.to, seen)));
    remain.set(id, v);
    return v;
  };
  for (const id of nodes.keys()) rem(id);

  // ---- carriles ----
  const hasLanes = lanesDef.length > 0;
  const extTasks = new Set(def.activities.filter((a) => a.message_target_participant_id).map((a) => a.participant_id));
  lanesDef = [...lanesDef].sort((a, b) => (extTasks.has(a.id) ? 1 : 0) - (extTasks.has(b.id) ? 1 : 0));
  const laneIds = hasLanes ? lanesDef.map((l) => l.id) : [pool.id];
  const laneOf = (n) => (hasLanes ? n.lane : pool.id);

  // ---- referencias a almacenes de datos (una por actividad y almacén) ----
  const dsRefs = [];
  for (const a of def.activities) for (const da of a.data_access || []) dsRefs.push({ id: `DSR_${da.data_store_id}_${a.id}`, store: da.data_store_id, activity: a.id, access: da.access });
  const dsByActivity = new Map();
  for (const r of dsRefs) { if (!dsByActivity.has(r.activity)) dsByActivity.set(r.activity, []); dsByActivity.get(r.activity).push(r); }

  // ---- filas dentro de cada carril ----
  const rowOf = new Map();
  const occ = new Map(); // `${lane}|${rank}` -> Set(rows)
  const order = [...nodes.keys()];
  const byRank = Array.from({ length: maxRank + 1 }, () => []);
  for (const id of order) byRank[rank.get(id)].push(id);
  const heightOf = (id) => 1 + (dsByActivity.get(id)?.length || 0);
  for (let r = 0; r <= maxRank; r++) {
    const items = [...byRank[r]].sort((a, b) => remain.get(b) - remain.get(a) || order.indexOf(a) - order.indexOf(b));
    for (const id of items) {
      const n = nodes.get(id);
      const lane = laneOf(n);
      const key = `${lane}|${r}`;
      if (!occ.has(key)) occ.set(key, new Set());
      const used = occ.get(key);
      const samePred = pred.get(id).filter((f) => !back.has(f.id)).map((f) => nodes.get(f.from)).find((p) => laneOf(p) === lane && rowOf.has(p.id));
      const want = samePred ? rowOf.get(samePred.id) : 0;
      const h = heightOf(id);
      const free = (row) => { for (let i = 0; i < h; i++) if (used.has(row + i)) return false; return true; };
      let row = want;
      for (let d = 0; !free(row); d++) { const cand = want + (d % 2 === 0 ? (d / 2 + 1) : -((d + 1) / 2)); row = cand; if (d > 50) break; }
      for (let i = 0; i < h; i++) used.add(row + i);
      rowOf.set(id, row);
    }
  }
  // normaliza filas por carril (mínimo 0)
  const laneRows = new Map();
  for (const lane of laneIds) {
    const ids = order.filter((id) => laneOf(nodes.get(id)) === lane);
    const mn = ids.length ? Math.min(...ids.map((i) => rowOf.get(i))) : 0;
    ids.forEach((i) => rowOf.set(i, rowOf.get(i) - mn));
    const mx = ids.length ? Math.max(...ids.map((i) => rowOf.get(i) + heightOf(i))) : 1;
    laneRows.set(lane, Math.max(1, mx));
  }

  // ---- geometría ----
  const nCols = maxRank + 1;
  const colX = (r) => CFG.poolX + CFG.headerW * (hasLanes ? 2 : 1) + CFG.padX + r * (CFG.colW + CFG.gap);
  const poolW = CFG.headerW * (hasLanes ? 2 : 1) + CFG.padX * 2 + nCols * CFG.colW + (nCols - 1) * CFG.gap;
  const laneGeom = [];
  let y = CFG.poolY;
  for (const lane of laneIds) {
    const h = laneRows.get(lane) * CFG.rowH + CFG.lanePadY * 2;
    laneGeom.push({ id: lane, x: CFG.poolX + (hasLanes ? CFG.headerW : 0), y, w: poolW - (hasLanes ? CFG.headerW : 0), h, top: y });
    y += h;
  }
  const poolRect = { id: pool.id, x: CFG.poolX, y: CFG.poolY, w: poolW, h: y - CFG.poolY };
  const laneTop = new Map(laneGeom.map((l) => [l.id, l.top]));

  const shapes = new Map();
  for (const n of nodes.values()) {
    const sz = SIZES[n.kind];
    const lane = laneOf(n);
    const cx = colX(rank.get(n.id)) + CFG.colW / 2;
    const cy = laneTop.get(lane) + CFG.lanePadY + rowOf.get(n.id) * CFG.rowH + CFG.rowH / 2 - (dsByActivity.has(n.id) ? 0 : 0);
    shapes.set(n.id, { id: n.id, kind: n.kind, x: cx - sz.w / 2, y: cy - sz.h / 2, w: sz.w, h: sz.h, lane, rank: rank.get(n.id) });
  }
  for (const r of dsRefs) {
    const t = shapes.get(r.activity);
    const idx = dsByActivity.get(r.activity).indexOf(r) + 1;
    const sz = SIZES.dataStore;
    shapes.set(r.id, { id: r.id, kind: 'dataStore', x: t.x + t.w / 2 - sz.w / 2, y: t.y + t.h / 2 - sz.h / 2 + idx * CFG.rowH, w: sz.w, h: sz.h, lane: t.lane, rank: t.rank });
  }

  // columnas (para canales)
  const chanAfter = (r) => colX(r) + CFG.colW + CFG.gap / 2;
  const chanBefore = (r) => colX(r) - CFG.gap / 2;
  const tracks = [];
  for (const l of laneGeom) {
    tracks.push(l.top + 6);
    for (let i = 1; i < laneRows.get(l.id); i++) tracks.push(l.top + CFG.lanePadY + i * CFG.rowH);
    tracks.push(l.top + l.h - 6);
  }

  const obstacles = () => new Map([...shapes].map(([id, s]) => [id, rect(s.x, s.y, s.w, s.h)]));
  const obs = obstacles();
  const usedIn = new Map(); // `${target}|side`
  const usedOut = new Map();
  const gapCount = new Map();
  const edgeStats = { crossings: 0, bends: 0, fallbacks: 0 };

  const C = (s) => ({ cx: s.x + s.w / 2, cy: s.y + s.h / 2 });

  function route(f) {
    const s = shapes.get(f.from), t = shapes.get(f.to);
    const sc = C(s), tc = C(t);
    const ignore = new Set([f.from, f.to]);
    const others = new Map([...obs].filter(([id]) => !ignore.has(id)));
    const sr = { x: s.x + s.w, y: sc.cy };
    const tl = { x: t.x, y: tc.cy };
    const cands = [];
    const isBack = back.has(f.id) || t.rank <= s.rank;
    if (!isBack) {
      if (Math.abs(sc.cy - tc.cy) < 1) cands.push({ pts: [sr, tl], out: 'r', in: 'l', pref: 0 });
      // H luego V hacia la cara superior/inferior del destino
      if (tc.cx > sr.x + 10 && Math.abs(sc.cy - tc.cy) >= 1) {
        const entry = sc.cy < tc.cy ? { x: tc.cx, y: t.y } : { x: tc.cx, y: t.y + t.h };
        cands.push({ pts: [sr, { x: tc.cx, y: sc.cy }, entry], out: 'r', in: sc.cy < tc.cy ? 't' : 'b', pref: 1 });
      }
      // V desde la cara superior/inferior del origen (compuertas) y H hacia la entrada izquierda
      if (s.kind === 'gateway' && tl.x > sc.cx + 10 && Math.abs(sc.cy - tc.cy) >= 1) {
        const exit = sc.cy > tc.cy ? { x: sc.cx, y: s.y } : { x: sc.cx, y: s.y + s.h };
        cands.push({ pts: [exit, { x: sc.cx, y: tc.cy }, tl], out: sc.cy > tc.cy ? 't' : 'b', in: 'l', pref: 1 });
      }
      // H-V-H por el canal anterior al destino
      const gk = `${t.rank - 1}`;
      const n = gapCount.get(gk) || 0;
      const xm = chanBefore(t.rank) - 0 + ((n % 4) - 1.5) * 9;
      cands.push({ pts: [sr, { x: xm, y: sc.cy }, { x: xm, y: tc.cy }, tl], out: 'r', in: 'l', pref: 2, gap: gk });
    }
    // desvíos por pistas horizontales (también para retrocesos)
    const xs = chanAfter(s.rank) - (isBack ? 0 : 0);
    const xt = isBack ? chanBefore(t.rank) : chanBefore(t.rank);
    const sorted = [...tracks].sort((a, b) => Math.abs(a - (sc.cy + tc.cy) / 2) - Math.abs(b - (sc.cy + tc.cy) / 2));
    for (const ty of sorted) {
      cands.push({ pts: [sr, { x: xs, y: sc.cy }, { x: xs, y: ty }, { x: xt, y: ty }, { x: xt, y: tc.cy }, tl], out: 'r', in: 'l', pref: 3 });
      if (s.kind === 'gateway' && !isBack && Math.abs(ty - sc.cy) > 1) {
        const ex = ty < sc.cy ? { x: sc.cx, y: s.y } : { x: sc.cx, y: s.y + s.h };
        cands.push({ pts: [ex, { x: sc.cx, y: ty }, { x: xt, y: ty }, { x: xt, y: tc.cy }, tl], out: ty < sc.cy ? 't' : 'b', in: 'l', pref: 2 });
      }
    }
    let best = null;
    for (const c of cands) {
      const pts = dedupe(c.pts);
      const hits = pathHits(pts, others);
      const portOut = `${f.from}|${c.out}`;
      const portIn = `${f.to}|${c.in}`;
      const clash = (usedOut.get(portOut) ? 1 : 0) + (usedIn.get(portIn) ? 1 : 0);
      const score = hits.length * 10000 + clash * 1500 + c.pref * 50 + bends(pts) * 10 + length(pts) / 100;
      if (!best || score < best.score) best = { pts, hits, score, c, portOut, portIn };
    }
    usedOut.set(best.portOut, true);
    usedIn.set(best.portIn, true);
    if (best.c.gap !== undefined) gapCount.set(best.c.gap, (gapCount.get(best.c.gap) || 0) + 1);
    if (best.hits.length) { edgeStats.crossings += best.hits.length; edgeStats.fallbacks++; warnings.push(`Flujo ${f.id} (${f.from} -> ${f.to}) cruza elementos: ${best.hits.join(', ')}`); }
    edgeStats.bends += bends(best.pts);
    return best.pts;
  }

  const flowEdges = new Map();
  // enruta primero las aristas de rango corto para reservar puertos
  const sortedFlows = [...flows].sort((a, b) => (rank.get(a.to) - rank.get(a.from)) - (rank.get(b.to) - rank.get(b.from)));
  for (const f of sortedFlows) flowEdges.set(f.id, { points: route(f) });
  for (const f of flows) {
    const e = flowEdges.get(f.id);
    if (f.name) {
      const p0 = e.points[0], p1 = e.points[1];
      const w = Math.max(24, Math.min(110, f.name.length * 6.5 + 6));
      const horizontal = p0.y === p1.y;
      e.label = horizontal ? rect(p0.x + 6, p0.y - 20, w, 14) : rect(p0.x + 4, p0.y + (p1.y > p0.y ? 4 : -18), w, 14);
    }
  }

  // ---- pools externos y flujos de mensaje ----
  const extGeom = [];
  let ey = poolRect.y + poolRect.h + CFG.externalGap;
  for (const ex of externals) {
    extGeom.push({ id: ex.id, x: CFG.poolX, y: ey, w: poolW, h: CFG.externalH });
    ey += CFG.externalH + CFG.externalGap / 2;
  }
  const extById = new Map(extGeom.map((g) => [g.id, g]));
  const messageEdges = new Map();
  const mfs = def.message_flows || [];
  const perAct = new Map();
  for (const m of mfs) {
    const actId = shapes.has(m.from) ? m.from : m.to;
    const outgoing = shapes.has(m.from);
    const extId = outgoing ? m.to : m.from;
    const s = shapes.get(actId);
    const ex = extById.get(extId);
    if (!s || !ex) { warnings.push(`Flujo de mensaje ${m.id} referencia elementos sin geometría`); continue; }
    const k = perAct.get(actId) || 0;
    perAct.set(actId, k + 1);
    const off = outgoing ? [-30, -45, -15] : [30, 45, 15];
    let best = null;
    for (const o of off) {
      const x = s.x + s.w / 2 + o;
      const pts = outgoing ? [{ x, y: s.y + s.h }, { x, y: ex.y }] : [{ x, y: ex.y }, { x, y: s.y + s.h }];
      const hits = pathHits(pts, new Map([...obs].filter(([id]) => id !== actId)));
      if (!best || hits.length < best.hits.length) best = { pts, hits };
      if (!hits.length) break;
    }
    if (best.hits.length) warnings.push(`Flujo de mensaje ${m.id} cruza elementos: ${best.hits.join(', ')}`);
    const w = Math.max(24, m.name ? m.name.length * 6.5 : 0);
    const lblX = (pts) => (outgoing ? pts[0].x - w - 4 : pts[0].x + 4);
    messageEdges.set(m.id, { points: best.pts, label: m.name ? rect(lblX(best.pts), (best.pts[0].y + best.pts[1].y) / 2 - 7, Math.min(w, 120), 14) : undefined });
  }

  // ---- asociaciones de datos ----
  const dataEdges = [];
  for (const r of dsRefs) {
    const t = shapes.get(r.activity), d = shapes.get(r.id);
    const x = t.x + t.w / 2;
    const pts = r.access === 'read' ? [{ x, y: d.y }, { x, y: t.y + t.h }] : [{ x, y: t.y + t.h }, { x, y: d.y }];
    dataEdges.push({ ...r, points: pts });
  }

  // ---- métricas ----
  const rectList = [...shapes.values()];
  let overlaps = 0;
  for (let i = 0; i < rectList.length; i++) for (let j = i + 1; j < rectList.length; j++) {
    const a = rectList[i], b = rectList[j];
    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) { overlaps++; warnings.push(`Superposición entre ${a.id} y ${b.id}`); }
  }
  const lastExt = extGeom.length ? extGeom[extGeom.length - 1] : null;
  const width = poolRect.x + poolRect.w + CFG.poolX;
  const height = (lastExt ? lastExt.y + lastExt.h : poolRect.y + poolRect.h) + CFG.poolY;

  const result = {
    pool: poolRect,
    lanes: hasLanes ? laneGeom : [],
    externals: extGeom,
    shapes,
    flowEdges,
    messageEdges,
    dataEdges,
    dsRefs,
    backFlows: back,
    size: { width, height },
    warnings,
    metrics: { nodes: nodes.size, overlaps, edge_crossings_with_nodes: edgeStats.crossings, fallback_routes: edgeStats.fallbacks, bends: edgeStats.bends, columns: nCols, lanes: laneGeom.length },
  };
  placeDiagramLabels(result, def);
  return result;
}

// Una sola distribución de etiquetas para BPMN DI y XPDL nativo. Reserva las
// etiquetas ya ubicadas: comprobar únicamente figuras no evita texto sobre texto.
export function placeDiagramLabels(layout, def) {
  const occupied = [];
  const boxesOverlap = (a, b, pad = 3) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
  const shapes = [...layout.shapes.values()];
  const edges = [...layout.flowEdges.values(), ...layout.messageEdges.values(), ...layout.dataEdges];
  const choose = (candidates, path = null) => {
    let best = null, score = Infinity;
    for (const [i, r] of candidates.entries()) {
      if (r.x < 0 || r.y < 0) continue;
      const hits = shapes.filter((s) => boxesOverlap(r, s)).length + occupied.filter((s) => boxesOverlap(r, s)).length;
      const crossing = edges.filter((e) => pathHits(e.points, new Map([['text', r]])).length).length;
      // Las etiquetas de flechas deben seguir siendo atribuibles a su línea:
      // no enviarlas muy lejos sólo por evitar un cruce de texto con otra arista.
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      const distance = path ? Math.min(...path.slice(1).map((b, j) => {
        const a = path[j];
        return Math.hypot(cx - Math.max(Math.min(a.x, b.x), Math.min(cx, Math.max(a.x, b.x))), cy - Math.max(Math.min(a.y, b.y), Math.min(cy, Math.max(a.y, b.y))));
      })) : 0;
      const cost = hits * 100000 + crossing * (path ? 100 : 1000) + distance * 4 + i;
      if (cost < score) { best = r; score = cost; }
       if (!path && !hits && !crossing) break;
    }
    const pick = best ?? candidates[0];
    occupied.push(pick);
    return pick;
  };
  layout.nodeLabels = new Map();
  const named = [...def.events, ...def.decisions].map((n) => ({ id: n.id, name: n.name }));
  for (const ref of layout.dsRefs) named.push({ id: ref.id, name: def.participants.find((p) => p.id === ref.store)?.name });
  for (const n of named) {
    if (!n.name) continue;
    const s = layout.shapes.get(n.id), lines = labelLines(n.name, 22);
    const w = Math.max(40, Math.min(170, Math.max(...lines.map((l) => l.length)) * 6 + 8)), h = 13 * lines.length + 2;
    const cx = s.x + s.w / 2;
    const candidates = [];
    for (const gap of [4, 12, 24, 40, 64, 96]) {
      const above = rect(cx - w / 2, s.y - h - gap, w, h), below = rect(cx - w / 2, s.y + s.h + gap, w, h);
      candidates.push(...(s.kind === 'gateway' ? [above, below] : [below, above]), rect(s.x + s.w + gap, s.y + s.h / 2 - h / 2, w, h), rect(s.x - w - gap, s.y + s.h / 2 - h / 2, w, h));
    }
    layout.nodeLabels.set(n.id, choose(candidates));
  }
  for (const [defs, edgeMap] of [[def.flows, layout.flowEdges], [def.message_flows ?? [], layout.messageEdges]]) {
    for (const f of defs) {
      const e = edgeMap.get(f.id);
      if (!f.name || !e) continue;
      const lines = labelLines(f.name, 22), w = Math.max(24, Math.min(170, Math.max(...lines.map((l) => l.length)) * 6.5 + 6)), h = 14 * lines.length;
      const candidates = [];
      for (const gap of [6, 14, 26, 42, 66, 98]) for (let i = 1; i < e.points.length; i++) {
        const a = e.points[i - 1], b = e.points[i], horizontal = a.y === b.y;
        for (const t of [0.5, 0.25, 0.75]) {
          const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
          candidates.push(...(horizontal ? [rect(x - w / 2, y - h - gap, w, h), rect(x - w / 2, y + gap, w, h)] : [rect(x + gap, y - h / 2, w, h), rect(x - w - gap, y - h / 2, w, h)]));
        }
      }
       e.label = choose(candidates, e.points);
    }
  }
  const pairs = occupied.flatMap((a, i) => occupied.slice(i + 1).filter((b) => boxesOverlap(a, b, 0)));
  layout.metrics.label_overlaps = pairs.length;
  if (pairs.length) layout.warnings.push(`Persisten ${pairs.length} solapes entre etiquetas; revisar la presentación.`);
  layout.size.width = Math.max(layout.size.width, ...occupied.map((r) => r.x + r.w + 20));
  layout.size.height = Math.max(layout.size.height, ...occupied.map((r) => r.y + r.h + 20));
}
