import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validate } from '../contracts/validate.js';
import { SqliteJournal } from '../runtime/journal/index.js';
import { authorization, fixture, initialTime, record } from './host-kit/fixtures.js';
import { authority, bytes, otherSid, session, sid } from './fixtures/journal/helpers.mjs';

/** Normalize only the transport envelope; documents and stored bytes stay intact. */
function sqlite(t) {
  const journal = new SqliteJournal(':memory:', { now: () => initialTime * 1000 });
  journal.createSession(bytes(session({ tid: 'tenant-1', pid: 'project-1' })));
  journal.createSession(bytes(session({ sid: otherSid, tid: 'tenant-1', pid: 'project-1' })));
  t.after(() => journal.close());
  const grant = (patch = {}) => authority({ tid: 'tenant-1', pid: 'project-1', exp: initialTime + 900, ...patch });
  return {
    append(wire, patch = {}) {
      try {
        const stored = journal.append(wire, grant(patch));
        return { status: 200, code: null, document: stored.document, bytes: stored.bytes };
      } catch (error) {
        if (!Number.isInteger(error.status)) throw error;
        return { status: error.status, code: error.code };
      }
    },
    takeover: (gen) => journal.takeover(grant({ gen })).worker_generation,
    lastSeq: () => journal.cursor(grant()).last_seq,
    revoke: () => journal.append(bytes({ ...record(sid, 'authz.epoch', { epoch: 2, reason: 'withdrawal' }),
      writer: { kind: 'host' } }), grant({ writer_kind: 'host', gen: 2 })),
  };
}

function hostKit() {
  const f = fixture({ sid });
  f.host.createSession(authorization(otherSid));
  return {
    append(wire, patch = {}) {
      const response = f.request('journal', 'records', wire.toString('utf8'), { token: f.token(patch) });
      if (response.status !== 200) return { status: response.status, code: response.body.code ?? null };
      return { status: 200, code: null, document: response.body,
        bytes: Buffer.from(f.host.storedBytes(sid, response.body.client_event_id), 'utf8') };
    },
    takeover: () => f.host.takeover(sid),
    lastSeq: () => f.request('journal', 'cursor').body.seq,
    revoke: () => f.host.revoke(sid, { tombstone: false }),
  };
}

function committed(t, make, kind = 'turn') {
  const host = make(t);
  const doc = record(sid, kind);
  const wire = bytes(doc);
  const first = host.append(wire);
  assert.equal(first.status, 200);
  assert.equal(first.document.seq, 1);
  assert.deepEqual(first.bytes, wire);
  assert.equal(validate(first.document.contract, first.document).ok, true);
  assert.equal(host.takeover(1), 2);
  return { host, doc, wire, first };
}

