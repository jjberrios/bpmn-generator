// Diagnóstico local de metadatos/IL de la instalación autorizada por el usuario.
// No modifica la instalación, no lee fuentes del proyecto ni inicia la interfaz.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { readNativeStructure } from '../reference/inspect-xpdl.mjs';

// Verifica el formato que cargó Bizagi, no el XML que produjo el exportador.
export function loadedFontContrast(label) {
  const luminance = (argb) => {
    const values = [16, 8, 0].map((shift) => {
      const v = ((argb >>> shift) & 255) / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
  };
  if (!Number.isInteger(label.font_argb) || !Number.isInteger(label.fill_argb)) return 0;
  const a = luminance(label.font_argb), b = luminance(label.fill_argb);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
export function loadedFontReadable(label) {
  return typeof label.font_name === 'string' && label.font_name.trim().length > 0
    && Number.isFinite(label.font_size) && label.font_size >= 8
    && label.font_alpha === 255 && (label.font_argb >>> 24) === 255
    && (label.fill_argb >>> 24) === 255 && loadedFontContrast(label) >= 4.5;
}

export function diagnoseLoader(installation, mode = 'types', pattern = 'Persist|Document|ModelLoader|FileManager', archive = null) {
  const base = fs.realpathSync(installation);
  if (!fs.statSync(base).isDirectory() || !fs.existsSync(path.join(base, 'Bizagi.ProcessModeler.Persistence.dll'))) throw new Error('No es una instalación de Bizagi Modeler verificable.');
  if (!['types', 'il', 'find', 'deserialize', 'load'].includes(mode) || pattern.length > 300) throw new Error('Diagnóstico no permitido.');
  let input;
  if (['deserialize', 'load'].includes(mode)) {
    readNativeStructure(archive); // Valida límites y rutas antes de extraer solo Diagram.xml.
    const outer = unzipSync(fs.readFileSync(archive), { filter: (e) => e.name.endsWith('.diag') });
    input = JSON.stringify(Object.entries(outer).map(([name, data]) => ({ name, xml: strFromU8(unzipSync(data, { filter: (e) => e.name === 'Diagram.xml' })['Diagram.xml']) })));
  }
  const script = fileURLToPath(new URL('./diagnose-loader.ps1', import.meta.url));
  const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Installation', base, '-Mode', mode, '-Pattern', pattern], { input, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 12 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'Falló el diagnóstico .NET.');
  return JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
}
