// Explicación funcional: únicamente del modelo final y de la interpretación documentada del código.
import fs from 'node:fs';
import path from 'node:path';
import { workDir } from '../layout-paths.mjs';
import { createHash } from 'node:crypto';
import { buildNarrativeDocx, validateActivityDocx, currentActivityWord } from './activity-word.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const clean = (name) => name.replace(/^\d+\.\s*/, '');
function locations(projectId, processId, root) {
  if (![projectId, processId].every((id) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id))) throw new Error('Identificador inválido.');
  return {
    base: path.join(workDir(root, projectId), 'diagrams', processId),
    folder: path.join(workDir(root, projectId), 'documents'),
    narrative: path.join(root, 'workspace', projectId, 'processes', processId, 'process-explanation.json'),
  };
}
export function generalSections(def, narrative = {}) {
  const text = (key, fallback) => {
    if (narrative[key] !== undefined && (typeof narrative[key] !== 'string' || !narrative[key].trim())) throw new Error(`Explicación general: ${key} debe ser texto no vacío.`);
    return narrative[key] || fallback;
  };
  const ordered = [...def.activities].sort((a, b) => (parseInt(a.name, 10) || 0) - (parseInt(b.name, 10) || 0));
  const steps = narrative.steps || {};
  for (const [id, value] of Object.entries(steps)) if (!ordered.some(a => a.id === id) || typeof value !== 'string' || !value.trim()) throw new Error(`Etapa general inválida: ${id}`);
  const decisions = def.decisions || [];
  const results = def.outcomes || [];
  const data = ordered.filter(a => a.data_access?.length);
  return [
    { title: 'Descripción general del proceso', paragraphs: [text('purpose', `El proceso comprende las siguientes funciones: ${ordered.map(a => clean(a.name)).join(', ')}.`)] },
    { title: 'Inicio y entradas principales', paragraphs: [text('entry', `El proceso comienza con ${def.events.find(e => e.type === 'start')?.name || 'la solicitud de entrada'}. Las entradas no descritas en el modelo deben consultarse en el documento de actividades.`)] },
    { title: 'Cómo funciona el proceso', paragraphs: ordered.map(a => `${a.name}: ${steps[a.id] || `El servicio realiza la actividad «${clean(a.name)}» en la etapa correspondiente del flujo.`}`) },
    { title: 'Decisiones y resultados', paragraphs: [text('decisions', decisions.length ? `El flujo se dirige según las siguientes comprobaciones: ${decisions.map(d => d.name).join('; ')}. Las conexiones del BPMN determinan qué etapa se ejecuta en cada caso.` : 'El modelo no contiene decisiones explícitas.'), ...results.map(o => `• ${def.events.find(e => e.id === o.event_id)?.name || o.name}`)] },
    { title: 'Sistemas y datos utilizados', paragraphs: [text('systems', data.length ? `El acceso a datos está representado por ${data.map(a => `«${clean(a.name)}»`).join(', ')}. El modelo no permite deducir efectos internos adicionales de esos sistemas.` : 'Las actividades de esta vista no declaran accesos a almacenes de datos. Esto no demuestra ausencia de otras integraciones en el código.')] },
    { title: 'Qué hace el código', paragraphs: [text('implementation', `El código implementa las etapas representadas en el BPMN y sus rutas de respuesta. El documento de actividades conserva las entradas, salidas y transformaciones verificadas; esta explicación presenta su funcionamiento a nivel general, sin reproducir métodos ni parámetros técnicos.`)] },
  ];
}
export function generateGeneralWord(projectId, processId, { root } = {}) {
  const p = locations(projectId, processId, root);
  const activity = currentActivityWord(projectId, processId, { root });
  if (activity.approval !== 'APROBADO') throw new Error('Explicación general bloqueada: primero se requiere el Word de actividades vigente.');
  const def = read(`${p.base}.process.json`);
  const narrative = fs.existsSync(p.narrative) ? read(p.narrative) : {};
  const latestFile = path.join(p.folder, `${processId}.explicacion-general.latest.json`);
  if (fs.existsSync(p.narrative) && fs.existsSync(latestFile)) {
    const previous = read(latestFile);
    if (previous.narrative_sha256 === sha(JSON.stringify(narrative)) && JSON.stringify(previous.evidence_sha256) !== JSON.stringify(activity.evidence_sha256)) throw new Error('Las fuentes cambiaron: revise process-explanation.json antes de regenerar la explicación general.');
  }
  const sections = generalSections(def, narrative);
  const bytes = buildNarrativeDocx(sections);
  validateActivityDocx(bytes, 0);
  let file = path.join(p.folder, `${processId}.explicacion-general.docx`);
  try { fs.writeFileSync(file, bytes); } catch (e) {
    if (!['EBUSY', 'EACCES', 'EPERM'].includes(e.code)) throw e;
    file = path.join(p.folder, `${processId}.explicacion-general.actualizado.docx`);
    fs.writeFileSync(file, bytes);
  }
  const result = {
    approval: 'APROBADO', content_status: activity.content_status,
    file: path.relative(root, file).split(path.sep).join('/'), sha256: sha(bytes),
    activity_word_sha256: activity.sha256, bpmn_sha256: activity.bpmn_sha256,
    definition_sha256: activity.definition_sha256, evidence_sha256: activity.evidence_sha256,
    narrative_sha256: sha(JSON.stringify(narrative)), activities: def.activities.map(a => ({ id: a.id, name: a.name })),
    checks: ['Paquete DOCX y XML bien formados', 'Sin relaciones externas', 'Etapas del BPMN final', 'Vinculación a Word de actividades y fuentes vigentes'],
    limitation: 'La validación estructural no demuestra fidelidad semántica ni comprueba la apariencia en Microsoft Word.',
  };
  fs.writeFileSync(latestFile, JSON.stringify({ ...result, sections }, null, 2));
  return result;
}
export function currentGeneralWord(projectId, processId, { root } = {}) {
  const p = locations(projectId, processId, root);
  const file = path.join(p.folder, `${processId}.explicacion-general.latest.json`);
  if (!fs.existsSync(file)) return { approval: 'PENDIENTE' };
  const result = read(file);
  const activity = currentActivityWord(projectId, processId, { root });
  const doc = path.resolve(root, result.file);
  const relative = path.relative(p.folder, doc);
  if (activity.approval !== 'APROBADO' || activity.sha256 !== result.activity_word_sha256 || activity.bpmn_sha256 !== result.bpmn_sha256 || activity.definition_sha256 !== result.definition_sha256 || sha(JSON.stringify(fs.existsSync(p.narrative) ? read(p.narrative) : {})) !== result.narrative_sha256 || relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(doc) || sha(fs.readFileSync(doc)) !== result.sha256) return { approval: 'DESACTUALIZADO' };
  return result;
}
