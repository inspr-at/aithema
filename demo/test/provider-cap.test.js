import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SQLiteStorage, createSpendCap } from '../../packages/server/src/index.js';
import { createDemoHost } from '../host-ports.js';
import { listenAdmin, adminRequest } from '../admin-socket.js';

const execute = promisify(execFile);
const identity = { actor: 'ops-cli:fixture', source: 'ops-cli' };
const capFor = (storage, capMicro = 100, account = 'fixture') => createSpendCap({ storage, account, capMicro });
const save = (cap, capUsd, baseRevision = cap.settings().revision) => cap.saveSettings({ baseRevision, capUsd }, identity);
async function fixture(t, { provider = true } = {}) {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const host = createDemoHost({ storage, demo: false }), cap = provider ? capFor(storage) : undefined;
  const path = join(await mkdtemp(join(tmpdir(), 'ait-170-')), 'ops.sock');
  const admin = await listenAdmin({ host, spendCap: cap, socketPath: path }); t.after(() => admin.close());
  const run = (...args) => execute(process.execPath, [new URL('../admin-cli.js', import.meta.url).pathname, '--socket', path, ...args],
    { env: { PATH: process.env.PATH } }).then(r => JSON.parse(r.stdout));
  return { storage, host, cap, path, run };
}

test('AIT-170 null migration uses today\'s configured cap until the first runtime save, across restart', async t => {
  const path = join(await mkdtemp(join(tmpdir(), 'ait-170-db-')), 'session.sqlite');
  let storage = new SQLiteStorage(path); t.after(() => storage.close());
  storage.db.exec(`CREATE TABLE spend_reservations (id TEXT PRIMARY KEY, account TEXT NOT NULL,
    reserved_micro INTEGER NOT NULL CHECK(reserved_micro>0), actual_micro INTEGER CHECK(actual_micro>=0));
    INSERT INTO spend_reservations VALUES ('spent','fixture',20,10), ('unknown','fixture',30,NULL);`);
  let cap = capFor(storage);
  assert.equal(cap.settings().storedCapMicro, null);
  assert.equal(cap.settings().revision, 1);
  assert.equal(cap.settings().minimumMicro, 40);
  assert.equal(cap.snapshot().capMicro, 100);
  assert.deepEqual(cap.audit(), []);
  storage.close(); storage = new SQLiteStorage(path); cap = capFor(storage, 200);
  assert.equal(cap.settings().storedCapMicro, null);
  assert.equal(cap.snapshot().capMicro, 200);
  save(cap, '0.000150');
  storage.close(); storage = new SQLiteStorage(path); cap = capFor(storage, 300);
  assert.equal(cap.snapshot().capMicro, 150);
  assert.equal(cap.settings().revision, 2);
  assert.equal(capFor(storage, 400, 'other').snapshot().capMicro, 400);
});

test('AIT-170 clamps to confirmed + reserved + uncertain with one attributed audit row', async t => {
  const { cap, path, host } = await fixture(t);
  cap.settle(cap.reserve(20), 10); cap.reserve(25);
  const unknown = cap.reserve(30); cap.dispatch(unknown); cap.uncertain(unknown);
  const before = (await adminRequest(path, 'provider-cap')).body;
  const result = await adminRequest(path, 'set-provider-cap', { baseRevision: before.revision, capUsd: '0.000001' });
  assert.equal(result.status, 200);
  assert.equal(result.body.capMicro, 65); assert.equal(result.body.minimumMicro, 65);
  assert.equal(result.body.revision, before.revision + 1);
  assert.throws(() => cap.reserve(1), /spend cap exhausted/u);
  const page = await adminRequest(path, 'provider-cap-audit');
  assert.equal(page.status, 200); assert.equal(page.body.items.length, 1);
  const [row] = page.body.items;
  assert.equal(row.actor, `ops-cli:${userInfo().username}`); assert.equal(row.source, 'ops-cli');
  assert.equal(row.revision, result.body.revision);
  assert.equal(row.oldValues.capMicro, 100); assert.equal(row.newValues.capMicro, 65);
  assert.equal(row.requestedUsd, '0.000001');
  assert.deepEqual(row.clamp, { reason: 'minimum', minimumMicro: 65, maximumMicro: Number.MAX_SAFE_INTEGER });
  assert.equal(page.body.nextAfter, row.id);
  assert.deepEqual((await adminRequest(path, 'provider-cap-audit', { after: row.id })).body.items, []);
  assert.equal(host.visitorCredits.settings().revision, 1, 'provider saves do not change visitor revisions');
});

test('AIT-170 stale revisions return 409/current and cannot append another audit record', async t => {
  const { cap, path } = await fixture(t);
  const input = { baseRevision: 1, capUsd: '0.000200' };
  assert.equal((await adminRequest(path, 'set-provider-cap', input)).status, 200);
  const result = await adminRequest(path, 'set-provider-cap', input);
  assert.equal(result.status, 409); assert.equal(result.body.error, 'stale-provider-cap-settings');
  assert.equal(result.body.current.revision, 2); assert.equal(result.body.current.capMicro, 200);
  assert.equal(cap.audit().length, 1);
});

