import { it } from 'node:test';
import assert from 'node:assert/strict';
import { AuditWriter } from '../runtime/audit/index.js';
import { JournalError, SqliteJournal } from '../runtime/journal/index.js';
import { authority, bytes, now, otherSid, record, session, sid } from './fixtures/journal/helpers.mjs';

const cases = [
  ['authz.epoch', { epoch: 2, reason: 'withdrawal' }, { epoch: 3, reason: 'withdrawal' }, 'host'],
  ['budget.hold', { hold_id: '33333333-3333-4333-8333-333333333333',
    attempt_id: `${sid}:1:spec:1`, lane: 'spec', max_micro: 100, currency: 'EUR' },
  { hold_id: '33333333-3333-4333-8333-333333333333',
    attempt_id: `${sid}:1:spec:1`, lane: 'spec', max_micro: 200, currency: 'EUR' }, 'worker'],
  ['session.control', { action: 'purge' }, { action: 'resume' }, 'host'],
  ['session.end', { reason: 'person', host_mode: 'review', export: 'offered' },
    { reason: 'host', host_mode: 'review', export: 'offered' }, 'worker'],
  ['ui.confirm', { item_ref: 'REQ-fixture', version: 1, content_sha256: 'a'.repeat(64), principal_ref: 'fixture-person' },
    { item_ref: 'REQ-fixture', version: 2, content_sha256: 'a'.repeat(64), principal_ref: 'fixture-person' }, 'worker'],
];

function host(t) {
  const journal = new SqliteJournal(':memory:', { now });
  journal.createSession(bytes(session()));
  t.after(() => journal.close());
  return journal;
}

function writer(port, options = {}) {
  return new AuditWriter({ port, authority: authority(), now, ...options });
}

for (const [kind, data, changed, writerKind] of cases) {
  for (const failure of ['malformed ack', 'lost ack', 'crash before commit']) {
    it(`(a) ${kind}: ${failure} retains exact bytes and retries only the outstanding effect`, async (t) => {
      const journal = host(t);
      const submissions = [];
      let stored;
      let wallTime = now();
      let generatedIds = 0;
      let firstEffects = 0;
      let retryEffects = 0;
      const port = {
        cursor: (a) => journal.cursor(a),
        append(b, a) {
          submissions.push(Buffer.from(b));
          if (submissions.length === 1) {
            if (failure === 'crash before commit') throw new Error('fixture crash');
            stored = journal.append(b, a);
            if (failure === 'lost ack') throw new Error('fixture lost ack');
            return null;
          }
          assert.deepEqual(b, submissions[0], 'retry preserves UUID, timestamp and exact original bytes');
          // Model the host retransmitting its original response, including for
          // controls that revoke ordinary journal routes when committed.
          stored ??= journal.append(b, a);
          return stored;
        },
      };
      const audit = writer(port, { authority: authority({ writer_kind: writerKind }), now: () => ++wallTime,
        uuid: () => { generatedIds++; return '44444444-4444-4444-8444-444444444444'; } });
      const input = structuredClone(data);
      const first = audit.critical(kind, input, () => firstEffects++);
      Object.assign(input, changed);
      await assert.rejects(first, failure === 'malformed ack' ? { status: 502 } : /fixture/);
      assert.equal(firstEffects, 0);
      assert.equal(audit.state.unacknowledged_critical, true);
      assert.deepEqual(audit.exportUnacknowledgedCritical(), submissions[0]);
      const exported = audit.exportUnacknowledgedCritical();
      exported.fill(0);
      assert.deepEqual(audit.exportUnacknowledgedCritical(), submissions[0], 'exports cannot mutate retained bytes');

      await assert.rejects(audit.critical(kind, changed, () => retryEffects++), { status: 409 });
      assert.equal(submissions.length, 1, 'a different critical record cannot overtake the outstanding submission');
      assert.equal(retryEffects, 0);
      // Object-key order is not a new operation; the retained wire bytes win.
      const reordered = Object.fromEntries(Object.entries(data).reverse());
      const retried = await audit.critical(kind, reordered, (ack) => { retryEffects++; return ack.document.seq; });
      assert.equal(retried.value, 1);
      assert.equal(retried.record.document.seq, 1);
      assert.deepEqual(submissions[1], submissions[0]);
      assert.equal(firstEffects, 0, 'a failed invocation never runs its old callback');
      assert.equal(retryEffects, 1);
      assert.equal(generatedIds, 1, 'retry never mints a replacement event id');
      assert.equal(audit.state.unacknowledged_critical, false);
      assert.equal(audit.exportUnacknowledgedCritical(), null);
    });
  }
}

