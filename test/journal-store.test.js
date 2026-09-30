import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteJournal } from '../runtime/journal/index.js';
import { loadContractFile, validate, sha256Hex } from '../contracts/validate.js';
import { authority, bytes, code, now, otherSid, pendingOp, record, session, sid, snapshot, source, turn } from './fixtures/journal/helpers.mjs';

function host(t, sessionOverrides = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'aithema-journal-store-')), 'journal.sqlite');
  const journal = new SqliteJournal(path, { now });
  journal.createSession(bytes(session(sessionOverrides)));
  t.after(() => journal.close());
  return { journal, path };
}

it('(a) snapshot append IS the CAS commit; retries precede CAS and no checkpoint exists', (t) => {
  const { journal } = host(t);
  const first = bytes(snapshot());
  const committed = journal.append(first, authority());
  assert.equal(committed.document.seq, 1);
  assert.equal(validate(committed.document.contract, committed.document).ok, true);
  const cursor = journal.cursor(authority());
  assert.equal(cursor.working_rev, 1);
  assert.deepEqual(cursor.snapshot.bytes, first);
  assert.equal(journal.append(first, authority()).document.seq, 1);
  assert.throws(() => journal.append(bytes(snapshot()), authority()), { status: 409, code: null });
  assert.equal(journal.cursor(authority()).last_seq, 1);
  const next = journal.append(bytes(snapshot({ expected_prev_rev: 1, working_rev: 2 })), authority());
  assert.equal(next.document.seq, 2);
  assert.equal(journal.cursor(authority()).working_rev, 2);
});

it('(a) two host connections arbitrate competing snapshots atomically', (t) => {
  const { journal, path } = host(t);
  const second = new SqliteJournal(path, { now });
  t.after(() => second.close());
  journal.append(bytes(snapshot()), authority());
  assert.throws(() => second.append(bytes(snapshot()), authority()), { status: 409 });
  assert.equal(second.cursor(authority()).last_seq, 1);
  assert.equal(second.cursor(authority()).working_rev, 1);
});

it('(a) an insertion failure rolls back the append, seq allocation and revision', (t) => {
  const { journal, path } = host(t);
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  db.exec(`CREATE TRIGGER fixture_crash BEFORE UPDATE OF working_rev ON journal_sessions
    BEGIN SELECT RAISE(ABORT, 'fixture crash during commit'); END;`);
  assert.throws(() => journal.append(bytes(snapshot()), authority()), /fixture crash/);
  assert.equal(journal.cursor(authority()).last_seq, 0);
  assert.equal(journal.cursor(authority()).working_rev, 0);
  assert.deepEqual(journal.recordsAfter(0, authority()), []);
  db.exec('DROP TRIGGER fixture_crash');
  assert.equal(journal.append(bytes(snapshot()), authority()).document.seq, 1);
});

it('(a) snapshots cannot consume future seqs, move consumed_seq backwards or change host mode', (t) => {
  const { journal } = host(t);
  assert.throws(() => journal.append(bytes(snapshot({ consumed_seq: 1 })), authority()), { status: 400 });
  journal.append(bytes(turn()), authority());
  journal.append(bytes(snapshot({ consumed_seq: 1 })), authority());
  assert.throws(() => journal.append(bytes(snapshot({ working_rev: 2, expected_prev_rev: 1, consumed_seq: 0 })), authority()), { status: 400 });
  assert.throws(() => journal.append(bytes(snapshot({ working_rev: 2, expected_prev_rev: 1, consumed_seq: 1,
    host_mode: 'working_spec_only' })), authority()), { status: 400 });
});

it('(a) op.result persists host ids and binds the op key to its own session', (t) => {
  const { journal } = host(t);
  const doc = record('op.result', { op_key: `${sid}:submit:1`, host_ids: { proposal_ref: 'fixture-P1' } });
  const stored = journal.append(bytes(doc), authority());
  assert.equal(stored.document.seq, 1);
  assert.equal(validate(stored.document.contract, stored.document).ok, true);
  assert.deepEqual(journal.recordsByIds([1], authority())[0].document.data.host_ids, { proposal_ref: 'fixture-P1' });
  assert.throws(() => journal.append(bytes(record('op.result', { op_key: `${otherSid}:submit:1`, host_ids: {} })), authority()), { status: 400 });
});

