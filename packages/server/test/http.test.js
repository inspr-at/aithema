import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { SQLiteStorage, createHandlers } from '../src/index.js';
import { httpAdapter, listen } from '../src/http.js';
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

for (const status of [403, 404]) test(`AIT-142: early ${status} preserves a bounded multipart upload until its final boundary`,
  { timeout: 5_000 }, async t => {
    const rejected = Promise.withResolvers(), finish = Promise.withResolvers();
    const { server, url } = await listen(() => {
      rejected.resolve(); return Response.json({ error: 'refused' }, { status });
    });
    t.after(async () => { finish.resolve(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const form = new FormData(); form.append('files', new File(['fixture'], 'fixture.txt'));
    const serialized = new Request(url, { method: 'POST', body: form });
    const bytes = new Uint8Array(await serialized.arrayBuffer()), split = bytes.length - 10;
    let first = true;
    const body = new ReadableStream({ async pull(controller) {
      if (first) { first = false; controller.enqueue(bytes.subarray(0, split)); return; }
      await finish.promise; controller.enqueue(bytes.subarray(split)); controller.close();
    } });
    const posting = globalThis.fetch(url, { method: 'POST', duplex: 'half', body,
      headers: { 'content-type': serialized.headers.get('content-type'), 'content-length': String(bytes.length) } });
    // Observe the rejection before allowing the final multipart bytes to be sent.
    // No wall-clock delay or chance of the entire request arriving in one write.
    posting.catch(() => {});
    await rejected.promise; finish.resolve();
    const response = await posting;
    assert.equal(response.status, status); assert.deepEqual(await response.json(), { error: 'refused' });
    assert.equal(response.headers.get('connection'), 'keep-alive', 'small rejected uploads must finish sending before the socket can close');
  });

test('AIT-142: a stalled small rejection has a controlled discard deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const incoming = new PassThrough(), outgoing = new PassThrough();
  Object.assign(incoming, { method: 'POST', url: '/uploads', complete: false,
    headers: { 'content-length': '128' }, rawHeaders: ['content-length', '128'] });
  let response; const chunks = [];
  outgoing.writeHead = (status, headers) => { response = { status, headers }; };
  outgoing.on('data', chunk => chunks.push(chunk));
  t.after(() => { incoming.destroy(); outgoing.destroy(); });
  const serving = httpAdapter(() => Response.json({ error: 'refused' }, { status: 404 }))(incoming, outgoing);
  // Let the handler install its deadline; network and elapsed time play no role.
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(999); assert.equal(response, undefined);
  t.mock.timers.tick(1); await serving;
  assert.equal(response.status, 404); assert.equal(response.headers.connection, 'close');
  assert.deepEqual(JSON.parse(Buffer.concat(chunks)), { error: 'refused' });
  assert.equal(incoming.isPaused(), true, 'the deadline stops discarding more bytes');
});

for (const length of [undefined, '65537']) test(`AIT-142: early rejection does not drain ${length ?? 'undeclared'} bytes`, async t => {
  const incoming = new PassThrough(), outgoing = new PassThrough();
  const headers = length === undefined ? {} : { 'content-length': length };
  Object.assign(incoming, { method: 'POST', url: '/uploads', complete: false, headers,
    rawHeaders: Object.entries(headers).flat() });
  let response, resume;
  outgoing.writeHead = (status, headers) => { response = { status, headers }; };
  outgoing.resume();
  t.after(() => { incoming.destroy(); outgoing.destroy(); });
  const serving = httpAdapter(() => {
    // The bridge's initial pipe already scheduled a resume event. Observe new
    // resume calls after rejection, rather than that earlier transport event.
    resume = t.mock.method(incoming, 'resume');
    return Response.json({ error: 'refused' }, { status: 413 });
  })(incoming, outgoing);
  await serving; await new Promise(resolve => setImmediate(resolve));
  assert.equal(response.status, 413); assert.equal(response.headers.connection, 'close');
  assert.equal(resume.mock.calls.length, 0, 'rejection must not resume an unbounded body');
});

test('HTTP adapter preserves a successful response that streams its request body', async t => {
  const incoming = new PassThrough(), outgoing = new PassThrough(), first = Promise.withResolvers();
  Object.assign(incoming, { method: 'POST', url: '/echo', complete: false,
    headers: { 'content-length': '128' }, rawHeaders: ['content-length', '128'] });
  let status; const chunks = [];
  outgoing.writeHead = code => { status = code; };
  outgoing.on('data', chunk => { chunks.push(chunk); first.resolve(); });
  t.after(() => { incoming.destroy(); outgoing.destroy(); });
  const serving = httpAdapter(request => new Response(request.body))(incoming, outgoing);
  incoming.write(Buffer.alloc(64, 97));
  await first.promise;
  incoming.complete = true; incoming.end(Buffer.alloc(64, 98));
  await serving;
  assert.equal(status, 200); assert.equal(Buffer.concat(chunks).toString(), 'a'.repeat(64) + 'b'.repeat(64));
});
