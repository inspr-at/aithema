import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { SqliteJournal } from '../runtime/journal/index.js';
import { BudgetClient, SqliteBudgetLedger, budgetMessage, encodeMessage, resultStatus } from '../runtime/budget/index.js';
import { validate } from '../contracts/validate.js';
import { authority as journalAuthority, bytes, code, now, otherSid, record, session, sid, time, turn } from './fixtures/journal/helpers.mjs';

const authority = (overrides = {}) => journalAuthority({ capabilities: ['aithema.ledger', 'aithema.journal.read', 'aithema.journal.write'], ...overrides });
const setup = (sid, overrides = {}) => ({ sid, issuer: 'fixture-issuer', principal: 'fixture-person', currency: 'EUR',
  session_cap_micro: 1000, principal_day_cap_micro: 1000, tenant_day_cap_micro: 1000, evidence: true, ...overrides });
const admitBody = (n = 1, overrides = {}) => {
  const body = { sid, worker_generation: 1, auth_epoch: 1, lane: 'spec', max_micro: 100, currency: 'EUR', ...overrides };
  return { ...body, attempt_id: `${body.sid}:${body.worker_generation}:${body.lane}:${n}` };
};
const claimBody = (hold_id, overrides = {}) => ({ hold_id, request_sha256: 'a'.repeat(64), worker_generation: 1, auth_epoch: 1, ...overrides });
const recoverBody = (hold_id, overrides = {}) => ({ hold_id, worker_generation: 1, auth_epoch: 1, ...overrides });
function host(t, policy = {}, clock = now) {
  const path = join(mkdtempSync(join(tmpdir(), 'aithema-budget-')), 'host.sqlite');
  const journal = new SqliteJournal(path, { now: clock });
  journal.createSession(bytes(session()));
  const ledger = new SqliteBudgetLedger(path, { now: clock });
  ledger.registerSession(setup(sid, policy));
  const client = new BudgetClient({ port: ledger, journal, authority: authority(), now: clock });
  const db = new DatabaseSync(path);
  t.after(() => { db.close(); ledger.close(); journal.close(); });
  return { path, journal, ledger, client, db };
}
const admit = (ledger, body, auth = authority()) => ledger.admit(encodeMessage('admit_request', body), auth);
const claim = (ledger, hold, auth = authority(), overrides = {}) => ledger.claim(encodeMessage('claim_request', claimBody(hold, overrides)), auth);
const recover = (ledger, hold, auth = authority(), overrides = {}) => ledger.recover(encodeMessage('recover_request', recoverBody(hold, overrides)), auth);
const settle = (ledger, claim_id, actual_micro = 25, auth = authority()) => ledger.settle(encodeMessage('settle_request', { claim_id, outcome: 'settled', actual_micro }), auth);

