import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { SqliteJournal } from '../runtime/journal/index.js';
import { BudgetClient, SqliteBudgetLedger, budgetMessage, createOutboundGate, deploymentPeriodAt, deploymentPeriodBounds,
  encodeMessage, resultStatus } from '../runtime/budget/index.js';
import { notificationThreshold } from '../runtime/budget/period.js';
import { validate } from '../contracts/validate.js';
import { authority as baseAuthority, bytes, record, session, sid } from './fixtures/journal/helpers.mjs';

const policy = (overrides = {}) => ({ deployment_id: 'fixture-host', period: 'month', time_zone: 'Europe/Vienna',
  ceiling_micro: 100, notify_at: [0.5, 0.8, 1], ...overrides });
const registration = (overrides = {}) => ({ sid, issuer: 'fixture-issuer', principal: 'fixture-principal', currency: 'EUR',
  session_cap_micro: 1000, principal_day_cap_micro: 1000, tenant_day_cap_micro: 1000, evidence: true,
  deployment_period: policy(), ...overrides });
const authority = (overrides = {}) => baseAuthority({
  exp: Date.parse('2030-01-01T00:00:00Z') / 1000,
  capabilities: ['aithema.ledger', 'aithema.journal.read', 'aithema.journal.write'], ...overrides,
});
const admission = (n = 1, overrides = {}) => {
  const body = { sid, worker_generation: 1, auth_epoch: 1, lane: 'spec', max_micro: 40, currency: 'EUR', ...overrides };
  return { ...body, attempt_id: `${body.sid}:${body.worker_generation}:${body.lane}:${n}` };
};
const admit = (ledger, body, auth = authority()) => ledger.admit(encodeMessage('admit_request', body), auth);
const claim = (ledger, hold_id, auth = authority()) => ledger.claim(encodeMessage('claim_request', {
  hold_id, request_sha256: 'a'.repeat(64), worker_generation: auth.gen, auth_epoch: auth.auth_epoch,
}), auth);
const recover = (ledger, hold_id, auth = authority()) => ledger.recover(encodeMessage('recover_request', {
  hold_id, worker_generation: auth.gen, auth_epoch: auth.auth_epoch,
}), auth);
const settle = (ledger, claim_id, actual_micro, auth = authority()) => ledger.settle(encodeMessage('settle_request', {
  claim_id, outcome: 'settled', actual_micro,
}), auth);
const report = (ledger, period_id = '2026-10', deployment_id = 'fixture-host') => ledger.getDeploymentPeriod({ deployment_id, period_id });
const expected = (overrides = {}) => ({ deployment_id: 'fixture-host', period_id: '2026-10', ceiling_micro: 100,
  admitted_micro: 0, claimed_micro: 0, settled_micro: 0, open_holds: 0, ...overrides });

function host(t, overrides = {}, at = '2026-10-10T12:00:00Z') {
  const clock = { at: Date.parse(at) };
  const now = () => clock.at;
  const path = join(mkdtempSync(join(tmpdir(), 'aithema-deployment-')), 'host.sqlite');
  const journal = new SqliteJournal(path, { now });
  journal.createSession(bytes(session()));
  const ledger = new SqliteBudgetLedger(path, { now });
  ledger.registerSession(registration(overrides));
  const client = new BudgetClient({ port: ledger, journal, authority: authority(), now });
  const db = new DatabaseSync(path);
  t.after(() => { db.close(); ledger.close(); journal.close(); });
  const addSession = (scope = {}, overrides = {}) => {
    const doc = session({ sid: randomUUID(), ...scope });
    journal.createSession(bytes(doc));
    ledger.registerSession(registration({ ...overrides, sid: doc.sid }));
    return authority({ sid: doc.sid, tid: doc.tid, pid: doc.pid });
  };
  return { clock, now, path, ledger, journal, client, db, addSession };
}

function notifications(db) {
  return db.prepare("SELECT original_bytes FROM journal_records WHERE kind = 'audit.event' ORDER BY sid,seq").all()
    .map((row) => JSON.parse(Buffer.from(row.original_bytes).toString('utf8')))
    .filter((doc) => doc.data.name === 'budget.deployment_period.notify');
}

