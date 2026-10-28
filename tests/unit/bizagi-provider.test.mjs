import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync, unzipSync, strFromU8, strToU8 } from 'fflate';
import { buildNativeProject } from '../../tools/bizagi/native-project.mjs';
import { diagnoseLoader, loadedFontReadable, loadedFontContrast } from '../../tools/bizagi/diagnose-loader.mjs';
import { makeMinimalDef } from '../helpers/minimal-process.mjs';

const installation = process.env.BIZAGI_INSTALLATION ?? path.join(os.homedir(), 'AppData/Local/Programs/Bizagi/Bizagi Modeler');
const reference = 'inputs/references/claro-post-consultareclamos.bpm';
const available = process.platform === 'win32' && fs.existsSync(path.join(installation, 'Bizagi.ProcessModeler.Persistence.dll')) && fs.existsSync(reference);

test('el control de legibilidad rechaza transparencia, fuente/tamaño nulos y contraste insuficiente', () => {
  const label = { font_name: 'Segoe UI', font_size: 8, font_argb: -16777216, font_alpha: 255, fill_argb: -1 };
  assert.equal(loadedFontContrast(label), 21);
  assert.equal(loadedFontReadable(label), true);
  for (const patch of [{ font_name: null }, { font_size: 0 }, { font_alpha: 0, font_argb: 0 }, { font_argb: -1 }, { fill_argb: undefined }]) assert.equal(loadedFontReadable({ ...label, ...patch }), false);
});

test('Bizagi real: control válido, carga de cuatro diagramas y rechazo del enum que causaba la incompatibilidad', { skip: !available && 'Requiere instalación local autorizada de Bizagi y referencia', timeout: 180000 }, () => {
  const rows = (r) => Array.isArray(r) ? r : [r];
  const check = (r, count) => {
    const items = rows(r);
    assert.equal(items.length, count);
    for (const item of items) {
      assert.ok(!item.error, item.error);
      assert.equal(item.collaboration_loaded, true);
      assert.equal(item.workflows, 2);
      assert.deepEqual(item.unknown_elements, []);
      assert.equal(item.labels.length, item.activities);
      for (const label of item.labels) {
        assert.equal(label.name_preserved, true, 'DisplayName conserva el texto visible');
        assert.ok(label.graphical_properties_present);
        assert.ok(label.text_width > 0 && label.text_height > 0, `área visible de ${label.type}`);
        assert.ok(Number.isFinite(label.text_x) && Number.isFinite(label.text_y));
        assert.equal(label.font_name, 'Segoe UI');
        assert.equal(label.font_size, 8);
        assert.equal(label.font_argb, -16777216);
        assert.equal(label.font_alpha, 255);
        assert.equal(loadedFontReadable(label), true, 'fuente, opacidad y contraste cargados por el proveedor');
      }
    }
  };
  check(diagnoseLoader(installation, 'load', undefined, reference), 1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpmn-bizagi-provider-'));
  try {
    const definitions = Array.from({ length: 4 }, (_, i) => {
      const d = makeMinimalDef(); d.id = `Proveedor_${i}`;
      d.participants.push({ id: 'DS', kind: 'data_store', name: 'Almacén de prueba', justification: 'Prueba de asociación', evidence_ids: ['EV2'] });
      d.activities[0].data_access = [{ data_store_id: 'DS', access: 'read' }];
      return d;
    });
    const project = buildNativeProject('proveedor', definitions), file = path.join(dir, 'correcto.bpm');
    fs.writeFileSync(file, project.bytes);
    check(diagnoseLoader(installation, 'load', undefined, file), 4);
    const noText = unzipSync(project.bytes), first = project.diagrams[0].name, missing = unzipSync(noText[first]);
    missing['Diagram.xml'] = strToU8(strFromU8(missing['Diagram.xml']).replace(/ Text(?:X|Y|Width|Height)="[^"]*"/g, ''));
    noText[first] = zipSync(missing);
    const invisible = path.join(dir, 'texto-invisible.bpm');
    fs.writeFileSync(invisible, zipSync(noText));
    const loadedInvisible = rows(diagnoseLoader(installation, 'load', undefined, invisible))[0];
    assert.ok(!loadedInvisible.error, loadedInvisible.error);
    assert.equal(loadedInvisible.collaboration_loaded, true, 'el bug visual no impide abrir el modelo');
    assert.ok(loadedInvisible.labels.length > 0);
    assert.ok(loadedInvisible.labels.every((label) => label.name_preserved && label.text_width === 0 && label.text_height === 0), 'reproducción del bug: nombre conservado pero área de texto 0x0');
    const wrongFont = unzipSync(project.bytes), incorrect = unzipSync(wrongFont[first]);
    incorrect['Diagram.xml'] = strToU8(strFromU8(incorrect['Diagram.xml']).replace(/<Formatting>[\s\S]*?<\/Formatting>/g, '<Formatting FontName="Segoe UI" SizeFont="8" ColorFont="-16777216"></Formatting>'));
    wrongFont[first] = zipSync(incorrect);
    const transparent = path.join(dir, 'fuente-transparente.bpm');
    fs.writeFileSync(transparent, zipSync(wrongFont));
    const loadedTransparent = rows(diagnoseLoader(installation, 'load', undefined, transparent))[0];
    assert.ok(!loadedTransparent.error, loadedTransparent.error);
    assert.equal(loadedTransparent.collaboration_loaded, true);
    assert.ok(loadedTransparent.labels.length > 0);
    assert.ok(loadedTransparent.labels.every((label) => label.name_preserved && label.text_width > 0 && label.text_height > 0 && !label.font_name && label.font_size === 0 && label.font_alpha === 0 && !loadedFontReadable(label)), 'reproducción del segundo bug: área positiva pero fuente nula y color transparente');
    const outer = unzipSync(project.bytes), name = project.diagrams[0].name, inner = unzipSync(outer[name]);
    inner['Diagram.xml'] = strToU8(strFromU8(inner['Diagram.xml']).replace('<Association ', '<Association AssociationDirection="One" '));
    outer[name] = zipSync(inner);
    const bad = path.join(dir, 'enum-invalido.bpm');
    fs.writeFileSync(bad, zipSync(outer));
    const failed = rows(diagnoseLoader(installation, 'deserialize', undefined, bad));
    assert.match(failed[0].error, /One.*AssociationAssociationDirection/);
  } finally {
    // Solo los archivos temporales creados por esta prueba.
    for (const name of ['correcto.bpm', 'enum-invalido.bpm', 'texto-invisible.bpm', 'fuente-transparente.bpm']) fs.rmSync(path.join(dir, name), { force: true });
    fs.rmdirSync(dir);
  }
});