it('(a) queued critical submissions cannot bypass an outstanding uncertain acknowledgement', async (t) => {
  const journal = host(t);
  const [, data, changed] = cases[4];
  const submissions = [];
  let effects = 0;
  const audit = writer({ cursor: (a) => journal.cursor(a), append(b, a) {
    submissions.push(Buffer.from(b));
    const stored = journal.append(b, a);
    return submissions.length === 1 ? null : stored;
  } });
  const first = assert.rejects(audit.critical('ui.confirm', data, () => effects++), { status: 502 });
  const next = assert.rejects(audit.critical('ui.confirm', changed, () => effects++), { status: 409 });
  await Promise.all([first, next]);
  assert.equal(submissions.length, 1);
  assert.equal(effects, 0);
  await audit.start();
  assert.equal((await audit.bestEffort({ name: 'fixture.audit_only' })).acked, true);
  assert.deepEqual(audit.exportUnacknowledgedCritical(), submissions[0], 'start and best-effort never clear critical bytes');
  assert.equal(effects, 0);
  await audit.critical('ui.confirm', data, () => effects++);
  assert.deepEqual(submissions[2], submissions[0]);
  assert.equal(effects, 1);
  assert.equal(journal.cursor(authority()).last_seq, 2, 'retry returns the original seq without a second critical record');
});

it('(a) repeated uncertain replay failures and transport mutations never replace retained bytes', async (t) => {
  const journal = host(t);
  const submissions = [];
  let effects = 0;
  const audit = writer({ cursor: (a) => journal.cursor(a), append(b, a) {
    submissions.push(Buffer.from(b));
    const stored = journal.append(b, a);
    if (submissions.length < 3) { b.fill(0); return null; }
    return stored;
  } });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(audit.critical('ui.confirm', cases[4][1], () => effects++), { status: 502 });
    assert.deepEqual(audit.exportUnacknowledgedCritical(), submissions[0]);
    assert.equal(effects, 0);
  }
  const result = await audit.critical('ui.confirm', cases[4][1], () => effects++);
  assert.equal(result.record.document.seq, 1);
  assert.equal(effects, 1);
  assert.equal(submissions.every((b) => b.equals(submissions[0])), true);
  assert.equal(journal.cursor(authority()).last_seq, 1);
});

it('(a) concurrent retries run only one effect and await the replay acknowledgement', async (t) => {
  const journal = host(t);
  const submissions = [];
  let entered;
  let acknowledge;
  let stored;
  const replayEntered = new Promise((resolve) => { entered = resolve; });
  const replayAck = new Promise((resolve) => { acknowledge = resolve; });
  let effects = 0;
  const audit = writer({ cursor: (a) => journal.cursor(a), append(b, a) {
    submissions.push(Buffer.from(b));
    stored = journal.append(b, a);
    if (submissions.length === 1) return null;
    entered();
    return replayAck;
  } });
  await assert.rejects(audit.critical('ui.confirm', cases[4][1], () => effects++), { status: 502 });
  const first = audit.critical('ui.confirm', cases[4][1], () => effects++);
  const second = assert.rejects(audit.critical('ui.confirm', cases[4][1], () => effects++), { status: 409 });
  await replayEntered;
  assert.equal(effects, 0, 'the replay also waits for a validated acknowledgement');
  assert.deepEqual(audit.exportUnacknowledgedCritical(), submissions[0]);
  acknowledge(stored);
  assert.equal((await first).record.document.seq, 1);
  await second;
  assert.equal(effects, 1, 'the other retry never runs a second callback for this record');
  assert.equal(submissions.length, 2);
  assert.deepEqual(submissions[1], submissions[0]);
  assert.equal(journal.cursor(authority()).last_seq, 1);
});

