// Estado de entrega por proceso: FINAL solo si el modelo, los nombres y la documentación están completos.
// Un BORRADOR se conserva para diagnóstico, pero no se publica con el nombre de un entregable aprobado.
import fs from 'node:fs';
import path from 'node:path';
import { checkNameQuality, textIssues } from './validation/name-quality.mjs';

const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);

export function evaluateProcessQuality(work, processId) {
  const reasons = [];
  const dir = (n) => path.join(work, n);
  const viewDir = fs.existsSync(path.join(dir('functional'), `${processId}.process.json`)) ? 'functional' : 'diagrams';
  const view = readJson(path.join(dir(viewDir), `${processId}.process.json`));
  if (!view) return { process_id: processId, status: 'BORRADOR', reasons: [{ code: 'SIN_MODELO', message: 'No existe la definición del diagrama.' }] };
  const names = checkNameQuality(view);
  for (const i of names.issues) reasons.push({ code: i.code, element_id: i.element_id, message: `${i.kind} «${i.name}»: ${i.message}` });
  const bpmnFile = path.join(dir(viewDir), `${processId}.bpmn`);
  if (fs.existsSync(bpmnFile) && textIssues(fs.readFileSync(bpmnFile, 'utf8')).some((i) => i.code === 'CODIFICACION_DANADA')) reasons.push({ code: 'CODIFICACION_DANADA', message: 'El BPMN contiene caracteres con codificación dañada.' });
  const validation = readJson(path.join(dir('reports'), `${processId}.validation.json`));
  if (!validation || validation.approval !== 'APROBADO') reasons.push({ code: 'VALIDACION_NO_APROBADA', message: 'El BPMN no tiene una validación aprobada.' });
  const review = readJson(path.join(dir('reports'), `${processId}.review.json`));
  if (review?.verdict === 'RECHAZADO') reasons.push({ code: 'REVISION_RECHAZADA', message: 'La revisión determinista rechazó el modelo.' });
  const act = readJson(path.join(dir('documents'), `${processId}.latest.json`));
  if (!act) reasons.push({ code: 'DOCUMENTACION_AUSENTE', message: 'No existe el Word de actividades.' });
  else if (act.content_status !== 'DOCUMENTADO_CON_EVIDENCIA') reasons.push({ code: 'DOCUMENTACION_INCOMPLETA', message: `Word de actividades con contenido ${act.content_status}: faltan fichas con evidencia (activity-documentation.json).` });
  const gen = readJson(path.join(dir('documents'), `${processId}.explicacion-general.latest.json`));
  if (!gen) reasons.push({ code: 'EXPLICACION_AUSENTE', message: 'No existe el Word de explicación general.' });
  else if (gen.content_status !== 'DOCUMENTADO_CON_EVIDENCIA' || (gen.missing_narrative || []).length) reasons.push({ code: 'EXPLICACION_INCOMPLETA', message: `Explicación general incompleta${(gen.missing_narrative || []).length ? ` (falta: ${gen.missing_narrative.join(', ')})` : ''}: redacte process-explanation.json.` });
  return { process_id: processId, status: reasons.length ? 'BORRADOR' : 'FINAL', reasons };
}

export function evaluateProjectQuality(work) {
  const processes = new Set();
  for (const sub of ['functional', 'diagrams']) {
    const d = path.join(work, sub);
    if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) if (/\.process\.json$/.test(f)) processes.add(f.replace(/\.process\.json$/, ''));
  }
  const list = [...processes].sort().map((p) => evaluateProcessQuality(work, p));
  if (!list.length) return { status: 'BORRADOR', processes: [{ process_id: null, status: 'BORRADOR', reasons: [{ code: 'SIN_MODELO', message: 'No hay modelos para publicar.' }] }] };
  const status = list.every((p) => p.status === 'FINAL') ? 'FINAL' : 'BORRADOR';
  return { status, processes: list };
}