it('(a) foreign-session pending_ops are rejected without committing a snapshot or allocating seq', (t) => {
  const { journal } = host(t);
  const foreign = pendingOp({ op_key: `${otherSid}:source:1` });
  const valid = pendingOp();
  let rejected;
  for (const pending_ops of [[foreign], [valid, foreign]]) {
    const submitted = snapshot({ pending_ops });
    rejected = submitted;
    assert.equal(validate(submitted.contract, submitted).ok, true, 'the key is structurally valid');
    assert.throws(() => journal.append(bytes(submitted), authority()), { status: 400, code: null });
    const cursor = journal.cursor(authority());
    assert.equal(cursor.last_seq, 0);
    assert.equal(cursor.working_rev, 0);
    assert.equal(cursor.snapshot, null);
    assert.deepEqual(journal.recordsAfter(0, authority()), []);
  }
  // Even a rejected id remains usable with the corrected session key.
  const corrected = bytes({ ...rejected, pending_ops: [valid] });
  assert.equal(journal.append(corrected, authority()).document.seq, 1);
  assert.equal(journal.append(corrected, authority()).document.seq, 1);
});

for (const host_mode of ['review', 'working_spec_only']) {
  for (const writerKind of ['worker', 'host']) {
    it(`(a) session.end from ${writerKind} must match ${host_mode} session mode`, (t) => {
      const { journal } = host(t, { host_mode });
      const writer = writerKind === 'worker' ? { kind: writerKind, generation: 1 } : { kind: writerKind };
      const mismatched = record('session.end', { reason: 'host',
        host_mode: host_mode === 'review' ? 'working_spec_only' : 'review', export: 'exported' }, { writer });
      const grant = authority({ writer_kind: writerKind });
      assert.equal(validate(mismatched.contract, mismatched).ok, true);
      assert.throws(() => journal.append(bytes(mismatched), grant), { status: 400, code: null });
      assert.equal(journal.cursor(authority()).last_seq, 0);
      const matching = bytes({ ...mismatched, data: { ...mismatched.data, host_mode } });
      assert.equal(journal.append(matching, grant).document.seq, 1);
      assert.equal(journal.append(matching, grant).document.seq, 1);
      assert.deepEqual(journal.recordsByIds([1], authority())[0].bytes, matching);
    });
  }
}

it('(a) takeover fences stale tokens on writes AND exact retries, but journal reads need no current gen', (t) => {
  const { journal } = host(t);
  const original = bytes(turn());
  journal.append(original, authority());
  assert.equal(journal.takeover(authority()).worker_generation, 2);
  assert.throws(() => journal.append(original, authority()), code('fenced_generation'));
  assert.throws(() => journal.append(bytes(snapshot()), authority({ gen: 2 })), code('fenced_generation'));
  assert.throws(() => journal.takeover(authority()), code('fenced_generation'));
  assert.equal(journal.recordsByIds([1], authority())[0].document.seq, 1);
  assert.equal(journal.cursor(authority()).worker_generation, 2);
  const current = snapshot({ worker_generation: 2 });
  assert.equal(journal.append(bytes(current), authority({ gen: 2 })).document.seq, 2);
});