it('(a) a definitive host refusal is retained and surfaced without automatic resubmission', async (t) => {
  const journal = host(t);
  let appends = 0;
  let effects = 0;
  const failure = new JournalError(409, 'fixture refusal', 'idempotency_conflict');
  const audit = writer({ cursor: (a) => journal.cursor(a), append() { appends++; throw failure; } });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(audit.critical('ui.confirm', cases[4][1], () => effects++), (e) => e === failure);
  }
  assert.equal(appends, 1);
  assert.equal(effects, 0);
  assert.equal(JSON.parse(audit.exportUnacknowledgedCritical()).kind, 'ui.confirm');
});

it('(a) timeout handoff retains the id and a late ack never runs the timed-out effect', async (t) => {
  const journal = host(t);
  let time = 0;
  let expire;
  let lateAck;
  let entered;
  const appended = new Promise((resolve) => { entered = resolve; });
  const response = new Promise((resolve) => { lateAck = resolve; });
  let stored;
  let oldEffects = 0;
  let newEffects = 0;
  const audit = writer({ cursor: (a) => journal.cursor(a), append(b, a) {
    stored = journal.append(b, a); entered(); return response;
  } }, { clock: { now: () => time, setTimeout: (fn) => { expire = fn; return 1; }, clearTimeout() {} } });
  const rejected = assert.rejects(audit.critical('ui.confirm', cases[4][1], () => oldEffects++), { status: 504 });
  await appended;
  time = 10_000;
  expire();
  await rejected;
  const original = audit.exportUnacknowledgedCritical();
  assert.deepEqual(original, stored.bytes);
  const recovered = writer(journal, { unacknowledgedCritical: original });
  original.fill(0);
  const result = await recovered.critical('ui.confirm', cases[4][1], () => newEffects++);
  assert.equal(result.record.document.seq, 1);
  lateAck(stored);
  await Promise.resolve();
  assert.equal(oldEffects, 0);
  assert.equal(newEffects, 1);
  assert.equal(audit.state.blocked, true);
  assert.deepEqual(audit.exportUnacknowledgedCritical(), stored.bytes);
  assert.equal(journal.cursor(authority()).last_seq, 1);
});

it('(a) epoch replay requires fresh verified authority and never mints a second epoch record', async (t) => {
  const journal = host(t);
  let first = true;
  let effects = 0;
  const submissions = [];
  const port = { cursor: (a) => journal.cursor(a), append(b, a) {
    submissions.push(Buffer.from(b));
    const stored = journal.append(b, a);
    if (first) { first = false; return null; }
    return stored;
  } };
  const audit = writer(port, { authority: authority({ writer_kind: 'host' }) });
  await assert.rejects(audit.critical('authz.epoch', cases[0][1], () => effects++), { status: 502 });
  await assert.rejects(audit.critical('authz.epoch', cases[0][1], () => effects++), { code: 'revoked' });
  assert.deepEqual(submissions[1], submissions[0]);
  assert.equal(effects, 0);
  const recovered = writer(port, { authority: authority({ writer_kind: 'host', auth_epoch: 2 }),
    unacknowledgedCritical: audit.exportUnacknowledgedCritical() });
  const result = await recovered.critical('authz.epoch', cases[0][1], () => effects++);
  assert.equal(result.record.document.seq, 1);
  assert.deepEqual(submissions[2], submissions[0]);
  assert.equal(effects, 1);
  assert.equal(journal.cursor(recovered.authority).last_seq, 1);
});

