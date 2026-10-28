// Vista previa SVG renderizada a partir del XML BPMN exportado (usa el BPMN DI, no el modelo intermedio).
import { BpmnModdle } from 'bpmn-moddle';
import { labelLines } from './layout.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function textBlock(lines, cx, cy, lineH = 13, extra = '') {
  const y0 = cy - ((lines.length - 1) * lineH) / 2;
  return `<text text-anchor="middle" font-size="11" font-family="Arial, sans-serif" ${extra}>` +
    lines.map((l, i) => `<tspan x="${cx}" y="${y0 + i * lineH + 4}">${esc(l)}</tspan>`).join('') + '</text>';
}

export async function renderSvg(xml) {
  const moddle = new BpmnModdle();
  const { rootElement } = await moddle.fromXML(xml);
  const diagram = rootElement.diagrams?.[0];
  if (!diagram) throw new Error('El BPMN no contiene BPMNDiagram: no se puede renderizar');
  const els = diagram.plane.planeElement || [];
  const shapes = els.filter((e) => e.$type === 'bpmndi:BPMNShape');
  const edges = els.filter((e) => e.$type === 'bpmndi:BPMNEdge');
  let maxX = 0, maxY = 0;
  for (const s of shapes) { maxX = Math.max(maxX, s.bounds.x + s.bounds.width); maxY = Math.max(maxY, s.bounds.y + s.bounds.height); }
  for (const e of edges) for (const p of e.waypoint || []) { maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  const W = maxX + 40, H = maxY + 40;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  out.push('<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#222"/></marker>' +
    '<marker id="arrm" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#fff" stroke="#222"/></marker></defs>');
  out.push(`<rect width="${W}" height="${H}" fill="#fff"/>`);

  const isContainer = (t) => t === 'bpmn:Participant' || t === 'bpmn:Lane';
  const sorted = [...shapes].sort((a, b) => (isContainer(b.bpmnElement.$type) ? 1 : 0) - (isContainer(a.bpmnElement.$type) ? 1 : 0));
  for (const s of sorted) {
    const el = s.bpmnElement, b = s.bounds, t = el.$type, name = el.name || '';
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    out.push(`<g data-bpmn-id="${esc(el.id)}">`);
    if (t === 'bpmn:Participant' || t === 'bpmn:Lane') {
      out.push(`<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" fill="${t === 'bpmn:Lane' ? '#fff' : '#fafafa'}" stroke="#222"/>`);
      const hdr = t === 'bpmn:Participant' && b.height > 100 ? 30 : t === 'bpmn:Participant' ? 0 : 30;
      if (hdr || b.height <= 100) {
        const h = hdr || b.height;
        if (hdr) out.push(`<line x1="${b.x + hdr}" y1="${b.y}" x2="${b.x + hdr}" y2="${b.y + b.height}" stroke="#222"/>`);
        const maxCh = Math.max(8, Math.floor((b.height - 10) / 6.5));
        const ls = labelLines(name, Math.max(maxCh, Math.ceil(name.length / 2) + 2));
        const gx = b.x + (hdr ? hdr / 2 : 18);
        out.push(`<g transform="translate(${gx},${cy}) rotate(-90)">` + textBlock(ls, 0, 0, 13, 'font-weight="bold"') + '</g>');
        void h;
      }
    } else if (t.endsWith('Event')) {
      const end = t === 'bpmn:EndEvent', start = t === 'bpmn:StartEvent';
      out.push(`<circle cx="${cx}" cy="${cy}" r="${b.width / 2 - 1}" fill="${end ? '#fde' : start ? '#dfd' : '#ffd'}" stroke="#222" stroke-width="${end ? 3 : 1.5}"/>`);
      const def = el.eventDefinitions?.[0]?.$type;
      if (def === 'bpmn:ErrorEventDefinition') out.push(`<path d="M${cx - 6},${cy + 6} L${cx - 3},${cy - 6} L${cx + 2},${cy + 1} L${cx + 6},${cy - 6}" fill="none" stroke="#222" stroke-width="1.5"/>`);
      if (def === 'bpmn:MessageEventDefinition') out.push(`<rect x="${cx - 7}" y="${cy - 5}" width="14" height="10" fill="none" stroke="#222"/><path d="M${cx - 7},${cy - 5} L${cx},${cy + 1} L${cx + 7},${cy - 5}" fill="none" stroke="#222"/>`);
      if (def === 'bpmn:TerminateEventDefinition') out.push(`<circle cx="${cx}" cy="${cy}" r="8" fill="#222"/>`);
      if (def === 'bpmn:TimerEventDefinition') out.push(`<circle cx="${cx}" cy="${cy}" r="9" fill="none" stroke="#222"/><path d="M${cx},${cy - 6} L${cx},${cy} L${cx + 4},${cy + 2}" fill="none" stroke="#222"/>`);
    } else if (t.endsWith('Gateway')) {
      out.push(`<polygon points="${cx},${b.y} ${b.x + b.width},${cy} ${cx},${b.y + b.height} ${b.x},${cy}" fill="#ffe9b3" stroke="#222" stroke-width="1.5"/>`);
      if (t === 'bpmn:ExclusiveGateway') out.push(`<path d="M${cx - 9},${cy - 9} L${cx + 9},${cy + 9} M${cx + 9},${cy - 9} L${cx - 9},${cy + 9}" stroke="#222" stroke-width="3"/>`);
      if (t === 'bpmn:ParallelGateway') out.push(`<path d="M${cx - 11},${cy} L${cx + 11},${cy} M${cx},${cy - 11} L${cx},${cy + 11}" stroke="#222" stroke-width="3"/>`);
      if (t === 'bpmn:InclusiveGateway') out.push(`<circle cx="${cx}" cy="${cy}" r="10" fill="none" stroke="#222" stroke-width="3"/>`);
    } else if (t === 'bpmn:DataStoreReference') {
      out.push(`<path d="M${b.x},${b.y + 8} v${b.height - 16} a${b.width / 2},8 0 0 0 ${b.width},0 v-${b.height - 16}" fill="#eef" stroke="#222"/><ellipse cx="${cx}" cy="${b.y + 8}" rx="${b.width / 2}" ry="8" fill="#eef" stroke="#222"/>`);
    } else {
      const fill = t === 'bpmn:ServiceTask' ? '#e6f0ff' : '#f2f2f2';
      out.push(`<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="8" fill="${fill}" stroke="#222" stroke-width="1.5"/>`);
      if (t === 'bpmn:ServiceTask') out.push(`<text x="${b.x + 6}" y="${b.y + 14}" font-size="10" font-family="Arial, sans-serif">⚙</text>`);
      out.push(textBlock(labelLines(name, 18), cx, cy));
    }
    if (!isContainer(t) && !t.endsWith('Task') && !t.endsWith('SubProcess') && name) {
      const lb = s.label?.bounds;
      const lines = labelLines(name, 24);
      if (lb) out.push(textBlock(lines, lb.x + lb.width / 2, lb.y + 4 + ((lines.length - 1) * 13) / 2, 13));
      else out.push(textBlock(lines, cx, b.y + b.height + 14, 13));
    }
    out.push('</g>');
  }
  for (const e of edges) {
    const el = e.bpmnElement; const pts = e.waypoint || [];
    if (pts.length < 2) continue;
    const t = el.$type;
    const dash = t === 'bpmn:MessageFlow' ? ' stroke-dasharray="8,4"' : (t.startsWith('bpmn:Data') ? ' stroke-dasharray="3,3"' : '');
    const marker = t === 'bpmn:MessageFlow' ? 'url(#arrm)' : 'url(#arr)';
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
    out.push(`<path data-bpmn-id="${esc(el.id)}" d="${d}" fill="none" stroke="#222" stroke-width="1.3"${dash} marker-end="${marker}"/>`);
    if (el.name) {
      const lb = e.label?.bounds;
      const mid = pts[Math.floor((pts.length - 1) / 2)], nxt = pts[Math.floor((pts.length - 1) / 2) + 1];
      const lx = lb ? lb.x + lb.width / 2 : (mid.x + nxt.x) / 2;
      const ly = lb ? lb.y + lb.height / 2 : (mid.y + nxt.y) / 2 - 6;
      out.push(`<text x="${lx}" y="${ly + 4}" text-anchor="middle" font-size="10" font-family="Arial, sans-serif" paint-order="stroke" stroke="#fff" stroke-width="3">${esc(el.name)}</text>`);
    }
  }
  out.push('</svg>');
  return { svg: out.join('\n'), width: W, height: H };
}
