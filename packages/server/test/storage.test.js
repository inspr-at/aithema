import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, ConflictError, createHandlers, exportSession } from '../src/index.js';
import { inputRevision, createMockReasoning } from '@inspr/aithema-core';
import { instrumentedMockRuntime } from '../../../test/server-fixtures.js';
import { temporaryDb, unzip, readEvents } from '../../../test/helpers.js';
const bytes = content => Buffer.from(JSON.stringify({ clientEventId: 'turn1', content }));
test('storage connections wait briefly for another SQLite writer', () => {
  const store = new SQLiteStorage();
  try {
    const timeout = store.db.prepare('PRAGMA busy_timeout').get().timeout;
    assert.ok(timeout >= 100 && timeout <= 1000);
  } finally { store.close(); }
});
test('acknowledged turn and receipt survive close/reopen; append-only events have monotonic seq', async () => {
  const path = await temporaryDb(); let store = new SQLiteStorage(path);
  const session = store.create(), result = store.postTurn(session.id, 'turn1', bytes('hello'), 'hello'); store.close();
  store = new SQLiteStorage(path);
  try {
    assert.equal(store.get(session.id).transcript[0].content, 'hello');
    assert.deepEqual(store.postTurn(session.id, 'turn1', bytes('hello'), 'hello').event, result.event);
    assert.deepEqual(store.read(session.id).map(e => e.seq), [1, 2]);
    assert.throws(() => store.db.exec('UPDATE events SET event=event'), /append only/);
    assert.throws(() => store.db.exec('DELETE FROM events'), /append only/);
  } finally { store.close(); }
});
test('same client id + identical bytes returns original result; different bytes conflict', () => {
  const store = new SQLiteStorage();
  try {
    const s = store.create(), first = store.postTurn(s.id, 'turn1', bytes('hello'), 'hello');
    assert.equal(store.postTurn(s.id, 'turn1', bytes('hello'), 'hello').replayed, true);
    assert.throws(() => store.postTurn(s.id, 'turn1', bytes('changed'), 'changed'), ConflictError);
    assert.throws(() => store.postTurn(s.id, 'turn1', Buffer.from(' ' + bytes('hello')), 'hello'), ConflictError);
    assert.equal(store.get(s.id).transcript.length, 1); assert.equal(first.event.seq, 2);
  } finally { store.close(); }
});
test('stale publication guard rejects a snapshot/event together', () => {
  const store = new SQLiteStorage();
  try {
    const s = store.create(), revision = inputRevision(s); store.postTurn(s.id, 'turn1', bytes('hello'), 'hello');
    assert.equal(store.append(s.id, 'understanding.updated', {}, revision), null);
    assert.equal(store.read(s.id).length, 2);
  } finally { store.close(); }
});
test('turn transaction rolls back event and snapshot if receipt persistence fails', () => {
  const store = new SQLiteStorage();
  try {
    const s = store.create(); store.db.exec("CREATE TRIGGER deny_receipt BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT,'test failure'); END;");
    assert.throws(() => store.postTurn(s.id, 'turn1', bytes('hello'), 'hello'));
    assert.equal(store.get(s.id).transcript.length, 0); assert.equal(store.read(s.id).length, 1);
  } finally { store.close(); }
});
test('SSE Last-Event-ID replays exactly missed durable events and never partial deltas', async () => {
  const store = new SQLiteStorage(), handlers = createHandlers({ storage: store });
  try {
    const s = store.create({ demo: true }); store.postTurn(s.id, 'turn1', bytes('systems: SAP'), 'systems: SAP');
    await handlers.lanes.run(s.id, 'reaction'); await handlers.lanes.run(s.id, 'understanding');
    const missed = store.read(s.id, 2), response = await handlers.handle(new Request(`http://localhost/api/sessions/${s.id}/events`, { headers: { 'Last-Event-ID': '2' } }));
    assert.deepEqual(await readEvents(response, missed.length), missed);
    assert.equal(missed.some(e => e.type === 'turn.partial'), false);
    const invalid = await handlers.handle(new Request(`http://localhost/api/sessions/${s.id}/events`, { headers: { 'Last-Event-ID': '999' } }));
    assert.equal(invalid.status, 400);
  } finally { await handlers.close(); store.close(); }
});
test('export ZIP holds exactly transcript JSON/Markdown and understanding, without confirmation', () => {
  const store = new SQLiteStorage();
  try {
    const s = store.create(); store.postTurn(s.id, 'turn1', bytes('Hello ü'), 'Hello ü');
    const files = unzip(exportSession(store.get(s.id)));
    assert.deepEqual(Object.keys(files), ['transcript.json', 'transcript.md', 'understanding.json']);
    assert.equal(JSON.parse(files['transcript.json']).turns[0].content, 'Hello ü');
    assert.match(files['transcript.md'], /## user\n\nHello ü/u);
    assert.deepEqual(JSON.parse(files['understanding.json']), s.understanding);
  } finally { store.close(); }
});
test('turn acknowledgement happens before reasoning completes and malformed requests are rejected', async () => {
  const store = new SQLiteStorage(), mock = createMockReasoning(); let release;
  const gate = new Promise(r => { release = r; });
  const reasoning = { ...mock, async structured(...args) { await gate; return mock.structured(...args); },
    async *stream(...args) { await gate; yield* mock.stream(...args); } };
  const handlers = createHandlers({ storage: store, reasoning, pluginRuntime: instrumentedMockRuntime(store, reasoning) });
  try {
    const s = store.create({ demo: true });
    const response = await handlers.handle(new Request(`http://localhost/api/sessions/${s.id}/turns`, { method: 'POST', body: bytes('hello') }));
    assert.equal(response.status, 200); assert.equal(store.get(s.id).transcript[0].content, 'hello');
    for (const content of ['', 'a'.repeat(8001)]) assert.equal((await handlers.handle(new Request(`http://localhost/api/sessions/${s.id}/turns`, {
      method: 'POST', body: JSON.stringify({ clientEventId: 'bad', content }),
    }))).status, 400);
  } finally { release(); await handlers.close(); store.close(); }
});