it('(a) cross-generation event replay leaves snapshot generation fencing and CAS unchanged', (t) => {
  const { journal } = host(t);
  const original = bytes(snapshot());
  journal.append(original, authority());
  journal.takeover(authority());
  const current = authority({ gen: 2 });
  assert.throws(() => journal.append(original, current), code('fenced_generation'));
  assert.throws(() => journal.append(bytes(snapshot({ worker_generation: 2 })), current), { status: 409, code: null });
  assert.equal(journal.cursor(current).last_seq, 1);
  assert.equal(journal.cursor(current).working_rev, 1);
  const next = bytes(snapshot({ worker_generation: 2, working_rev: 2, expected_prev_rev: 1 }));
  const committed = journal.append(next, current);
  assert.equal(committed.document.seq, 2);
  assert.deepEqual(journal.append(next, current), committed, 'same-generation snapshot replay still precedes CAS');
  assert.equal(journal.cursor(current).working_rev, 2);
});

it('(a,c) current-token replay recovers the durable old-generation record after reopening SQLite', (t) => {
  const { journal, path } = host(t);
  const original = bytes(turn());
  const committed = journal.append(original, authority());
  journal.takeover(authority());
  const reopened = new SqliteJournal(path, { now });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.append(original, authority({ gen: 2 })), committed);
  assert.equal(reopened.cursor(authority({ gen: 2 })).last_seq, 1);
  assert.deepEqual(journal.recordsByIds([1], authority())[0], committed);
});

for (const [kind, make, writerKind] of [
  ['turn', turn, 'worker'],
  ['host session.control', (overrides) => record('session.control', { action: 'suspend' }, overrides), 'host'],
]) {
  it(`(a) stale writer.generation on ${kind} is fenced even with current authority.gen`, (t) => {
    const { journal } = host(t);
    journal.takeover(authority());
    const grant = authority({ gen: 2, writer_kind: writerKind });
    const stale = make({ writer: { kind: writerKind, generation: 1 } });
    assert.throws(() => journal.append(bytes(stale), grant), code('fenced_generation'));
    assert.equal(journal.cursor(authority()).last_seq, 0);
    const current = bytes({ ...stale, writer: { kind: writerKind, generation: 2 } });
    assert.equal(journal.append(current, grant).document.seq, 1);
    assert.deepEqual(journal.recordsByIds([1], authority())[0].bytes, current);
  });
}

const fixtureRoot = new URL('../contracts/fixtures/valid/', import.meta.url);
const fixtures = readdirSync(fixtureRoot).filter((name) => name.startsWith('record.')).map((name) =>
  JSON.parse(readFileSync(new URL(name, fixtureRoot), 'utf8')).doc);
const byKind = new Map(fixtures.map((doc) => [doc.kind, doc]));
// Supplement fixtures for kinds without a golden example.
byKind.set('authz.epoch', record('authz.epoch', { epoch: 2, reason: 'change' }, { writer: { kind: 'host' } }));
byKind.set('session.control', record('session.control', { action: 'purge' }, { writer: { kind: 'host' } }));
byKind.set('audit.event', record('audit.event', { audit_seq: 1, name: 'fixture.event' }));
byKind.set('source', source());

for (const [kind, fixture] of byKind) {
  it(`(a) stale generation is rejected on ${kind}, regardless of writer kind`, (t) => {
    const { journal } = host(t);
    journal.takeover(authority());
    const doc = structuredClone(fixture);
    delete doc.seq;
    doc.sid = sid;
    if (doc.writer.kind === 'worker') doc.writer.generation = 1;
    assert.throws(() => journal.append(bytes(doc), authority({ writer_kind: doc.writer.kind })), code('fenced_generation'));
    assert.equal(journal.cursor(authority()).last_seq, 0);
  });
}

for (const [kind, allowed] of Object.entries(loadContractFile('record-writers.json').writers)) {
  it(`writer kinds for ${kind} match record-writers.json exactly`, (t) => {
    const { journal } = host(t);
    const fixture = byKind.get(kind);
    assert.ok(fixture, `missing test fixture for ${kind}`);
    for (const forbidden of ['browser', 'worker', 'host'].filter((writer) => !allowed.includes(writer))) {
      const doc = structuredClone(fixture);
      delete doc.seq;
      doc.sid = sid;
      doc.writer = forbidden === 'worker' ? { kind: forbidden, generation: 1 } : { kind: forbidden };
      assert.throws(() => journal.append(bytes(doc), authority({ writer_kind: forbidden })),
        (error) => error.status === 400 && error.message.includes('record.writer_allowed'));
    }
    assert.equal(journal.cursor(authority()).last_seq, 0);
  });
}