it('(a) purged sessions retain original critical bytes and stay closed when replay is revoked', async (t) => {
  const journal = host(t);
  const submissions = [];
  let effects = 0;
  const port = { cursor: (a) => journal.cursor(a), append(b, a) {
    submissions.push(Buffer.from(b));
    journal.append(b, a);
    return null;
  } };
  const audit = writer(port, { authority: authority({ writer_kind: 'host' }) });
  await assert.rejects(audit.critical('session.control', cases[2][1], () => effects++), { status: 502 });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(audit.critical('session.control', cases[2][1], () => effects++), { code: 'revoked' });
  }
  assert.equal(submissions.length, 2, 'the terminal replay refusal is not retried');
  assert.deepEqual(submissions[1], submissions[0]);
  assert.deepEqual(audit.exportUnacknowledgedCritical(), submissions[0]);
  const recovered = writer(port, { authority: authority({ writer_kind: 'host' }),
    unacknowledgedCritical: audit.exportUnacknowledgedCritical() });
  await assert.rejects(recovered.critical('session.control', cases[2][1], () => effects++), { code: 'revoked' });
  assert.equal(submissions.length, 2, 'no new append may bypass the tombstone');
  assert.deepEqual(recovered.exportUnacknowledgedCritical(), submissions[0]);
  assert.equal(effects, 0);
});

for (const committed of [false, true]) {
  for (const [kind, data, changed, writerKind] of cases) {
    if (writerKind !== 'worker') continue;
    it(`(a,b) ${kind}: takeover preserves ${committed ? 'committed' : 'uncommitted'} original bytes without rewriting the generation`, async (t) => {
      const journal = host(t);
      let original;
      let stored;
      let oldEffects = 0;
      let recoveredEffects = 0;
      const audit = writer({ cursor: (a) => journal.cursor(a), append(b, a) {
        original = Buffer.from(b);
        if (committed) stored = journal.append(b, a);
        throw new Error('fixture uncertain append');
      } });
      await assert.rejects(audit.critical(kind, data, () => oldEffects++), /uncertain/);
      journal.takeover(authority());
      const submissions = [];
      const recovered = writer({ cursor: (a) => journal.cursor(a), append(b, a) {
        submissions.push(Buffer.from(b));
        assert.equal(a.gen, 2, 'recovery uses the new verified token without rewriting the record');
        return journal.append(b, a);
      } }, { authority: authority({ gen: 2 }), unacknowledgedCritical: audit.exportUnacknowledgedCritical() });
      await assert.rejects(recovered.critical(kind, changed, () => recoveredEffects++), { status: 409 });
      assert.equal(submissions.length, 1, 'only the restart marker may precede a mismatched critical retry');
      const recovery = recovered.critical(kind, data, () => recoveredEffects++);
      if (committed) {
        const result = await recovery;
        assert.deepEqual(result.record, stored, 'the original host acknowledgement is recovered');
        assert.equal(recoveredEffects, 1, 'only the explicitly supplied recovery effect runs');
        assert.equal(recovered.exportUnacknowledgedCritical(), null);
      } else {
        await assert.rejects(recovery, { code: 'fenced_generation' });
        assert.deepEqual(recovered.exportUnacknowledgedCritical(), original);
        await assert.rejects(recovered.critical(kind, data, () => recoveredEffects++), { code: 'fenced_generation' });
        assert.equal(recoveredEffects, 0);
      }
      assert.equal(JSON.parse(submissions[0]).kind, 'audit.restart', 'restart marker is still first');
      assert.deepEqual(submissions[1], original, 'the coordinator retains original generation, id and bytes');
      assert.deepEqual(audit.exportUnacknowledgedCritical(), original, 'the old writer retains its handoff bytes');
      assert.equal(journal.cursor(recovered.authority).last_seq, committed ? 2 : 1);
      assert.equal(oldEffects, 0, 'the failed invocation is never re-run');
      assert.equal(submissions.length, 2);
    });
  }
}

