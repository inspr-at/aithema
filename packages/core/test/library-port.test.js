import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertLibraryPort, createMemoryLibrary, libraryConformance } from '../src/index.js';
import { SQLiteStorage } from '../../server/src/storage.js';

test('memory library passes the complete host conformance kit', async () => {
  const fixture = createMemoryLibrary();
  assert.deepEqual(await libraryConformance(fixture.port, fixture), { ok: true, failures: [] });
});

test('search, stable pages and metadata avoid session content in list results', async () => {
  const { port } = createMemoryLibrary();
  const a = await port.new({ title: ' Alpha ', locale: 'de' });
  const b = await port.new({ title: 'Beta' });
  assert.equal(a.title, 'Alpha');
  const page = await port.list({ offset: 0, limit: 1 });
  assert.equal(page.total, 2);
  assert.equal(page.items[0].id, a.id);
  assert.equal((await port.list({ offset: 1, limit: 1 })).items[0].id, b.id);
  assert.deepEqual((await port.list({ search: ' ALPHA ' })).items.map(e => e.id), [a.id]);
  assert.equal((await port.list({ offset: 99 })).items.length, 0);
  assert.deepEqual(Object.keys(page.items[0]).sort(), ['createdAt', 'id', 'revision', 'title', 'updatedAt']);
});

test('open, new and list results cannot mutate the stored conversation', async () => {
  const { port } = createMemoryLibrary();
  const created = await port.new({ title: 'Original' });
  created.session.transcript.push({ content: 'new mutation' });
  const opened = await port.open(created.id);
  opened.session.transcript.push({ content: 'open mutation' });
  const listed = await port.list(); listed.items[0].title = 'list mutation';
  assert.equal((await port.open(created.id)).session.transcript.length, 0);
  assert.equal((await port.open(created.id)).title, 'Original');
});

test('rename advances metadata and updates the search/order without changing session content', async () => {
  let now = 0;
  const { port } = createMemoryLibrary({ now: () => now });
  const a = await port.new({ title: 'First' });
  await port.new({ title: 'Second' });
  now = 10;
  const result = await port.rename(a.id, ' Renamed ');
  assert.equal(result.revision, 1);
  assert.equal(result.updatedAt, 10);
  assert.equal((await port.list()).items[0].id, a.id);
  assert.equal((await port.open(a.id)).session.inputRevision, 0);
  assert.equal((await port.list({ search: 'First' })).total, 0);
  assert.equal((await port.list({ search: 'Renamed' })).total, 1);
});

test('delete awaits erasure, blocks competing operations and shares one pending erasure', async () => {
  let complete, count = 0;
  const fixture = createMemoryLibrary({ erase: () => { count += 1; return new Promise(resolve => { complete = resolve; }); } });
  const { port } = fixture, created = await port.new();
  const deletion = port.delete(created.id), repeated = port.delete(created.id);
  await Promise.resolve();
  assert.equal(count, 1);
  assert.equal(fixture.wasErased(created.id), false);
  await assert.rejects(port.open(created.id), { code: 'erasing' });
  await assert.rejects(port.rename(created.id, 'race'), { code: 'erasing' });
  assert.equal((await port.list()).total, 0);
  complete({ erased: true });
  assert.deepEqual(await deletion, { id: created.id, erased: true });
  assert.deepEqual(await repeated, await deletion);
  assert.equal(fixture.wasErased(created.id), true);
  await assert.rejects(port.open(created.id), { code: 'not-found' });
});

test('failed or unconfirmed erasure keeps the conversation and permits retry', async () => {
  let mode = 'throw';
  const { port, wasErased } = createMemoryLibrary({ erase: async () => {
    if (mode === 'throw') throw new Error('storage unavailable');
    return { erased: mode === 'ok' };
  } });
  const a = await port.new({ title: 'Keep me' });
  await assert.rejects(port.delete(a.id), /storage unavailable/);
  assert.equal((await port.open(a.id)).title, 'Keep me');
  mode = 'unconfirmed';
  await assert.rejects(port.delete(a.id), { code: 'erasure-unconfirmed' });
  assert.equal(wasErased(a.id), false);
  mode = 'ok'; await port.delete(a.id);
  assert.equal(wasErased(a.id), true);
});

