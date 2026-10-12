import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat, mkdtemp } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SQLiteStorage, createSpendCap } from '../../packages/server/src/index.js';
import { createDemoHost } from '../host-ports.js';
const execute = promisify(execFile);

test('AIT-135 OPS socket is private, owns the audit actor, reports the cap read-only and returns 409 on replay', async t => {
  const { listenAdmin, adminRequest } = await import('../admin-socket.js');
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const host = createDemoHost({ storage, demo: false }), spendCap = createSpendCap({ storage, account: 'fixture', capMicro: 100 });
  const path = join(await mkdtemp(join(tmpdir(), 'ait-admin-')), 'private', 'ops.sock');
  const admin = await listenAdmin({ host, spendCap, socketPath: path }); t.after(() => admin.close());
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(path, '..'))).mode & 0o777, 0o700);
  const initial = await adminRequest(path, 'settings'); assert.equal(initial.status, 200);
  const payload = { baseRevision: initial.body.revision, allowancesUsd: { anonymous: '10', emailGiven: '15', emailConfirmed: '20' } };
  assert.equal((await adminRequest(path, 'set-allowances', { ...payload, actor: 'forged' })).status, 400);
  assert.equal((await adminRequest(path, 'set-allowances', payload)).status, 200);
  assert.equal((await adminRequest(path, 'set-allowances', payload)).status, 409);
  const audit = await adminRequest(path, 'audit');
  assert.equal(audit.body.items.filter(e => e.source === 'ops-cli').length, 1);
  assert.equal(audit.body.items.at(-1).actor, `ops-cli:${userInfo().username}`);
  const confirmed = spendCap.reserve(10); spendCap.settle(confirmed, 9);
  spendCap.reserve(11); const unknown = spendCap.reserve(12); spendCap.dispatch(unknown); spendCap.uncertain(unknown);
  const cap = await adminRequest(path, 'provider-cap');
  assert.deepEqual(Object.fromEntries(['capMicro', 'confirmedMicro', 'reservedMicro', 'uncertainMicro', 'remainingMicro', 'breached'].map(k => [k, cap.body[k]])),
    { capMicro: 100, confirmedMicro: 9, reservedMicro: 11, uncertainMicro: 12, remainingMicro: 68, breached: false });
  assert.match(cap.body.recovery, /reconcil/iu);
  assert.equal((await adminRequest(path, 'set-provider-cap', { capMicro: 1000 })).status, 404);
});

test('AIT-135 CLI talks only to a running host and refuses offline without opening SQLite', async t => {
  const { listenAdmin } = await import('../admin-socket.js');
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const host = createDemoHost({ storage, demo: false });
  const path = join(await mkdtemp(join(tmpdir(), 'ait-cli-')), 'ops.sock');
  const admin = await listenAdmin({ host, socketPath: path });
  const cli = new URL('../admin-cli.js', import.meta.url);
  try {
    const result = await execute(process.execPath, [cli.pathname, '--socket', path, 'settings']);
    assert.equal(JSON.parse(result.stdout).confirmationEnabled, false);
    const before = host.visitorCredits.settings();
    await execute(process.execPath, [cli.pathname, '--socket', path, 'set-allowances', '--base-revision', String(before.revision), '--anonymous', '10', '--email-given', '15', '--email-confirmed', '20']);
    assert.equal(host.visitorCredits.settings().allowancesMicro.emailGiven, 15_000_000);
  } finally { await admin.close(); }
  await assert.rejects(execute(process.execPath, [cli.pathname, '--socket', path, 'settings']), error => /host is not running/iu.test(error.stderr));
});
