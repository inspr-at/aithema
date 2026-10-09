import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createHandlers } from '../src/index.js';
import { mockConsent, testToken, ownedRequest } from '../../../test/helpers.js';
import { createMockReasoning, inputRevision } from '@inspr/aithema-core';
import { instrumentedMockRuntime } from '../../../test/server-fixtures.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const request = (path, body) => ownedRequest(`http://localhost/api/sessions/${path}`, body === undefined ? {} : {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const turn = (handlers, id, clientEventId, content) => handlers.handle(request(`${id}/turns`, { clientEventId, content }));
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  assert.fail('Expected current-revision work before the held call was released');
}

for (const check of ['abort', 'reply']) test(`superseding a held understanding call: ${check}`, async () => {
  const storage = new SQLiteStorage(), mock = createMockReasoning(), started = deferred(), held = deferred();
  let oldSignal, calls = 0, oldReturned = false;
  const reasoning = { ...mock, async structured(...args) {
    if (++calls === 1) { oldSignal = args[1].signal; started.resolve(); await held.promise; oldReturned = true; }
    return mock.structured(...args);
  } };
  const handlers = createHandlers({ storage, reasoning, pluginRuntime: instrumentedMockRuntime(storage, reasoning) });
  try {
    const s = storage.create({ demo: true, ownerToken: testToken });
    await turn(handlers, s.id, 'first', 'First'); await started.promise;
    await turn(handlers, s.id, 'second', 'Second');
    if (check === 'abort') assert.equal(oldSignal.aborted, true, 'obsolete paid work must receive cancellation');
    const revision = inputRevision(storage.get(s.id));
    await waitFor(() => storage.get(s.id).transcript.some(t => t.role === 'assistant' && t.inputRevision === revision));
    assert.equal(oldReturned, false, 'the reply must publish before the cancelled provider call returns');
    held.resolve(); await handlers.idle();
    assert.equal(storage.get(s.id).understanding.inputRevision, revision);
    assert.equal((await handlers.handle(request(s.id)).then(r => r.json())).operations.lastFailure, null);
  } finally { held.resolve(); await handlers.close(); storage.close(); }
});

test('GET retains a sanitized current-revision lane failure and SSE reschedules unfinished work', async () => {
  const storage = new SQLiteStorage(), mock = createMockReasoning(); let calls = 0;
  const reasoning = { ...mock, async structured(...args) {
    if (++calls === 1) throw new Error('private provider diagnostic');
    return mock.structured(...args);
  } };
  const handlers = createHandlers({ storage, reasoning, pluginRuntime: instrumentedMockRuntime(storage, reasoning) });
  let subscription;
  try {
    const s = storage.create({ demo: true, ownerToken: testToken });
    await turn(handlers, s.id, 'first', 'First'); await handlers.idle();
    const snapshot = await handlers.handle(request(s.id)).then(r => r.json());
    assert.deepEqual(snapshot.operations.lastFailure, { inputRevision: inputRevision(snapshot), lane: 'understanding',
      error: 'reasoning-unavailable', retryable: true });
    assert.deepEqual(snapshot.operations.running, []);
    assert.equal(JSON.stringify(snapshot).includes('private provider diagnostic'), false);
    const other = storage.create({ demo: true, ownerToken: testToken });
    assert.equal((await handlers.handle(request(other.id)).then(r => r.json())).operations.lastFailure, null);
    subscription = await handlers.handle(request(`${s.id}/events?after=${snapshot.seq}`));
    await handlers.idle();
    assert.equal(calls, 2);
    assert.equal(storage.get(s.id).understanding.inputRevision, inputRevision(snapshot));
    assert.equal(storage.get(s.id).understanding.draft, false);
    assert.equal((await handlers.handle(request(s.id)).then(r => r.json())).operations.lastFailure, null);
  } finally { await subscription?.body.cancel(); await handlers.close(); storage.close(); }
});

test('a turn queued at scheduler completion is never lost', async () => {
  const storage = new SQLiteStorage(), handlers = createHandlers({ consent: mockConsent, storage }), runs = [];
  const get = storage.get.bind(storage); let queued = false, retry;
  handlers.lanes.run = async (id, lane) => { runs.push({ lane, revision: inputRevision(get(id)) }); return 'completed'; };
  storage.get = id => {
    const session = get(id);
    if (!queued && session.inputRevision === 1 && runs.length === 2) {
      queued = true;
      queueMicrotask(() => {
        const body = { clientEventId: 'second', content: 'Second' };
        storage.postTurn(id, body.clientEventId, Buffer.from(JSON.stringify(body)), body.content);
        retry = handlers.handle(request(`${id}/retry`, {}));
      });
    }
    return session;
  };
  try {
    const s = storage.create({ demo: true, ownerToken: testToken });
    await turn(handlers, s.id, 'first', 'First'); await handlers.idle(); await retry; await handlers.idle();
    assert.equal(queued, true);
    const revision = inputRevision(get(s.id));
    assert.deepEqual(runs.filter(r => r.revision === revision).map(r => r.lane).sort(), ['reaction', 'understanding']);
  } finally { await handlers.close(); storage.close(); }
});

test('8,000 non-ASCII characters fit the request budget; oversized bytes still fail', async () => {
  const storage = new SQLiteStorage(), handlers = createHandlers({ consent: mockConsent, storage });
  try {
    const s = storage.create({ demo: true, ownerToken: testToken }), content = '界'.repeat(8000);
    assert.equal((await turn(handlers, s.id, 'unicode', content)).status, 200);
    assert.equal(storage.get(s.id).transcript[0].content, content);
    assert.equal((await handlers.handle(ownedRequest(`http://localhost/api/sessions/${s.id}/turns`, {
      method: 'POST', body: ' '.repeat(32_769),
    }))).status, 413);
  } finally { await handlers.close(); storage.close(); }
});