it('(a,b) timeout recovery after takeover awaits exact replay and concurrent retries cannot re-run the effect', async (t) => {
  const journal = host(t);
  let time = 0;
  let expire;
  let acknowledgeOld;
  let enteredOld;
  const oldAppend = new Promise((resolve) => { enteredOld = resolve; });
  const oldAck = new Promise((resolve) => { acknowledgeOld = resolve; });
  let stored;
  let oldEffects = 0;
  let recoveredEffects = 0;
  const audit = writer({ cursor: (a) => journal.cursor(a), append(b, a) {
    stored = journal.append(b, a);
    enteredOld();
    return oldAck;
  } }, { clock: { now: () => time, setTimeout: (fn) => { expire = fn; return 1; }, clearTimeout() {} } });
  const rejected = assert.rejects(audit.critical('ui.confirm', cases[4][1], () => oldEffects++), { status: 504 });
  await oldAppend;
  time = 10_000;
  expire();
  await rejected;
  const retained = audit.exportUnacknowledgedCritical();
  journal.takeover(authority());

  let enteredReplay;
  let acknowledgeReplay;
  const replayAppend = new Promise((resolve) => { enteredReplay = resolve; });
  const replayAck = new Promise((resolve) => { acknowledgeReplay = resolve; });
  const submissions = [];
  const recovered = writer({ cursor: (a) => journal.cursor(a), append(b, a) {
    assert.equal(a.gen, 2);
    submissions.push(Buffer.from(b));
    const response = journal.append(b, a);
    if (response.document.kind === 'audit.restart') return response;
    assert.deepEqual(response, stored);
    enteredReplay();
    return replayAck;
  } }, { authority: authority({ gen: 2 }), unacknowledgedCritical: retained });
  const first = recovered.critical('ui.confirm', cases[4][1], () => recoveredEffects++);
  const second = assert.rejects(recovered.critical('ui.confirm', cases[4][1], () => recoveredEffects++), { status: 409 });
  await replayAppend;
  acknowledgeOld(stored);
  await Promise.resolve();
  assert.equal(oldEffects, 0, 'a late old acknowledgement never revives the timed-out callback');
  assert.equal(recoveredEffects, 0, 'the recovery effect still waits for its own acknowledgement');
  assert.deepEqual(recovered.exportUnacknowledgedCritical(), retained);
  acknowledgeReplay(stored);
  assert.deepEqual((await first).record, stored);
  await second;
  assert.equal(oldEffects, 0);
  assert.equal(recoveredEffects, 1);
  assert.equal(recovered.exportUnacknowledgedCritical(), null);
  assert.equal(audit.state.blocked, true);
  assert.deepEqual(submissions[1], retained);
  assert.equal(submissions.length, 2, 'one restart marker and one replay; no duplicate critical append');
  assert.equal(journal.cursor(recovered.authority).last_seq, 2);
  assert.deepEqual(journal.recordsAfter(0, recovered.authority).map((r) => r.document.kind), ['ui.confirm', 'audit.restart']);
});

it('(a) recovery imports accept only original contract-valid critical submissions of the same session and writer', (t) => {
  const journal = host(t);
  const good = record('ui.confirm', cases[4][1]);
  for (const invalid of [Buffer.from('invalid'), bytes({ ...good, sid: otherSid }),
    bytes({ ...good, seq: 1 }), bytes({ ...good, data: { ...good.data, version: 0 } }),
    bytes(record('audit.event', { audit_seq: 1, name: 'fixture.event' })),
    bytes(record('authz.epoch', cases[0][1], { writer: { kind: 'host' } })),
    bytes({ ...good, writer: { kind: 'worker', generation: 2 } }), {}]) {
    assert.throws(() => writer(journal, { unacknowledgedCritical: invalid }), JournalError);
  }
  assert.equal(journal.cursor(authority()).last_seq, 0);
});
