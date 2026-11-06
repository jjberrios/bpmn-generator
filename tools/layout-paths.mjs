// Disposición de salidas: los intermedios viven en workspace/<id>/_intermedios y
// outputs/<id>/ contiene únicamente el .bpm, los .bpmn y los Word.
import fs from 'node:fs';
import path from 'node:path';
import { evaluateProjectQuality } from './quality.mjs';

export const INTERMEDIATE = '_intermedios';
export const DRAFT_PREFIX = 'BORRADOR_';

export function workDir(root, projectId) {
  return path.join(root, 'workspace', projectId, INTERMEDIATE);
}

const list = (dir, re) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f)) : []);

// Publica los archivos limpios (sin subcarpetas ni intermedios). Si existe la vista
// por actividades (functional/) sus .bpmn sustituyen a los del detalle técnico (diagrams/).
// Si la calidad no es FINAL (nombres técnicos, codificación dañada, Word incompleto...) los archivos se
// publican con el prefijo BORRADOR_ y el motivo queda en _intermedios/reports/calidad-entrega.json.
export function publishDeliverables(root, projectId) {
  const work = workDir(root, projectId);
  const out = path.join(root, 'outputs', projectId);
  fs.mkdirSync(out, { recursive: true });
  const quality = evaluateProjectQuality(work);
  fs.mkdirSync(path.join(work, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(work, 'reports', 'calidad-entrega.json'), JSON.stringify(quality, null, 2), 'utf8');
  const functional = list(path.join(work, 'functional'), /\.bpmn$/);
  const bpmn = functional.length ? functional : list(path.join(work, 'diagrams'), /\.bpmn$/);
  const prefix = quality.status === 'FINAL' ? '' : DRAFT_PREFIX;
  const wanted = [
    ...bpmn,
    ...list(path.join(work, 'delivery'), /\.bpm$/),
    ...list(path.join(work, 'documents'), /\.docx$/),
  ].map((f) => ({ from: f, name: `${prefix}${path.basename(f)}` }));
  const names = new Set(wanted.map((f) => f.name));
  for (const entry of fs.readdirSync(out, { withFileTypes: true })) {
    const full = path.join(out, entry.name);
    if (entry.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
    else if (!names.has(entry.name)) fs.rmSync(full, { force: true });
  }
  for (const f of wanted) fs.copyFileSync(f.from, path.join(out, f.name));
  const published = [...names].sort().map((n) => `outputs/${projectId}/${n}`);
  published.quality = quality;
  return published;
}
