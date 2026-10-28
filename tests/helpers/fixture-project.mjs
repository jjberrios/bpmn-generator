import fs from 'node:fs';
import path from 'node:path';
import { ROOT, ingest, analyze } from '../../tools/pipeline.mjs';

export const FIXTURE_ZIP = 'tests/fixtures/orders-service.zip';
export const PROJECT_ID = 'orders-service';
export const PROJECT_DIR = path.join(ROOT, 'workspace', PROJECT_ID);

let prepared = false;
export function prepareFixtureProject() {
  if (!prepared) {
    ingest(FIXTURE_ZIP, { projectId: PROJECT_ID, force: true });
    analyze(PROJECT_ID);
    prepared = true;
  }
  return PROJECT_DIR;
}

export function loadTrace(traceId) {
  const doc = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'analysis', 'execution-trace.json'), 'utf8'));
  return doc.traces.find((t) => t.id === traceId);
}
