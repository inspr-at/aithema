import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SQLiteStorage, createSpendCap } from '../../packages/server/src/index.js';
import { createDemoHost } from '../host-ports.js';
import { startChild, temporaryDb, post } from '../../test/helpers.js';
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
  const breached = spendCap.reserve(1); spendCap.settle(breached, 2);
  assert.equal((await adminRequest(path, 'provider-cap')).body.breached, true);
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

test('AIT-135 the running start2 host exposes OPS only on its socket, with $1000 ledger subcaps and no owner deadline', { timeout: 15_000 }, async t => {
  const { adminRequest } = await import('../admin-socket.js');
  const db = await temporaryDb(), socketPath = join(db, '..', 'ops', 'admin');
  const running = await startChild(new URL('../server.js', import.meta.url), db); t.after(() => running.kill());
  assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
  assert.equal((await adminRequest(socketPath, 'settings')).body.allowancesMicro.anonymous, 10_000_000);
  for (const path of ['/settings', '/set-allowances', '/audit', '/provider-cap', '/api/admin/settings', '/demo/admin-socket.js']) {
    assert.equal((await fetch(running.url + path)).status, 404);
  }
  const created = await post(running.url + '/api/sessions', {}), session = await created.json();
  const headers = { cookie: created.headers.get('set-cookie').split(';')[0] };
  const credits = await fetch(running.url + `/api/sessions/${session.id}/credits`, { headers }).then(r => r.json());
  assert.equal(credits.limitSlot, null);
  assert.equal(credits.balance.session.limitMicro, 1_000_000_000);
  assert.equal(credits.balance.voiceVisitor.limitMicro, 1_000_000_000);
  const initial = (await adminRequest(socketPath, 'settings')).body;
  await adminRequest(socketPath, 'set-allowances', { baseRevision: initial.revision, allowancesUsd: { anonymous: '10', emailGiven: '15', emailConfirmed: '20' } });
  const notice = await fetch(running.url + '/api/visitor/email', { headers }).then(r => r.json());
  assert.equal(notice.notice.optional, true);
  assert.equal((await post(running.url + '/api/visitor/email', { address: 'socket@example.test', noticeVersion: notice.notice.version }, headers)).status, 200);
  assert.equal((await fetch(running.url + `/api/sessions/${session.id}/credits`, { headers }).then(r => r.json())).balance.owner.limitMicro, 15_000_000);
  await running.kill();
  await assert.rejects(adminRequest(socketPath, 'settings'), error => ['ENOENT', 'ECONNREFUSED'].includes(error.code));
});

test('AIT-135 a long database directory still permits the default private Unix socket', { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'ait-135-path-'));
  const directory = join(root, 'x'.repeat(90 - root.length - 1));
  await mkdir(directory);
  const running = await startChild(new URL('../server.js', import.meta.url), join(directory, 'session.sqlite'));
  t.after(() => running.kill());
  const response = await post(running.url + '/api/sessions', {});
  assert.equal(response.status, 201);
});

test('AIT-163: OPS repair defaults to dry-run and apply is idempotent', async t => {
  const { listenAdmin, adminRequest } = await import('../admin-socket.js');
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const host = createDemoHost({ storage }); let changes = 0;
  const repair = async ({ apply = false }) => { const count = changes ? 0 : 1; if (apply) changes += count;
    return { candidates: count, beforeMicro: count * 1_000_000, afterMicro: count * 600, corrected: apply ? count : 0 }; };
  const path = join(await mkdtemp(join(tmpdir(), 'ait-repair-')), 'ops.sock');
  const admin = await listenAdmin({ host, socketPath: path, reconcileUncertain: repair }); t.after(() => admin.close());
  const cli = new URL('../admin-cli.js', import.meta.url);
  const run = (...args) => execute(process.execPath, [cli.pathname, '--socket', path, 'reconcile-uncertain', ...args]).then(r => JSON.parse(r.stdout));
  assert.equal((await run()).candidates, 1); assert.equal(changes, 0);
  assert.equal((await run('--dry-run')).corrected, 0); assert.equal(changes, 0);
  assert.equal((await run('--apply')).corrected, 1); assert.equal((await run('--apply')).corrected, 0);
  assert.equal((await adminRequest(path, 'reconcile-uncertain', { apply: true, address: 'forbidden@example.test' })).status, 400);
});
