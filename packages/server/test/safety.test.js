import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createHandlers, exportSession, ConflictError } from '../src/index.js';
import { createMockReasoning, inputRevision, reasoningRequest, applyEvent, createSession } from '@inspr/aithema-core';
import { temporaryDb, startChild, unzip } from '../../../test/helpers.js';
import { instrumentedMockRuntime } from '../../../test/server-fixtures.js';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { coversProcessingScope } from '@inspr/aithema-core';
import { listen } from '../src/http.js';

const token = 'fixture-owner';
const scope = { purpose: 'mock-conversation', recipients: ['mock'], upstreamProcessors: [], dataCategories: ['conversation'], itemVersion: 1 };
const consent = { async coverage({ consentRevision }) { return { covered: true, ...scope, consentRevision, expiresAt: Date.now() + 10000 }; } };
const handlersWith = options => createHandlers({ ...options, pluginRuntime: instrumentedMockRuntime(options.storage, options.reasoning ?? createMockReasoning(), options.consent ?? { coverage: () => ({ covered: false }) }) });
const request = (id, action = '', body, owner = token) => new Request(`http://localhost/api/sessions/${id}${action ? '/' + action : ''}`, {
  headers: { 'x-aithema-session-token': owner, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('every session handler hides another visitor session with 404', async () => {
  const storage = new SQLiteStorage(), handlers = handlersWith({ storage, consent });
  try {
    const s = storage.create({ ownerToken: token, demo: true });
    for (const [action, body] of [['', undefined], ['events', undefined], ['export', undefined], ['turns', { clientEventId: 'x', content: 'x' }],
      ['retry', {}], ['pause', { paused: true }], ['withdraw', { turnId: 'x' }], ['consent', { granted: false }], ['erase', {}]]) {
      assert.equal((await handlers.handle(request(s.id, action, body, 'another-owner'))).status, 404, action);
    }
    assert.equal((await handlers.handle(request(s.id))).status, 200);
  } finally { await handlers.close(); storage.close(); }
});

test('withdrawal erases understanding, assistant context, receipts and journal content after restart and replay', async () => {
  const db = await temporaryDb(); let storage = new SQLiteStorage(db);
  const s = storage.create({ ownerToken: token, demo: true });
  const body = Buffer.from(JSON.stringify({ clientEventId: 'secret-turn', content: 'systems: secret-SAP' }));
  storage.postTurn(s.id, 'secret-turn', body, 'systems: secret-SAP');
  const handlers = handlersWith({ storage, consent });
  await handlers.lanes.run(s.id, 'reaction'); await handlers.lanes.run(s.id, 'understanding');
  assert.match(JSON.stringify(storage.get(s.id).understanding), /secret-SAP/);
  const response = await handlers.handle(request(s.id, 'withdraw', { turnId: 'secret-turn' }));
  assert.equal(response.status, 200);
  assert.equal(storage.get(s.id).understanding.inputRevision, null, 'invalidation persists before ack');
  await handlers.close(); storage.close(); storage = new SQLiteStorage(db);
  try {
    const restored = storage.get(s.id);
    assert.equal(JSON.stringify(restored).includes('secret-SAP'), false);
    assert.equal(JSON.stringify(reasoningRequest(restored, 'reaction')).includes('secret-SAP'), false);
    assert.equal(JSON.stringify(unzip(exportSession(restored))).includes('secret-SAP'), false);
    assert.equal(JSON.stringify(storage.db.prepare('SELECT * FROM events').all()).includes('secret-SAP'), false);
    assert.equal(JSON.stringify(storage.db.prepare('SELECT * FROM receipts').all()).includes('secret-SAP'), false);
    const events = storage.read(s.id);
    assert.equal(events.find(e => e.type === 'turn.final').data.erased, true);
    let replay = createSession({ id: s.id, demo: true });
    for (const event of events) replay = applyEvent(replay, event);
    assert.equal(JSON.stringify(replay).includes('secret-SAP'), false);
    assert.equal(replay.transcript.find(t => t.id === 'secret-turn').erased, true);
    assert.equal(storage.postTurn(s.id, 'secret-turn', body, 'systems: secret-SAP').event.data.erased, true);
  } finally { storage.close(); }
});

test('consent withdrawal aborts held calls immediately and ignores a provider late result', async () => {
  const storage = new SQLiteStorage(), mock = createMockReasoning(), gate = deferred(), started = deferred();
  let signal;
  const handlers = handlersWith({ storage, consent, reasoning: { ...mock, async structured(request, options) {
    const result = await mock.structured(request, options); signal = options.signal; started.resolve(); await gate.promise; return result;
  } } });
  try {
    const s = storage.create({ ownerToken: token, demo: true });
    await handlers.handle(request(s.id, 'turns', { clientEventId: 't', content: 'Hello' })); await started.promise;
    assert.equal((await handlers.handle(request(s.id, 'consent', { granted: false }))).status, 200);
    assert.equal(signal.aborted, true);
    const seq = storage.get(s.id).seq; gate.resolve(); await handlers.idle();
    assert.equal(storage.get(s.id).seq, seq);
    assert.equal(storage.get(s.id).understanding.inputRevision, null);
  } finally { gate.resolve(); await handlers.close(); storage.close(); }
});

test('pause persists, serves cached state and allows joining but starts no new paid call', async () => {
  const storage = new SQLiteStorage(), mock = createMockReasoning(); let calls = 0;
  const handlers = handlersWith({ storage, consent, reasoning: { ...mock, async structured(...args) { calls++; return mock.structured(...args); },
    async *stream(...args) { calls++; yield* mock.stream(...args); } } });
  try {
    const s = storage.create({ ownerToken: token, demo: true });
    await handlers.handle(request(s.id, 'turns', { clientEventId: 'one', content: 'One' })); await handlers.idle();
    const cached = storage.get(s.id).understanding;
    assert.equal((await handlers.handle(request(s.id, 'pause', { paused: true })).then(r => r.json())).paused, true);
    assert.deepEqual((await handlers.handle(request(s.id)).then(r => r.json())).understanding, cached);
    const before = calls;
    await handlers.handle(request(s.id, 'turns', { clientEventId: 'two', content: 'Two' })); await handlers.idle();
    assert.equal(calls, before);
    assert.equal(await handlers.lanes.run(s.id, 'understanding'), 'paused');
    assert.equal((await handlers.handle(request(s.id, 'pause', { paused: false })).then(r => r.json())).paused, false);
    await handlers.idle(); assert.ok(calls > before);
  } finally { await handlers.close(); storage.close(); }
});

test('a second server process refuses the same database; a crashed writer releases its lock', { timeout: 10000 }, async t => {
  const db = await temporaryDb(), file = new URL('../bin/server.js', import.meta.url);
  let first = await startChild(file, db); t.after(() => first.kill());
  await assert.rejects(async () => { const second = await startChild(file, db); await second.kill(); }, /exited before ready/);
  await first.kill('SIGKILL'); first = await startChild(file, db);
});

test('ownership and tombstone precede dedup; stale revisions reject only new turns', () => {
  const storage = new SQLiteStorage();
  try {
    const s = storage.create({ ownerToken: token }), body = Buffer.from('original');
    storage.postTurn(s.id, 'first', body, 'original');
    const guard = { ownerToken: token, revision: inputRevision(storage.get(s.id)) };
    storage.postTurn(s.id, 'second', Buffer.from('second'), 'second');
    assert.equal(storage.postTurn(s.id, 'first', body, 'original', guard).replayed, true);
    assert.throws(() => storage.postTurn(s.id, 'new', body, 'original', guard), ConflictError);
    assert.throws(() => storage.postTurn(s.id, 'first', body, 'original', { ownerToken: 'wrong' }));
    storage.erase(s.id);
    assert.throws(() => storage.postTurn(s.id, 'first', body, 'original'));
    assert.equal(JSON.stringify(storage.read(s.id)).includes('original'), false);
  } finally { storage.close(); }
});

test('missing or expired consent and incomplete processor coverage fail closed before dispatch', async () => {
  for (const port of [undefined, { coverage() { throw new Error('unavailable'); } },
    { coverage() { return { covered: true, ...scope, expiresAt: Date.now() - 1 }; } },
    { coverage() { return { covered: true, ...scope, recipients: [], expiresAt: Date.now() + 10000 }; } }]) {
    const storage = new SQLiteStorage(), mock = createMockReasoning(); let calls = 0;
    const handlers = handlersWith({ storage, consent: port, reasoning: { ...mock, async structured(...args) { calls++; return mock.structured(...args); },
      async *stream(...args) { calls++; yield* mock.stream(...args); } } });
    try {
      const s = storage.create({ ownerToken: token, demo: true });
      await handlers.handle(request(s.id, 'turns', { clientEventId: 't', content: 'Hello' })); await handlers.idle();
      assert.equal(calls, 0);
    } finally { await handlers.close(); storage.close(); }
  }
});

test('consent scope binds purpose, every recipient and upstream, data, item version, revision and expiry', () => {
  const actual = { ...scope, upstreamProcessors: ['processor'] }, now = Date.now();
  const grant = { covered: true, ...actual, consentRevision: 3, expiresAt: now + 1 };
  assert.equal(coversProcessingScope(grant, actual, 3, now), true);
  for (const change of [{ purpose: 'different' }, { recipients: [] }, { upstreamProcessors: [] }, { dataCategories: [] },
    { itemVersion: 2 }, { consentRevision: 2 }, { expiresAt: now }, { covered: false }]) {
    assert.equal(coversProcessingScope({ ...grant, ...change }, actual, 3, now), false);
  }
});

test('pause survives restart and an existing pass can be joined while paused', async () => {
  const path = await temporaryDb(), mock = createMockReasoning(), started = deferred(), gate = deferred();
  let storage = new SQLiteStorage(path), calls = 0;
  const s = storage.create({ ownerToken: token, demo: true }); storage.postTurn(s.id, 't', Buffer.from('Hello'), 'Hello');
  let handlers = handlersWith({ storage, consent, reasoning: { ...mock, async structured(...args) {
    calls++; const value = await mock.structured(...args); started.resolve(); await gate.promise; return value;
  } } });
  try {
    const first = handlers.lanes.run(s.id, 'understanding'); await started.promise;
    await handlers.handle(request(s.id, 'pause', { paused: true }));
    assert.equal(handlers.lanes.run(s.id, 'understanding'), first);
    gate.resolve(); assert.equal(await first, 'completed'); assert.equal(calls, 1);
    await handlers.close(); storage.close(); storage = new SQLiteStorage(path);
    handlers = handlersWith({ storage, consent }); handlers.resume(); await handlers.idle();
    assert.equal(storage.get(s.id).paused, true);
    assert.equal(await handlers.lanes.run(s.id, 'understanding'), 'cached');
    assert.equal(await handlers.lanes.run(s.id, 'reaction'), 'paused');
  } finally { gate.resolve(); await handlers.close(); storage.close(); }
});

test('withdrawal rolls back content erasure and projection invalidation if the durable event fails', async () => {
  const storage = new SQLiteStorage(), handlers = handlersWith({ storage, consent });
  try {
    const s = storage.create({ ownerToken: token, demo: true }); storage.postTurn(s.id, 't', Buffer.from('systems: SAP'), 'systems: SAP');
    await handlers.lanes.run(s.id, 'understanding'); const before = storage.get(s.id);
    storage.db.exec("CREATE TRIGGER fail_withdraw BEFORE INSERT ON events WHEN json_extract(NEW.event,'$.type')='turn.withdrawn' BEGIN SELECT RAISE(ABORT,'failure'); END;");
    assert.equal((await handlers.handle(request(s.id, 'withdraw', { turnId: 't' }))).status, 500);
    assert.deepEqual(storage.get(s.id), before);
    assert.equal(storage.getRecord(s.id, before.transcript[0].contentRef).data.content, 'systems: SAP');
  } finally { await handlers.close(); storage.close(); }
});

test('expiry uses withdrawal invalidation and rebuilds understanding only from remaining turns', async () => {
  const storage = new SQLiteStorage(), handlers = handlersWith({ storage, consent });
  try {
    const s = storage.create({ ownerToken: token, demo: true });
    storage.postTurn(s.id, 'old', Buffer.from('systems: old-secret'), 'systems: old-secret');
    storage.postTurn(s.id, 'remaining', Buffer.from('data: public'), 'data: public');
    await handlers.lanes.run(s.id, 'understanding');
    const event = storage.expire(s.id, 'old'); assert.equal(event.data.reason, 'expiry');
    assert.equal(storage.get(s.id).understanding.inputRevision, null);
    await handlers.lanes.run(s.id, 'understanding');
    assert.equal(storage.get(s.id).understanding.constraints.systems, null);
    assert.equal(storage.get(s.id).understanding.constraints.data.value, 'public');
    assert.equal(JSON.stringify(storage.get(s.id)).includes('old-secret'), false);
  } finally { await handlers.close(); storage.close(); }
});

test('invalidation during a pending consent check prevents paid dispatch', async () => {
  const storage = new SQLiteStorage(), gate = deferred(), started = deferred(), mock = createMockReasoning(); let calls = 0;
  const handlers = handlersWith({ storage, consent: { async coverage(query) { started.resolve(); await gate.promise; return consent.coverage(query); } },
    reasoning: { ...mock, async structured(...args) { calls++; return mock.structured(...args); } } });
  try {
    const s = storage.create({ ownerToken: token, demo: true }); storage.postTurn(s.id, 't', Buffer.from('Hello'), 'Hello');
    const run = handlers.lanes.run(s.id, 'understanding'); await started.promise;
    await handlers.withdrawConsent(s.id); gate.resolve(); await run.catch(() => {}); assert.equal(calls, 0);
  } finally { gate.resolve(); await handlers.close(); storage.close(); }
});

test('erasure checkpoints content out of the database and WAL before acknowledgement', async () => {
  const path = await temporaryDb(), storage = new SQLiteStorage(path);
  try {
    const s = storage.create({ ownerToken: token }); storage.postTurn(s.id, 't', Buffer.from('erase-unique-fixture'), 'erase-unique-fixture');
    storage.withdraw(s.id, 't');
    for (const file of [path, path + '-wal']) {
      const bytes = await readFile(file).catch(error => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; });
      assert.equal(bytes.includes(Buffer.from('erase-unique-fixture')), false, file.endsWith('-wal') ? 'WAL' : 'database');
    }
  } finally { storage.close(); }
});

test('legacy databases migrate to metadata-only events and receipts without losing content or ids', async () => {
  const path = await temporaryDb(), db = new DatabaseSync(path), s = createSession({ id: 'legacy', demo: true });
  const event = { sessionId: s.id, seq: 2, type: 'turn.final', data: { id: 'old', role: 'user', content: 'legacy-fixture', at: '2026-10-01T00:00:00.000Z' } };
  db.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY,snapshot TEXT); CREATE TABLE events(session_id TEXT,seq INTEGER,event TEXT,PRIMARY KEY(session_id,seq)); CREATE TABLE receipts(session_id TEXT,client_id TEXT,bytes BLOB,result TEXT,PRIMARY KEY(session_id,client_id));');
  db.prepare('INSERT INTO sessions VALUES (?,?)').run(s.id, JSON.stringify(applyEvent(s, event)));
  db.prepare('INSERT INTO events VALUES (?,?,?)').run(s.id, 1, JSON.stringify({ sessionId: s.id, seq: 1, type: 'session.created', data: { id: s.id } }));
  db.prepare('INSERT INTO events VALUES (?,?,?)').run(s.id, 2, JSON.stringify(event));
  db.prepare('INSERT INTO receipts VALUES (?,?,?,?)').run(s.id, 'old', Buffer.from('original'), JSON.stringify(event)); db.close();
  const storage = new SQLiteStorage(path);
  try {
    assert.equal(storage.get(s.id).transcript[0].content, 'legacy-fixture');
    assert.equal(storage.postTurn(s.id, 'old', Buffer.from('original'), 'legacy-fixture').event.seq, 2);
    assert.equal(JSON.stringify(storage.db.prepare('SELECT * FROM events').all()).includes('legacy-fixture'), false);
    assert.equal(JSON.stringify(storage.db.prepare('SELECT * FROM receipts').all()).includes('legacy-fixture'), false);
    storage.withdraw(s.id, 'old'); assert.equal(storage.read(s.id)[1].data.erased, true);
  } finally { storage.close(); }
});

test('withdrawal rebuilds remaining input without waiting for a provider that ignores cancellation', async () => {
  const storage = new SQLiteStorage(), mock = createMockReasoning(), started = deferred(), gate = deferred(); let calls = 0, oldSignal;
  const handlers = handlersWith({ storage, consent, reasoning: { ...mock, async structured(request, options) {
    const value = await mock.structured(request, options);
    if (++calls === 1) { oldSignal = options.signal; started.resolve(); await gate.promise; }
    return value;
  } } });
  try {
    const s = storage.create({ ownerToken: token, demo: true });
    storage.postTurn(s.id, 'old', Buffer.from('systems: old-input'), 'systems: old-input');
    storage.postTurn(s.id, 'kept', Buffer.from('data: public'), 'data: public');
    const old = handlers.lanes.run(s.id, 'understanding'); old.catch(() => {}); await started.promise;
    await handlers.handle(request(s.id, 'withdraw', { turnId: 'old' }));
    assert.equal(oldSignal.aborted, true);
    for (let i = 0; i < 50 && storage.get(s.id).understanding.inputRevision === null; i++) await new Promise(r => setTimeout(r, 2));
    assert.equal(storage.get(s.id).understanding.inputRevision, inputRevision(storage.get(s.id)));
    const seq = storage.get(s.id).seq; gate.resolve(); await old.catch(() => {}); await handlers.idle();
    assert.equal(storage.get(s.id).seq, seq);
    assert.equal(JSON.stringify(storage.get(s.id)).includes('old-input'), false);
  } finally { gate.resolve(); await handlers.close(); storage.close(); }
});

test('coverage expiry is checked after the host returns its asynchronous grant', async () => {
  const { consentCoverage } = await import('@inspr/aithema-core');
  const session = createSession(), expiresAt = Date.now() + 5;
  const port = { async coverage() {
    await new Promise(resolve => setTimeout(resolve, 15));
    return { covered: true, ...scope, consentRevision: session.consentRevision, expiresAt };
  } };
  assert.equal(await consentCoverage(port, session, scope), false);
});

test('identical HTTP resend replays its receipt after success even with the original inputRevision', async () => {
  const storage = new SQLiteStorage(), handlers = handlersWith({ storage, consent });
  try {
    const s = storage.create({ ownerToken: token, demo: true });
    const body = { clientEventId: 'revision-retry', content: 'Hello', inputRevision: inputRevision(s) };
    const first = await handlers.handle(request(s.id, 'turns', body));
    assert.equal(first.status, 200);
    const event = await first.json(); await handlers.idle();
    const seq = storage.get(s.id).seq;
    const replay = await handlers.handle(request(s.id, 'turns', body));
    assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), event);
    await handlers.idle(); assert.equal(storage.get(s.id).seq, seq);
    assert.equal((await handlers.handle(request(s.id, 'turns', { ...body, clientEventId: 'new-turn' }))).status, 409);
    assert.equal((await handlers.handle(request(s.id, 'turns', { ...body, content: 'Changed' }))).status, 409);
    assert.equal((await handlers.handle(request(s.id, 'turns', body, 'wrong'))).status, 404);
    await handlers.handle(request(s.id, 'erase', {}));
    assert.equal((await handlers.handle(request(s.id, 'turns', body))).status, 404);
  } finally { await handlers.close(); storage.close(); }
});

