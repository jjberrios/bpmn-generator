// Validación de contratos JSON Schema (Ajv 2020-12). Uso como módulo o CLI.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMAS_DIR = path.resolve(HERE, '..', '..', 'schemas');

export const CONTRACTS = {
  'repository-manifest': 'repository-manifest.schema.json',
  'architecture-map': 'architecture-map.schema.json',
  'execution-trace': 'execution-trace.schema.json',
  'process-definition': 'process-definition.schema.json',
  'evidence': 'evidence.schema.json',
  'review-report': 'review-report.schema.json',
};

let ajvInstance = null;

function getAjv() {
  if (ajvInstance) return ajvInstance;
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  // evidence.schema.json se registra primero: otros contratos lo referencian por $ref relativo.
  for (const file of Object.values(CONTRACTS)) {
    const schema = JSON.parse(fs.readFileSync(path.join(SCHEMAS_DIR, file), 'utf8'));
    ajv.addSchema(schema, file);
  }
  ajvInstance = ajv;
  return ajv;
}

export function validateContract(contract, data) {
  const file = CONTRACTS[contract];
  if (!file) throw new Error(`Contrato desconocido: ${contract}. Disponibles: ${Object.keys(CONTRACTS).join(', ')}`);
  const validate = getAjv().getSchema(file);
  const valid = validate(data);
  const errors = valid
    ? []
    : validate.errors.map((e) => `${e.instancePath || '/'} ${e.message}${e.params && Object.keys(e.params).length ? ' ' + JSON.stringify(e.params) : ''}`);
  return { valid: Boolean(valid), errors };
}

export function validateContractFile(contract, filePath) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return { valid: false, errors: [`No se pudo leer/parsear JSON: ${err.message}`] };
  }
  return validateContract(contract, data);
}

export function detectContract(filePath) {
  const base = path.basename(filePath).toLowerCase();
  for (const key of Object.keys(CONTRACTS)) {
    if (base.includes(key)) return key;
  }
  return null;
}
