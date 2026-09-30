import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { AuditWriter, CRITICAL_RECORD_KINDS, restartLoss } from '../runtime/audit/index.js';
import { JournalError, SqliteJournal } from '../runtime/journal/index.js';
import { validate } from '../contracts/validate.js';
import { authority, bytes, now, otherSid, record, session, sid } from './fixtures/journal/helpers.mjs';

const id = '33333333-3333-4333-8333-333333333333';
const digest = 'a'.repeat(64);
const criticalCases = [
  ['authz.epoch', { epoch: 2, reason: 'withdrawal' }, 'host'],
  ['budget.hold', { hold_id: id, attempt_id: `${sid}:1:spec:1`, lane: 'spec', max_micro: 100, currency: 'EUR' }, 'worker'],
  ['session.control', { action: 'purge', reason: 'fixture' }, 'host'],
  ['session.end', { reason: 'person', host_mode: 'review', export: 'offered' }, 'worker'],
  ['ui.confirm', { item_ref: 'REQ-fixture', version: 1, content_sha256: digest, principal_ref: 'fixture-person' }, 'worker'],
];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function clock() {
  let time = 0;
  let next = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout: (fn, ms) => { const id = ++next; timers.set(id, { fn, at: time + ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    get timerCount() { return timers.size; },
    advance(ms, fire = true) {
      time += ms;
      if (fire) for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); }
    },
  };
}

function host(t) {
  const journal = new SqliteJournal(':memory:', { now });
  journal.createSession(bytes(session()));
  t.after(() => journal.close());
  return journal;
}

function writer(journal, options = {}) {
  return new AuditWriter({ port: journal, authority: authority(), now, ...options });
}

it('(a) the critical kind set includes every write-ahead contract kind', () => {
  assert.deepEqual(CRITICAL_RECORD_KINDS, criticalCases.map(([kind]) => kind));
  assert.equal(Object.isFrozen(CRITICAL_RECORD_KINDS), true);
});

