// WordprocessingML editable: tablas inspiradas en inputs/references/word, sin ejecutar fuentes.
import fs from 'node:fs';
import path from 'node:path';
import { workDir } from '../layout-paths.mjs';
import { createHash } from 'node:crypto';
import { zipSync, strToU8, unzipSync, strFromU8 } from 'fflate';
import { XMLValidator, XMLParser } from 'fast-xml-parser';

const NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const UNKNOWN = 'No determinado con la información disponible.';
const esc = (s) => String(s ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sha = (b) => createHash('sha256').update(b).digest('hex');
function paragraph(text = '', { bold = false, center = false, after = 0, size = 18, keep = false } = {}) {
  return `<w:p><w:pPr><w:spacing w:after="${after}" w:line="240" w:lineRule="auto"/>${center ? '<w:jc w:val="center"/>' : ''}${keep ? '<w:keepNext/>' : ''}</w:pPr><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="${size}"/>${bold ? '<w:b/>' : ''}</w:rPr>${String(text).split('\n').map((s, i) => `${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${esc(s)}</w:t>`).join('')}</w:r></w:p>`;
}
function cell(text, width, { gray = false, bold = false, center = false } = {}) {
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${gray ? '<w:shd w:fill="D9D9D9" w:val="clear"/>' : ''}<w:vAlign w:val="center"/></w:tcPr>${paragraph(text, { bold, center })}</w:tc>`;
}
function table(rows, widths, { header = false, labels = false } = {}) {
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:color="000000"/>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="10466" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${borders}</w:tblBorders><w:tblCellMar><w:top w:w="45" w:type="dxa"/><w:left w:w="55" w:type="dxa"/><w:bottom w:w="45" w:type="dxa"/><w:right w:w="55" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${rows.map((r, ri) => `<w:tr><w:trPr><w:trHeight w:val="300" w:hRule="atLeast"/>${header && !ri ? '<w:tblHeader/>' : ''}</w:trPr>${r.map((s, ci) => cell(s, widths[ci], { gray: (header && !ri) || (labels && !ci), bold: (header && !ri) || (labels && !ci), center: header && !ri })).join('')}</w:tr>`).join('')}</w:tbl>`;
}
const gap = () => paragraph('', { after: 180, size: 10 });
const block = (title, text) => table([[title], [text || UNKNOWN]], [10466], { header: true });

export function buildNarrativeDocx(sections) {
  const entries = unzipSync(buildActivityDocx({ activities: [], evidence: [] }).bytes);
  const body = sections.map(({ title, paragraphs }) => `${paragraph(title, { bold: true, size: 26, after: 160, keep: true })}${paragraphs.map((text) => paragraph(text, { size: 22, after: 140 })).join('')}`).join('');
  entries['word/document.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${NS}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000"/></w:sectPr></w:body></w:document>`);
  return zipSync(entries);
}

export function buildActivityDocx(definition, annotations = {}) {
  const known = new Set(definition.activities.map((a) => a.id));
  for (const id of Object.keys(annotations.activities || {})) if (!known.has(id)) throw new Error(`Ficha de actividad inexistente: ${id}`);
  const ordered = [...definition.activities].sort((a, b) => {
    const na = a.name.match(/^(\d+)\./), nb = b.name.match(/^(\d+)\./);
    return na && nb ? Number(na[1]) - Number(nb[1]) : 0;
  });
  const fichas = ordered.map((a) => {
    const d = annotations.activities?.[a.id];
    if (d) {
      for (const key of ['type', 'operation', 'location', 'considerations', 'properties', 'query']) if (typeof d[key] !== 'string') throw new Error(`Ficha ${a.id}: ${key} debe ser texto.`);
      for (const key of ['input', 'output']) if (!Array.isArray(d[key]) || d[key].some((r) => !Array.isArray(r) || r.length !== 4 || r.some((v) => typeof v !== 'string'))) throw new Error(`Ficha ${a.id}: ${key} debe tener filas de cuatro textos.`);
      if (!Array.isArray(d.evidence) || !d.evidence.length) throw new Error(`Ficha ${a.id}: faltan evidencias.`);
    }
    return { activity_id: a.id, name: a.name, status: d ? 'INFERIDA' : 'DESCONOCIDA',
      type: d?.type || (a.data_access?.length ? 'Actividad de acceso a datos' : 'Actividad del servicio'),
      operation: d?.operation || a.description || UNKNOWN, location: d?.location || UNKNOWN,
      input: d?.input || [['No determinado', 'No determinado', '-', UNKNOWN]],
      output: d?.output || [['No determinado', 'No determinado', '-', UNKNOWN]],
      considerations: d?.considerations || UNKNOWN, properties: d?.properties || UNKNOWN, query: d?.query || UNKNOWN,
      evidence: d?.evidence || definition.evidence.filter((e) => a.evidence_ids.includes(e.id)) };
  });
  const sections = fichas.map((d, i) => `${i ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' : ''}${paragraph(d.name, { after: 80, keep: true })}${table([
    ['Tipo', d.type], ['Nombre', d.name], ['Operación', d.operation], ['URL / TNSNAMES / JNDI', d.location],
  ], [1800, 8666], { labels: true })}${gap()}${table([['INPUT', 'Origen', 'Destino', 'Transformación'], ...d.input], [1800, 1650, 1530, 5486], { header: true })}${gap()}${table([['OUTPUT', 'Tipo', 'Destino', 'Transformación'], ...d.output], [2300, 1100, 1580, 5486], { header: true })}${gap()}${block('CONSIDERACIONES', d.considerations)}${gap()}${block('VARIABLES PROPERTIES', d.properties)}${gap()}${block('Query - Script', d.query)}`).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${NS}"><w:body>${sections}<w:p/><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="540" w:right="720" w:bottom="540" w:left="720" w:header="240" w:footer="240"/></w:sectPr></w:body></w:document>`;
  const bytes = zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(xml),
  });
  return { bytes, fichas };
}

export function validateActivityDocx(bytes, activityCount) {
  const entries = unzipSync(bytes);
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']) {
    if (!entries[name]) throw new Error(`DOCX incompleto: ${name}`);
    const result = XMLValidator.validate(strFromU8(entries[name]));
    if (result !== true) throw new Error(`XML DOCX inválido: ${name}`);
  }
  const text = strFromU8(entries['word/document.xml']);
  if ((text.match(/<w:tbl>/g) || []).length !== activityCount * 6) throw new Error('Cantidad de tablas incorrecta.');
  if (/TargetMode="External"|<!DOCTYPE|<!ENTITY/i.test(Object.values(entries).map((b) => strFromU8(b)).join(''))) throw new Error('Contenido externo no permitido.');
  return { approval: 'APROBADO', activities: activityCount, tables: activityCount * 6, checks: ['Paquete OPC mínimo', 'XML bien formado', 'Seis tablas por actividad', 'Sin relaciones externas'], limitation: 'No comprueba paginación ni coincidencia visual en Microsoft Word.' };
}