/** Independent SQLite writers; IPC barrier starts admissions together, offline. */
async function parallelAdmits(path, calls, at) {
  const module = new URL('../runtime/budget/index.js', import.meta.url).href;
  const workers = calls.map(({ body, auth }) => {
    const source = `import {SqliteBudgetLedger,encodeMessage} from ${JSON.stringify(module)};
      const ledger=new SqliteBudgetLedger(${JSON.stringify(path)},{now:()=>${at}});
      process.on('message',()=>{try{
        const result=ledger.admit(encodeMessage('admit_request',${JSON.stringify(body)}),${JSON.stringify(auth)});
        ledger.close();process.send({result},()=>process.disconnect());
      }catch(error){process.send({error:error.message},()=>process.disconnect());}});
      process.send({ready:true});`;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let readyResolve, readyReject, doneResolve, doneReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const done = new Promise((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
    done.catch(() => {});
    let result, stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('message', (message) => { if (message.ready) readyResolve(); else result = message; });
    child.on('error', (error) => { readyReject(error); doneReject(error); });
    child.on('exit', (status) => {
      if (status !== 0 || !result || result.error) {
        const error = new Error(result?.error ?? stderr ?? 'Fixture worker failed');
        readyReject(error); doneReject(error);
      } else doneResolve(result.result);
    });
    return { child, ready, done };
  });
  try {
    await Promise.all(workers.map((worker) => worker.ready));
    for (const worker of workers) worker.child.send('go');
    return await Promise.all(workers.map((worker) => worker.done));
  } finally {
    for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill('SIGKILL');
  }
}

for (const [period_id, zone, start_at, end_at] of [
  ['2026-03', 'Europe/Vienna', '2026-02-28T23:00:00.000Z', '2026-03-31T22:00:00.000Z'],
  ['2026-10', 'Europe/Vienna', '2026-09-30T22:00:00.000Z', '2026-10-31T23:00:00.000Z'],
  ['2026-11', 'America/New_York', '2026-11-01T04:00:00.000Z', '2026-12-01T05:00:00.000Z'],
  ['2026-12', 'Europe/Vienna', '2026-11-30T23:00:00.000Z', '2026-12-31T23:00:00.000Z'],
  ['2027-01', 'UTC', '2027-01-01T00:00:00.000Z', '2027-02-01T00:00:00.000Z'],
  ['2028-02', 'Asia/Kathmandu', '2028-01-31T18:15:00.000Z', '2028-02-29T18:15:00.000Z'],
  ['2011-04', 'Asia/Amman', '2011-03-31T22:00:00.000Z', '2011-04-30T21:00:00.000Z'],
  ['2020-11', 'America/Havana', '2020-11-01T04:00:00.000Z', '2020-12-01T05:00:00.000Z'],
]) {
  it(`(b) deterministic half-open month ${period_id} in ${zone}`, () => {
    const bounds = { period_id, start_at, end_at };
    assert.deepEqual(deploymentPeriodBounds(period_id, zone), bounds);
    assert.deepEqual(deploymentPeriodAt(Date.parse(start_at), zone), bounds);
    assert.deepEqual(deploymentPeriodAt(Date.parse(end_at) - 1, zone), bounds);
    assert.notEqual(deploymentPeriodAt(Date.parse(start_at) - 1, zone).period_id, period_id);
    assert.notEqual(deploymentPeriodAt(Date.parse(end_at), zone).period_id, period_id);
  });
}

it('(b) period computation is independent of the process time zone', () => {
  const source = `import {deploymentPeriodAt} from ${JSON.stringify(new URL('../runtime/budget/index.js', import.meta.url).href)};
    console.log(JSON.stringify(deploymentPeriodAt(Date.parse('2026-09-30T22:00:00Z'),'Europe/Vienna')));`;
  const results = ['UTC', 'Pacific/Honolulu', 'Asia/Tokyo'].map((TZ) => {
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
      env: { ...process.env, TZ }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  });
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[0], results[2]);
  assert.equal(results[0].period_id, '2026-10');
});

it('(a) old unconfigured sessions keep original behavior alongside scoped deployments', (t) => {
  const { ledger, addSession, db } = host(t, { deployment_period: undefined });
  const old = admit(ledger, admission(1, { max_micro: 100 }));
  assert.equal(old.body.remaining_micro, 900);
  const auth = addSession({ tid: 'fixture-other-tenant' });
  assert.ok(admit(ledger, admission(1, { sid: auth.sid, max_micro: 100 }), auth).body.hold_id);
  assert.deepEqual(admit(ledger, admission(1, { max_micro: 100 })), old);
  assert.equal(admit(ledger, admission(2)).body.remaining_micro, 860);
  assert.deepEqual(report(ledger), expected({ admitted_micro: 100, open_holds: 1 }));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_deployment_holds').get().n, 1);
});

it('(a) deployment identity and session bindings stay immutable, shared, currency-safe and atomic', (t) => {
  const { ledger, journal, db } = host(t);
  assert.doesNotThrow(() => ledger.registerSession(registration()));
  for (const deployment_period of [undefined, policy({ deployment_id: 'different' }), policy({ time_zone: 'UTC' })]) {
    assert.throws(() => ledger.registerSession(registration({ deployment_period })), { status: 409 });
  }
  const otherSid = randomUUID();
  journal.createSession(bytes(session({ sid: otherSid, tid: 'fixture-other-tenant' })));
  for (const overrides of [{ deployment_period: policy({ time_zone: 'UTC' }) }, { currency: 'USD' }]) {
    assert.throws(() => ledger.registerSession(registration({ sid: otherSid, ...overrides })), { status: 409 });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_sessions WHERE sid = ?').get(otherSid).n, 0);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_deployments').get().n, 1);
  ledger.registerSession(registration({ sid: otherSid, deployment_period: undefined }));
  assert.throws(() => ledger.registerSession(registration({ sid: otherSid })), { status: 409 });
});

