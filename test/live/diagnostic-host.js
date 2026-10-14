import { appendFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createVoiceHost as createStart2VoiceHost } from '../../demo/start2-voice-host.js';
import { diagnosticRecords } from './soak-model.js';

/** Closed-schema JSONL for this isolated OPS host, including legacy object logs. */
export function createSoakLog(append) {
  return value => {
    let row; try { row = typeof value === 'string' ? JSON.parse(value) : value; } catch { return; }
    if (!/^[a-f0-9]{64}$/u.test(row?.callHash ?? '')) return;
    for (const record of diagnosticRecords(JSON.stringify(row), row.callHash)) append(JSON.stringify(record) + '\n');
  };
}

// OPS configures this module on a separate test host only. Importing it performs
// no provider work; the builder never calls this live factory.
export async function createVoiceHost(options) {
  const path = process.env.AITHEMA_SOAK_DIAGNOSTICS;
  if (!path || !isAbsolute(path)) throw new Error('Absolute isolated soak diagnostics path required');
  return createStart2VoiceHost({ ...options, log: createSoakLog(line => appendFileSync(path, line, { mode: 0o600, flag: 'a' })) });
}
