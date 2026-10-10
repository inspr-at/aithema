import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createHandlers } from '../src/index.js';
import { mockConsent, testToken, ownedRequest, readEvents } from '../../../test/helpers.js';
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

test('AIT-109 L6: escaped Unicode and control-heavy turns fit decoded limits; metadata and wire limits remain', async () => {
  const storage = new SQLiteStorage(), handlers = createHandlers({ storage, consent: mockConsent });
  const session = storage.create({ demo: true, ownerToken: testToken });
  const send = body => handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}/turns`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  }));
  try {
    const content = '界'.repeat(8000);
    const escaped = JSON.stringify({ clientEventId: 'escaped', content }).replaceAll('界', '\\u754c');
    assert.ok(Buffer.byteLength(escaped) > 32_768);
    assert.equal((await send(escaped)).status, 200, 'JSON escaping must not consume the decoded content budget');
    assert.equal(storage.get(session.id).transcript[0].content, content);
    const controls = '\u0001'.repeat(7999) + 'x';
    assert.equal((await turn(handlers, session.id, 'controls', controls)).status, 200);
    assert.equal(storage.get(session.id).transcript.filter(t => t.role === 'user').at(-1).content, controls);
    assert.equal((await send(JSON.stringify({ clientEventId: 'metadata', content: 'x', padding: 'p'.repeat(32_768) }))).status, 413);
    assert.equal((await send(' '.repeat(65_537))).status, 413);
  } finally { await handlers.close(); storage.close(); }
});

test('AIT-109 L2: boot recovery starts only one session at a time and drains the backlog', async () => {
  const storage = new SQLiteStorage(), held = deferred(), started = [];
  const handlers = createHandlers({ storage, consent: mockConsent });
  handlers.lanes.run = async (id, lane) => { started.push({ id, lane }); await held.promise; return 'completed'; };
  Array.from({ length: 4 }, (_, i) => {
    const s = storage.create({ demo: true, ownerToken: testToken });
    storage.postTurn(s.id, `boot-${i}`, Buffer.from('input'), 'input'); return s.id;
  });
  const ids = storage.list();
  try {
    await handlers.resume(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(new Set(started.map(job => job.id)).size, 1, 'boot must not dispatch every saved session together');
    assert.deepEqual(started.map(job => job.lane).sort(), ['reaction', 'understanding']);
    held.resolve(); await handlers.idle();
    assert.deepEqual([...new Set(started.map(job => job.id))], ids, 'idle includes queued boot work');
  } finally { held.resolve(); await handlers.close(); storage.close(); }
});

test('AIT-109 L2: shutdown cancels boot recovery without dispatching queued sessions', async () => {
  const storage = new SQLiteStorage(), held = deferred(), started = [];
  const handlers = createHandlers({ storage, consent: mockConsent });
  handlers.lanes.run = async (id, lane, { signal }) => {
    started.push(id); signal.addEventListener('abort', held.resolve, { once: true });
    await held.promise; return 'completed';
  };
  for (let i = 0; i < 3; i++) {
    const session = storage.create({ demo: true, ownerToken: testToken });
    storage.postTurn(session.id, `boot-${i}`, Buffer.from('input'), 'input');
  }
  try {
    await handlers.resume(); await new Promise(resolve => setImmediate(resolve));
    await handlers.close();
    assert.equal(new Set(started).size, 1, 'shutdown must leave the recovery backlog undispatched');
  } finally { held.resolve(); await handlers.close(); storage.close(); }
});

test('AIT-109 N1: scheduling publishes both running lanes together, including superseded work', { timeout: 3000 }, async () => {
  const storage = new SQLiteStorage(), held = deferred(), handlers = createHandlers({ storage, consent: mockConsent });
  handlers.lanes.run = async () => { await held.promise; return 'completed'; };
  let subscription;
  try {
    const s = storage.create({ demo: true, ownerToken: testToken });
    subscription = await handlers.handle(request(`${s.id}/events?after=${storage.get(s.id).seq}`));
    await turn(handlers, s.id, 'first', 'First');
    const events = await readEvents(subscription, 4); subscription = null;
    const status = events.find(event => event.type === 'lane.status' && event.data.inputRevision === inputRevision(storage.get(s.id)));
    assert.ok(status, 'scheduling must publish the current revision');
    assert.deepEqual(status.data.running.sort(), ['reaction', 'understanding']);
    subscription = await handlers.handle(request(`${s.id}/events?after=${storage.get(s.id).seq}`));
    await turn(handlers, s.id, 'second', 'Second');
    const updated = await readEvents(subscription, 4); subscription = null;
    assert.equal(updated.at(-1).type, 'lane.status');
    assert.equal(updated.at(-1).data.inputRevision, inputRevision(storage.get(s.id)));
    assert.deepEqual(updated.at(-1).data.running.sort(), ['reaction', 'understanding']);
  } finally { await subscription?.body.cancel(); held.resolve(); await handlers.close(); storage.close(); }
});

test('AIT-109 N2: deferred understanding does not reschedule completed work on SSE reconnect', async () => {
  const storage = new SQLiteStorage(), handlers = createHandlers({ storage, consent: mockConsent });
  const run = handlers.lanes.run.bind(handlers.lanes), calls = [];
  handlers.lanes.run = (...args) => { calls.push(args[1]); return run(...args); };
  let subscription;
  try {
    const s = storage.create({ demo: false, ownerToken: testToken });
    await turn(handlers, s.id, 'first', 'First'); await handlers.idle();
    assert.ok(storage.get(s.id).transcript.some(t => t.role === 'assistant'));
    assert.equal(storage.get(s.id).understanding.inputRevision, null);
    const before = calls.length;
    subscription = await handlers.handle(request(`${s.id}/events?after=${storage.get(s.id).seq}`));
    await handlers.idle();
    assert.equal(calls.length, before, 'deferred assessment is not unfinished work');
    await subscription.body.cancel(); subscription = null;
    await turn(handlers, s.id, 'second', 'Second'); await turn(handlers, s.id, 'third', 'Third'); await handlers.idle();
    assert.equal(storage.get(s.id).understanding.inputRevision, inputRevision(storage.get(s.id)));
  } finally { await subscription?.body.cancel(); await handlers.close(); storage.close(); }
});

test('AIT-109 N4: obsolete failure entries are removed when the input revision moves on', async t => {
  const storage = new SQLiteStorage(), handlers = createHandlers({ storage, consent: mockConsent });
  const s = storage.create({ demo: true, ownerToken: testToken });
  let failures;
  const set = Map.prototype.set;
  t.mock.method(Map.prototype, 'set', function (key, value) {
    if (key === s.id && value?.error === 'reasoning-unavailable') failures = this;
    return set.call(this, key, value);
  });
  handlers.lanes.run = async (id, lane) => { if (lane === 'understanding') throw new Error('mock failure'); return 'completed'; };
  try {
    await turn(handlers, s.id, 'first', 'First'); await handlers.idle();
    assert.ok(failures.has(s.id));
    storage.postTurn(s.id, 'second', Buffer.from('Second'), 'Second');
    const snapshot = await handlers.handle(request(s.id)).then(r => r.json());
    assert.equal(snapshot.operations.lastFailure, null);
    assert.equal(failures.has(s.id), false, 'masking a stale failure must also release its map entry');
  } finally { await handlers.close(); storage.close(); }
});