test('AIT-170 an existing spend port observes a save and the minimum includes holds made after the read', t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const first = capFor(storage), second = capFor(storage), before = first.settings();
  second.reserve(90);
  assert.equal(save(first, '0.000010', before.revision).capMicro, 90);
  assert.equal(second.snapshot().capMicro, 90);
  assert.throws(() => second.reserve(1), /spend cap exhausted/u);
  save(first, '0.000120');
  second.reserve(30);
  assert.throws(() => second.reserve(1), /spend cap exhausted/u);
});

test('AIT-170 cap raises and lowers preserve the reservation-overrun latch and holds across restart', async t => {
  const path = join(await mkdtemp(join(tmpdir(), 'ait-170-latch-')), 'session.sqlite');
  let storage = new SQLiteStorage(path); t.after(() => storage.close());
  let cap = capFor(storage);
  cap.reserve(15); const unknown = cap.reserve(20); cap.dispatch(unknown); cap.uncertain(unknown);
  cap.settle(cap.reserve(10), 11);
  for (const usd of ['0.001000', '0.000001']) {
    save(cap, usd);
    const current = cap.snapshot({ includeBreachReason: true });
    assert.equal(current.breached, true); assert.equal(current.breachReason, 'overrun');
    assert.equal(current.spentMicro, 11); assert.equal(current.reservedMicro, 15); assert.equal(current.uncertainMicro, 20);
    assert.throws(() => cap.reserve(1), /spend cap exhausted/u);
  }
  storage.close(); storage = new SQLiteStorage(path); cap = capFor(storage, 10_000);
  assert.equal(cap.snapshot().capMicro, 46); assert.equal(cap.snapshot().breached, true);
  assert.equal(cap.audit().length, 2);
});

test('AIT-170 signed USD below zero and above safe microUSD are clamped and audited exactly', t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close()); const cap = capFor(storage);
  assert.equal(save(cap, '-1.000001').capMicro, 0);
  assert.equal(cap.audit()[0].clamp.reason, 'minimum');
  assert.equal(save(cap, '9007199254.740992').capMicro, Number.MAX_SAFE_INTEGER);
  assert.equal(cap.audit()[1].requestedUsd, '9007199254.740992');
  assert.equal(cap.audit()[1].clamp.reason, 'maximum');
  assert.equal(save(cap, '0.000001').capMicro, 1);
  assert.equal(cap.audit()[2].clamp, null, 'an in-range save is audited too');
});

test('AIT-170 cap settings and audit commit atomically', t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close()); const cap = capFor(storage), before = cap.settings();
  storage.db.exec(`CREATE TRIGGER reject_cap_audit BEFORE INSERT ON spend_cap_audit BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;`);
  assert.throws(() => save(cap, '0.000200'), /audit unavailable/u);
  assert.deepEqual(cap.settings(), before); assert.deepEqual(cap.audit(), []);
});

test('AIT-170 malformed saves and forged attribution do not change settings or append audits', async t => {
  const { cap, path } = await fixture(t);
  const before = cap.settings();
  for (const input of [null, [], {}, { capUsd: '1' }, { baseRevision: 0, capUsd: '1' },
    { baseRevision: 1, capUsd: 1 }, { baseRevision: 1, capUsd: '1e2' }, { baseRevision: 1, capUsd: '1.0000001' },
    { baseRevision: 1, capUsd: '1', actor: 'forged' }, { baseRevision: 1, capUsd: '1', source: 'forged' },
    { baseRevision: 1, capUsd: '1', allowancesUsd: {} }]) {
    assert.equal((await adminRequest(path, 'set-provider-cap', input)).status, 400, JSON.stringify(input));
  }
  assert.throws(() => cap.saveSettings({ baseRevision: 1, capUsd: '1' }), /OPS/u);
  assert.deepEqual(cap.settings(), before); assert.deepEqual(cap.audit(), []);
});

test('AIT-170 CLI reads, saves, observes clamp, reads audit and refuses stale replay', async t => {
  const { cap, run } = await fixture(t);
  const initial = await run('provider-cap'); assert.equal(initial.revision, 1);
  cap.reserve(20);
  const saved = await run('set-provider-cap', '--base-revision', String(initial.revision), '--usd', '0.000010');
  assert.equal(saved.capMicro, 20); assert.equal(saved.revision, 2);
  const current = await run('provider-cap'); assert.equal(current.capMicro, 20); assert.equal(current.remainingMicro, 0);
  assert.equal((await run('provider-cap-audit', '--after', '0', '--limit', '1')).items[0].clamp.reason, 'minimum');
  await assert.rejects(run('set-provider-cap', '--base-revision', '1', '--usd', '1'),
    error => JSON.parse(error.stdout).error === 'stale-provider-cap-settings');
});

test('AIT-170 a host without a configured provider cap refuses writes and audit reads', async t => {
  const { path } = await fixture(t, { provider: false });
  assert.equal((await adminRequest(path, 'provider-cap')).body.available, false);
  assert.equal((await adminRequest(path, 'set-provider-cap', { baseRevision: 1, capUsd: '10' })).status, 503);
  assert.equal((await adminRequest(path, 'provider-cap-audit')).status, 503);
});
