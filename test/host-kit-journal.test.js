import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256Hex } from '../contracts/validate.js';
import { fixture, record, snapshot, validDocuments } from './host-kit/fixtures.js';

describe('host kit journal (AIT-44b/c)', () => {
  it('assigns immutable host sequences, hydrates source/design/turn records and preserves wire bytes', () => {
    const f = fixture();
    const docs = ['turn', 'source', 'design.input'].map((kind) => record(f.sid, kind));
    const bytes = `\n${JSON.stringify(docs[0], null, 2)}\n`;
    const first = f.request('journal', 'records', bytes);
    assert.equal(first.status, 200);
    assert.equal(first.body.seq, 1);
    assert.equal(f.host.storedBytes(f.sid, docs[0].client_event_id), bytes);
    first.body.data.body = 'tampered';
    for (const doc of docs.slice(1)) assert.equal(f.request('journal', 'records', doc).status, 200);
    const all = f.request('journal', 'records');
    assert.deepEqual(all.body.map((doc) => doc.seq), [1, 2, 3]);
    assert.equal(all.body[0].data.body, docs[0].data.body);
    validDocuments(all.body);
    const filtered = f.request('journal', 'records', undefined, { path: `/journal/sessions/${f.sid}/records?ids=1,3` });
    assert.deepEqual(filtered.body.map((doc) => doc.kind), ['turn', 'design.input']);
    assert.deepEqual(f.request('journal', 'records', undefined, { path: `/journal/sessions/${f.sid}/records?after=2` }).body.map((d) => d.seq), [3]);
    const cursor = f.request('journal', 'cursor');
    assert.deepEqual(cursor.body, { seq: 3, working_rev: 0, snapshot: null });
  });

  it('lost-ack retries return the existing sequence and byte changes conflict', () => {
    const f = fixture();
    const doc = record(f.sid);
    const bytes = JSON.stringify(doc);
    const original = f.request('journal', 'records', bytes);
    assert.deepEqual(f.request('journal', 'records', bytes), original);
    for (const changed of [{ ...doc, data: { ...doc.data, body: 'other' } }, { ...doc, extra: true }, `${bytes}\n`]) {
      const response = f.request('journal', 'records', changed);
      assert.equal(response.status, 409);
      assert.equal(response.body.code, 'idempotency_conflict');
      validDocuments(response.body);
    }
    assert.equal(f.request('journal', 'records').body.length, 1);
  });

  for (const action of ['records', 'snapshots', 'op.result']) {
    it(`${action}: current-generation lost-ack retries return old bytes without another write`, () => {
      const f = fixture();
      const doc = action === 'snapshots' ? snapshot(f.sid) : record(f.sid, action === 'op.result' ? action : 'turn');
      const bytes = `\n${JSON.stringify(doc, null, 2)}\n`;
      const first = f.request('journal', action, bytes);
      assert.equal(first.status, 200);
      assert.equal(first.body.seq, 1);
      f.host.takeover(f.sid);
      const current = { token: f.token({ gen: 2 }) };
      assert.equal(f.request('journal', action, bytes).body.code, 'fenced_generation', 'old tokens cannot replay');
      assert.deepEqual(f.request('journal', action, bytes, current), first);
      validDocuments(first.body);
      assert.equal(f.host.storedBytes(f.sid, doc.client_event_id), bytes);

      const rewritten = action === 'snapshots' ? { ...doc, worker_generation: 2 }
        : { ...doc, writer: { kind: 'worker', generation: 2 } };
      for (const changed of [rewritten, `${bytes}\n`]) {
        const conflict = f.request('journal', action, changed, current);
        assert.equal(conflict.status, 409);
        assert.equal(conflict.body.code, 'idempotency_conflict', 'replay/conflict precedes embedded generation');
        validDocuments(conflict.body);
      }
      const stale = f.request('journal', action, { ...doc, client_event_id: randomUUID() }, current);
      assert.equal(stale.status, 409);
      assert.equal(stale.body.code, 'fenced_generation', 'new ids still require current embedded generation');
      assert.equal(f.request('journal', 'cursor').body.seq, 1);
      assert.equal(f.request('journal', 'records').body.length, 1);
      f.host.revoke(f.sid);
      assert.equal(f.request('journal', action, bytes, current).body.code, 'revoked', 'authorization precedes replay');
    });
  }

  it('(sid, client_event_id) scopes idempotency to one session', () => {
    const a = fixture();
    const b = fixture();
    const id = randomUUID();
    assert.equal(a.request('journal', 'records', record(a.sid, 'turn', null, { client_event_id: id })).body.seq, 1);
    assert.equal(b.request('journal', 'records', record(b.sid, 'turn', null, { client_event_id: id })).body.seq, 1);
  });

  it('snapshot append is the CAS commit and exact retry precedes the changed current revision', () => {
    const f = fixture();
    f.request('journal', 'records', record(f.sid));
    const doc = snapshot(f.sid, [], { consumed_seq: 1 });
    const first = f.request('journal', 'snapshots', doc);
    assert.equal(first.status, 200);
    assert.equal(first.body.seq, 2);
    assert.deepEqual(f.request('journal', 'snapshots', doc), first);
    assert.equal(f.request('journal', 'snapshots', snapshot(f.sid)).status, 409);
    const second = snapshot(f.sid, [], { working_rev: 2, expected_prev_rev: 1, consumed_seq: 2 });
    assert.equal(f.request('journal', 'snapshots', second).body.seq, 3);
    assert.deepEqual(f.request('journal', 'snapshots', doc), first);
    assert.equal(f.request('journal', 'snapshots', { ...doc, consumed_seq: 0 }).body.code, 'idempotency_conflict');
    const cursor = f.request('journal', 'cursor').body;
    assert.equal(cursor.working_rev, 2);
    assert.equal(cursor.snapshot.client_event_id, second.client_event_id);
    validDocuments(cursor);
  });

  it('records and snapshots share the event-id namespace', () => {
    const f = fixture();
    const doc = record(f.sid);
    f.request('journal', 'records', doc);
    const response = f.request('journal', 'snapshots', snapshot(f.sid, [], { client_event_id: doc.client_event_id }));
    assert.equal(response.body.code, 'idempotency_conflict');
    assert.equal(f.request('journal', 'cursor').body.working_rev, 0);
  });

  it('writes and replays fence stale generations and changed epochs before idempotency', () => {
    const f = fixture();
    const doc = record(f.sid);
    f.request('journal', 'records', doc);
    f.host.takeover(f.sid);
    assert.equal(f.request('journal', 'records', doc).body.code, 'fenced_generation');
    assert.equal(f.request('journal', 'records', { ...doc, data: { ...doc.data, body: 'changed' } }).body.code, 'fenced_generation');
    const current = f.token({ gen: 2 });
    assert.equal(f.request('journal', 'records', record(f.sid, 'turn', null, { writer: { kind: 'worker', generation: 2 } }), { token: current }).status, 200);
    f.host.revoke(f.sid);
    assert.equal(f.request('journal', 'records', doc).body.code, 'revoked');
    assert.equal(f.request('journal', 'records').body.code, 'revoked');
    const authority = f.request('journal', 'authority');
    assert.equal(authority.status, 200);
    assert.equal(authority.headers['cache-control'], 'no-store');
    assert.equal(authority.body.auth_epoch, 2);
    assert.equal(authority.body.tombstone, true);
    assert.equal(authority.body.worker_generation, 2);
    assert.equal(authority.body.issued_at, new Date(f.now() * 1000).toISOString());
    validDocuments(authority.body);
  });

  it('op.result has its own route and remains an immutable acknowledged record', () => {
    const f = fixture();
    const doc = record(f.sid, 'op.result');
    const first = f.request('journal', 'op.result', doc);
    assert.equal(first.status, 200);
    assert.deepEqual(f.request('journal', 'op.result', doc), first);
    assert.equal(f.request('journal', 'op.result', record(f.sid)).status, 400);
    validDocuments(first.body);
  });

  it('rejects malformed, foreign, forged host, unsafe and incompatible documents without appending', () => {
    const f = fixture();
    const good = record(f.sid);
    const cases = [
      ['not JSON', 400], [{ ...good, sid: randomUUID() }, 403], [{ ...good, extra: true }, 400],
      [{ ...good, seq: 900 }, 400], [{ ...good, major: 2 }, 422], [{ ...good, minor: 3, min_reader: 3 }, 422],
      [{ ...good, writer: { kind: 'host' }, kind: 'session.control', data: { action: 'purge' } }, 403],
      [{ ...good, writer: { kind: 'worker', generation: 2 } }, 409],
      [{ ...good, data: { ...good.data, body: 'x'.repeat(8001) } }, 400],
      [{ ...good, writer: { kind: 'browser' }, data: { ...good.data, speaker: 'assistant', trust: 'assistant' } }, 400],
      [{ ...good, recorded_at: '2026-02-30T00:00:00Z' }, 400],
      [{ ...good, extra: undefined }, 400], [{ ...good, extra: NaN }, 400],
      ['{"__proto__":{}}', 400], ['x'.repeat(1024 * 1024 + 1), 413],
      [record(f.sid, 'source', { ...record(f.sid, 'source').data, segments: [{ id: 's1', start: 0, end: 100 }] }), 400],
      [record(f.sid, 'design.input', { ...record(f.sid, 'design.input').data, tokens_sha256: sha256Hex('tampered') }), 400],
    ];
    for (const [doc, expected] of cases) {
      const response = f.request('journal', 'records', doc);
      assert.equal(response.status, expected, JSON.stringify(response.body));
      validDocuments(response.body);
    }
    assert.equal(f.request('journal', 'records').body.length, 0);
    assert.equal(f.request('journal', 'snapshots', snapshot(f.sid, [], { consumed_seq: 1 })).status, 400);
    assert.equal(f.request('journal', 'snapshots', snapshot(f.sid, [], { patch: { canonical: canonicalJson({ op: 'x' }), sha256: sha256Hex('wrong') } })).status, 400);
  });

  it('rejects invalid read cursors and unknown routes', () => {
    const f = fixture();
    for (const query of ['after=-1', 'after=1.5', 'after=9007199254740992', 'ids=1,no', 'ids=']) {
      assert.equal(f.request('journal', 'records', undefined, { path: `/journal/sessions/${f.sid}/records?${query}` }).status, 400);
    }
    assert.equal(f.host.request({ method: 'DELETE', path: `/journal/sessions/${f.sid}/records`, token: f.token() }).status, 404);
    assert.equal(f.host.request({ method: 'GET', path: `/journal/sessions/${randomUUID()}/cursor`, token: f.token() }).status, 404);
  });
});