it('(a) epoch write is atomic write-ahead; changed epoch revokes ALL reads and writes', (t) => {
  const { journal } = host(t);
  const old = authority();
  const hostAuthority = authority({ writer_kind: 'host' });
  journal.append(bytes(record('authz.epoch', { epoch: 2, reason: 'withdrawal' }, { writer: { kind: 'host' } })), hostAuthority);
  for (const call of [() => journal.append(bytes(turn()), old), () => journal.cursor(old),
    () => journal.recordsAfter(0, old), () => journal.recordsByIds([], old), () => journal.takeover(old)]) {
    assert.throws(call, code('revoked'));
  }
  const current = authority({ auth_epoch: 2 });
  assert.equal(journal.cursor(current).auth_epoch, 2);
  assert.equal(journal.recordsByIds([1], current)[0].document.kind, 'authz.epoch');
  assert.throws(() => journal.append(bytes(record('authz.epoch', { epoch: 2, reason: 'change' }, { writer: { kind: 'host' } })),
    authority({ ...current, writer_kind: 'host' })), { status: 409 });
});

it('(a) purge tombstone survives reopening and can never be resumed', (t) => {
  const { journal, path } = host(t);
  journal.append(bytes(record('session.control', { action: 'purge' }, { writer: { kind: 'host' } })), authority({ writer_kind: 'host' }));
  const reopened = new SqliteJournal(path, { now });
  t.after(() => reopened.close());
  assert.throws(() => reopened.takeover(authority()), code('revoked'));
  assert.throws(() => reopened.cursor(authority()), code('revoked'));
  assert.throws(() => reopened.append(bytes(record('session.control', { action: 'resume' }, { writer: { kind: 'host' } })),
    authority({ writer_kind: 'host' })), code('revoked'));
});

it('(a) suspend keeps reads open and refuses worker writes until host resume, without revoking authority', (t) => {
  const { journal } = host(t);
  const hostAuthority = authority({ writer_kind: 'host' });
  const suspended = journal.append(bytes(record('session.control', { action: 'suspend' }, { writer: { kind: 'host' } })), hostAuthority);
  for (const call of [() => journal.takeover(authority()), () => journal.append(bytes(turn()), authority()),
    () => journal.append(bytes(snapshot()), authority())]) {
    assert.throws(call, { status: 409, code: null });
  }
  for (const reader of ['worker', 'browser', 'host']) {
    const grant = authority({ writer_kind: reader, gen: 0, capabilities: ['aithema.journal.read'] });
    const cursor = journal.cursor(grant);
    assert.equal(cursor.worker_generation, 1, 'refused takeover does not burn a generation');
    assert.equal(cursor.last_seq, 1, 'refused writes do not allocate seq');
    assert.deepEqual(journal.recordsByIds([1], grant)[0].bytes, suspended.bytes);
    assert.deepEqual(journal.recordsAfter(0, grant)[0].document.data, { action: 'suspend' });
  }
  assert.throws(() => journal.append(bytes(turn()), authority({ gen: 0 })), code('fenced_generation'));
  journal.append(bytes(record('session.control', { action: 'resume' }, { writer: { kind: 'host' } })), hostAuthority);
  assert.equal(journal.append(bytes(turn()), authority()).document.seq, 3);
});

