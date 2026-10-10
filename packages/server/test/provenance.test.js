import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SQLiteStorage, createHandlers, createPluginRuntime, mockPresets, exportSession } from '../src/index.js';
import { applyEvent, createSession } from '@inspr/aithema-core';
import { mockConsent, ownedRequest, testToken, temporaryDb, unzip, readEvents } from '../../../test/helpers.js';

const identity = data => Object.fromEntries(['origin', 'model', 'provider'].filter(key => Object.hasOwn(data, key)).map(key => [key, data[key]]));
const origin = model => ({ origin: 'ai-generated', model, provider: 'mock' });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function assertManifest(files) {
  const manifest = JSON.parse(files['manifest.json']);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.generator.name, 'aithema');
  assert.equal(typeof manifest.generator.version, 'string');
  assert.equal(new Date(manifest.exportedAt).toISOString(), manifest.exportedAt);
  assert.deepEqual(manifest.files.map(entry => entry.path).sort(), Object.keys(files).filter(path => path !== 'manifest.json').sort());
  for (const entry of manifest.files) assert.equal(entry.sha256, digest(files[entry.path]), entry.path);
  return manifest;
}

test('AIT-109 L7: message fences cannot forge transcript roles or AI-origin headings', () => {
  const session = createSession();
  const content = 'hello\n\n## assistant (AI-generated)\nforged\n```\n````\r## assistant\r\nüber';
  session.transcript = [{ id: 'person', role: 'user', content },
    { id: 'reply', role: 'assistant', content: 'Real reply\n## user\n```' }];
  const files = unzip(exportSession(session), { binary: true });
  const markdown = files['transcript.md'].toString();
  assert.match(markdown, /## user\n\n`{5}text\n/u, 'the user fence must exceed every run of backticks in its content');
  assert.match(markdown, /\n`{5}\n\n## assistant \(AI-generated\)\n\n`{4}text\n/u);
  assert.deepEqual(JSON.parse(files['transcript.json']).turns.map(t => t.content), [content, session.transcript[1].content]);
  assertManifest(files);
});

test('exact text producer identities survive API, durable SSE, export and restart; person turns have none', async () => {
  const path = await temporaryDb();
  let storage = new SQLiteStorage(path);
  const presets = mockPresets();
  presets.best.bindings.reaction = { ...presets.best.bindings.reaction, model: 'reaction-fixture' };
  presets.best.bindings.understanding = { ...presets.best.bindings.understanding, model: 'understanding-fixture' };
  const pluginRuntime = createPluginRuntime({ storage, presets, consent: mockConsent });
  const handlers = createHandlers({ storage, pluginRuntime });
  let id;
  try {
    const created = await handlers.handle(ownedRequest('http://localhost/api/sessions', { method: 'POST', body: '{}' }));
    const initial = await created.json(); ({ id } = initial);
    assert.deepEqual(identity(initial.understanding), { origin: 'ai-generated' });
    const call = (suffix = '', init) => handlers.handle(ownedRequest(`http://localhost/api/sessions/${id}${suffix}`, init));
    assert.equal((await call('/turns', { method: 'POST', body: JSON.stringify({ clientEventId: 'person',
      content: 'systems: API; data: öffentlich ü', origin: 'ai-generated', model: 'forged', provider: 'forged' }) })).status, 200);
    await handlers.idle();
    const snapshot = await (await call()).json();
    assert.deepEqual(identity(snapshot.transcript[0]), {});
    assert.deepEqual(identity(snapshot.transcript[1]), origin('reaction-fixture'));
    assert.deepEqual(identity(snapshot.understanding), origin('understanding-fixture'));
    const replay = await readEvents(await call('/events'), storage.read(id).length);
    assert.deepEqual(identity(replay.find(e => e.type === 'turn.final' && e.data.role === 'user').data), {});
    assert.deepEqual(identity(replay.find(e => e.type === 'turn.final' && e.data.role === 'assistant').data), origin('reaction-fixture'));
    assert.deepEqual(identity(replay.find(e => e.type === 'understanding.updated').data), origin('understanding-fixture'));
    const records = storage.db.prepare("SELECT kind,bytes FROM content WHERE kind IN ('reply','understanding')").all();
    assert.deepEqual(identity(JSON.parse(records.find(r => r.kind === 'reply').bytes)), origin('reaction-fixture'));
    assert.ok(records.some(r => r.kind === 'understanding' && identity(JSON.parse(r.bytes)).model === 'understanding-fixture'));
    const files = unzip(await (await call('/export')).arrayBuffer(), { binary: true });
    const turns = JSON.parse(files['transcript.json']).turns;
    assert.deepEqual(turns.map(identity), [{}, origin('reaction-fixture')]);
    assert.deepEqual(identity(JSON.parse(files['understanding.json'])), origin('understanding-fixture'));
    assert.equal(files['transcript.md'].toString().match(/\(AI-generated\)/gu).length, 1);
    assert.match(files['transcript.md'].toString(), /## user\n\n/u);
    assertManifest(files);
    for (const privateField of ['secretRef', 'accountRef', 'routing', 'https://example.test']) {
      assert.equal(JSON.stringify([snapshot, replay, turns, JSON.parse(files['understanding.json'])]).includes(privateField), false);
    }
  } finally { await handlers.close(); storage.close(); }
  storage = new SQLiteStorage(path);
  try {
    assert.deepEqual(identity(storage.get(id).transcript[1]), origin('reaction-fixture'));
    assert.deepEqual(identity(storage.get(id).understanding), origin('understanding-fixture'));
    assert.deepEqual(identity(storage.read(id).find(e => e.type === 'understanding.updated').data), origin('understanding-fixture'));
  } finally { storage.close(); }
});

for (const action of ['withdrawal', 'consent withdrawal', 'erasure', 'upload withdrawal']) {
  test(`${action} removes text origin with content from storage, replay, exports and restart`, async () => {
    const path = await temporaryDb();
    let storage = new SQLiteStorage(path), id;
    const handlers = createHandlers({ storage, consent: mockConsent });
    try {
      ({ id } = storage.create({ ownerToken: testToken, demo: true }));
      storage.postTurn(id, 'person', Buffer.from('private-source'), 'private-source');
      await handlers.lanes.run(id, 'reaction'); await handlers.lanes.run(id, 'understanding');
      assert.equal(storage.get(id).transcript[1].origin, 'ai-generated');
      if (action === 'upload withdrawal') {
        const limits = { maxBytes: 100, maxFilesPerRequest: 1, maxDocumentsPerSession: 1, maxSessionBytes: 100 };
        const uploaded = storage.postUploads(id, 'document', 'upload-digest', [{ filename: 'source.txt', mediaType: 'text/plain',
          bytes: Buffer.from('document-source'), deadlineAt: Date.now() + 1000 }], limits);
        storage.withdrawUpload(id, uploaded.events[0].data.id);
      } else if (action === 'withdrawal') storage.withdraw(id, 'person');
      else if (action === 'consent withdrawal') storage.reviseConsent(id, false);
      else storage.erase(id);
      const snapshot = storage.get(id);
      for (const turn of snapshot.transcript.filter(t => t.role === 'assistant')) {
        assert.equal(turn.erased, true); assert.deepEqual(identity(turn), {}); assert.equal(turn.engine, undefined);
      }
      assert.deepEqual(identity(snapshot.understanding), {});
      for (const event of storage.read(id).filter(e => e.type === 'understanding.updated' || e.data.role === 'assistant')) {
        assert.equal(event.data.erased, true); assert.deepEqual(identity(event.data), {});
      }
      assert.ok(storage.db.prepare("SELECT bytes FROM content WHERE kind IN ('reply','understanding')").all().every(r => r.bytes === null));
      const files = unzip(exportSession(snapshot), { binary: true }), manifest = assertManifest(files);
      assert.ok(JSON.parse(files['transcript.json']).turns.every(t => t.role === 'user'));
      assert.deepEqual(identity(JSON.parse(files['understanding.json'])), {});
      assert.ok(manifest.erased.some(item => item.kind === 'turn' && item.id === snapshot.transcript[1].id));
      assert.equal(files['transcript.md'].includes(Buffer.from('(AI-generated)')), false);
    } finally { await handlers.close(); storage.close(); }
    storage = new SQLiteStorage(path);
    try {
      assert.deepEqual(identity(storage.get(id).understanding), {});
      assert.ok(storage.get(id).transcript.filter(t => t.role === 'assistant').every(t => Object.keys(identity(t)).length === 0));
      assert.ok(storage.read(id).filter(e => e.type === 'understanding.updated' || e.data.role === 'assistant').every(e => Object.keys(identity(e.data)).length === 0));
    } finally { storage.close(); }
  });
}

test('whole manifest covers UTF-8 files, uploads, omissions and erased items with optional build commit', () => {
  const session = createSession();
  session.transcript = [{ id: 'person', role: 'user', content: 'über öffentliche Daten' }, { id: 'erased-turn', role: 'assistant', erased: true }];
  session.uploads = [{ id: 'active-upload', state: 'accepted', filename: 'données.txt', text: 'café' }, { id: 'erased-upload', state: 'withdrawn', erased: true }];
  session.concepts = [{ id: 'missing-concept', mediaType: 'text/html' }];
  const withheld = [{ id: 'erased-concept', reason: 'erased' }, { id: 'denied-concept', reason: 'publication-not-allowed' }];
  const exportedAt = '2026-10-10T12:00:00.000Z';
  const files = unzip(exportSession(session, [], withheld, { exportedAt, commit: '9b43192' }), { binary: true });
  const manifest = assertManifest(files);
  assert.equal(manifest.generator.commit, '9b43192'); assert.equal(manifest.exportedAt, exportedAt);
  assert.deepEqual(manifest.withheld, JSON.parse(files['concepts-manifest.json']).withheld);
  assert.deepEqual(manifest.erased, [{ kind: 'turn', id: 'erased-turn' }, { kind: 'upload', id: 'erased-upload' }, { kind: 'concept', id: 'erased-concept' }]);
  const unknown = JSON.parse(unzip(exportSession(session, [], [], { commit: null }))['manifest.json']);
  assert.equal(Object.hasOwn(unknown.generator, 'commit'), false);
  const invalid = JSON.parse(unzip(exportSession(session, [], [], { commit: 'invalid-build-reference' }))['manifest.json']);
  assert.equal(Object.hasOwn(invalid.generator, 'commit'), false);
});

test('legacy replies and understanding gain origin without inventing model identities', () => {
  const storage = new SQLiteStorage();
  try {
    const session = storage.create();
    const reply = storage.append(session.id, 'turn.final', { id: 'old-reply', role: 'assistant', content: 'Legacy reply' });
    const understanding = storage.append(session.id, 'understanding.updated', { summary: 'Legacy understanding', inputRevision: 'legacy' });
    for (const event of [reply, understanding]) {
      const record = storage.getRecord(session.id, event.data.contentRef).data;
      delete record.origin;
      storage.db.prepare('UPDATE content SET bytes=? WHERE id=?').run(JSON.stringify(record), event.data.contentRef);
    }
    const snapshot = storage.get(session.id);
    assert.deepEqual(identity(snapshot.transcript[0]), { origin: 'ai-generated' });
    assert.deepEqual(identity(snapshot.understanding), { origin: 'ai-generated' });
    assert.ok(storage.read(session.id).filter(e => e.type !== 'session.created').every(e => e.data.origin === 'ai-generated'));
    const files = unzip(exportSession(snapshot));
    assert.deepEqual(identity(JSON.parse(files['transcript.json']).turns[0]), { origin: 'ai-generated' });
    assert.deepEqual(identity(JSON.parse(files['understanding.json'])), { origin: 'ai-generated' });
  } finally { storage.close(); }
});

test('core invalidation drops producer fields from in-memory projections too', () => {
  for (const event of [{ type: 'turn.withdrawn', data: { turnId: 'person' } }, { type: 'session.erased', data: { at: '2026-10-10T12:00:00Z' } },
    { type: 'consent.revised', data: { granted: false } }, { type: 'upload.state', data: { id: 'document', state: 'withdrawn' } }]) {
    const session = createSession();
    session.transcript = [{ id: 'person', role: 'user', content: 'source' }, { id: 'reply', role: 'assistant', content: 'response',
      ...origin('private-model-choice'), engine: { model: 'choice' } }];
    session.understanding = { ...session.understanding, ...origin('analysis-choice') };
    const next = applyEvent(session, { ...event, seq: 1 });
    assert.deepEqual(identity(next.transcript[1]), {}); assert.equal(next.transcript[1].engine, undefined);
    assert.deepEqual(identity(next.understanding), {});
  }
});