for (const [kind, data, writerKind] of criticalCases) {
  it(`(a) ${kind}: commits contract-valid bytes, waits for ack, then runs the effect`, async (t) => {
    const journal = host(t);
    const entered = deferred();
    const ack = deferred();
    let stored;
    let effects = 0;
    const port = {
      cursor: (a) => journal.cursor(a),
      append: (b, a) => { stored = journal.append(b, a); entered.resolve(); return ack.promise; },
    };
    const audit = writer(port, { authority: authority({ writer_kind: writerKind }) });
    await audit.start();
    const result = audit.critical(kind, data, (record) => {
      effects++;
      assert.deepEqual(record.bytes, stored.bytes);
      assert.equal(record.document.seq, 1);
      return 'effect-result';
    });
    await entered.promise;
    assert.equal(validate(stored.document.contract, stored.document).ok, true);
    assert.equal(stored.document.kind, kind);
    assert.equal(stored.document.writer.kind, writerKind);
    assert.equal(effects, 0, 'the record is committed but its ack has not arrived');
    ack.resolve(stored);
    assert.equal((await result).value, 'effect-result');
    assert.equal(effects, 1);
    assert.equal(audit.state.pending, 0);
  });

  for (const committed of [false, true]) {
    it(`(a) ${kind}: ${committed ? 'lost ack after host commit' : 'crash/refusal before host commit'} refuses the effect`, async (t) => {
      const journal = host(t);
      const failure = new Error('fixture host crash');
      let effects = 0;
      let stored;
      const port = {
        cursor: (a) => journal.cursor(a),
        append(b, a) { if (committed) stored = journal.append(b, a); throw failure; },
      };
      const audit = writer(port, { authority: authority({ writer_kind: writerKind }) });
      await assert.rejects(audit.critical(kind, data, () => effects++), (error) => error === failure);
      assert.equal(effects, 0);
      assert.equal(Boolean(stored), committed);
    });
  }

  it(`(a) ${kind}: timeout refuses the effect even when the host later acknowledges`, async (t) => {
    const journal = host(t);
    const fakeClock = clock();
    const entered = deferred();
    const ack = deferred();
    let stored;
    let effects = 0;
    let appends = 0;
    const audit = writer({
      cursor: (a) => journal.cursor(a),
      append(b, a) { appends++; stored = journal.append(b, a); entered.resolve(); return ack.promise; },
    }, { authority: authority({ writer_kind: writerKind }), clock: fakeClock });
    const result = audit.critical(kind, data, () => effects++);
    const rejected = assert.rejects(result, { status: 504, code: null });
    await entered.promise;
    fakeClock.advance(10_000);
    await rejected;
    ack.resolve(stored);
    await Promise.resolve();
    assert.equal(effects, 0);
    assert.equal(audit.state.blocked, true);
    await assert.rejects(audit.critical(kind, data, () => effects++), { status: 503 });
    assert.equal(appends, 1, 'no accumulation of stalled JournalPort calls');
    assert.equal(fakeClock.timerCount, 0);
  });

  it(`(a) ${kind}: closing during an unacknowledged append prevents a late effect`, async (t) => {
    const journal = host(t);
    const fakeClock = clock();
    const entered = deferred();
    const ack = deferred();
    let stored;
    let effects = 0;
    const audit = writer({
      cursor: (a) => journal.cursor(a),
      append(b, a) { stored = journal.append(b, a); entered.resolve(); return ack.promise; },
    }, { authority: authority({ writer_kind: writerKind }), clock: fakeClock });
    const result = audit.critical(kind, data, () => effects++);
    const rejected = assert.rejects(result, { status: 409 });
    await entered.promise;
    audit.close();
    await rejected;
    ack.resolve(stored);
    await Promise.resolve();
    assert.equal(effects, 0);
    assert.equal(audit.state.closed, true);
    assert.equal(fakeClock.timerCount, 0);
  });

  it(`(a) ${kind}: process crash after commit and before ack leaves no effect`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'aithema-audit-crash-'));
    const database = join(directory, 'journal.sqlite');
    const effectPath = join(directory, 'effect');
    const auditUrl = new URL('../runtime/audit/index.js', import.meta.url).href;
    const journalUrl = new URL('../runtime/journal/index.js', import.meta.url).href;
    const helpersUrl = new URL('./fixtures/journal/helpers.mjs', import.meta.url).href;
    const script = `
      import { writeFileSync } from 'node:fs';
      import { AuditWriter } from ${JSON.stringify(auditUrl)};
      import { SqliteJournal } from ${JSON.stringify(journalUrl)};
      import { authority, bytes, now, session } from ${JSON.stringify(helpersUrl)};
      const journal = new SqliteJournal(${JSON.stringify(database)}, { now });
      journal.createSession(bytes(session()));
      const audit = new AuditWriter({ now, authority: authority({ writer_kind: ${JSON.stringify(writerKind)} }),
        port: { cursor: a => journal.cursor(a), append(b, a) { journal.append(b, a); process.exit(71); } } });
      await audit.critical(${JSON.stringify(kind)}, ${JSON.stringify(data)},
        () => writeFileSync(${JSON.stringify(effectPath)}, 'effect'));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 71, child.stderr);
    assert.equal(existsSync(effectPath), false);
    // Epoch/purge records revoke normal reads; inspect immutable storage via
    // a read-only SQLite connection without weakening host authorization.
    const restored = new DatabaseSync(database, { readOnly: true });
    t.after(() => restored.close());
    const rows = restored.prepare('SELECT kind, original_bytes FROM journal_records').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, kind);
    const doc = JSON.parse(Buffer.from(rows[0].original_bytes).toString('utf8'));
    assert.deepEqual(doc.data, data);
    assert.equal(validate(doc.contract, doc).ok, true);
  });
}

for (const [label, corrupt] of [
  ['no response', () => null],
  ['missing seq', (r) => ({ ...r, document: { ...r.document, seq: undefined } })],
  ['zero seq', (r) => ({ ...r, document: { ...r.document, seq: 0 } })],
  ['unsafe seq', (r) => ({ ...r, document: { ...r.document, seq: Number.MAX_SAFE_INTEGER + 1 } })],
  ['different session', (r) => ({ ...r, document: { ...r.document, sid: otherSid } })],
  ['changed projection', (r) => ({ ...r, document: { ...r.document, data: { ...r.document.data, version: 2 } } })],
  ['reserialized bytes', (r) => ({ ...r, bytes: Buffer.concat([r.bytes, Buffer.from('\n')]) })],
  ['another valid record', () => {
    const doc = record('ui.confirm', criticalCases[4][1]);
    return { bytes: bytes(doc), document: { ...doc, seq: 1 } };
  }],
]) {
  it(`(a) malformed acknowledgement (${label}) never runs an effect`, async (t) => {
    const journal = host(t);
    let effects = 0;
    const audit = writer({ cursor: (a) => journal.cursor(a), append: (b, a) => corrupt(journal.append(b, a)) });
    await assert.rejects(audit.critical('ui.confirm', criticalCases[4][1], () => effects++), { status: 502 });
    assert.equal(effects, 0);
    assert.equal(journal.cursor(authority()).last_seq, 1);
  });
}

it('(a) an aborted signal before enqueue performs no host call or effect', async (t) => {
  const journal = host(t);
  const signal = AbortSignal.abort();
  let calls = 0;
  let effects = 0;
  const audit = writer({ cursor() { calls++; }, append() { calls++; } });
  await assert.rejects(audit.critical('ui.confirm', criticalCases[4][1], () => effects++, { signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
  assert.equal(effects, 0);
  assert.equal(journal.cursor(authority()).last_seq, 0);
});

it('(a) cancellation during acknowledgement and just before continuation prevents effects', async (t) => {
  for (const during of [true, false]) {
    const journal = host(t);
    const controller = new AbortController();
    const entered = deferred();
    const ack = deferred();
    let stored;
    let effects = 0;
    const audit = writer({ cursor: (a) => journal.cursor(a), append(b, a) {
      stored = journal.append(b, a);
      entered.resolve();
      if (!during) { controller.abort(); return stored; }
      return ack.promise;
    } });
    const result = audit.critical('ui.confirm', criticalCases[4][1], () => effects++, { signal: controller.signal });
    const rejected = assert.rejects(result, { name: 'AbortError' });
    await entered.promise;
    if (during) controller.abort();
    await rejected;
    ack.resolve(stored);
    await Promise.resolve();
    assert.equal(effects, 0);
  }
});

it('(a) a blocked event loop cannot turn an expired deadline into an ack', async (t) => {
  const journal = host(t);
  const fakeClock = clock();
  let effects = 0;
  let appends = 0;
  const audit = writer({ cursor: (a) => journal.cursor(a), append(b, a) {
    appends++;
    const stored = journal.append(b, a);
    fakeClock.advance(10_001, false);
    return stored;
  } }, { clock: fakeClock });
  await assert.rejects(audit.critical('ui.confirm', criticalCases[4][1], () => effects++), { status: 504 });
  assert.equal(effects, 0);
  assert.equal(audit.state.blocked, true);
  await assert.rejects(audit.critical('ui.confirm', criticalCases[4][1], () => effects++), { status: 503 });
  assert.equal(appends, 1, 'an expired synchronous response blocks further append calls');
  assert.equal(effects, 0);
  assert.equal(fakeClock.timerCount, 0);
});

it('(a) effect failures propagate after ack and are never automatically retried', async (t) => {
  const journal = host(t);
  const audit = writer(journal);
  const failure = new Error('fixture effect failed');
  let effects = 0;
  await assert.rejects(audit.critical('ui.confirm', criticalCases[4][1], () => { effects++; throw failure; }), (e) => e === failure);
  assert.equal(effects, 1);
  assert.equal(journal.cursor(authority()).last_seq, 1);
  assert.equal((await audit.bestEffort({ name: 'fixture.after_effect_failure' })).acked, true);
  assert.equal(effects, 1);
});

it('(a) an acknowledged effect can await another audit write without deadlocking the queue', async (t) => {
  const journal = host(t);
  const audit = writer(journal);
  const result = await audit.critical('ui.confirm', criticalCases[4][1], async (ack) => {
    assert.equal(journal.cursor(authority()).last_seq, ack.document.seq);
    const next = await audit.bestEffort({ name: 'fixture.confirmed' });
    assert.equal(next.acked, true);
    return next.record.document.seq;
  });
  assert.equal(result.value, 2);
  assert.equal(audit.state.pending, 0);
});

it('(a) critical input is copied immediately and a transport cannot mutate retained marker bytes', async (t) => {
  const journal = host(t);
  const audit = writer(journal);
  const data = { ...criticalCases[4][1] };
  const result = audit.critical('ui.confirm', data, (r) => r.document.data.version);
  data.version = 99;
  assert.equal((await result).value, 1);
  journal.takeover(authority());
  let firstBytes;
  let appends = 0;
  const restarted = writer({ cursor: (a) => journal.cursor(a), append(b, a) {
    appends++;
    if (appends === 1) {
      firstBytes = Buffer.from(b);
      b.fill(0);
      throw new Error('fixture transport mutation');
    }
    assert.deepEqual(b, firstBytes);
    return journal.append(b, a);
  } }, { authority: authority({ gen: 2 }) });
  await assert.rejects(restarted.start(), /transport mutation/);
  await restarted.start();
  assert.equal(appends, 2);
  assert.equal(journal.recordsAfter(1, restarted.authority)[0].document.kind, 'audit.restart');
});

it('(a) JournalPort refusal codes pass through unchanged and never run an effect', async (t) => {
  const journal = host(t);
  for (const [status, code] of [[409, 'fenced_generation'], [409, 'revoked'],
    [409, 'idempotency_conflict'], [422, 'contract_too_new']]) {
    let effects = 0;
    const error = new JournalError(status, 'fixture refusal', code);
    const audit = writer({ cursor: (a) => journal.cursor(a), append() { throw error; } });
    await assert.rejects(audit.critical('ui.confirm', criticalCases[4][1], () => effects++), (e) => e === error);
    assert.equal(effects, 0);
  }
});

it('(a) writer permissions and critical inputs are validated before host writes', (t) => {
  const journal = host(t);
  const worker = writer(journal);
  const hostWriter = writer(journal, { authority: authority({ writer_kind: 'host' }) });
  for (const kind of ['authz.epoch', 'session.control']) {
    const data = criticalCases.find(([k]) => k === kind)[1];
    assert.throws(() => worker.critical(kind, data, () => {}), { status: 400 });
  }
  assert.throws(() => hostWriter.critical('ui.confirm', criticalCases[4][1], () => {}), { status: 400 });
  assert.throws(() => worker.critical('turn', {}, () => {}), { status: 400 });
  assert.throws(() => worker.critical('ui.confirm', { ...criticalCases[4][1], unexpected: true }, () => {}), { status: 400 });
  assert.throws(() => worker.critical('ui.confirm', criticalCases[4][1], null), TypeError);
  assert.equal(journal.cursor(authority()).last_seq, 0);
});

it('(a) host-written session.end and suspend/resume controls also use write-ahead ordering', async (t) => {
  const journal = host(t);
  const audit = writer(journal, { authority: authority({ writer_kind: 'host' }) });
  const observed = [];
  for (const action of ['suspend', 'resume']) {
    await audit.critical('session.control', { action }, (r) => observed.push(r.document.seq));
  }
  await audit.critical('session.end', criticalCases[3][1], (r) => observed.push(r.document.seq));
  assert.deepEqual(observed, [1, 2, 3]);
});

it('(b) restart marker precedes concurrent records, exposes uncertain tail and continues host numbering', async (t) => {
  const journal = host(t);
  journal.append(bytes(record('audit.event', { audit_seq: 5, name: 'fixture.acked' })), authority());
  journal.append(bytes(record('audit.event', { audit_seq: 7, name: 'fixture.lost_ack' })), authority());
  const cursor = journal.takeover(authority());
  const audit = writer(journal, { authority: authority({ gen: cursor.worker_generation }), lastAckedAuditSeq: 5 });
  const effect = audit.critical('ui.confirm', criticalCases[4][1], (r) => r.document.seq);
  const event = audit.bestEffort({ name: 'fixture.next' });
  assert.equal((await effect).value, 4);
  assert.equal((await event).audit_seq, 8);
  const records = journal.recordsAfter(2, audit.authority).map((r) => r.document);
  assert.deepEqual(records.map((r) => r.kind), ['audit.restart', 'ui.confirm', 'audit.event']);
  assert.deepEqual(records[0].data, { generation: 2, last_acked_audit_seq: 5 });
  const loss = { previous_generation: 1, after_audit_seq: 5, possibly_lost: true, upper_bound: null, gap_detection: false };
  assert.deepEqual(restartLoss(records[0]), loss);
  assert.deepEqual(audit.state.possibly_lost_tail, loss);
  assert.equal(audit.state.last_acked_audit_seq, 8);
  assert.equal(audit.state.last_issued_audit_seq, 8);
  assert.equal(records.every((r) => validate(r.contract, r).ok), true);
});

it('(b) lost marker response prevents effects; retry uses identical marker bytes and id', async (t) => {
  const journal = host(t);
  journal.takeover(authority());
  const submissions = [];
  let fail = true;
  let effects = 0;
  const audit = writer({ cursor: (a) => journal.cursor(a), append(b, a) {
    submissions.push(Buffer.from(b));
    const stored = journal.append(b, a);
    if (fail) { fail = false; throw new Error('fixture lost marker response'); }
    return stored;
  } }, { authority: authority({ gen: 2 }) });
  await assert.rejects(audit.critical('ui.confirm', criticalCases[4][1], () => effects++), /lost marker/);
  assert.equal(effects, 0);
  assert.equal(audit.state.started, false);
  assert.deepEqual(journal.recordsAfter(0, authority({ gen: 2 })).map((r) => r.document.kind), ['audit.restart']);
  await audit.start();
  assert.deepEqual(submissions[0], submissions[1]);
  assert.equal(journal.cursor(authority({ gen: 2 })).last_seq, 1);
  assert.equal((await audit.bestEffort({ name: 'fixture.after_restart' })).audit_seq, 1);
  assert.equal(effects, 0);
});

it('(b) marker timeout stops queued events and effects; no late ack starts them', async (t) => {
  const journal = host(t);
  journal.takeover(authority());
  const fakeClock = clock();
  const entered = deferred();
  const ack = deferred();
  let stored;
  let effects = 0;
  const audit = writer({ cursor: (a) => journal.cursor(a), append(b, a) {
    stored = journal.append(b, a); entered.resolve(); return ack.promise;
  } }, { authority: authority({ gen: 2 }), clock: fakeClock });
  const first = audit.critical('ui.confirm', criticalCases[4][1], () => effects++);
  const rejected = assert.rejects(first, { status: 504 });
  const next = audit.bestEffort({ name: 'fixture.unsent' });
  await entered.promise;
  fakeClock.advance(10_000);
  await rejected;
  assert.equal((await next).acked, false);
  ack.resolve(stored);
  await Promise.resolve();
  assert.equal(effects, 0);
  assert.equal(audit.state.started, false);
  assert.equal(journal.cursor(authority({ gen: 2 })).last_seq, 1);
});

it('(b) unknown prior acknowledgement boundary is conservative and fresh sessions need no restart', async (t) => {
  const journal = host(t);
  const fresh = writer(journal);
  await fresh.start();
  await fresh.start();
  assert.equal(journal.cursor(authority()).last_seq, 0);
  assert.equal((await fresh.bestEffort({ name: 'fixture.first' })).audit_seq, 1);
  journal.takeover(authority());
  const restarted = writer(journal, { authority: authority({ gen: 2 }) });
  await restarted.start();
  assert.equal(restarted.state.possibly_lost_tail.after_audit_seq, 0);
  assert.equal(restarted.state.possibly_lost_tail.upper_bound, null);
  assert.equal((await restarted.bestEffort({ name: 'fixture.second' })).audit_seq, 2);
  journal.takeover(authority({ gen: 2 }));
  const third = writer(journal, { authority: authority({ gen: 3 }), lastAckedAuditSeq: 2 });
  await third.start();
  assert.equal(third.state.possibly_lost_tail.previous_generation, 2);
  assert.equal((await third.bestEffort({ name: 'fixture.third' })).audit_seq, 3);
});

it('(b) best-effort failures are explicit and numbering continues without claiming gaps', async (t) => {
  const journal = host(t);
  let fails = true;
  const audit = writer({ cursor: (a) => journal.cursor(a), append(b, a) {
    if (fails) { fails = false; throw new Error('fixture unavailable'); }
    return journal.append(b, a);
  } });
  const failed = await audit.bestEffort({ name: 'fixture.dropped' });
  assert.equal(failed.acked, false);
  assert.equal(failed.audit_seq, 1);
  assert.match(failed.error.message, /unavailable/);
  const next = await audit.bestEffort({ name: 'fixture.acked' });
  assert.equal(next.acked, true);
  assert.equal(next.audit_seq, 2);
  assert.equal(audit.state.last_acked_audit_seq, 2);
  assert.equal(journal.cursor(authority()).audit_seq, 2);
});

it('(b) concurrent best-effort events retain invocation order and snapshot their inputs', async (t) => {
  const journal = host(t);
  const audit = writer(journal);
  const event = { name: 'fixture.original', detail: 'synthetic detail' };
  const first = audit.bestEffort(event);
  event.name = 'fixture.mutated';
  event.detail = 'changed';
  const rest = Array.from({ length: 8 }, () => audit.bestEffort({ name: 'fixture.concurrent' }));
  const result = await Promise.all([first, ...rest]);
  assert.deepEqual(result.map((r) => r.audit_seq), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(result[0].record.document.data, { name: 'fixture.original', detail: 'synthetic detail', audit_seq: 1 });
});

it('(a,b) bounds cover queued effects and events, and a closed writer never writes', async (t) => {
  const journal = host(t);
  const entered = deferred();
  const ack = deferred();
  let stored;
  const audit = writer({ cursor: (a) => journal.cursor(a), append(b, a) {
    stored = journal.append(b, a); entered.resolve(); return ack.promise;
  } }, { maxPending: 2 });
  await audit.start();
  const first = audit.bestEffort({ name: 'fixture.first' });
  const second = audit.bestEffort({ name: 'fixture.second' });
  const dropped = await audit.bestEffort({ name: 'fixture.dropped' });
  assert.equal(dropped.acked, false);
  assert.equal(dropped.audit_seq, null);
  assert.equal(dropped.error.status, 503);
  let effects = 0;
  await assert.rejects(audit.critical('ui.confirm', criticalCases[4][1], () => effects++), { status: 503 });
  await entered.promise;
  audit.close();
  assert.equal((await first).acked, false);
  assert.equal((await second).acked, false);
  ack.resolve(stored);
  await assert.rejects(audit.start(), { status: 409 });
  assert.equal((await audit.bestEffort({ name: 'fixture.closed' })).acked, false);
  assert.equal(effects, 0);
  assert.equal(audit.state.pending, 0);
  assert.equal(journal.cursor(authority()).last_seq, 1);
});

it('(b) invalid best-effort data and spoofed audit numbers never reach the host', (t) => {
  const journal = host(t);
  const audit = writer(journal);
  for (const data of [{ name: 'Invalid Name' }, { name: 'fixture.x', message: 'arbitrary' },
    { name: 'fixture.x', audit_seq: 9 }, { name: 'fixture.x', detail: 'x'.repeat(2001) }]) {
    assert.throws(() => audit.bestEffort(data), { status: 400 });
  }
  const hostWriter = writer(journal, { authority: authority({ writer_kind: 'host' }) });
  assert.throws(() => hostWriter.bestEffort({ name: 'fixture.x' }), { status: 400 });
  assert.equal(journal.cursor(authority()).last_seq, 0);
});

it('(a,b) stale generation, revoked authority and invalid cursors refuse all effects', async (t) => {
  const journal = host(t);
  journal.takeover(authority());
  const stale = writer(journal);
  let effects = 0;
  await assert.rejects(stale.critical('ui.confirm', criticalCases[4][1], () => effects++), { code: 'fenced_generation' });
  const revoked = writer(journal, { authority: authority({ gen: 2, auth_epoch: 2 }) });
  await assert.rejects(revoked.critical('ui.confirm', criticalCases[4][1], () => effects++), { code: 'revoked' });
  for (const change of [{ audit_seq: -1 }, { audit_seq: Number.MAX_SAFE_INTEGER + 1 },
    { last_seq: undefined }, { worker_generation: 3 }, { auth_epoch: 2 }]) {
    const audit = writer({ cursor: () => ({ worker_generation: 1, auth_epoch: 1, audit_seq: 0, last_seq: 0, ...change }),
      append() { assert.fail('invalid cursor must not allow append'); } });
    await assert.rejects(audit.critical('ui.confirm', criticalCases[4][1], () => effects++), JournalError);
  }
  assert.equal(effects, 0);
});

it('(b) acknowledged boundary above host cursor and integer exhaustion fail explicitly', async (t) => {
  const journal = host(t);
  const impossible = writer(journal, { lastAckedAuditSeq: 1 });
  await assert.rejects(impossible.start(), { status: 400 });
  const exhausted = writer({ cursor: () => ({ worker_generation: 1, auth_epoch: 1, audit_seq: Number.MAX_SAFE_INTEGER, last_seq: 0 }),
    append() { assert.fail('exhausted sequence must not append'); } });
  const result = await exhausted.bestEffort({ name: 'fixture.exhausted' });
  assert.equal(result.acked, false);
  assert.equal(result.error.status, 409);
  assert.equal(result.audit_seq, null);
});

it('(b) pure restart reader accepts only valid markers and reports no known tail endpoint', () => {
  const marker = record('audit.restart', { generation: 3, last_acked_audit_seq: 12 }, { writer: { kind: 'worker', generation: 3 } });
  assert.equal(restartLoss(marker).upper_bound, null);
  assert.equal(restartLoss(marker).gap_detection, false);
  assert.equal(restartLoss(record('audit.restart', { generation: 1, last_acked_audit_seq: 0 })), null);
  for (const invalid of [null, record('audit.event', { audit_seq: 1, name: 'fixture.x' }),
    { ...marker, data: { ...marker.data, generation: 0 } }]) {
    assert.throws(() => restartLoss(invalid), { status: 400 });
  }
});

it('constructor configuration rejects invalid authority, bounds, clocks and deadlines', (t) => {
  const journal = host(t);
  for (const options of [{ authority: authority({ writer_kind: 'browser' }) }, { authority: authority({ gen: 0 }) },
    { maxPending: 0 }, { maxPending: 1.5 }, { lastAckedAuditSeq: -1 }, { ackTimeoutMs: 0 },
    { ackTimeoutMs: 10_001 }, { ackTimeoutMs: NaN }, { now: null }, { uuid: null }, { clock: {} }]) {
    assert.throws(() => writer(journal, options));
  }
  assert.throws(() => writer({}));
  const original = authority();
  const audit = writer(journal, { authority: original });
  original.gen = 99;
  audit.authority.gen = 98;
  assert.equal(audit.authority.gen, 1);
});