it('(a) ceiling and notifications update on the same deployment through existing or new sessions', (t) => {
  const { ledger, addSession, db } = host(t);
  ledger.registerSession(registration({ deployment_period: policy({ ceiling_micro: 200 }) }));
  assert.equal(report(ledger).ceiling_micro, 200);
  ledger.registerSession(registration({ deployment_period: policy({ ceiling_micro: 200, notify_at: [] }) }));
  const changed = policy({ ceiling_micro: 300, notify_at: [] });
  addSession({ tid: 'fixture-other-tenant' }, { deployment_period: changed });
  assert.deepEqual(JSON.parse(Buffer.from(db.prepare('SELECT policy_bytes FROM budget_deployments').get().policy_bytes)), changed);
  assert.ok(admit(ledger, admission(1, { max_micro: 300 })).body.hold_id);
  assert.deepEqual(report(ledger), expected({ ceiling_micro: 300, admitted_micro: 300, open_holds: 1 }));
  assert.equal(notifications(db).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_deployments').get().n, 1);
});

it('(a) failed registration rolls back a policy update and any new session binding', (t) => {
  const { ledger, journal, db } = host(t);
  const original = Buffer.from(db.prepare('SELECT policy_bytes FROM budget_deployments').get().policy_bytes);
  const otherSid = randomUUID();
  journal.createSession(bytes(session({ sid: otherSid })));
  for (const registrationSid of [sid, otherSid]) {
    assert.throws(() => ledger.registerSession(registration({ sid: registrationSid, tenant_day_cap_micro: 999,
      deployment_period: policy({ ceiling_micro: 200, notify_at: [] }) })), { status: 409 });
    assert.deepEqual(Buffer.from(db.prepare('SELECT policy_bytes FROM budget_deployments').get().policy_bytes), original);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_sessions WHERE sid = ?').get(otherSid).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_session_deployments WHERE sid = ?').get(otherSid).n, 0);
});