for (const action of ['withdrawConsent', 'expire']) {
  test(`host ${action} waits for lane cancellation to settle before acknowledgement`, async () => {
    const storage = new SQLiteStorage(), gate = deferred();
    const mock = createMockReasoning(), started = deferred(), provider = deferred(); let signal;
    const handlers = handlersWith({ storage, consent, reasoning: { ...mock, async structured(req, options) {
      signal = options.signal; started.resolve(); await provider.promise; return mock.structured(req, options);
    } } });
    let pending;
    try {
      const s = storage.create({ ownerToken: token, demo: true });
      storage.postTurn(s.id, 't', Buffer.from('Hello'), 'Hello');
      const run = handlers.lanes.run(s.id, 'understanding'); run.catch(() => {}); await started.promise;
      const cancel = handlers.lanes.cancel.bind(handlers.lanes);
      handlers.lanes.cancel = async id => { await cancel(id); await gate.promise; };
      let acknowledged = false;
      pending = Promise.resolve(action === 'expire' ? handlers.expire(Date.now() + 1000)
        : handlers.withdrawConsent(s.id)).then(value => { acknowledged = true; return value; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(signal.aborted, true);
      assert.equal(acknowledged, false, 'the host must await the cancellation promise');
      gate.resolve(); await pending;
      assert.equal(acknowledged, true); await run.catch(() => {});
    } finally {
      gate.resolve(); provider.resolve(); await pending; await handlers.close(); storage.close();
    }
  });
}

test('snapshot retries are bounded while events keep arriving during the feature check', { timeout: 1000 }, async () => {
  const storage = new SQLiteStorage(), runtime = instrumentedMockRuntime(storage, createMockReasoning(), consent);
  let checks = 0;
  const handlers = createHandlers({ storage, consent, pluginRuntime: { ...runtime, async matrix(session) {
    checks++;
    if (checks <= 10) storage.pause(session.id, Boolean(checks % 2));
    return runtime.matrix(session);
  } } });
  try {
    const s = storage.create({ ownerToken: token });
    const response = await handlers.handle(request(s.id));
    assert.equal(response.status, 409, 'a busy session yields a retryable conflict');
    assert.equal(checks, 3);
    assert.equal(JSON.stringify(await response.json()).includes('ownerHash'), false);
    checks = 10;
    assert.equal((await handlers.handle(request(s.id))).status, 200, 'later stable snapshots succeed');
  } finally { await handlers.close(); storage.close(); }
});

test('consent withdrawal stops reaction deltas and ignores a stream that returns late', async () => {
  const storage = new SQLiteStorage(), mock = createMockReasoning(), held = deferred(), started = deferred();
  let signal;
  const handlers = handlersWith({ storage, consent, reasoning: { ...mock, async *stream(req, options) {
    signal = options.signal; yield 'Before revocation'; started.resolve(); await held.promise; yield 'Late private delta';
  } } });
  let subscription, collected = '';
  try {
    const s = storage.create({ ownerToken: token, demo: true });
    subscription = await handlers.handle(request(s.id, 'events'));
    const reader = subscription.body.getReader();
    const reading = (async () => { while (true) {
      const { done, value } = await reader.read(); if (done) return;
      collected += new TextDecoder().decode(value);
    } })();
    await handlers.handle(request(s.id, 'turns', { clientEventId: 'reaction', content: 'Hello' }));
    await started.promise;
    assert.match(collected, /Before revocation/);
    assert.equal((await handlers.handle(request(s.id, 'consent', { granted: false }))).status, 200);
    assert.equal(signal.aborted, true);
    const seq = storage.get(s.id).seq; held.resolve(); await handlers.idle();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(storage.get(s.id).seq, seq);
    assert.equal(collected.includes('Late private delta'), false);
    assert.equal(storage.get(s.id).transcript.some(turn => turn.role === 'assistant' && !turn.erased), false);
    await reader.cancel(); await reading;
  } finally { held.resolve(); await handlers.close(); storage.close(); }
});

test('erase handler removes content before acknowledgement and closes every visitor route across restart', async () => {
  const path = await temporaryDb(); let storage = new SQLiteStorage(path), handlers = handlersWith({ storage, consent });
  const { server, url } = await listen(request => handlers.handle(request));
  const call = (id, action = '', body) => fetch(`${url}/api/sessions/${id}${action ? '/' + action : ''}`, {
    headers: { 'x-aithema-session-token': token, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
  try {
    const created = await fetch(url + '/api/sessions', { method: 'POST', body: '{}',
      headers: { 'x-aithema-session-token': token, 'content-type': 'application/json' } });
    assert.equal(created.status, 201); const s = await created.json();
    assert.equal((await call(s.id, 'turns', { clientEventId: 'erase-handler', content: 'systems: erase-handler-private' })).status, 200);
    await handlers.idle();
    const response = await call(s.id, 'erase', {});
    assert.equal(response.status, 200);
    const ack = await response.json(); assert.equal(ack.erased, true); assert.equal(ack.providerDeletion, 'not-confirmed');
    assert.equal(ack.event.type, 'session.erased'); assert.ok(storage.get(s.id).tombstone);
    assert.equal(JSON.stringify(storage.get(s.id)).includes('erase-handler-private'), false);
    assert.equal(storage.db.prepare('SELECT count(*) AS n FROM content WHERE bytes IS NOT NULL').get().n, 0);
    for (const file of [path, path + '-wal']) {
      const bytes = await readFile(file).catch(error => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; });
      assert.equal(bytes.includes(Buffer.from('erase-handler-private')), false);
    }
    await handlers.close(); storage.close(); storage = new SQLiteStorage(path); handlers = handlersWith({ storage, consent });
    for (const [action, body] of [['', undefined], ['events', undefined], ['export', undefined], ['retry', {}], ['pause', { paused: false }],
      ['withdraw', { turnId: 'erase-handler' }], ['consent', { granted: true }], ['erase', {}],
      ['turns', { clientEventId: 'erase-handler', content: 'systems: erase-handler-private' }]]) {
      assert.equal((await call(s.id, action, body)).status, 404, action);
    }
    assert.equal(JSON.stringify(unzip(exportSession(storage.get(s.id)))).includes('erase-handler-private'), false);
  } finally {
    await handlers.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); storage.close();
  }
});

test('missing content rows load as tombstones in snapshots, events, receipts, export and after restart', async () => {
  const path = await temporaryDb(); let storage = new SQLiteStorage(path), handlers = handlersWith({ storage, consent });
  try {
    const s = storage.create({ ownerToken: token, demo: true, actor: { evidence: 'selected', name: 'missing-actor-private' } });
    const body = Buffer.from(JSON.stringify({ clientEventId: 'missing', content: 'systems: missing-content-private' }));
    storage.postTurn(s.id, 'missing', body, 'systems: missing-content-private');
    await handlers.lanes.run(s.id, 'reaction'); await handlers.lanes.run(s.id, 'understanding');
    storage.db.prepare('DELETE FROM content WHERE session_id=?').run(s.id);
    await handlers.close(); storage.close(); storage = new SQLiteStorage(path); handlers = handlersWith({ storage, consent });
    const restored = storage.get(s.id);
    assert.ok(restored.transcript.every(turn => turn.erased && turn.withdrawn && turn.content === undefined));
    assert.equal(restored.understanding.inputRevision, null); assert.equal(restored.actor, null);
    assert.equal(storage.getRecord(s.id, restored.transcript[0].contentRef).tombstone, 'missing');
    assert.equal(storage.postTurn(s.id, 'missing', body, 'systems: missing-content-private').event.data.erased, true);
    assert.ok(storage.read(s.id).filter(event => ['turn.final', 'understanding.updated'].includes(event.type)).every(event => event.data.erased));
    assert.equal(JSON.stringify(reasoningRequest(restored, 'reaction')).includes('missing-content-private'), false);
    assert.equal(JSON.stringify(unzip(exportSession(restored))).includes('missing-content-private'), false);
    const response = await handlers.handle(request(s.id)); assert.equal(response.status, 200);
    assert.equal(JSON.stringify(await response.json()).includes('missing-content-private'), false);
  } finally { await handlers.close(); storage.close(); }
});