for (const [name, make] of [['SQLite', sqlite], ['host kit', hostKit]]) {
  describe(`journal replay conformance (AIT-84): ${name}`, () => {
    for (const kind of ['turn', 'op.result']) {
      it(`${kind}: a current token replays older generation bytes and seq across repeated takeovers`, (t) => {
        const { host, wire, first } = committed(t, make, kind);
        for (const gen of [2, 3]) {
          assert.deepEqual(host.append(wire, { gen }), first);
          assert.equal(host.lastSeq(), 1, 'an acknowledgement replay does not append');
          if (gen === 2) assert.equal(host.takeover(gen), 3);
        }
      });

      it(`${kind}: same id with different bytes conflicts before the embedded generation fence`, (t) => {
        const { host, doc, wire, first } = committed(t, make, kind);
        const data = kind === 'turn' ? { ...doc.data, body: 'Changed synthetic turn.' }
          : { ...doc.data, host_ids: {} };
        const reordered = Object.fromEntries(Object.entries(doc).reverse());
        for (const changed of [Buffer.concat([wire, Buffer.from('\n')]), bytes(reordered), bytes({ ...doc, data }),
          bytes({ ...doc, writer: { kind: 'worker', generation: 2 } })]) {
          assert.deepEqual(host.append(changed, { gen: 2 }), { status: 409, code: 'idempotency_conflict' });
        }
        assert.deepEqual(host.append(wire, { gen: 2 }), first, 'conflicts cannot replace stored bytes');
        assert.equal(host.lastSeq(), 1);
      });

      it(`${kind}: a new id with stale embedded generation is fenced without reserving id or seq`, (t) => {
        const { host, doc } = committed(t, make, kind);
        const stale = { ...doc, client_event_id: randomUUID() };
        assert.deepEqual(host.append(bytes(stale), { gen: 2 }), { status: 409, code: 'fenced_generation' });
        assert.equal(host.lastSeq(), 1);
        const current = bytes({ ...stale, writer: { kind: 'worker', generation: 2 } });
        const result = host.append(current, { gen: 2 });
        assert.equal(result.status, 200);
        assert.equal(result.document.seq, 2);
        assert.deepEqual(result.bytes, current);
        assert.deepEqual(host.append(current, { gen: 2 }), result);
      });

      it(`${kind}: stale tokens are fenced before exact replay, conflict and new submissions`, (t) => {
        const { host, doc, wire } = committed(t, make, kind);
        for (const submitted of [wire, Buffer.concat([wire, Buffer.from('\n')]),
          bytes({ ...doc, client_event_id: randomUUID() }),
          bytes({ ...doc, client_event_id: randomUUID(), writer: { kind: 'worker', generation: 2 } })]) {
          assert.deepEqual(host.append(submitted), { status: 409, code: 'fenced_generation' });
        }
        assert.equal(host.lastSeq(), 1);
      });
    }

    for (const [scope, patch, status, code] of [
      ['tenant', { tid: 'foreign' }, 403, null],
      ['project', { pid: 'foreign' }, 403, null],
      ['session', { sid: otherSid, gen: 1 }, 403, null],
      ['capability', { capabilities: ['aithema.journal.read'] }, 403, null],
      ['expiry', { exp: initialTime }, 401, null],
      ['epoch', { auth_epoch: 2 }, 409, 'revoked'],
    ]) {
      it(`${scope} authorization still precedes replay and conflict`, (t) => {
        const { host, wire } = committed(t, make);
        for (const submitted of [wire, Buffer.concat([wire, Buffer.from('\n')])]) {
          assert.deepEqual(host.append(submitted, { gen: 2, ...patch }), { status, code });
        }
        assert.equal(host.lastSeq(), 1);
      });
    }

    it('revocation refuses old committed bytes even with the current generation token', (t) => {
      const { host, wire } = committed(t, make);
      host.revoke();
      for (const submitted of [wire, Buffer.concat([wire, Buffer.from('\n')])]) {
        assert.deepEqual(host.append(submitted, { gen: 2 }), { status: 409, code: 'revoked' });
      }
    });

    for (const [kind, data] of [
      ['source', null], ['design.input', null],
      ['reaction', { turn_seq: 1, text: 'Synthetic answer.', delivered_prefix: '', certainty: 'uncertain', complete: false }],
      ['ui.confirm', { item_ref: 'REQ-1', version: 1, content_sha256: 'a'.repeat(64), principal_ref: 'person-1' }],
      ['budget.hold', { hold_id: '33333333-3333-4333-8333-333333333333', attempt_id: `${sid}:1:spec:1`,
        lane: 'spec', max_micro: 100, currency: 'EUR' }],
      ['budget.claim', { hold_id: '33333333-3333-4333-8333-333333333333',
        claim_id: '44444444-4444-4444-8444-444444444444', request_sha256: 'b'.repeat(64) }],
      ['budget.settle', { hold_id: '33333333-3333-4333-8333-333333333333', outcome: 'void', charged_micro: 0 }],
      ['audit.event', { audit_seq: 1, name: 'fixture.acked' }],
      ['audit.restart', { generation: 1, last_acked_audit_seq: 0 }],
      ['session.end', { reason: 'person', host_mode: 'review', export: 'offered' }],
    ]) {
      it(`${kind}: replay returns the original record without reapplying record-specific checks`, (t) => {
        const host = make(t);
        const doc = record(sid, kind, data);
        const wire = bytes(doc);
        const first = host.append(wire);
        assert.equal(first.status, 200);
        assert.equal(validate(first.document.contract, first.document).ok, true);
        host.takeover(1);
        assert.deepEqual(host.append(wire, { gen: 2 }), first);
        assert.deepEqual(host.append(Buffer.concat([wire, Buffer.from('\n')]), { gen: 2 }),
          { status: 409, code: 'idempotency_conflict' });
        assert.deepEqual(host.append(bytes({ ...doc, client_event_id: randomUUID() }), { gen: 2 }),
          { status: 409, code: 'fenced_generation' });
        assert.equal(host.lastSeq(), 1);
      });
    }
  });
}