it('(a) invalid host policy never registers a session or deployment', (t) => {
  const { ledger, journal, db } = host(t);
  const otherSid = randomUUID();
  journal.createSession(bytes(session({ sid: otherSid })));
  for (const deployment_period of [null, policy({ time_zone: 'Wrong/Zone' }), policy({ notify_at: [0.8, 0.5] }),
    policy({ ceiling_micro: -1 }), policy({ deployment_id: 'a'.repeat(129) }), policy({ period: 'year' })]) {
    assert.throws(() => ledger.registerSession(registration({ sid: otherSid, deployment_period })), { status: 400 });
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_sessions').get().n, 1);
});

for (const [oldCeiling, newCeiling] of [[100, 200], [200, 100], [100, 0]]) {
  it(`(a,c,e) an opened October keeps ceiling ${oldCeiling}; November uses the updated ${newCeiling}`, (t) => {
    const { ledger, clock, path, now } = host(t, { deployment_period: policy({ ceiling_micro: oldCeiling }) });
    const body = admission(1, { max_micro: 40 });
    const held = admit(ledger, body);
    ledger.registerSession(registration({ deployment_period: policy({ ceiling_micro: newCeiling }) }));
    const reopened = new SqliteBudgetLedger(path, { now });
    t.after(() => reopened.close());
    assert.deepEqual(admit(reopened, body), held);
    assert.deepEqual(report(reopened), expected({ ceiling_micro: oldCeiling, admitted_micro: 40, open_holds: 1 }));
    assert.equal(admit(reopened, admission(2, { max_micro: oldCeiling - 40 })).body.remaining_micro, 0);
    assert.equal(admit(ledger, admission(3, { max_micro: 1 })).body.denied, 'deployment_period_cap');
    assert.deepEqual(report(ledger), expected({ ceiling_micro: oldCeiling, admitted_micro: oldCeiling, open_holds: 2 }));
    clock.at = Date.parse('2026-10-31T23:00:00Z');
    assert.deepEqual(admit(reopened, body), held);
    assert.deepEqual(report(reopened, '2026-11'), expected({ period_id: '2026-11', ceiling_micro: newCeiling }));
    const next = admit(reopened, admission(4, { max_micro: newCeiling || 1 }));
    if (newCeiling === 0) assert.equal(next.body.denied, 'deployment_period_cap');
    else assert.equal(next.body.remaining_micro, 0);
    assert.deepEqual(report(ledger, '2026-11'), expected({ period_id: '2026-11', ceiling_micro: newCeiling,
      admitted_micro: newCeiling, open_holds: newCeiling ? 1 : 0 }));
  });
}

it('(a,c,d) an opened period freezes both notification ratios and their ceiling across edits and restart', (t) => {
  const { ledger, db, clock, path, now } = host(t);
  admit(ledger, admission(1)); // 40, below every original threshold.
  ledger.registerSession(registration({ deployment_period: policy({ ceiling_micro: 200, notify_at: [0.25, 0.75] }) }));
  const reopened = new SqliteBudgetLedger(path, { now });
  t.after(() => reopened.close());
  admit(reopened, admission(2, { max_micro: 10 }));
  assert.deepEqual(notifications(db).map((doc) => JSON.parse(doc.data.detail).notify_at), [0.5]);
  admit(reopened, admission(3, { max_micro: 50 }));
  assert.deepEqual(notifications(db).map((doc) => JSON.parse(doc.data.detail).notify_at), [0.5, 0.8, 1]);
  assert.ok(notifications(db).every((doc) => JSON.parse(doc.data.detail).ceiling_micro === 100));
  clock.at = Date.parse('2026-10-31T23:00:00Z');
  admit(reopened, admission(4, { max_micro: 100 }));
  admit(reopened, admission(5, { max_micro: 50 }));
  assert.deepEqual(notifications(db).slice(3).map((doc) => JSON.parse(doc.data.detail)), [0.25, 0.75].map((notify_at, i) => ({
    scope: 'deployment_period', deployment_id: 'fixture-host', period_id: '2026-11',
    notify_at, ceiling_micro: 200, reserved_or_charged_micro: i === 0 ? 100 : 150,
  })));
});

it('(a,c,d) fully recovered reservations leave the period policy frozen and crossings deduplicated', (t) => {
  const { ledger, db } = host(t);
  const held = admit(ledger, admission(1, { max_micro: 100 }));
  recover(ledger, held.body.hold_id);
  ledger.registerSession(registration({ deployment_period: policy({ ceiling_micro: 200, notify_at: [0.25] }) }));
  assert.equal(report(ledger).ceiling_micro, 100);
  assert.equal(admit(ledger, admission(2, { max_micro: 101 })).body.denied, 'deployment_period_cap');
  assert.ok(admit(ledger, admission(3, { max_micro: 100 })).body.hold_id);
  assert.equal(notifications(db).length, 3);
});

it('(a,c,e) a denial leaves the period unopened; changed policy applies to a new attempt, never to replay', (t) => {
  const { ledger, db } = host(t);
  const body = admission(1, { max_micro: 101 });
  const denied = admit(ledger, body);
  assert.equal(denied.body.denied, 'deployment_period_cap');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_deployment_periods').get().n, 0);
  ledger.registerSession(registration({ deployment_period: policy({ ceiling_micro: 200, notify_at: [0.25] }) }));
  assert.deepEqual(report(ledger), expected({ ceiling_micro: 200 }));
  assert.deepEqual(admit(ledger, body), denied);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_deployment_periods').get().n, 0);
  assert.ok(admit(ledger, admission(2, { max_micro: 101 })).body.hold_id);
  assert.deepEqual(report(ledger), expected({ ceiling_micro: 200, admitted_micro: 101, open_holds: 1 }));
  assert.deepEqual(notifications(db).map((doc) => JSON.parse(doc.data.detail).notify_at), [0.25]);
});

it('(a,c,d,e) upgrade freezes legacy reserved periods, removes denial-only metadata and preserves original bytes atomically', async (t) => {
  const { ledger, client, db, clock, path, now } = host(t);
  const body = admission(1, { max_micro: 60 });
  const held = await client.admit(body);
  clock.at = Date.parse('2026-10-31T23:00:00Z');
  const deniedBody = admission(2, { max_micro: 101 });
  const denied = admit(ledger, deniedBody);
  // Reproduce the previous schema, whose admission opened metadata on denial.
  const bounds = deploymentPeriodBounds('2026-11', 'Europe/Vienna');
  db.prepare('INSERT INTO budget_deployment_periods VALUES(?,?,?,?,?,?)')
    .run('fixture-host', '2026-11', bounds.start_at, bounds.end_at, 100, Buffer.from('[]'));
  db.exec('ALTER TABLE budget_deployment_periods DROP COLUMN notify_at_bytes');
  const ledgerBytes = () => db.prepare('SELECT original_bytes,verdict_bytes FROM budget_holds ORDER BY attempt_id').all()
    .map((row) => [Buffer.from(row.original_bytes), Buffer.from(row.verdict_bytes)]);
  const journalBytes = () => db.prepare('SELECT original_bytes FROM journal_records ORDER BY seq').all()
    .map((row) => Buffer.from(row.original_bytes));
  const before = { ledger: ledgerBytes(), journal: journalBytes() };
  db.exec(`CREATE TRIGGER fail_period_upgrade BEFORE UPDATE ON budget_deployment_periods
    BEGIN SELECT RAISE(ABORT,'fixture period upgrade failure'); END;`);
  assert.throws(() => new SqliteBudgetLedger(path, { now }), /fixture period upgrade failure/);
  assert.equal(db.prepare('PRAGMA table_info(budget_deployment_periods)').all().some((column) => column.name === 'notify_at_bytes'), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_deployment_periods').get().n, 2);
  assert.deepEqual({ ledger: ledgerBytes(), journal: journalBytes() }, before);
  db.exec('DROP TRIGGER fail_period_upgrade');
  const reopened = new SqliteBudgetLedger(path, { now });
  t.after(() => reopened.close());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_deployment_periods').get().n, 1);
  assert.deepEqual(report(reopened), expected({ admitted_micro: 60, open_holds: 1 }));
  assert.deepEqual(report(reopened, '2026-11'), expected({ period_id: '2026-11' }));
  assert.deepEqual({ ledger: ledgerBytes(), journal: journalBytes() }, before);
  reopened.registerSession(registration({ deployment_period: policy({ ceiling_micro: 200, notify_at: [] }) }));
  assert.deepEqual(admit(reopened, body).body, held);
  assert.deepEqual(admit(reopened, deniedBody), denied);
  assert.deepEqual(report(reopened), expected({ admitted_micro: 60, open_holds: 1 }));
  assert.deepEqual(report(reopened, '2026-11'), expected({ period_id: '2026-11', ceiling_micro: 200 }));
  const committed = claim(reopened, held.hold_id).body.claim_id;
  assert.equal(settle(reopened, committed, 20).body.charged_micro, 20);
  assert.deepEqual(report(reopened), expected({ settled_micro: 20 }));
  const frozen = db.prepare('SELECT notify_at_bytes FROM budget_deployment_periods WHERE period_id = ?').get('2026-10');
  assert.deepEqual(JSON.parse(Buffer.from(frozen.notify_at_bytes)), [0.5, 0.8, 1]);
  const again = new SqliteBudgetLedger(path, { now });
  t.after(() => again.close());
  assert.deepEqual(report(again), report(reopened));
  assert.ok(admit(again, admission(3, { max_micro: 150 })).body.hold_id);
  assert.deepEqual(report(again, '2026-11'), expected({ period_id: '2026-11', ceiling_micro: 200, admitted_micro: 150, open_holds: 1 }));
  assert.equal(notifications(db).length, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

it('(b,c) admitted holds retain their period through late claim, settlement and all replays', async (t) => {
  const { ledger, client, clock, path, now } = host(t, {}, '2026-10-31T22:59:59.999Z');
  const oldBody = admission(1, { max_micro: 100 });
  const old = await client.admit(oldBody);
  assert.deepEqual(report(ledger), expected({ admitted_micro: 100, open_holds: 1 }));
  clock.at++;
  const reopened = new SqliteBudgetLedger(path, { now });
  t.after(() => reopened.close());
  assert.deepEqual(admit(reopened, oldBody).body, old);
  assert.deepEqual(report(ledger, '2026-11'), expected({ period_id: '2026-11' }));
  const committed = claim(reopened, old.hold_id).body.claim_id;
  assert.deepEqual(report(ledger), expected({ claimed_micro: 100, open_holds: 1 }));
  assert.deepEqual(claim(ledger, old.hold_id).body, { error: 'already_claimed' });
  const closed = settle(ledger, committed, 25);
  assert.deepEqual(settle(reopened, committed, 25), closed);
  assert.deepEqual(recover(ledger, old.hold_id), closed);
  assert.deepEqual(report(ledger), expected({ settled_micro: 25 }));
  const fresh = admit(ledger, admission(2, { max_micro: 100 }));
  assert.equal(fresh.body.remaining_micro, 0);
  assert.deepEqual(report(ledger, '2026-11'), expected({ period_id: '2026-11', admitted_micro: 100, open_holds: 1 }));
});

for (const claimed of [false, true]) {
  it(`(b,c) recovery after year-end retains the admission period (${claimed ? 'claimed/unknown' : 'unclaimed/void'})`, async (t) => {
    const { ledger, client, clock } = host(t, {}, '2026-12-31T22:59:59.999Z');
    const held = await client.admit(admission(1, { max_micro: 100 }));
    if (claimed) claim(ledger, held.hold_id);
    clock.at++;
    const closed = recover(ledger, held.hold_id);
    assert.equal(closed.body.closed_reason, claimed ? 'unknown' : 'void');
    assert.deepEqual(recover(ledger, held.hold_id), closed);
    assert.deepEqual(claim(ledger, held.hold_id).body, { error: 'hold_closed' });
    assert.deepEqual(report(ledger, '2026-12'), expected({ period_id: '2026-12', settled_micro: claimed ? 100 : 0 }));
    assert.deepEqual(report(ledger, '2027-01'), expected({ period_id: '2027-01' }));
    assert.ok(admit(ledger, admission(2, { max_micro: 100 })).body.hold_id);
  });
}

it('(b,c,d) denied decisions replay identically across freed capacity, month rollover and reopen', (t) => {
  const { ledger, clock, path, now, db } = host(t, {}, '2026-09-30T21:59:59.999Z');
  const hold = admit(ledger, admission(1, { max_micro: 100 })).body.hold_id;
  const body = admission(2);
  const denied = admit(ledger, body);
  assert.deepEqual(denied.body, { denied: 'deployment_period_cap', detail: {
    scope: 'deployment_period', deployment_id: 'fixture-host', period_id: '2026-09',
  } });
  assert.deepEqual(resultStatus(denied), { status: 402, code: 'budget_denied' });
  recover(ledger, hold);
  assert.deepEqual(admit(ledger, body), denied);
  clock.at++;
  const reopened = new SqliteBudgetLedger(path, { now });
  t.after(() => reopened.close());
  assert.deepEqual(admit(reopened, body), denied);
  assert.deepEqual(report(ledger), expected());
  assert.ok(admit(reopened, admission(3, { max_micro: 100 })).body.hold_id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_holds').get().n, 3);
});

for (const [scope, overrides, denied] of [
  ['session', { session_cap_micro: 30 }, 'session_cap'],
  ['principal-day', { principal_day_cap_micro: 30 }, 'principal_day_cap'],
  ['tenant-day', { tenant_day_cap_micro: 30 }, 'tenant_day_cap'],
  ['evidence', { evidence: false }, 'no_evidence'],
  ['deployment-period', { deployment_period: policy({ ceiling_micro: 30 }) }, 'deployment_period_cap'],
]) {
  it(`(c) checks ${scope} together with all other scopes without reserving on denial`, (t) => {
    const { ledger, db } = host(t, overrides);
    const result = admit(ledger, admission());
    assert.equal(result.body.denied, denied);
    assert.equal(validate(result.contract, result).ok, true);
    assert.equal(report(ledger).admitted_micro, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_deployment_holds').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_deployment_periods').get().n, 0);
    assert.equal(notifications(db).length, 0);
  });
}

it('(c) aggregate deployment usage spans tenants/projects/principals without accepting caller-chosen scope', (t) => {
  const { ledger, addSession } = host(t);
  admit(ledger, admission(1, { max_micro: 60 }));
  const auth = addSession({ tid: 'fixture-other-tenant', pid: 'fixture-other-project' }, { principal: 'fixture-other-principal' });
  assert.equal(admit(ledger, admission(1, { sid: auth.sid, max_micro: 40 }), auth).body.remaining_micro, 0);
  assert.equal(admit(ledger, admission(2, { sid: auth.sid, max_micro: 1 }), auth).body.denied, 'deployment_period_cap');
  assert.throws(() => admit(ledger, admission(3, { deployment_id: 'escape' })), { status: 400 });
  assert.throws(() => admit(ledger, admission(3, { period_id: '2026-11' })), { status: 400 });
  assert.deepEqual(report(ledger), expected({ admitted_micro: 100, open_holds: 2 }));
});

it('(c) deployment ids define separate ledgers, each with its own period ceiling', (t) => {
  const { ledger, addSession } = host(t);
  const auth = addSession({}, { deployment_period: policy({ deployment_id: 'fixture-host-2', ceiling_micro: 80 }) });
  assert.ok(admit(ledger, admission(1, { max_micro: 100 })).body.hold_id);
  assert.ok(admit(ledger, admission(1, { sid: auth.sid, max_micro: 80 }), auth).body.hold_id);
  assert.equal(report(ledger).admitted_micro, 100);
  assert.equal(report(ledger, '2026-10', 'fixture-host-2').admitted_micro, 80);
});

it('(c) independent concurrent admissions cannot jointly exceed a deployment ceiling', { timeout: 15_000 }, async (t) => {
  const { ledger, addSession, path, clock, db } = host(t);
  const auths = [authority(), ...Array.from({ length: 5 }, (_, n) => addSession({ tid: `fixture-tenant-${n}` }))];
  const results = await parallelAdmits(path, auths.map((auth) => ({ auth, body: admission(1, { sid: auth.sid }) })), clock.at);
  assert.equal(results.filter((result) => result.body.hold_id).length, 2);
  assert.equal(results.filter((result) => result.body.denied === 'deployment_period_cap').length, 4);
  assert.deepEqual(report(ledger), expected({ admitted_micro: 80, open_holds: 2 }));
  assert.deepEqual(notifications(db).map((doc) => JSON.parse(doc.data.detail).notify_at).sort(), [0.5, 0.8]);
});

it('(a,c) parallel admits use the frozen ceiling after an edit and the new ceiling next month', { timeout: 15_000 }, async (t) => {
  const { ledger, addSession, path, clock, db } = host(t);
  const auths = [authority(), ...Array.from({ length: 3 }, (_, n) => addSession({ tid: `fixture-tenant-${n}` }))];
  admit(ledger, admission(1, { max_micro: 20 }));
  ledger.registerSession(registration({ deployment_period: policy({ ceiling_micro: 200, notify_at: [] }) }));
  const calls = (n) => auths.map((auth) => ({ auth, body: admission(n, { sid: auth.sid, max_micro: 60 }) }));
  const october = await parallelAdmits(path, calls(2), clock.at);
  assert.equal(october.filter((result) => result.body.hold_id).length, 1);
  assert.equal(october.filter((result) => result.body.denied === 'deployment_period_cap').length, 3);
  assert.deepEqual(report(ledger), expected({ admitted_micro: 80, open_holds: 2 }));
  assert.equal(notifications(db).length, 2);
  clock.at = Date.parse('2026-10-31T23:00:00Z');
  const november = await parallelAdmits(path, calls(3), clock.at);
  assert.equal(november.filter((result) => result.body.hold_id).length, 3);
  assert.equal(november.filter((result) => result.body.denied === 'deployment_period_cap').length, 1);
  assert.deepEqual(report(ledger, '2026-11'), expected({ period_id: '2026-11', ceiling_micro: 200, admitted_micro: 180, open_holds: 3 }));
  assert.equal(notifications(db).length, 2);
});

it('(c,d) concurrent exact replays reserve and notify once', { timeout: 10_000 }, async (t) => {
  const { ledger, path, clock, db } = host(t);
  const call = { auth: authority(), body: admission(1, { max_micro: 80 }) };
  const results = await parallelAdmits(path, [call, call, call], clock.at);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[0], results[2]);
  assert.deepEqual(report(ledger), expected({ admitted_micro: 80, open_holds: 1 }));
  assert.equal(notifications(db).length, 2);
});

it('(c,d) admission, period binding, notification and journal cursors roll back together on failure', (t) => {
  const { ledger, db } = host(t);
  db.exec(`CREATE TRIGGER fail_notification BEFORE INSERT ON budget_deployment_notifications
    BEGIN SELECT RAISE(ABORT,'fixture notification failure'); END;`);
  assert.throws(() => admit(ledger, admission(1, { max_micro: 80 })), /fixture notification failure/);
  for (const table of ['budget_holds', 'budget_deployment_holds', 'budget_deployment_periods', 'budget_deployment_notifications', 'journal_records']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  }
  assert.deepEqual({ ...db.prepare('SELECT last_seq,audit_seq FROM journal_sessions WHERE sid = ?').get(sid) }, { last_seq: 0, audit_seq: 0 });
  db.exec('DROP TRIGGER fail_notification');
  assert.ok(admit(ledger, admission(1, { max_micro: 80 })).body.hold_id);
  assert.deepEqual(report(ledger), expected({ admitted_micro: 80, open_holds: 1 }));
});

for (const cursor of ['last_seq', 'audit_seq']) {
  for (const slots of [0, 1]) {
    it(`(c,d) exhausted ${cursor} with ${slots} notification slots returns 409 and rolls back every write`, (t) => {
      const { ledger, db } = host(t);
      const cursors = { last_seq: 0, audit_seq: 0, [cursor]: Number.MAX_SAFE_INTEGER - slots };
      db.prepare('UPDATE journal_sessions SET last_seq = ?, audit_seq = ? WHERE sid = ?')
        .run(cursors.last_seq, cursors.audit_seq, sid);
      assert.throws(() => admit(ledger, admission(1, { max_micro: 80 })), {
        status: 409, message: 'Journal or audit sequence exhausted',
      });
      for (const table of ['budget_holds', 'budget_deployment_holds', 'budget_deployment_periods',
        'budget_deployment_notifications', 'journal_records']) {
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
      }
      assert.deepEqual({ ...db.prepare('SELECT last_seq,audit_seq FROM journal_sessions WHERE sid = ?').get(sid) }, cursors);
      assert.deepEqual(report(ledger), expected());
      db.prepare('UPDATE journal_sessions SET last_seq = 0, audit_seq = 0 WHERE sid = ?').run(sid);
      assert.ok(admit(ledger, admission(1, { max_micro: 80 })).body.hold_id);
      assert.equal(notifications(db).length, 2);
    });
  }
}

it('(c,d) exact integer arithmetic admits the last micro-unit without overflow or premature notifications', (t) => {
  const maximum = Number.MAX_SAFE_INTEGER;
  const { ledger, db } = host(t, { session_cap_micro: maximum, principal_day_cap_micro: maximum, tenant_day_cap_micro: maximum,
    deployment_period: policy({ ceiling_micro: maximum, notify_at: [0.1, 1] }) });
  admit(ledger, admission(1, { max_micro: maximum - 1 }));
  assert.equal(notifications(db).length, 1);
  assert.equal(admit(ledger, admission(2, { max_micro: 2 })).body.denied, 'session_cap');
  assert.ok(admit(ledger, admission(3, { max_micro: 1 })).body.hold_id);
  assert.equal(report(ledger).admitted_micro, maximum);
  assert.equal(notifications(db).length, 2);
  assert.equal(notificationThreshold(100, 0.07), 7n);
  assert.equal(notificationThreshold(maximum, 0.1), 900719925474100n);
  assert.equal(notificationThreshold(maximum, Number.MIN_VALUE), 1n);
});

it('(d) a zero deployment ceiling denies all new admissions and emits no crossings', (t) => {
  const { ledger, db } = host(t, { deployment_period: policy({ ceiling_micro: 0 }) });
  const denied = admit(ledger, admission());
  assert.equal(denied.body.denied, 'deployment_period_cap');
  assert.equal(resultStatus(denied).code, 'budget_denied');
  assert.deepEqual(report(ledger), expected({ ceiling_micro: 0 }));
  assert.equal(notifications(db).length, 0);
});

it('(d) client receives machine-readable detail; committed claims settle at the ceiling', async (t) => {
  const { ledger, client } = host(t);
  const held = await client.admit(admission(1, { max_micro: 100 }));
  const committed = await client.claim({ hold_id: held.hold_id, request_sha256: 'a'.repeat(64), worker_generation: 1, auth_epoch: 1 });
  await assert.rejects(client.admit(admission(2)), (error) => {
    assert.equal(error.code, 'budget_denied');
    assert.deepEqual(error.detail, { scope: 'deployment_period', deployment_id: 'fixture-host', period_id: '2026-10' });
    return true;
  });
  assert.equal(client.paidState, 'BUDGET_DENIED');
  assert.equal(client.textCaptureAllowed, true);
  assert.equal(settle(ledger, committed.claim_id, 75).body.charged_micro, 75);
  assert.deepEqual(report(ledger), expected({ settled_micro: 75 }));
  assert.ok(admit(ledger, admission(3, { max_micro: 25 })).body.hold_id);
});

it('(d) an in-flight dispatch finishes and publishes after a new admission is denied', async (t) => {
  const { ledger, client } = host(t);
  const held = await client.admit(admission(1, { max_micro: 100 }));
  let opened, finish;
  const started = new Promise((resolve) => { opened = resolve; });
  const provider = new Promise((resolve) => { finish = resolve; });
  const dispatch = createOutboundGate({ budget: client, open: () => { opened(); return provider; } });
  const sent = dispatch({ hold_id: held.hold_id, request_bytes: Buffer.from('fixture request') });
  await started;
  await assert.rejects(client.admit(admission(2)), { code: 'budget_denied' });
  finish({ output: 'fixture result', actual_micro: 80 });
  const result = await sent;
  assert.equal(result.discarded, false);
  assert.equal(result.output, 'fixture result');
  assert.deepEqual(report(ledger), expected({ settled_micro: 80 }));
});

it('(d) distinct ratios sharing an integer threshold each emit once; empty notify_at emits nothing', (t) => {
  const { ledger, db, addSession } = host(t, { deployment_period: policy({ ceiling_micro: 10, notify_at: [Number.MIN_VALUE, 0.001, 0.01, 0.02] }) });
  const body = admission(1, { max_micro: 1 });
  const held = admit(ledger, body);
  assert.equal(notifications(db).length, 4);
  assert.deepEqual(admit(ledger, body), held);
  recover(ledger, held.body.hold_id);
  admit(ledger, admission(2, { max_micro: 1 }));
  assert.equal(notifications(db).length, 4);
  const auth = addSession({}, { deployment_period: policy({ deployment_id: 'fixture-silent', notify_at: [] }) });
  admit(ledger, admission(1, { sid: auth.sid, max_micro: 100 }), auth);
  assert.equal(notifications(db).length, 4);
});

it('(c,d) scoped admission retries preserve existing generation/epoch fences without changing usage', (t) => {
  const { ledger, journal, db } = host(t);
  const body = admission(1, { max_micro: 100 });
  admit(ledger, body);
  journal.takeover(authority());
  assert.deepEqual(admit(ledger, body).body, { error: 'fenced_generation' });
  journal.append(bytes(record('authz.epoch', { epoch: 2, reason: 'change' }, { writer: { kind: 'host' } })), authority({ gen: 2, writer_kind: 'host' }));
  assert.deepEqual(admit(ledger, body).body, { error: 'revoked' });
  assert.deepEqual(report(ledger), expected({ admitted_micro: 100, open_holds: 1 }));
  assert.equal(notifications(db).length, 3);
});

it('(d) audit.event crossings are contract-valid, globally deduplicated and survive replay/recovery/restart', (t) => {
  const { ledger, db, journal, path, now, clock } = host(t);
  journal.append(bytes(record('audit.event', { audit_seq: 9, name: 'fixture.previous' })), authority());
  const body = admission(1, { max_micro: 100 });
  const first = admit(ledger, body);
  const events = notifications(db);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((doc) => doc.data.audit_seq), [10, 11, 12]);
  assert.deepEqual(events.map((doc) => JSON.parse(doc.data.detail).notify_at), [0.5, 0.8, 1]);
  assert.ok(events.every((doc) => validate(doc.contract, doc).ok));
  assert.equal(journal.cursor(authority()).audit_seq, 12);
  const reopened = new SqliteBudgetLedger(path, { now });
  t.after(() => reopened.close());
  assert.deepEqual(admit(reopened, body), first);
  recover(reopened, first.body.hold_id);
  recover(ledger, first.body.hold_id);
  assert.ok(admit(ledger, admission(2, { max_micro: 100 })).body.hold_id);
  assert.equal(notifications(db).length, 3);
  clock.at = Date.parse('2026-10-31T23:00:00Z');
  assert.ok(admit(reopened, admission(3, { max_micro: 100 })).body.hold_id);
  assert.equal(notifications(db).length, 6);
  assert.deepEqual(notifications(db).slice(3).map((doc) => JSON.parse(doc.data.detail).period_id), ['2026-11', '2026-11', '2026-11']);
  journal.append(bytes(record('audit.event', { audit_seq: 16, name: 'fixture.after' })), authority());
  assert.equal(journal.cursor(authority()).audit_seq, 16);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

it('(d) thresholds use charged plus reserved usage; denied attempts and released holds never add notifications', async (t) => {
  const { ledger, client, db } = host(t);
  const first = await client.admit(admission(1, { max_micro: 49 }));
  assert.equal(notifications(db).length, 0);
  const committed = claim(ledger, first.hold_id).body.claim_id;
  settle(ledger, committed, 20);
  admit(ledger, admission(2, { max_micro: 29 }));
  assert.equal(notifications(db).length, 0);
  admit(ledger, admission(3, { max_micro: 1 }));
  assert.equal(notifications(db).length, 1);
  assert.equal(admit(ledger, admission(4, { max_micro: 51 })).body.denied, 'deployment_period_cap');
  assert.equal(notifications(db).length, 1);
});

it('(e) reporting uses disjoint admitted/claimed/settled buckets, including zero and unknown settlements', async (t) => {
  const { ledger, client, path, now } = host(t);
  const a = await client.admit(admission(1, { max_micro: 30 }));
  const b = await client.admit(admission(2, { max_micro: 30 }));
  const c = await client.admit(admission(3, { max_micro: 40 }));
  const claimedB = claim(ledger, b.hold_id).body.claim_id;
  claim(ledger, c.hold_id);
  assert.deepEqual(report(ledger), expected({ admitted_micro: 30, claimed_micro: 70, open_holds: 3 }));
  settle(ledger, claimedB, 0);
  const closed = recover(ledger, c.hold_id);
  assert.equal(closed.body.charged_micro, 40);
  assert.deepEqual(report(ledger), expected({ admitted_micro: 30, settled_micro: 40, open_holds: 1 }));
  recover(ledger, a.hold_id);
  assert.deepEqual(report(ledger), expected({ settled_micro: 40 }));
  const reopened = new SqliteBudgetLedger(path, { now });
  t.after(() => reopened.close());
  assert.deepEqual(report(reopened), report(ledger));
  assert.equal(validate('aithema.budget.message', budgetMessage('deployment_period_report', report(ledger))).ok, true);
});

it('(e) reports empty past/future periods without writes and rejects malformed or unknown keys', (t) => {
  const { ledger, db } = host(t);
  for (const period_id of ['2020-01', '2026-10', '2027-01']) {
    const value = report(ledger, period_id);
    assert.deepEqual(value, expected({ period_id }));
    value.admitted_micro = 100;
    assert.equal(report(ledger, period_id).admitted_micro, 0);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_deployment_periods').get().n, 0);
  for (const period_id of ['2026-00', '2026-13', '2026-1', '2026-10\n', 'not-a-period', 202610, null]) {
    assert.throws(() => report(ledger, period_id), { status: 400 });
  }
  assert.throws(() => report(ledger, '2026-10', 'unknown-deployment'), { status: 404 });
  assert.throws(() => report(ledger, '2026-10', ''), { status: 400 });
  assert.throws(() => report(ledger, '2026-10', 'fixture-host\n'), { status: 400 });
  for (const query of [undefined, null, [], {}, { deployment_id: 'fixture-host', period_id: '2026-10', bypass: true }]) {
    assert.throws(() => ledger.getDeploymentPeriod(query), { status: 400 });
  }
});

it('(e) reports unopened past, current and future periods using the live policy without freezing them', (t) => {
  const { ledger, db } = host(t);
  for (const ceiling_micro of [200, 0, 300]) {
    ledger.registerSession(registration({ deployment_period: policy({ ceiling_micro, notify_at: [] }) }));
    for (const period_id of ['2020-01', '2026-10', '2027-01']) {
      assert.deepEqual(report(ledger, period_id), expected({ period_id, ceiling_micro }));
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_deployment_periods').get().n, 0);
  }
});