for (const revoke of ['epoch', 'purge']) {
  it(`(a) ${revoke} still revokes every journal route for host and worker while suspended`, (t) => {
    const { journal } = host(t);
    const hostAuthority = authority({ writer_kind: 'host' });
    journal.append(bytes(record('session.control', { action: 'suspend' }, { writer: { kind: 'host' } })), hostAuthority);
    const doc = revoke === 'epoch'
      ? record('authz.epoch', { epoch: 2, reason: 'withdrawal' }, { writer: { kind: 'host' } })
      : record('session.control', { action: 'purge' }, { writer: { kind: 'host' } });
    journal.append(bytes(doc), hostAuthority);
    for (const writer_kind of ['worker', 'host']) {
      const grant = authority({ writer_kind });
      for (const call of [() => journal.cursor(grant), () => journal.recordsByIds([1], grant),
        () => journal.recordsAfter(0, grant), () => journal.takeover(grant), () => journal.append(bytes(turn()), grant)]) {
        assert.throws(call, code('revoked'));
      }
    }
  });
}

it('(b,c) original bytes are verbatim; SQL updates/deletes and caller mutation cannot alter records', (t) => {
  const { journal, path } = host(t);
  const original = bytes(source());
  const saved = Buffer.from(original);
  const response = journal.append(original, authority());
  original.fill(0);
  response.bytes.fill(0);
  response.document.data.text = 'mutated';
  assert.deepEqual(journal.recordsByIds([1], authority())[0].bytes, saved);
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  assert.throws(() => db.prepare('UPDATE journal_records SET original_bytes = ? WHERE sid = ?').run(Buffer.from('{}'), sid), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM journal_records WHERE sid = ?').run(sid), /immutable/);
  assert.deepEqual(Buffer.from(db.prepare('SELECT original_bytes FROM journal_records').get().original_bytes), saved);
  assert.deepEqual(journal.append(saved, authority()).bytes, saved);
});

it('(c) same event id + changed whitespace, content, or contract conflicts; new event ids receive new seqs', (t) => {
  const { journal } = host(t);
  const doc = turn();
  const original = bytes(doc);
  assert.equal(journal.append(original, authority()).document.seq, 1);
  assert.equal(journal.append(original, authority()).document.seq, 1);
  for (const changed of [Buffer.from(JSON.stringify(doc)), bytes({ ...doc, data: { ...doc.data, body: 'Different bytes' } }),
    bytes(snapshot({ client_event_id: doc.client_event_id }))]) {
    assert.throws(() => journal.append(changed, authority()), code('idempotency_conflict'));
  }
  assert.equal(journal.append(bytes(turn()), authority()).document.seq, 2);
  assert.deepEqual(journal.recordsAfter(0, authority()).map((r) => r.document.seq), [1, 2]);
});

it('(c) idempotency and records-by-ids are isolated by session', (t) => {
  const { journal } = host(t);
  journal.createSession(bytes(session({ sid: otherSid })));
  const doc = turn();
  journal.append(bytes(doc), authority());
  assert.equal(journal.append(bytes({ ...doc, sid: otherSid }), authority({ sid: otherSid })).document.seq, 1);
  journal.append(bytes(turn()), authority());
  assert.throws(() => journal.recordsByIds([2], authority({ sid: otherSid })), { status: 404 });
  assert.deepEqual(journal.recordsByIds([1, 1], authority()).map((r) => r.document.seq), [1]);
  assert.throws(() => journal.recordsByIds([0], authority()), { status: 400 });
  assert.throws(() => journal.recordsAfter(-1, authority()), { status: 400 });
});

it('(c) callers cannot submit seq, including seq 0; host counters fail closed before unsafe integers', (t) => {
  const { journal, path } = host(t);
  assert.throws(() => journal.append(bytes(turn({ seq: 0 })), authority()), { status: 400 });
  assert.throws(() => journal.append(bytes(snapshot({ seq: 1 })), authority()), { status: 400 });
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  db.prepare('UPDATE journal_sessions SET last_seq = ? WHERE sid = ?').run(Number.MAX_SAFE_INTEGER, sid);
  assert.throws(() => journal.append(bytes(turn()), authority()), /seq exhausted/);
  db.prepare('UPDATE journal_sessions SET worker_generation = ? WHERE sid = ?').run(Number.MAX_SAFE_INTEGER, sid);
  assert.throws(() => journal.takeover(authority({ gen: Number.MAX_SAFE_INTEGER })), /worker_generation exhausted/);
});

it('enforces verified scope, capabilities, expiry and authenticated writer independently of record JSON', (t) => {
  const { journal } = host(t);
  for (const patch of [{ tid: 'foreign' }, { pid: 'foreign' }, { capabilities: [] }, { writer_kind: 'host' }]) {
    assert.throws(() => journal.append(bytes(turn()), authority(patch)), { status: 403 });
  }
  assert.throws(() => journal.append(bytes(turn({ sid: otherSid })), authority()), { status: 403 });
  assert.throws(() => journal.append(bytes(turn()), authority({ exp: Math.floor(now() / 1000) })), { status: 401 });
  assert.throws(() => journal.cursor(authority({ capabilities: ['aithema.journal.write'] })), { status: 403 });
  assert.throws(() => journal.takeover(authority({ capabilities: ['aithema.journal.write'] })), { status: 403 });
  assert.throws(() => journal.append(bytes(record('session.control', { action: 'purge' })), authority()), { status: 400 });
  assert.throws(() => journal.append(bytes(source({ writer: { kind: 'browser' } })), authority({ writer_kind: 'browser' })), { status: 400 });
  assert.throws(() => journal.append(bytes(turn({ writer: { kind: 'browser' }, data: {
    speaker: 'assistant', participant_ref: 'fixture-ai', channel: 'text', trust: 'assistant', lang: 'en', body: 'AI' } })),
    authority({ writer_kind: 'browser' })), { status: 400 });
  assert.equal(journal.cursor(authority()).last_seq, 0);
});

it('strict contracts reject tampering, future readers, unknown fields, invalid UTF-8 and noncanonical patches', (t) => {
  const { journal } = host(t);
  assert.throws(() => journal.append(bytes(turn({ major: 2 })), authority()), code('contract_too_new', 422));
  assert.throws(() => journal.append(bytes(turn({ minor: 1, min_reader: 1 })), authority()), code('contract_too_new', 422));
  assert.throws(() => journal.append(bytes(turn({ unknown: true })), authority()), { status: 400 });
  assert.throws(() => journal.append(Buffer.from([0xff]), authority()), { status: 400 });
  assert.throws(() => journal.append(Buffer.from('{'), authority()), { status: 400 });
  const badSource = source();
  badSource.data.segments[0].end = 1000;
  assert.throws(() => journal.append(bytes(badSource), authority()), { status: 400 });
  const canonical = '{ "x": 1 }';
  assert.throws(() => journal.append(bytes(snapshot({ patch: { canonical, sha256: sha256Hex(canonical) } })), authority()), { status: 400 });
  assert.throws(() => journal.append(Buffer.concat([bytes(turn()), Buffer.alloc(1024 * 1024, 32)]), authority()), { status: 413 });
  assert.equal(journal.cursor(authority()).last_seq, 0);
});

it('(d) audit restart exposes volatile tail; audit numbering is durable and monotonic', (t) => {
  const { journal } = host(t);
  journal.append(bytes(record('audit.event', { audit_seq: 7, name: 'fixture.acked' })), authority());
  journal.takeover(authority());
  const current = authority({ gen: 2 });
  const writer = { kind: 'worker', generation: 2 };
  journal.append(bytes(record('audit.restart', { generation: 2, last_acked_audit_seq: 5 }, { writer })), current);
  assert.throws(() => journal.append(bytes(record('audit.event', { audit_seq: 7, name: 'fixture.duplicate' }, { writer })), current), { status: 409 });
  assert.throws(() => journal.append(bytes(record('audit.restart', { generation: 2, last_acked_audit_seq: 8 }, { writer })), current), { status: 400 });
  journal.append(bytes(record('audit.event', { audit_seq: 8, name: 'fixture.next' }, { writer })), current);
  assert.equal(journal.cursor(current).audit_seq, 8);
});
