// Renderizado de informes en Markdown (español). Funciones puras, sin acceso a red.

const SECRET_RE = /((?:password|passwd|pwd|secret|token|api[-_]?key|apikey|credential)[\w.-]*\s*[:=]\s*)(["']?)([^\s"',;]+)\2/gi;

export function redactSecrets(text) {
  return String(text ?? '').replace(SECRET_RE, (_m, k) => `${k}<REDACTADO>`);
}

const esc = (s) => redactSecrets(String(s ?? '')).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function table(headers, rows) {
  if (!rows.length) return '_Sin elementos._\n';
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const r of rows) lines.push(`| ${r.map(esc).join(' | ')} |`);
  return lines.join('\n') + '\n';
}

const ref = (e) => (e?.file ? `${e.file}${e.line_start ? `:${e.line_start}${e.line_end && e.line_end !== e.line_start ? `-${e.line_end}` : ''}` : ''}${e.class ? ` ${e.class}${e.method ? `.${e.method}` : ''}` : ''}` : '—');

export function renderDiscoveryMarkdown({ projectId, manifest, architecture, candidates }) {
  const t = manifest?.totals ?? {};
  const out = [];
  out.push(`# Descubrimiento de procesos — ${projectId}\n`);
  out.push('## Inventario técnico\n');
  out.push(`- Archivos extraídos: ${t.files_extracted ?? '?'} (excluidos: ${t.files_excluded ?? '?'}); bytes: ${t.bytes_extracted ?? '?'}`);
  out.push(`- Lenguajes: ${(architecture?.languages ?? []).map((l) => `${l.name} (${l.files} archivos${l.version_hint ? `, ${l.version_hint}` : ''})`).join('; ') || '—'}`);
  out.push(`- Frameworks detectados: ${(architecture?.frameworks ?? []).map((f) => `${f.name}${f.version ? ' ' + f.version : ''}`).join('; ') || '—'}`);
  out.push(`- Componentes: ${architecture?.components?.length ?? 0}; puntos de entrada: ${architecture?.entry_points?.length ?? 0}; integraciones: ${architecture?.integrations?.length ?? 0}`);
  const sens = manifest?.sensitive_files ?? [];
  if (sens.length) out.push(`- Archivos potencialmente sensibles (no extraídos o redactados): ${sens.length}. Sus valores no se incluyen en ningún informe.`);
  out.push('\n## Candidatos a proceso\n');
  out.push(
    table(
      ['ID', 'Nombre', 'Punto de entrada', 'Módulos/clases', 'Decisiones', 'Rutas', 'Resultados', 'Integraciones', 'Evidencia'],
      candidates.map((c) => [
        c.process_id,
        c.name,
        `${c.entry_point.class}.${c.entry_point.method}${c.entry_point.http_method ? ` (${c.entry_point.http_method} ${c.entry_point.path})` : ''}`,
        c.classes.join(', '),
        c.decisions,
        c.paths,
        c.outcomes.join(', '),
        c.integrations.join('; ') || '—',
        `${c.evidence_sufficiency}: ${c.sufficiency_reason}`,
      ]),
    ),
  );
  const unresolved = architecture?.unresolved ?? [];
  if (unresolved.length) {
    out.push('\n## Elementos no analizados o no resueltos\n');
    out.push(table(['Descripción'], unresolved.map((u) => [typeof u === 'string' ? u : u.description ?? JSON.stringify(u)])));
  }
  out.push('\n> Cada candidato modela únicamente el comportamiento observable en el backend analizado; no se asumen actividades de usuarios ni procesos de negocio externos.\n');
  return out.join('\n');
}

export function renderValidationMarkdown(r) {
  const out = [];
  out.push(`# Informe de validación BPMN${r.file ? ` — ${r.file}` : ''}\n`);
  out.push(`- Resultado: **${r.approval}** (errores: ${r.summary.errors}, advertencias: ${r.summary.warnings})\n`);
  out.push('## Comprobaciones\n');
  out.push(table(['Comprobación', 'Estado'], Object.entries(r.checks)));
  if (r.traceability) {
    out.push('## Trazabilidad\n');
    const count = (v) => Array.isArray(v) ? v.length : (v ?? 0);
    out.push(`Elementos revisados: ${r.traceability.elements ?? 0}; con evidencia: ${r.traceability.with_evidence ?? 0}; sin evidencia: ${count(r.traceability.without_evidence)}; no confirmados: ${count(r.traceability.unconfirmed)}.`);
    out.push('Esta cifra mide cobertura de evidencia, no fidelidad funcional comprobada.\n');
  }
  out.push('## Incidencias\n');
  out.push(table(['Severidad', 'Código', 'Elemento', 'Mensaje'], r.issues.map((i) => [i.severity, i.code, i.element_id ?? '', i.message])));
  return out.join('\n');
}

export function renderReviewMarkdown(r) {
  const out = [];
  out.push(`# Informe de revisión — ${r.process_id}\n`);
  out.push(`- Revisor: ${r.reviewer}`);
  out.push(`- Veredicto: **${r.verdict}**`);
  out.push(`- ${r.summary}\n`);
  out.push('## Hallazgos\n');
  out.push(table(['ID', 'Severidad', 'Categoría', 'Elemento', 'Descripción', 'Referencias', 'Recomendación'], r.findings.map((f) => [f.id, f.severity, f.category, f.element_id ?? '', f.description, (f.evidence_refs ?? []).map(ref).join('; '), f.recommendation])));
  out.push('## Inferencias y comportamientos no confirmados\n');
  out.push(table(['Elemento', 'Estado', 'Motivo'], (r.unconfirmed_inferences ?? []).map((u) => [u.element_id, u.status, u.reason])));
  return out.join('\n');
}

export function renderReferenceMarkdown(r) {
  const out = [];
  out.push('# Inspección del archivo de referencia Bizagi\n');
  out.push(`- Archivo: ${r.file} (${r.size_bytes} bytes, SHA-256 ${r.sha256})`);
  out.push(`- Paquete: ${r.package.name} — XPDL ${r.package.xpdl_version}, ${r.package.vendor} (modelado con ${r.package.bizagi_version})`);
  out.push(`- Fuente del diagrama: ${r.diagram_source}`);
  out.push(`- Conteos: ${Object.entries(r.counts).map(([k, v]) => `${k}=${v}`).join(', ')}\n`);
  out.push('## Pools y carriles\n');
  out.push(table(['Pool', 'Visible', 'Proceso', 'Carriles'], r.pools.map((p) => [p.name, p.boundary_visible, p.process_id ?? '', p.lanes.map((l) => l.name).join(', ')])));
  out.push('## Actividades\n');
  out.push(table(['Tipo', 'Subtipo', 'Nombre', 'Carril (por geometría)'], r.activities.map((a) => [a.kind, a.subtype ?? '', a.name, a.lane_by_geometry ?? ''])));
  out.push('## Transiciones\n');
  out.push(table(['Desde', 'Hacia', 'Nombre', 'Condición'], r.transitions.map((t) => [t.from, t.to, t.name ?? '', t.condition_type ?? ''])));
  out.push('## Almacenes de datos\n');
  out.push(table(['Almacén', 'Actividades asociadas'], r.data_store_references.map((d) => [d.data_store, d.associated_activities.map((a) => a.name).join(', ')])));
  out.push('## Convenciones de modelado observadas\n');
  const c = r.conventions;
  out.push(`- Tareas numeradas ("N.Nombre"): ${c.tareas_numeradas ? 'sí' : 'no'}`);
  out.push(`- Etiquetas de flujos de decisión: ${c.flujos_de_decision_etiquetados.join(', ') || '—'}`);
  out.push(`- Eventos finales por resultado: ${c.eventos_finales.join(', ')}`);
  out.push(`- Compuertas nombradas con la condición: ${c.compuertas_nombradas_con_condicion.join('; ')}`);
  out.push(`- Pool con el nombre del servicio: ${c.pool_con_nombre_del_servicio.join(', ')}; carriles: ${c.carriles.join(', ')}`);
  out.push(`- Almacenes de datos: ${c.almacenes_de_datos.join(', ')}`);
  out.push(`\n> ${c.nota}\n`);
  if (r.warnings?.length) out.push(`## Advertencias\n\n${r.warnings.map((w) => `- ${w}`).join('\n')}\n`);
  out.push(r.notes.map((n) => `- ${n}`).join('\n'));
  return out.join('\n') + '\n';
}

function evidenceStats(def) {
  const els = [...(def.activities ?? []), ...(def.events ?? []), ...(def.decisions ?? [])];
  const by = { CONFIRMADA: 0, INFERIDA: 0, DESCONOCIDA: 0 };
  for (const e of els) by[e.evidence_status] = (by[e.evidence_status] ?? 0) + 1;
  return { total: els.length, ...by };
}

export function renderFinalReport({ projectId, manifest, architecture, candidates, processes, referenceStatus, nativeProject = null, generatedAt }) {
  const out = [];
  out.push(`# Informe final BPMN Reverse Engineer — ${projectId}\n`);
  out.push(`Generado: ${generatedAt ?? new Date().toISOString()}\n`);
  out.push('## 1. Procesos identificados\n');
  out.push(table(['ID', 'Nombre', 'Entrada', 'Rutas', 'Evidencia suficiente'], candidates.map((c) => [c.process_id, c.name, `${c.entry_point.class}.${c.entry_point.method}`, c.paths, c.evidence_sufficiency])));
  out.push('## 2. Procesos generados\n');
  if (processes.length) {
    out.push(`**Entregable principal:** un archivo BPMN 2.0 (\`.bpmn\`, con BPMN DI) por proceso en \`outputs/${projectId}/diagrams/\`:\n`);
    for (const p of processes) out.push(`- \`outputs/${projectId}/diagrams/${p.process_id ?? p.definition.id}.bpmn\``);
    out.push('');
  }
  if (nativeProject) {
    out.push(`**Opcional:** \`${nativeProject.file}\` — ${nativeProject.diagrams.length} diagramas en un contenedor Bizagi .bpm (paquetes XPDL 2.2).`);
    out.push(`- Comprobaciones del contenedor: ${nativeProject.approval}; informe: \`${nativeProject.validation_report}\`.`);
    out.push('- Conserva los BPMN, vistas previas y trazas como intermedios. No es un ZIP de archivos BPMN renombrado.');
    out.push('');
    if (nativeProject.provider_load) {
      const provider = nativeProject.provider_load;
      out.push(`- Carga con el adaptador real de Bizagi: **${provider.approval}**, ${provider.diagrams.filter((d) => d.collaboration_loaded).length}/${nativeProject.diagrams.length} diagramas. Huella del archivo verificada; informe: \`${provider.report}\`.`);
      if (provider.labels) out.push(`- Etiquetas comprobadas en el modelo cargado: ${provider.labels.total}; nombres y áreas de texto positivas: **${provider.labels.visible_area_and_names_preserved ? 'OK' : 'FALLO'}**. No equivale a inspección visual de la interfaz.`);
      if (provider.labels?.readable_fonts_and_opaque_contrast !== undefined) out.push(`- Fuente y tamaño válidos, color opaco y contraste de texto suficiente: **${provider.labels.readable_fonts_and_opaque_contrast ? 'OK' : 'FALLO'}**; contraste mínimo medido: ${Number(provider.labels.minimum_contrast ?? 0).toFixed(2)}:1.`);
      out.push('- Esta prueba usa las DLL instaladas del proveedor, no solo el validador propio.\n');
    }
  }
  if (!processes.length) out.push('_No se generó ningún proceso._\n');
  for (const p of processes) {
    const { definition: def, validation, review, files } = p;
    const st = evidenceStats(def);
    out.push(`### ${def.name} (\`${def.id}\`)\n`);
    out.push(`- Alcance: ${def.abstraction_level} — ${def.scope_note}`);
    if (files.abstraccion) out.push('- Vista por actividades: agrupa detalles técnicos del modelo conservado. El mapa comprueba cobertura de elementos y resultados, no equivalencia automática de rutas; la interpretación se contrasta mediante revisión independiente.');
    out.push(`- Punto de entrada: ${def.entry_point.class}.${def.entry_point.method}${def.entry_point.http_method ? ` (${def.entry_point.http_method} ${def.entry_point.path})` : ''}`);
    out.push(`- Actividades: ${def.activities.length}; decisiones: ${def.decisions.length}; eventos: ${def.events.length}; flujos: ${def.flows.length}; participantes: ${def.participants.length}`);
    out.push(`- Resultados/rutas: ${def.outcomes.map((o) => `${o.name} (${o.kind})`).join(', ')}`);
    out.push(`- Cobertura de evidencia (no es fidelidad funcional): CONFIRMADA ${st.CONFIRMADA}, INFERIDA ${st.INFERIDA}, DESCONOCIDA ${st.DESCONOCIDA} de ${st.total} elementos`);
    out.push(`- Fidelidad funcional: no verificada automáticamente; requiere revisión humana`);
    out.push(`- Validación BPMN: ${validation.approval} (errores ${validation.summary.errors}, advertencias ${validation.summary.warnings})`);
    if (p.documentation) out.push(`- Documento de actividades: ${p.documentation.approval}; contenido: ${p.documentation.content_status ?? 'no informado'}; fichas: ${p.documentation.activities ?? 0}/${def.activities.length}${p.documentation.reason ? '; ' + esc(p.documentation.reason) : ''}. La validación estructural del Word no demuestra exhaustividad semántica.`);
    if (p.documentation?.general) out.push(`- Explicación general del proceso: ${p.documentation.general.approval}${p.documentation.general.reason ? '; ' + esc(p.documentation.general.reason) : ''}.`);
    out.push(`- Revisión (${review.reviewer}): ${review.verdict} — ${Object.entries(review.counts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    out.push(`- Archivos: ${Object.entries(files).map(([k, v]) => `${k}: \`${v}\``).join('; ')}`);
    for (const ds of def.participants.filter((x) => x.kind === 'data_store')) {
      const uncertainties = (def.uncertainties ?? []).filter((u) => u.element_ids?.includes(ds.id));
      out.push(`- Almacén \`${ds.id}\` — ${redactSecrets(ds.name)}: ${redactSecrets(ds.justification ?? '')}`);
      for (const u of uncertainties) out.push(`  - [${u.status}] ${redactSecrets(u.description)}`);
      out.push('  - Una asociación de lectura o escritura modelada no prueba exclusividad de acceso, efectos internos ni confirmación transaccional.');
    }
    if (def.uncertainties?.length) {
      out.push('- Incertidumbres:');
      for (const u of def.uncertainties) out.push(`  - ${u.id} [${u.status}] ${redactSecrets(u.description)}`);
    }
    if (def.related_processes?.length) {
      out.push('- Procesos relacionados:');
      for (const r of def.related_processes) out.push(`  - ${r.process_id ?? r.id ?? JSON.stringify(r)}${r.reason ? ': ' + r.reason : ''}`);
    }
    out.push('');
  }
  out.push('## 3. Evidencias y hallazgos pendientes\n');
  const rows = [];
  for (const p of processes) for (const f of p.review.findings.filter((x) => x.severity !== 'INFORMATIVO')) rows.push([p.process_id, f.severity, f.category, f.element_id ?? '', f.description]);
  out.push(table(['Proceso', 'Severidad', 'Categoría', 'Elemento', 'Descripción'], rows));
  out.push('## 4. Limitaciones del análisis\n');
  out.push('- El análisis es estático (AST); no se ejecutó el código del proyecto.');
  out.push('- Las trazas verificadas por agentes se conservan separadas de las deterministas. Cuando existen y cumplen el contrato, la revisión usa la traza del proceso y después la agregada del proyecto; en otro caso usa la determinista.');
  out.push('- El análisis AST no demuestra cobertura exhaustiva de excepciones ni de la sustitución de retornos y excepciones en finally; esos comportamientos requieren contraste semántico con el código.');
  out.push('- Las llamadas polimórficas, reflexivas o dependientes de la configuración del contenedor se registran como no resueltas (DESCONOCIDA).');
  out.push('- Solo se modela el comportamiento observable en el backend analizado; no se asumen actividades manuales ni aprobaciones.');
  out.push('- Los lenguajes distintos de Java se inventarían pero no se trazan.');
  for (const u of architecture?.unresolved ?? []) out.push(`- No resuelto: ${typeof u === 'string' ? u : u.description ?? JSON.stringify(u)}`);
  out.push('\n## 5. Validaciones ejecutadas\n');
  if (!processes.length) {
    out.push('- No hay resultados de generación: no consta validación de definiciones, BPMN, DI, bpmnlint, round-trip ni revisión de procesos.');
  }
  for (const p of processes) {
    out.push(`- ${p.process_id ?? p.definition.id}: validación ${p.validation.approval}; comprobaciones registradas: ${Object.entries(p.validation.checks ?? {}).map(([k, v]) => `${k}=${v}`).join(', ') || 'no informadas'}.`);
    out.push(`  - Revisión registrada: ${p.review.reviewer} — ${p.review.verdict}.`);
  }
  out.push('\n## 6. Archivos generados\n');
  out.push(processes.length ? `Archivos BPMN 2.0 por proceso en \`outputs/${projectId}/diagrams/\` (ver sección 2).` : 'No se generó ningún archivo BPMN.');
  out.push(nativeProject ? `Contenedor .bpm opcional: \`${nativeProject.file}\`.` : 'Contenedor .bpm (opcional): no generado (use `--bpm`).');
  out.push(`\nPrueba con el archivo de referencia: ${referenceStatus ?? 'no ejecutada'}.\n`);
  out.push('## 7. Confidencialidad\n');
  out.push('El código leído por los agentes se procesa mediante los proveedores LLM configurados en OpenCode. Los scripts locales no transmiten contenido a servicios externos.\n');
  return out.join('\n');
}
