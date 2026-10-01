import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteJournal } from '../../../runtime/journal/index.js';
import { BudgetClient, SqliteBudgetLedger } from '../../../runtime/budget/index.js';
import { authority as baseAuthority, bytes, now, session, sid } from '../journal/helpers.mjs';

export { sid, now };
export const authority = () => baseAuthority({ capabilities: ['aithema.ledger', 'aithema.journal.read', 'aithema.journal.write'] });
export function host(t, local = false, overrides = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'aithema-speech-')), 'host.sqlite');
  const journal = new SqliteJournal(path, { now }); journal.createSession(bytes(session()));
  const ledger = new SqliteBudgetLedger(path, { now });
  ledger.registerSession({ sid, issuer: 'fixture-issuer', principal: 'fixture-person', currency: 'EUR',
    session_cap_micro: local ? 0 : 1000, principal_day_cap_micro: local ? 0 : 1000, tenant_day_cap_micro: local ? 0 : 1000,
    evidence: true, operator_local_lanes: local ? ['stt', 'tts'] : [], ...overrides });
  const client = new BudgetClient({ port: ledger, journal, authority: authority(), now });
  t.after(() => { ledger.close(); journal.close(); });
  return { client, journal, ledger, path };
}

export function wav(samples = [0, 1200, -1200, 0]) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((value, index) => bytes.writeInt16LE(value, 44 + index * 2));
  return bytes;
}
export const sttRequest = (signal, n = 1) => ({ bytes: wav(), mimeType: 'audio/wav', language: 'de', signal,
  executionContext: { attempt_id: `${sid}:1:stt:${n}` } });
export const ttsRequest = (signal, n = 1) => ({ text: 'Ein synthetischer Test.', signal,
  executionContext: { attempt_id: `${sid}:1:tts:${n}` } });
export function config(client, endpoint, extra = {}) {
  return { budget: client, maxMicro: 100, currency: 'EUR', endpoint,
    priceUsage: () => 100, // explicit synthetic flat tariff, never a real price
    modelId: 'fixture-model', allowedModels: ['fixture-model'], voiceId: 'fixture-voice', allowedVoices: ['fixture-voice'], ...extra };
}
export function events(journal) { return journal.recordsAfter(0, authority()).map((row) => row.document); }
export function barrier() { let resolve; return { promise: new Promise((r) => { resolve = r; }), resolve: (v) => resolve(v) }; }
export async function server(t, handler) {
  const http = createServer(handler);
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(async () => { http.closeAllConnections(); await new Promise((resolve) => http.close(resolve)); });
  return `http://127.0.0.1:${http.address().port}`;
}
export async function collect(iterator) { const chunks = []; for await (const chunk of iterator) chunks.push(chunk); return chunks; }
export function claimed(ledger) { assert.equal(ledger.listOpen({}, authority()).body.holds[0]?.claimed, true); }