test('library deletion delegates to existing SQLite erasure and tombstones replayed content', async () => {
  const storage = new SQLiteStorage();
  try {
    const { port } = createMemoryLibrary({ erase: async ({ id }) => {
      storage.erase(id, { ownerToken: 'fixture-owner' });
      return { erased: true };
    } });
    const created = await port.new();
    storage.create({ id: created.id, ownerToken: 'fixture-owner' });
    storage.postTurn(created.id, 'fixture-turn', Buffer.from('fixture-input'), 'source to erase', { ownerToken: 'fixture-owner' });
    const contentRef = storage.get(created.id).transcript[0].contentRef;
    assert.equal(storage.getRecord(created.id, contentRef).data.content, 'source to erase');
    await port.delete(created.id);
    assert.ok(storage.get(created.id).tombstone);
    assert.equal(storage.getRecord(created.id, contentRef).erased, true);
    assert.equal(storage.read(created.id).find(e => e.type === 'turn.final').data.erased, true);
    assert.equal(JSON.stringify(storage.read(created.id)).includes('source to erase'), false);
    await assert.rejects(port.open(created.id), { code: 'not-found' });
  } finally { storage.close(); }
});

test('reset erases the old session and starts a fresh ID with the same locale/preset', async () => {
  const erasures = [], fixture = createMemoryLibrary({ erase: async request => { erasures.push(request); return { erased: true }; } });
  const a = await fixture.port.new({ title: 'old', locale: 'de', processingPreset: 'eu' });
  await fixture.port.rename(a.id, 'renamed');
  const b = await fixture.port.reset(a.id);
  assert.notEqual(a.id, b.id);
  assert.deepEqual(erasures, [{ id: a.id, revision: 1 }]);
  assert.equal(b.title, '');
  assert.equal(b.session.locale, 'de');
  assert.equal(b.session.processingPreset, 'eu');
  assert.equal(b.session.identified, false);
  assert.equal(b.session.actor, null);
  assert.equal(b.session.seq, 0);
  await assert.rejects(fixture.port.open(a.id), { code: 'not-found' });
});

test('reset cannot create a replacement before confirmed erasure', async () => {
  const { port } = createMemoryLibrary({ erase: async () => { throw new Error('erase failed'); } });
  const a = await port.new();
  await assert.rejects(port.reset(a.id));
  assert.equal((await port.list()).total, 1);
  assert.equal((await port.open(a.id)).id, a.id);
});

test('library validates page bounds, titles, session options, time and missing IDs', async () => {
  const { port } = createMemoryLibrary();
  for (const query of [{ offset: -1 }, { offset: 1.5 }, { limit: 0 }, { limit: 101 }, { search: 5 }]) await assert.rejects(port.list(query));
  for (const name of ['open', 'rename', 'delete', 'reset']) await assert.rejects(port[name]('missing', 'title'), { code: 'not-found' });
  await assert.rejects(port.new({ title: 'x'.repeat(201) }));
  await assert.rejects(port.new({ locale: 'xx' }));
  await assert.rejects(createMemoryLibrary({ now: () => -1 }).port.new());
  assert.throws(() => assertLibraryPort({}));
});

for (const operation of ['list', 'open', 'rename', 'delete', 'new', 'reset']) {
  test(`library kit rejects a broken host ${operation} operation`, async () => {
    const fixture = createMemoryLibrary();
    const broken = { ...fixture.port, [operation]: async () => undefined };
    const result = await libraryConformance(broken, fixture);
    assert.equal(result.ok, false);
    assert.ok(result.failures.length > 0);
  });
}

test('library kit rejects a host that hides rows without performing storage erasure', async () => {
  const fixture = createMemoryLibrary();
  const result = await libraryConformance(fixture.port, { wasErased: () => false });
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes('delete uses storage erasure'));
  assert.ok(result.failures.includes('reset erases and creates a fresh session'));
});

test('library kit fails closed for missing controls and bounds a hanging host', async () => {
  assert.equal((await libraryConformance({})).ok, false);
  const fixture = createMemoryLibrary();
  assert.equal((await libraryConformance(fixture.port)).ok, false);
  const broken = { ...fixture.port, new: () => new Promise(() => {}) };
  const result = await libraryConformance(broken, { ...fixture, timeoutMs: 10 });
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes('new failed'));
});
