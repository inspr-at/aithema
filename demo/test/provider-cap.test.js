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
const save = (cap, capUsd, baseRevision = cap.settings().revision, allowLarge = false) => cap.saveSettings({ baseRevision, capUsd, ...(allowLarge ? { allowLarge } : {}) }, identity);
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

test('AIT-170 refuses below confirmed + reserved + uncertain with one attributed audit row', async t => {
  const { cap, path, host } = await fixture(t);
  cap.settle(cap.reserve(20), 10); cap.reserve(25);
  const unknown = cap.reserve(30); cap.dispatch(unknown); cap.uncertain(unknown);
  const before = (await adminRequest(path, 'provider-cap')).body;
  const result = await adminRequest(path, 'set-provider-cap', { baseRevision: before.revision, capUsd: '0.000001' });
  assert.equal(result.status, 422);
  assert.match(result.body.error, /cap cannot go below spend already committed; current cap unchanged/u);
  assert.equal(result.body.current.capMicro, 100); assert.equal(result.body.current.minimumMicro, 65);
  assert.equal(result.body.current.revision, before.revision);
  const page = await adminRequest(path, 'provider-cap-audit');
  assert.equal(page.status, 200); assert.equal(page.body.items.length, 1);
  const [row] = page.body.items;
  assert.equal(row.actor, `ops-cli:${userInfo().username}`); assert.equal(row.source, 'ops-cli');
  assert.equal(row.revision, before.revision);
  assert.equal(row.oldValues.capMicro, 100); assert.equal(row.newValues.capMicro, 100);
  assert.equal(row.requestedUsd, '0.000001');
  assert.equal(row.outcome, 'refused'); assert.equal(row.reason, 'committed-spend');
  assert.equal(row.clamp, null);
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
  assert.throws(() => save(first, '0.000010', before.revision), /cap cannot go below spend/u);
  assert.equal(second.snapshot().capMicro, 100);
  assert.equal(save(first, '0.000090', before.revision).capMicro, 90);
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
  for (const usd of ['0.001000', '0.000046']) {
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

test('AIT-170 negative USD is refused and the explicit large override retains the safe accounting clamp', t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close()); const cap = capFor(storage);
  assert.throws(() => save(cap, '-1.000001'), /cap cannot go below spend/u);
  assert.equal(cap.audit()[0].outcome, 'refused');
  assert.equal(save(cap, '9007199254.740992', 1, true).capMicro, Number.MAX_SAFE_INTEGER);
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
  assert.throws(() => cap.resetSettings({ baseRevision: 1 }, identity), /audit unavailable/u);
  cap.reserve(20);
  assert.throws(() => save(cap, '0'), /audit unavailable/u);
  assert.equal(cap.settings().storedCapMicro, null); assert.equal(cap.settings().revision, 1);
  assert.deepEqual(cap.audit(), []);
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

test('AIT-170 CLI reads, saves at committed spend, reads audit and refuses stale replay', async t => {
  const { cap, run } = await fixture(t);
  const initial = await run('provider-cap'); assert.equal(initial.revision, 1);
  cap.reserve(20);
  const saved = await run('set-provider-cap', '--base-revision', String(initial.revision), '--usd', '0.000020');
  assert.equal(saved.capMicro, 20); assert.equal(saved.revision, 2);
  const current = await run('provider-cap'); assert.equal(current.capMicro, 20); assert.equal(current.remainingMicro, 0);
  assert.equal((await run('provider-cap-audit', '--after', '0', '--limit', '1')).items[0].outcome, 'saved');
  await assert.rejects(run('set-provider-cap', '--base-revision', '1', '--usd', '1'),
    error => JSON.parse(error.stdout).error === 'stale-provider-cap-settings');
});

test('AIT-170 a host without a configured provider cap refuses writes and audit reads', async t => {
  const { path } = await fixture(t, { provider: false });
  assert.equal((await adminRequest(path, 'provider-cap')).body.available, false);
  assert.equal((await adminRequest(path, 'set-provider-cap', { baseRevision: 1, capUsd: '10' })).status, 503);
  assert.equal((await adminRequest(path, 'provider-cap-audit')).status, 503);
  assert.equal((await adminRequest(path, 'reset-provider-cap', { baseRevision: 1 })).status, 503);
});

test('AIT-170 round 2 lowering an already breached configured cap never raises it', async t => {
  const { storage, path } = await fixture(t);
  const old = capFor(storage, 200_000_000);
  old.settle(old.reserve(120_000_000), 120_000_000);
  const hold = old.reserve(30_000_000);
  const cap = capFor(storage, 100_000_000), before = cap.settings();
  // This socket shares the same account settings, with the deployment cap of $100.
  const host = createDemoHost({ storage, demo: false });
  const socketPath = join(path, '..', 'lower.sock');
  const admin = await listenAdmin({ host, spendCap: cap, socketPath }); t.after(() => admin.close());
  assert.equal(cap.snapshot().breached, true);
  const refused = await adminRequest(socketPath, 'set-provider-cap', { baseRevision: 1, capUsd: '0' });
  assert.equal(refused.status, 422);
  assert.deepEqual(cap.settings(), before);
  assert.equal(cap.snapshot().capMicro, 100_000_000);
  assert.equal(cap.snapshot().breached, true);
  assert.throws(() => save(cap, '121'), error => error.status === 422);
  cap.settle(hold, 0);
  assert.throws(() => cap.reserve(1), /spend cap exhausted/u);
  const [audit] = cap.audit();
  assert.equal(audit.outcome, 'refused'); assert.equal(audit.reason, 'committed-spend');
  assert.deepEqual(audit.oldValues, audit.newValues);
});

test('AIT-170 round 2 socket and CLI reset restore deployment configuration and audit revisions', async t => {
  const { storage, path, run } = await fixture(t);
  const old = capFor(storage, 200);
  old.settle(old.reserve(120), 120);
  save(old, '0.000300');
  const deployed = capFor(storage, 100);
  assert.equal(deployed.snapshot().capMicro, 300);
  const reset = await adminRequest(path, 'reset-provider-cap', { baseRevision: 2 });
  assert.equal(reset.status, 200); assert.equal(reset.body.storedCapMicro, null);
  assert.equal(reset.body.capMicro, 100); assert.equal(reset.body.revision, 3);
  assert.equal(deployed.snapshot().breached, true);
  assert.throws(() => deployed.reserve(1), /spend cap exhausted/u);
  const stale = await adminRequest(path, 'reset-provider-cap', { baseRevision: 2 });
  assert.equal(stale.status, 409); assert.equal(stale.body.error, 'stale-provider-cap-settings');
  assert.equal(deployed.audit().length, 2);
  save(deployed, '0.000400');
  const cliReset = await run('reset-provider-cap', '--base-revision', '4');
  assert.equal(cliReset.capMicro, 100); assert.equal(cliReset.storedCapMicro, null);
  const audit = (await run('provider-cap-audit')).items.at(-1);
  assert.equal(audit.operation, 'reset'); assert.equal(audit.outcome, 'saved');
  assert.equal(audit.actor, `ops-cli:${userInfo().username}`);
  assert.equal(audit.oldValues.capMicro, 400); assert.equal(audit.newValues.capMicro, 100);
  assert.equal(capFor(storage, 80).snapshot().capMicro, 80, 'null again follows later deploys');
  for (const input of [{}, { baseRevision: 5, capUsd: '1' }, { baseRevision: 5, allowLarge: true }]) {
    assert.equal((await adminRequest(path, 'reset-provider-cap', input)).status, 400);
  }
});

test('AIT-170 round 2 typo bound uses configured cap and CLI allow-large is explicit and audited', async t => {
  const { cap, path, run } = await fixture(t);
  const before = cap.settings(); // $0.000100 + $1,000 wins over ten times configuration.
  const refused = await adminRequest(path, 'set-provider-cap', { baseRevision: 1, capUsd: '1000.000101' });
  assert.equal(refused.status, 422); assert.match(refused.body.error, /--allow-large/u);
  assert.deepEqual(cap.settings(), before); assert.equal(cap.audit()[0].outcome, 'refused');
  assert.equal(cap.audit()[0].reason, 'large-cap');
  assert.equal(save(cap, '1000.000100').capMicro, 1_000_000_100, 'boundary is inclusive');
  await assert.rejects(run('set-provider-cap', '--base-revision', '2', '--usd', '2000'),
    error => JSON.parse(error.stdout).error.includes('--allow-large'));
  const raised = await run('set-provider-cap', '--base-revision', '2', '--usd', '2000', '--allow-large');
  assert.equal(raised.capMicro, 2_000_000_000);
  const audit = cap.audit().at(-1);
  assert.equal(audit.allowLarge, true); assert.equal(audit.outcome, 'saved');
  assert.equal(audit.actor, `ops-cli:${userInfo().username}`);
  const bigStorage = new SQLiteStorage(), big = capFor(bigStorage, 200_000_000, 'big');
  t.after(() => bigStorage.close());
  // Above $111.111111, the ten-times rule wins. The runtime override is not the baseline.
  assert.equal(save(big, '2000').capMicro, 2_000_000_000);
  assert.throws(() => save(big, '2000.000001'), error => error.status === 422);
  assert.equal(big.settings().capMicro, 2_000_000_000);
  assert.equal((await adminRequest(path, 'set-provider-cap', { baseRevision: 3, capUsd: '3000', allowLarge: 'true' })).status, 400);
});


test('AIT-170 round 2 preserves append-only audit history from the round-1 schema', t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  storage.db.exec(`CREATE TABLE spend_cap_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, actor TEXT NOT NULL, source TEXT NOT NULL,
    at TEXT NOT NULL, revision INTEGER NOT NULL, requested_usd TEXT NOT NULL,
    old_json TEXT NOT NULL, new_json TEXT NOT NULL, clamp_json TEXT NOT NULL);
    INSERT INTO spend_cap_audit VALUES (1,'fixture','ops-cli:old','ops-cli','2026-10-14T00:00:00Z',1,'1','{}','{}','null');`);
  const cap = capFor(storage), [legacy] = cap.audit();
  assert.equal(legacy.requestedUsd, '1'); assert.equal(legacy.actor, 'ops-cli:old');
  assert.equal(legacy.operation, 'set'); assert.equal(legacy.outcome, 'saved'); assert.equal(legacy.allowLarge, false);
  save(cap, '0.000200');
  assert.deepEqual(cap.audit()[0], legacy); assert.equal(cap.audit().length, 2);
  assert.throws(() => storage.db.exec("UPDATE spend_cap_audit SET requested_usd='2' WHERE id=1"), /append only/u);
  assert.throws(() => storage.db.exec('DELETE FROM spend_cap_audit WHERE id=1'), /append only/u);
});