export function generateActivityWord(projectId, processId, { root, definition } = {}) {
  const safe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
  if (!safe.test(projectId) || !safe.test(processId)) throw new Error('Identificador de proyecto/proceso inválido.');
  const base = path.join(workDir(root, projectId), 'diagrams', processId);
  const def = definition || JSON.parse(fs.readFileSync(`${base}.process.json`, 'utf8'));
  if (fs.existsSync(`${base}.bpmn`)) {
    const tasks = [];
    const visit = (obj) => {
      for (const [key, value] of Object.entries(obj || {})) {
        if (!value || typeof value !== 'object') continue;
        for (const node of Array.isArray(value) ? value : [value]) {
          if (/^(?:\w+:)?(?:task|\w+Task)$/.test(key)) tasks.push({ id: node['@_id'], name: node['@_name'] });
          visit(node);
        }
      }
    };
    // processEntities:false + decodificación en una sola pasada: bpmn-moddle serializa «&», «>» como &#38;/&#62;
    // y el parser por defecto no decodifica entidades numéricas, lo que rompía la comparación de nombres.
    const named = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
    const decode = (s) => (typeof s === 'string' ? s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : named[e])) : s);
    visit(new XMLParser({ ignoreAttributes: false, processEntities: false }).parse(fs.readFileSync(`${base}.bpmn`, 'utf8')));
    for (const t of tasks) t.name = decode(t.name);
    if (tasks.length !== def.activities.length || def.activities.some((a) => !tasks.some((t) => t.id === a.id && t.name === a.name))) throw new Error('Las fichas no corresponden a las actividades del BPMN final.');
  }
  if (!definition) {
    const reports = path.join(workDir(root, projectId), 'reports');
    const validation = JSON.parse(fs.readFileSync(path.join(reports, `${processId}.validation.json`), 'utf8'));
    const review = JSON.parse(fs.readFileSync(path.join(reports, `${processId}.review.json`), 'utf8'));
    if (validation.approval !== 'APROBADO' || review.verdict === 'RECHAZADO') throw new Error('Word bloqueado: el BPMN requiere validación aprobada y revisión no rechazada.');
  }
  const annotationsFile = path.join(root, 'workspace', projectId, 'processes', processId, 'activity-documentation.json');
  const annotations = fs.existsSync(annotationsFile) ? JSON.parse(fs.readFileSync(annotationsFile, 'utf8')) : {};
  const source = fs.realpathSync(path.join(root, 'workspace', projectId, 'source'));
  const evidenceHashes = {};
  for (const d of Object.values(annotations.activities || {})) for (const e of d.evidence || []) {
    if (typeof e.file !== 'string' || path.isAbsolute(e.file) || e.file.includes('\\') || e.file.split('/').some((s) => s === '..' || s.includes(':'))) throw new Error('Ruta de evidencia no permitida.');
    const file = fs.realpathSync(path.join(source, e.file));
    if (!file.startsWith(source + path.sep)) throw new Error('Evidencia fuera de source.');
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    evidenceHashes[e.file] = sha(fs.readFileSync(file));
    if (!Number.isInteger(e.line_start) || !Number.isInteger(e.line_end) || e.line_start < 1 || e.line_end < e.line_start || e.line_end > lines.length) throw new Error(`Rango de evidencia inválido: ${e.file}`);
  }
  const { bytes, fichas } = buildActivityDocx(def, annotations);
  const validation = validateActivityDocx(bytes, def.activities.length);
  const folder = path.join(workDir(root, projectId), 'documents');
  fs.mkdirSync(folder, { recursive: true });
  const annotationsHash = sha(JSON.stringify(annotations));
  const latestFile = path.join(folder, `${processId}.latest.json`);
  if (fs.existsSync(latestFile)) {
    const previous = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
    if (previous.annotations_sha256 === annotationsHash && previous.evidence_sha256 && JSON.stringify(previous.evidence_sha256) !== JSON.stringify(evidenceHashes)) throw new Error('Las fuentes documentadas cambiaron: revise activity-documentation.json antes de regenerar Word.');
  }
  const rel = (p) => path.relative(root, p).split(path.sep).join('/');
  let file = path.join(folder, `${processId}.docx`);
  let warning;
  try { fs.writeFileSync(file, bytes); } catch (error) {
    if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
    // No cerrar Word ni perder un documento abierto del usuario.
    file = path.join(folder, `${processId}.actualizado.docx`);
    fs.writeFileSync(file, bytes);
    warning = 'El Word anterior está bloqueado; se guardó una versión actualizada sin cerrar documentos abiertos.';
  }
  const complete = fichas.every((f) => f.status !== 'DESCONOCIDA');
  const result = { ...validation, content_status: complete ? 'DOCUMENTADO_CON_EVIDENCIA' : 'INCOMPLETO', coverage: fichas.map((f) => ({ activity_id: f.activity_id, name: f.name, status: f.status })), file: rel(file), ...(warning ? { warning } : {}), sha256: sha(bytes), definition_sha256: sha(JSON.stringify(def)), bpmn_sha256: fs.existsSync(`${base}.bpmn`) ? sha(fs.readFileSync(`${base}.bpmn`)) : null, annotations_sha256: annotationsHash, evidence_sha256: evidenceHashes, annotated_activities: Object.keys(annotations.activities || {}).length, references: ['inputs/references/word/validar-parametros-entrada.png', 'inputs/references/word/registrar-bloqueo-cobs.png'] };
  fs.writeFileSync(file.replace(/\.docx$/, '.documentation.json'), JSON.stringify({ ...result, fichas }, null, 2) + '\n');
  fs.writeFileSync(latestFile, JSON.stringify(result, null, 2) + '\n');
  return result;
}

