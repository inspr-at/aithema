import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createHandlers } from '../src/index.js';
import { listen } from '../src/http.js';
import { mockConsent, testToken, sessionFetch as fetch, startChild, temporaryDb, post, waitForSession, readEvents, unzip } from '../../../test/helpers.js';

test('HTTP vertical: create, turns, understanding events, kill/restart, resume exactly, export', { timeout: 15_000 }, async t => {
  const db = await temporaryDb(); let running = await startChild(new URL('../bin/server.js', import.meta.url), db);
  t.after(async () => running.kill());
  const created = await post(running.url + '/api/sessions', {}); assert.equal(created.status, 201);
  const session = await created.json(), path = `/api/sessions/${session.id}`;
  assert.equal(created.headers.get('x-aithema-session-token'), testToken);
  await post(running.url + path + '/consent', { granted: true });
  let response = await post(running.url + path + '/turns', { clientEventId: 'first', content: 'systems: SAP' });
  assert.equal(response.status, 200); const receipt = await response.json(), cursor = receipt.seq;
  const settled = await waitForSession(running.url + path, s => s.understanding.readinessAssessed && !s.understanding.draft && s.transcript.length === 2);
  const events = await readEvents(await fetch(running.url + path + '/events', { headers: { 'Last-Event-ID': String(cursor) } }), settled.seq - cursor);
  assert.deepEqual(events.filter(e => e.type === 'understanding.updated').map(e => e.data.draft), [false]);
  const second = { clientEventId: 'second', content: 'operations: hosted; data: public; reach: international' };
  response = await post(running.url + path + '/turns', second); assert.equal(response.status, 200); const acknowledged = await response.json();
  await running.kill('SIGKILL'); running = await startChild(new URL('../bin/server.js', import.meta.url), db);
  await post(running.url + path + '/consent', { granted: true });
  const restored = await waitForSession(running.url + path, s => s.transcript.filter(t => t.role === 'user').length === 2 &&
    s.transcript.filter(t => t.role === 'assistant' && !t.erased).length === 1 && s.understanding.inputRevision.startsWith('2:') && !s.understanding.draft);
  assert.equal(restored.transcript.find(t => t.id === 'second').content, second.content);
  const retry = await post(running.url + path + '/turns', second); assert.deepEqual(await retry.json(), acknowledged);
  const conflict = await post(running.url + path + '/turns', { ...second, content: 'different' }); assert.equal(conflict.status, 409);
  const missed = await readEvents(await fetch(running.url + path + '/events', { headers: { 'Last-Event-ID': String(settled.seq) } }), restored.seq - settled.seq);
  assert.deepEqual(missed.filter(e => e.seq).map(e => e.seq), Array.from({ length: restored.seq - settled.seq }, (_, i) => settled.seq + i + 1));
  assert.equal(missed.filter(e => e.type === 'turn.final' && e.data.role === 'user').length, 1);
  const zip = await fetch(running.url + path + '/export'); assert.equal(zip.headers.get('content-type'), 'application/zip');
  const files = unzip(await zip.arrayBuffer()); assert.equal(JSON.parse(files['transcript.json']).turns.length, 3);
  assert.equal(JSON.parse(files['understanding.json']).constraints.systems.value, 'SAP');
});
test('HTTP adapter streams replay and handlers keep independent sessions isolated', async t => {
  const storage = new SQLiteStorage(), handlers = createHandlers({ consent: mockConsent, storage });
  const { server, url } = await listen(handlers.handle);
  t.after(async () => { await handlers.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); storage.close(); });
  const a = await post(url + '/api/sessions', {}).then(r => r.json()), b = await post(url + '/api/sessions', {}).then(r => r.json());
  await post(url + `/api/sessions/${a.id}/turns`, { clientEventId: 'same', content: 'A' });
  await post(url + `/api/sessions/${b.id}/turns`, { clientEventId: 'same', content: 'B' }); await handlers.idle();
  assert.equal(storage.get(a.id).transcript[0].content, 'A'); assert.equal(storage.get(b.id).transcript[0].content, 'B');
  assert.equal((await fetch(url + '/api/sessions/missing')).status, 404);
});
