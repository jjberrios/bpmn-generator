// Disposición de salidas: los intermedios viven en workspace/<id>/_intermedios y
// outputs/<id>/ contiene únicamente el .bpm, los .bpmn y los Word.
import fs from 'node:fs';
import path from 'node:path';

export const INTERMEDIATE = '_intermedios';

export function workDir(root, projectId) {
  return path.join(root, 'workspace', projectId, INTERMEDIATE);
}

const list = (dir, re) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f)) : []);

// Publica los archivos limpios (sin subcarpetas ni intermedios). Si existe la vista
// por actividades (functional/) sus .bpmn sustituyen a los del detalle técnico (diagrams/).
export function publishDeliverables(root, projectId) {
  const work = workDir(root, projectId);
  const out = path.join(root, 'outputs', projectId);
  fs.mkdirSync(out, { recursive: true });
  const functional = list(path.join(work, 'functional'), /\.bpmn$/);
  const bpmn = functional.length ? functional : list(path.join(work, 'diagrams'), /\.bpmn$/);
  const wanted = [
    ...bpmn,
    ...list(path.join(work, 'delivery'), /\.bpm$/),
    ...list(path.join(work, 'documents'), /\.docx$/),
  ];
  const names = new Set(wanted.map((f) => path.basename(f)));
  for (const entry of fs.readdirSync(out, { withFileTypes: true })) {
    const full = path.join(out, entry.name);
    if (entry.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
    else if (!names.has(entry.name)) fs.rmSync(full, { force: true });
  }
  for (const f of wanted) fs.copyFileSync(f, path.join(out, path.basename(f)));
  return [...names].sort().map((n) => `outputs/${projectId}/${n}`);
}