// Solo enlazar documentos que correspondan al diagrama y a sus actividades actuales.
export function currentActivityWord(projectId, processId, { root } = {}) {
  if (![projectId, processId].every((id) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id))) throw new Error('Identificador inválido.');
  const folder = path.join(workDir(root, projectId), 'documents');
  const latest = path.join(folder, `${processId}.latest.json`);
  if (!fs.existsSync(latest)) return { approval: 'PENDIENTE', content_status: 'PENDIENTE' };
  const result = JSON.parse(fs.readFileSync(latest, 'utf8'));
  const reportDir = path.join(workDir(root, projectId), 'reports');
  for (const [suffix, key, rejected] of [['validation', 'approval', 'BLOQUEADO'], ['review', 'verdict', 'RECHAZADO']]) {
    const report = path.join(reportDir, `${processId}.${suffix}.json`);
    if (fs.existsSync(report) && JSON.parse(fs.readFileSync(report, 'utf8'))[key] === rejected) return { approval: 'BLOQUEADO', content_status: 'PENDIENTE' };
  }
  const base = path.join(workDir(root, projectId), 'diagrams', processId);
  const doc = path.resolve(root, result.file);
  const inside = path.relative(folder, doc);
  if (inside.startsWith('..') || path.isAbsolute(inside)) return { approval: 'DESACTUALIZADO' };
  if (!fs.existsSync(doc) || sha(fs.readFileSync(doc)) !== result.sha256 || !fs.existsSync(`${base}.bpmn`) || sha(fs.readFileSync(`${base}.bpmn`)) !== result.bpmn_sha256 || sha(JSON.stringify(JSON.parse(fs.readFileSync(`${base}.process.json`, 'utf8')))) !== result.definition_sha256) return { approval: 'DESACTUALIZADO', content_status: 'DESACTUALIZADO' };
  const annotations = path.join(root, 'workspace', projectId, 'processes', processId, 'activity-documentation.json');
  if (sha(JSON.stringify(fs.existsSync(annotations) ? JSON.parse(fs.readFileSync(annotations, 'utf8')) : {})) !== result.annotations_sha256) return { approval: 'DESACTUALIZADO' };
  for (const [file, hash] of Object.entries(result.evidence_sha256 || {})) {
    const sourceRoot = path.resolve(root, 'workspace', projectId, 'source');
    const sourceFile = path.resolve(sourceRoot, file);
    if (!sourceFile.startsWith(sourceRoot + path.sep)) return { approval: 'DESACTUALIZADO' };
    if (!fs.existsSync(sourceFile) || sha(fs.readFileSync(sourceFile)) !== hash) return { approval: 'DESACTUALIZADO' };
  }
  return result;
}