/** Real independent SQLite writers, synchronised with local process IPC. */
async function raceWriters(path, calls) {
  const workers = calls.map(({ method, body, journal = false }) => {
    const source = `import { SqliteBudgetLedger, encodeMessage } from ${JSON.stringify(new URL('../runtime/budget/index.js', import.meta.url).href)};
      import { SqliteJournal } from ${JSON.stringify(new URL('../runtime/journal/index.js', import.meta.url).href)};
      const host = new ${journal ? 'SqliteJournal' : 'SqliteBudgetLedger'}(${JSON.stringify(path)}, { now: () => ${time} });
      process.on('message', () => {
        try {
          const result = host.${method}(${journal ? '' : `encodeMessage('${method}_request', ${JSON.stringify(body)}), `}${JSON.stringify(authority())});
          host.close(); process.send({ result }, () => process.disconnect());
        } catch (error) { process.send({ error: error.message }, () => process.disconnect()); }
      });
      process.send({ ready: true });`;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let readyResolve, readyReject, doneResolve, doneReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const done = new Promise((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
    // A failed start must not create an unhandled rejection before the ready barrier.
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

it('(a) admission preserves original bytes and its exact verdict across retries and reopen', (t) => {
  const { ledger, path, db } = host(t);
  const original = bytes(budgetMessage('admit_request', admitBody()));
  const first = ledger.admit(original, authority());
  assert.equal(first.body.remaining_micro, 900);
  admit(ledger, admitBody(2));
  assert.deepEqual(ledger.admit(original, authority()), first);
  assert.deepEqual(Buffer.from(db.prepare('SELECT original_bytes FROM budget_holds WHERE attempt_id = ?').get(admitBody().attempt_id).original_bytes), original);
  const reopened = new SqliteBudgetLedger(path, { now });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.admit(original, authority()), first);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_holds').get().n, 2);
  assert.equal(validate(first.contract, first).ok, true);
});

it('(a) different bytes under an attempt_id conflict, even equivalent JSON whitespace or key order', (t) => {
  const { ledger } = host(t);
  const doc = budgetMessage('admit_request', admitBody());
  ledger.admit(bytes(doc), authority());
  for (const different of [encodeMessage('admit_request', doc.body), bytes({ ...doc, body: { ...doc.body, max_micro: 101 } })]) {
    const result = ledger.admit(different, authority());
    assert.deepEqual(result.body, { error: 'idempotency_conflict' });
    assert.deepEqual(resultStatus(result), { status: 409, code: 'idempotency_conflict' });
  }
});

it('(a) denials are durable/idempotent even when recovered reservations free capacity', (t) => {
  const { ledger, path } = host(t, { session_cap_micro: 100 });
  const held = admit(ledger, admitBody()).body.hold_id;
  const denied = admit(ledger, admitBody(2));
  assert.deepEqual(denied.body, { denied: 'session_cap' });
  recover(ledger, held);
  const reopened = new SqliteBudgetLedger(path, { now });
  t.after(() => reopened.close());
  assert.deepEqual(admit(reopened, admitBody(2)), denied);
  assert.ok(admit(reopened, admitBody(3)).body.hold_id);
  assert.deepEqual(resultStatus(denied), { status: 402, code: 'budget_denied' });
});

it('(a,b,c) authority fencing applies even to exact admission retries and closed-hold recovery', (t) => {
  const { journal, ledger } = host(t);
  const held = admit(ledger, admitBody()).body.hold_id;
  recover(ledger, held);
  journal.takeover(authority());
  assert.deepEqual(admit(ledger, admitBody()).body, { error: 'fenced_generation' });
  assert.deepEqual(recover(ledger, held).body, { error: 'fenced_generation' });
  assert.deepEqual(recover(ledger, held, authority({ gen: 2 }), { worker_generation: 2 }).body,
    { hold_id: held, closed_reason: 'void', charged_micro: 0 });
});

it('(b) claim is durable and unique per hold across two ledger connections, binding exact digest/gen/epoch', async (t) => {
  const { ledger, client, path, db } = host(t);
  const held = await client.admit(admitBody());
  const response = claim(ledger, held.hold_id);
  const second = new SqliteBudgetLedger(path, { now });
  t.after(() => second.close());
  for (const request_sha256 of ['a'.repeat(64), 'b'.repeat(64)]) {
    assert.deepEqual(claim(second, held.hold_id, authority(), { request_sha256 }).body, { error: 'already_claimed' });
  }
  const row = db.prepare('SELECT * FROM budget_claims').get();
  assert.equal(row.claim_id, response.body.claim_id);
  assert.equal(row.request_sha256, 'a'.repeat(64));
  assert.equal(row.worker_generation, 1);
  assert.equal(row.auth_epoch, 1);
  assert.throws(() => db.prepare(`INSERT INTO budget_claims(claim_id,hold_id,request_sha256,worker_generation,auth_epoch,state,claimed_at)
    VALUES(?,?,?,?,?,'claimed',?)`).run(randomUUID(), held.hold_id, 'b'.repeat(64), 1, 1, new Date(time).toISOString()), /UNIQUE/);
});

it('(b) takeover before claim refuses both a stale worker and a new worker reusing an old hold', async (t) => {
  const { client, ledger, journal } = host(t);
  const held = await client.admit(admitBody());
  journal.takeover(authority());
  assert.deepEqual(claim(ledger, held.hold_id).body, { error: 'fenced_generation' });
  assert.deepEqual(claim(ledger, held.hold_id, authority({ gen: 2 }), { worker_generation: 2 }).body, { error: 'fenced_generation' });
  const current = authority({ gen: 2 });
  assert.deepEqual(recover(ledger, held.hold_id, current, { worker_generation: 2 }).body,
    { hold_id: held.hold_id, closed_reason: 'void', charged_micro: 0 });
});

for (const change of ['takeover', 'revocation', 'purge']) {
  it(`(b) ${change} after claim lets its original owner finish, charged at maximum`, async (t) => {
    const { client, ledger, journal } = host(t);
    const held = await client.admit(admitBody());
    const committed = claim(ledger, held.hold_id).body.claim_id;
    if (change === 'takeover') journal.takeover(authority());
    else journal.append(bytes(change === 'revocation'
      ? record('authz.epoch', { epoch: 2, reason: 'change' }, { writer: { kind: 'host' } })
      : record('session.control', { action: change }, { writer: { kind: 'host' } })), authority({ writer_kind: 'host' }));
    const closed = settle(ledger, committed);
    assert.deepEqual(closed.body, { hold_id: held.hold_id, closed_reason: 'unknown', charged_micro: 100 });
    assert.deepEqual(settle(ledger, committed), closed);
    assert.equal(ledger.isCurrent(authority()), false);
    assert.deepEqual(claim(ledger, held.hold_id).body, { error: change === 'takeover' ? 'fenced_generation' : 'revoked' });
  });
}

it('suspend pauses new admissions and claims, leaves reads/recovery open, and resume restores dispatch', async (t) => {
  const { client, ledger, journal, db } = host(t);
  const held = await client.admit(admitBody());
  journal.append(bytes(record('session.control', { action: 'suspend' }, { writer: { kind: 'host' } })), authority({ writer_kind: 'host' }));
  assert.throws(() => admit(ledger, admitBody(2)), { status: 409, code: null });
  assert.throws(() => admit(ledger, admitBody()), { status: 409, code: null });
  assert.throws(() => claim(ledger, held.hold_id), { status: 409, code: null });
  assert.equal(ledger.isCurrent(authority()), true);
  assert.deepEqual(ledger.listOpen({}, authority()).body.holds, [{ hold_id: held.hold_id, attempt_id: admitBody().attempt_id, claimed: false }]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_holds').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_claims').get().n, 0);
  const closed = recover(ledger, held.hold_id);
  assert.deepEqual(closed.body, { hold_id: held.hold_id, closed_reason: 'void', charged_micro: 0 });
  assert.deepEqual(recover(ledger, held.hold_id), closed);
  journal.append(bytes(record('session.control', { action: 'resume' }, { writer: { kind: 'host' } })), authority({ writer_kind: 'host' }));
  const resumed = await client.admit(admitBody(2));
  assert.ok(claim(ledger, resumed.hold_id).body.claim_id);
  assert.deepEqual(claim(ledger, held.hold_id).body, { error: 'hold_closed' });
});

it('suspend after claim preserves current authority and actual settlement across resume and retry', async (t) => {
  const { client, ledger, journal } = host(t);
  const held = await client.admit(admitBody());
  const committed = claim(ledger, held.hold_id).body.claim_id;
  journal.append(bytes(record('session.control', { action: 'suspend' }, { writer: { kind: 'host' } })), authority({ writer_kind: 'host' }));
  assert.equal(ledger.isCurrent(authority()), true);
  const closed = settle(ledger, committed, 5);
  assert.deepEqual(closed.body, { hold_id: held.hold_id, closed_reason: 'settled', charged_micro: 5 });
  assert.deepEqual(recover(ledger, held.hold_id), closed);
  assert.deepEqual(ledger.listOpen({}, authority()).body.holds, []);
  journal.append(bytes(record('session.control', { action: 'resume' }, { writer: { kind: 'host' } })), authority({ writer_kind: 'host' }));
  assert.deepEqual(settle(ledger, committed, 5), closed);
  assert.deepEqual(recover(ledger, held.hold_id), closed);
});

it('suspend never masks an epoch revocation or a stale generation on new admission/claim', async (t) => {
  const { client, ledger, journal } = host(t);
  const held = await client.admit(admitBody());
  journal.takeover(authority());
  journal.append(bytes(record('session.control', { action: 'suspend' }, { writer: { kind: 'host' } })), authority({ writer_kind: 'host', gen: 2 }));
  assert.deepEqual(admit(ledger, admitBody(2)).body, { error: 'fenced_generation' });
  assert.deepEqual(claim(ledger, held.hold_id).body, { error: 'fenced_generation' });
  journal.append(bytes(record('authz.epoch', { epoch: 2, reason: 'change' }, { writer: { kind: 'host' } })), authority({ writer_kind: 'host', gen: 2 }));
  assert.deepEqual(admit(ledger, admitBody(2)).body, { error: 'revoked' });
  assert.deepEqual(claim(ledger, held.hold_id).body, { error: 'revoked' });
});

it('(b) revocation before claim refuses stale epoch, even with the new generation supplied', async (t) => {
  const { client, journal, ledger } = host(t);
  const held = await client.admit(admitBody());
  journal.append(bytes(record('authz.epoch', { epoch: 2, reason: 'change' }, { writer: { kind: 'host' } })), authority({ writer_kind: 'host' }));
  assert.deepEqual(claim(ledger, held.hold_id).body, { error: 'revoked' });
  assert.deepEqual(claim(ledger, held.hold_id, authority({ auth_epoch: 2 }), { auth_epoch: 2 }).body, { error: 'revoked' });
  assert.deepEqual(recover(ledger, held.hold_id, authority({ auth_epoch: 2 }), { auth_epoch: 2 }).body.closed_reason, 'void');
});

it('(b) token and body generation/epoch must agree at claim time', async (t) => {
  const { client, ledger } = host(t);
  const held = await client.admit(admitBody());
  assert.deepEqual(claim(ledger, held.hold_id, authority(), { worker_generation: 2 }).body, { error: 'fenced_generation' });
  assert.deepEqual(claim(ledger, held.hold_id, authority(), { auth_epoch: 2 }).body, { error: 'revoked' });
  assert.ok(claim(ledger, held.hold_id).body.claim_id);
});

it('(b) hold must have an acknowledged matching write-ahead journal record', (t) => {
  const { ledger, journal } = host(t);
  const held = admit(ledger, admitBody()).body.hold_id;
  assert.throws(() => claim(ledger, held), /acknowledged matching/);
  journal.append(bytes(record('budget.hold', { hold_id: held, attempt_id: admitBody().attempt_id,
    lane: 'spec', max_micro: 99, currency: 'EUR' })), authority());
  assert.throws(() => claim(ledger, held), /acknowledged matching/);
  journal.append(bytes(record('budget.hold', { hold_id: held, attempt_id: admitBody().attempt_id,
    lane: 'spec', max_micro: 100, currency: 'EUR' })), authority());
  assert.ok(claim(ledger, held).body.claim_id);
});

it('(c,g) crash before claim (journaled or not) enumerates and recovers void, blocking later claim', async (t) => {
  const { client, ledger, path } = host(t);
  const unjournaled = admit(ledger, admitBody()).body.hold_id;
  const journaled = (await client.admit(admitBody(2))).hold_id;
  const reopened = new SqliteBudgetLedger(path, { now });
  t.after(() => reopened.close());
  assert.equal(reopened.listOpen({}, authority()).body.holds.length, 2);
  for (const hold of [unjournaled, journaled]) {
    const response = recover(reopened, hold);
    assert.deepEqual(response.body, { hold_id: hold, closed_reason: 'void', charged_micro: 0 });
    assert.deepEqual(recover(reopened, hold), response);
    assert.deepEqual(claim(reopened, hold).body, { error: 'hold_closed' });
  }
  assert.deepEqual(reopened.listOpen({}, authority()).body.holds, []);
});

it('(c,g) crash after claim recovers unknown at maximum; a late settlement cannot change recovery', async (t) => {
  const { client, ledger, path } = host(t);
  const held = await client.admit(admitBody());
  const committed = claim(ledger, held.hold_id).body.claim_id;
  const reopened = new SqliteBudgetLedger(path, { now });
  t.after(() => reopened.close());
  assert.equal(reopened.listOpen({}, authority()).body.holds[0].claimed, true);
  const response = recover(reopened, held.hold_id);
  assert.deepEqual(response.body, { hold_id: held.hold_id, closed_reason: 'unknown', charged_micro: 100 });
  assert.deepEqual(recover(ledger, held.hold_id), response);
  assert.deepEqual(settle(ledger, committed), response);
  assert.deepEqual(claim(ledger, held.hold_id).body, { error: 'hold_closed' });
});

it('(c,g) lost settlement response returns its recorded amount on recovery and exact settlement retry', async (t) => {
  const { client, ledger, path } = host(t);
  const held = await client.admit(admitBody());
  const committed = claim(ledger, held.hold_id).body.claim_id;
  settle(ledger, committed, 17); // emulate losing the committed response
  const reopened = new SqliteBudgetLedger(path, { now });
  t.after(() => reopened.close());
  const response = recover(reopened, held.hold_id);
  assert.deepEqual(response.body, { hold_id: held.hold_id, closed_reason: 'settled', charged_micro: 17 });
  assert.deepEqual(recover(reopened, held.hold_id), response);
  assert.deepEqual(settle(reopened, committed, 17), response);
  assert.throws(() => settle(reopened, committed, 18), code('idempotency_conflict'));
});

it('(c) recover always checks current generation and epoch, but may close an earlier-generation hold', async (t) => {
  const { client, journal, ledger } = host(t);
  const held = await client.admit(admitBody());
  journal.takeover(authority());
  assert.deepEqual(recover(ledger, held.hold_id).body, { error: 'fenced_generation' });
  assert.deepEqual(recover(ledger, held.hold_id, authority({ gen: 2 })).body, { error: 'fenced_generation' });
  assert.deepEqual(recover(ledger, held.hold_id, authority({ gen: 2 }), { worker_generation: 2, auth_epoch: 2 }).body, { error: 'revoked' });
  assert.equal(recover(ledger, held.hold_id, authority({ gen: 2 }), { worker_generation: 2 }).body.closed_reason, 'void');
});

it('(d) ledger keyset enumeration drains pages without skipping rows or relying on journal contents', async (t) => {
  const { ledger, client, db } = host(t);
  const held = [];
  for (let n = 0; n < 7; n++) held.push(admit(ledger, admitBody(n, { max_micro: 10 })).body.hold_id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM journal_records').get().n, 0);
  const settlements = await client.recoverOpen({ limit: 2 });
  assert.deepEqual(settlements.map((r) => r.hold_id), held);
  assert.ok(settlements.every((r) => r.closed_reason === 'void'));
  assert.deepEqual(ledger.listOpen({}, authority()).body, { sid, state: 'open', holds: [], next_cursor: null });
});

it('(d) pagination sees new admissions, rejects foreign/malformed cursors, and reads need no current gen', (t) => {
  const { ledger, journal } = host(t);
  const first = admit(ledger, admitBody()).body.hold_id;
  admit(ledger, admitBody(2));
  const page = ledger.listOpen({ limit: 1 }, authority()).body;
  assert.equal(page.holds[0].hold_id, first);
  recover(ledger, first);
  const third = admit(ledger, admitBody(3)).body.hold_id;
  assert.deepEqual(ledger.listOpen({ cursor: page.next_cursor }, authority()).body.holds.map((h) => h.hold_id),
    [admit(ledger, admitBody(2)).body.hold_id, third]);
  journal.takeover(authority());
  assert.equal(ledger.listOpen({}, authority()).body.holds.length, 2);
  for (const cursor of ['', `${otherSid}:1`, `${sid}:NaN`, `${sid}:0`, `${sid}:9007199254740992`, `${sid}:01`]) {
    assert.throws(() => ledger.listOpen({ cursor }, authority()), { status: 400 });
  }
  for (const limit of [0, 1001, 1.1]) assert.throws(() => ledger.listOpen({ limit }, authority()), { status: 400 });
});

it('(e) every potentially paid retry has its own attempt, hold and claim, charged independently', async (t) => {
  const { client, ledger, db } = host(t);
  for (let n = 1; n <= 3; n++) {
    const held = await client.admit(admitBody(n));
    const committed = claim(ledger, held.hold_id).body.claim_id;
    ledger.settle(encodeMessage('settle_request', { claim_id: committed, outcome: 'unknown' }), authority());
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_holds').get().n, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_claims').get().n, 3);
  assert.equal(db.prepare('SELECT SUM(charged_or_reserved_micro) AS n FROM budget_usage').get().n, 300);
});

for (const lane of ['reaction', 'spec', 'design', 'stt', 'tts']) {
  it(`(f) session ceiling denies paid ${lane}; text journal capture continues`, async (t) => {
    const { ledger, journal } = host(t, { session_cap_micro: 100 });
    admit(ledger, admitBody());
    assert.deepEqual(admit(ledger, admitBody(1, { lane })).body, lane === 'spec'
      ? admit(ledger, admitBody()).body : { denied: 'session_cap' });
    assert.deepEqual(admit(ledger, admitBody(2, { lane })).body, { denied: 'session_cap' });
    assert.equal(journal.append(bytes(turn()), authority()).document.kind, 'turn');
  });
}

for (const scope of ['principal', 'tenant']) {
  it(`(f) ${scope}/day aggregates across sessions and projects; identity/currency never come from callers`, (t) => {
    const policy = { [`${scope}_day_cap_micro`]: 100 };
    const { journal, ledger } = host(t, policy);
    journal.createSession(bytes(session({ sid: otherSid, pid: 'second-fixture-project' })));
    ledger.registerSession(setup(otherSid, { ...policy, principal: scope === 'tenant' ? 'another-person' : 'fixture-person' }));
    admit(ledger, admitBody());
    assert.deepEqual(admit(ledger, admitBody(1, { sid: otherSid }), authority({ sid: otherSid, pid: 'second-fixture-project' })).body,
      { denied: `${scope}_day_cap` });
    assert.throws(() => admit(ledger, admitBody(2, { currency: 'USD' })), { status: 400 });
  });
}

it('(f) UTC daily caps reset, but session charges persist and closing on a new day stays on admission day', async (t) => {
  let timestamp = time;
  const clock = () => timestamp;
  const { ledger, client, journal, db } = host(t, { principal_day_cap_micro: 100 }, clock);
  const held = await client.admit(admitBody());
  const committed = claim(ledger, held.hold_id).body.claim_id;
  assert.equal(admit(ledger, admitBody(2)).body.denied, 'principal_day_cap');
  timestamp += 86_400_000;
  const current = authority({ exp: Math.floor(timestamp / 1000) + 900 });
  assert.equal(settle(ledger, committed, 30, current).body.charged_micro, 30);
  assert.equal(db.prepare('SELECT budget_day FROM budget_holds WHERE hold_id = ?').get(held.hold_id).budget_day, '2026-09-30');
  journal.createSession(bytes(session({ sid: otherSid })));
  ledger.registerSession(setup(otherSid, { principal_day_cap_micro: 100 }));
  assert.ok(admit(ledger, admitBody(1, { sid: otherSid }), { ...current, sid: otherSid }).body.hold_id);
});

it('(f) missing evidence and zero ceilings fail closed with contract-valid budget_denied results', (t) => {
  const { ledger } = host(t, { evidence: false, session_cap_micro: 0 });
  assert.deepEqual(admit(ledger, admitBody()).body, { denied: 'no_evidence' });
});

it('(f) reservations include all open holds and settlement releases only the unused maximum', async (t) => {
  const { client, ledger } = host(t, { session_cap_micro: 100 });
  const held = await client.admit(admitBody());
  const committed = claim(ledger, held.hold_id).body.claim_id;
  assert.equal(admit(ledger, admitBody(2, { max_micro: 1 })).body.denied, 'session_cap');
  settle(ledger, committed, 25);
  assert.equal(admit(ledger, admitBody(3, { max_micro: 75 })).body.remaining_micro, 0);
  assert.equal(admit(ledger, admitBody(4, { max_micro: 1 })).body.denied, 'session_cap');
});

it('(f) integer accounting at MAX_SAFE_INTEGER cannot over-admit through rounding', (t) => {
  const max = Number.MAX_SAFE_INTEGER;
  const { ledger } = host(t, { session_cap_micro: max, principal_day_cap_micro: max, tenant_day_cap_micro: max });
  assert.equal(admit(ledger, admitBody(1, { max_micro: max - 1 })).body.remaining_micro, 1);
  assert.equal(admit(ledger, admitBody(2, { max_micro: 1 })).body.remaining_micro, 0);
  assert.equal(admit(ledger, admitBody(3, { max_micro: 1 })).body.denied, 'session_cap');
});

it('host registration is immutable and conflicting shared policy rolls back registration', (t) => {
  const { ledger, journal, db } = host(t);
  assert.doesNotThrow(() => ledger.registerSession(setup(sid)));
  assert.throws(() => ledger.registerSession(setup(sid, { principal: 'attacker' })), { status: 409 });
  journal.createSession(bytes(session({ sid: otherSid })));
  assert.throws(() => ledger.registerSession(setup(otherSid, { principal_day_cap_micro: 999 })), { status: 409 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_sessions').get().n, 1);
  assert.throws(() => ledger.registerSession(setup(otherSid, { session_cap_micro: -1 })), { status: 400 });
  assert.throws(() => new SqliteBudgetLedger(':memory:'), /Initialize SqliteJournal/);
});

it('transport rejects wrong scope, capabilities, expired tokens and unknown holds without mutation', (t) => {
  const { ledger, db } = host(t);
  for (const [overrides, status] of [[{ tid: 'foreign' }, 403], [{ pid: 'foreign' }, 403],
    [{ capabilities: [] }, 403], [{ capabilities: 'aithema.ledger' }, 403], [{ writer_kind: 'browser' }, 403],
    [{ exp: Math.floor(time / 1000) }, 401]]) {
    const auth = authority(overrides);
    assert.throws(() => admit(ledger, admitBody(), auth), { status });
    assert.throws(() => ledger.listOpen({}, auth), { status });
    assert.throws(() => recover(ledger, randomUUID(), auth), { status });
  }
  assert.throws(() => recover(ledger, randomUUID()), { status: 404 });
  assert.throws(() => claim(ledger, randomUUID()), { status: 404 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_holds').get().n, 0);
});

it('cross-session hold/claim access is hidden, even under valid authority for the other session', async (t) => {
  const { ledger, journal, client } = host(t);
  const held = await client.admit(admitBody());
  const committed = claim(ledger, held.hold_id).body.claim_id;
  journal.createSession(bytes(session({ sid: otherSid })));
  ledger.registerSession(setup(otherSid));
  const foreign = authority({ sid: otherSid });
  assert.throws(() => claim(ledger, held.hold_id, foreign), { status: 404 });
  assert.throws(() => recover(ledger, held.hold_id, foreign), { status: 404 });
  assert.throws(() => settle(ledger, committed, 10, foreign), { status: 404 });
  assert.throws(() => settle(ledger, committed, 10, authority({ gen: 2 })), { status: 403 });
});

it('malformed/incompatible budget messages, mismatched attempts and unsupported fields fail contracts', (t) => {
  const { ledger } = host(t);
  const doc = budgetMessage('admit_request', admitBody());
  for (const original of [Buffer.from('{'), Buffer.from([0xff]), bytes({ ...doc, body: { ...doc.body, unknown: true } }),
    bytes({ ...doc, body: { ...doc.body, attempt_id: `${otherSid}:1:spec:1` } }),
    bytes({ ...doc, body: { ...doc.body, max_micro: Number.MAX_SAFE_INTEGER + 1 } })]) {
    assert.throws(() => ledger.admit(original, authority()), { status: 400 });
  }
  for (const doc2 of [{ ...doc, major: 2 }, { ...doc, minor: 1, min_reader: 1 }]) {
    assert.throws(() => ledger.admit(bytes(doc2), authority()), code('contract_too_new', 422));
  }
  assert.throws(() => ledger.admit(doc, authority()), { status: 400 });
});

it('actual over maximum and illegal unknown/actual combinations cannot settle or release reservations', async (t) => {
  const { client, ledger } = host(t);
  const held = await client.admit(admitBody());
  const committed = claim(ledger, held.hold_id).body.claim_id;
  assert.throws(() => settle(ledger, committed, 101), { status: 400 });
  assert.throws(() => ledger.settle(bytes({ contract: 'aithema.budget.message', major: 1, minor: 0, min_reader: 0,
    type: 'settle_request', body: { claim_id: committed, outcome: 'unknown', actual_micro: 0 } }), authority()), { status: 400 });
  assert.equal(ledger.listOpen({}, authority()).body.holds.length, 1);
  assert.equal(recover(ledger, held.hold_id).body.charged_micro, 100);
});

it('admission, claim and recovery each roll back completely when a transaction fails', async (t) => {
  const { ledger, client, db } = host(t);
  db.exec("CREATE TRIGGER fixture_admit BEFORE INSERT ON budget_holds BEGIN SELECT RAISE(ABORT, 'fixture admit crash'); END;");
  assert.throws(() => admit(ledger, admitBody()), /fixture admit crash/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_holds').get().n, 0);
  db.exec('DROP TRIGGER fixture_admit');
  const held = await client.admit(admitBody());
  db.exec("CREATE TRIGGER fixture_claim AFTER INSERT ON budget_claims BEGIN SELECT RAISE(ABORT, 'fixture claim crash'); END;");
  assert.throws(() => claim(ledger, held.hold_id), /fixture claim crash/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_claims').get().n, 0);
  db.exec('DROP TRIGGER fixture_claim');
  claim(ledger, held.hold_id);
  db.exec("CREATE TRIGGER fixture_recover BEFORE UPDATE ON budget_holds BEGIN SELECT RAISE(ABORT, 'fixture recovery crash'); END;");
  assert.throws(() => recover(ledger, held.hold_id), /fixture recovery crash/);
  assert.equal(db.prepare('SELECT state FROM budget_claims').get().state, 'claimed');
  assert.equal(db.prepare('SELECT state FROM budget_holds').get().state, 'admitted');
  db.exec('DROP TRIGGER fixture_recover');
  assert.equal(recover(ledger, held.hold_id).body.closed_reason, 'unknown');
});

it('(a,f) simultaneous independent-process admissions cannot overspend an aggregate cap', { timeout: 10_000 }, async (t) => {
  const { path, db } = host(t, { session_cap_micro: 100 });
  const results = await raceWriters(path, [{ method: 'admit', body: admitBody(1) }, { method: 'admit', body: admitBody(2) }]);
  assert.equal(results.filter((result) => result.body.hold_id).length, 1);
  assert.equal(results.filter((result) => result.body.denied === 'session_cap').length, 1);
  assert.equal(db.prepare('SELECT SUM(charged_or_reserved_micro) AS used FROM budget_usage').get().used, 100);
});

it('(b,c) independent-process claim versus recovery has one linear outcome, never a reopened hold', { timeout: 10_000 }, async (t) => {
  const { client, path, ledger } = host(t);
  const held = await client.admit(admitBody());
  const [claimed, recovered] = await raceWriters(path, [
    { method: 'claim', body: claimBody(held.hold_id) }, { method: 'recover', body: recoverBody(held.hold_id) },
  ]);
  if (claimed.body.claim_id) assert.deepEqual(recovered.body, { hold_id: held.hold_id, closed_reason: 'unknown', charged_micro: 100 });
  else {
    assert.deepEqual(claimed.body, { error: 'hold_closed' });
    assert.deepEqual(recovered.body, { hold_id: held.hold_id, closed_reason: 'void', charged_micro: 0 });
  }
  assert.deepEqual(recover(ledger, held.hold_id), recovered);
  assert.deepEqual(claim(ledger, held.hold_id).body, { error: 'hold_closed' });
});

it('(b) independent-process journal takeover and ledger claim use the same transactional authority', { timeout: 10_000 }, async (t) => {
  const { client, path, ledger } = host(t);
  const held = await client.admit(admitBody());
  const [claimed, cursor] = await raceWriters(path, [
    { method: 'claim', body: claimBody(held.hold_id) }, { method: 'takeover', journal: true },
  ]);
  assert.equal(cursor.worker_generation, 2);
  const recovered = recover(ledger, held.hold_id, authority({ gen: 2 }), { worker_generation: 2 });
  if (claimed.body.claim_id) assert.equal(recovered.body.closed_reason, 'unknown');
  else {
    assert.deepEqual(claimed.body, { error: 'fenced_generation' });
    assert.equal(recovered.body.closed_reason, 'void');
  }
});

it('(g) abrupt process death after a durable claim still recovers unknown from disk', (t) => {
  const { ledger, journal, path } = host(t);
  const held = admit(ledger, admitBody()).body.hold_id;
  journal.append(bytes(record('budget.hold', { hold_id: held, attempt_id: admitBody().attempt_id,
    lane: 'spec', max_micro: 100, currency: 'EUR' })), authority());
  const source = `import { SqliteBudgetLedger, encodeMessage } from ${JSON.stringify(new URL('../runtime/budget/index.js', import.meta.url).href)};
    const ledger = new SqliteBudgetLedger(${JSON.stringify(path)}, { now: () => ${time} });
    const result = ledger.claim(encodeMessage('claim_request', ${JSON.stringify(claimBody(held))}), ${JSON.stringify(authority())});
    if (!result.body.claim_id) process.exit(2);
    process.kill(process.pid, 'SIGKILL');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  assert.deepEqual(recover(ledger, held).body, { hold_id: held, closed_reason: 'unknown', charged_micro: 100 });
});

it('existing budget golden wire fixtures validate, and runtime error mappings match the catalogue', () => {
  for (const [name, status, expectedCode] of [['budget.admit-denied.json', 402, 'budget_denied'],
    ['budget.claim-already-claimed.json', 409, 'already_claimed'], ['budget.claim-after-void.json', 409, 'hold_closed'],
    ['budget.admit-idempotency-conflict.json', 409, 'idempotency_conflict']]) {
    const fixture = JSON.parse(readFileSync(new URL(`../contracts/fixtures/valid/${name}`, import.meta.url))).doc;
    assert.equal(validate(fixture.contract, fixture).ok, true);
    assert.deepEqual(resultStatus(fixture), { status, code: expectedCode });
  }
});
