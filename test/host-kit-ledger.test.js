import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  admitRequest, authorization, budgetRequest, claimRequest, fixture, recoverRequest, validDocuments,
} from './host-kit/fixtures.js';

function admit(f, n = 1, overrides = {}) {
  const response = f.request('ledger', 'admit', admitRequest(f.sid, n, overrides));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  validDocuments(response.body);
  return response.body.body.hold_id;
}

function claim(f, holdId, overrides = {}) {
  const response = f.request('ledger', 'claim', claimRequest(holdId, overrides));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  validDocuments(response.body);
  return response.body.body.claim_id;
}

function holds(f, query = '') {
  return f.request('ledger', 'holds', undefined, { path: `/ledger/sessions/${f.sid}/holds?state=open${query}` });
}

describe('host kit authoritative ledger (AIT-44b/c)', () => {
  it('admission reserves caps, retries return the original verdict, and bytes conflict', () => {
    const f = fixture({ caps: { session: 500 } });
    const doc = admitRequest(f.sid);
    const first = f.request('ledger', 'admit', doc);
    assert.equal(first.body.body.remaining_micro, 400);
    assert.deepEqual(f.request('ledger', 'admit', doc), first);
    for (const changed of [admitRequest(f.sid, 1, { max_micro: 101 }), { ...doc, extra: true }, `${JSON.stringify(doc)}\n`]) {
      const response = f.request('ledger', 'admit', changed);
      assert.equal(response.status, 409);
      assert.equal(response.body.code, 'idempotency_conflict');
      validDocuments(response.body);
    }
    assert.equal(holds(f).body.body.holds.length, 1);
    assert.equal(f.request('journal', 'records').body.length, 0, 'enumeration must not depend on a journaled budget.hold');
  });

  for (const denied of [false, true]) {
    it(`current-generation admission retry preserves the ${denied ? 'denied' : 'admitted'} verdict without another hold`, () => {
      const f = fixture({ caps: { session: 500 }, session: { evidence: !denied } });
      const doc = admitRequest(f.sid);
      const bytes = `\n${JSON.stringify(doc, null, 2)}\n`;
      const first = f.request('ledger', 'admit', bytes);
      assert.equal(first.status, denied ? 402 : 200);
      validDocuments(first.body);
      f.host.setEvidence(f.sid, denied);
      f.host.takeover(f.sid);
      const current = { token: f.token({ gen: 2 }) };
      assert.equal(f.request('ledger', 'admit', bytes).body.code, 'fenced_generation');
      assert.deepEqual(f.request('ledger', 'admit', bytes, current), first, 'replay retains the original verdict and HTTP status');
      for (const changed of [`${bytes}\n`, { ...doc, body: { ...doc.body, worker_generation: 2 } }]) {
        const conflict = f.request('ledger', 'admit', changed, current);
        assert.equal(conflict.status, 409);
        assert.equal(conflict.body.code, 'idempotency_conflict');
        validDocuments(conflict.body);
      }
      const stale = f.request('ledger', 'admit', admitRequest(f.sid, 2), current);
      assert.equal(stale.status, 409);
      assert.equal(stale.body.code, 'fenced_generation', 'new attempts cannot carry a stale generation');
      assert.equal(holds(f).body.body.holds.length, denied ? 0 : 1);
      f.host.setEvidence(f.sid, true);
      const fresh = f.request('ledger', 'admit', admitRequest(f.sid, 2, { worker_generation: 2 }), current);
      assert.equal(fresh.status, 200);
      assert.equal(fresh.body.body.remaining_micro, denied ? 400 : 300, 'replay cannot reserve the budget twice');
      assert.equal(holds(f).body.body.holds.length, denied ? 1 : 2);
      f.host.revoke(f.sid);
      assert.equal(f.request('ledger', 'admit', bytes, current).body.code, 'revoked');
    });
  }

  it('duplicate claims, including identical digests, never return the claim twice (§3.4)', () => {
    const f = fixture();
    const hold = admit(f);
    const request = claimRequest(hold);
    const first = f.request('ledger', 'claim', request);
    assert.equal(first.status, 200);
    assert.ok(first.body.body.claim_id);
    for (const doc of [request, { ...request, body: { ...request.body, request_sha256: 'b'.repeat(64) } }]) {
      const response = f.request('ledger', 'claim', doc);
      assert.equal(response.status, 409);
      assert.equal(response.body.code, 'already_claimed');
      validDocuments(response.body);
    }
    assert.equal(holds(f).body.body.holds[0].claimed, true);
    assert.notEqual(claim(f, admit(f, 2)), first.body.body.claim_id, 'retry needs a fresh attempt, hold and claim');
  });

  it('recover before claim closes void, returns the same result, releases the hold and blocks later claims', () => {
    const f = fixture({ caps: { session: 100 } });
    const hold = admit(f);
    const first = f.request('ledger', 'recover', recoverRequest(hold));
    assert.deepEqual(first.body.body, { hold_id: hold, closed_reason: 'void', charged_micro: 0 });
    assert.deepEqual(f.request('ledger', 'recover', recoverRequest(hold)), first);
    const denied = f.request('ledger', 'claim', claimRequest(hold));
    assert.equal(denied.status, 409);
    assert.equal(denied.body.code, 'hold_closed');
    validDocuments(denied.body);
    assert.deepEqual(holds(f).body.body.holds, []);
    assert.ok(admit(f, 2));
  });

  it('crash after claim recovers unknown charged at maximum and cannot be resent or settled afterward', () => {
    const f = fixture({ caps: { session: 100 } });
    const hold = admit(f);
    const claimId = claim(f, hold);
    const recovered = f.request('ledger', 'recover', recoverRequest(hold));
    assert.deepEqual(recovered.body.body, { hold_id: hold, closed_reason: 'unknown', charged_micro: 100 });
    validDocuments(recovered.body);
    assert.deepEqual(f.request('ledger', 'recover', recoverRequest(hold)), recovered);
    assert.equal(f.request('ledger', 'claim', claimRequest(hold)).body.code, 'hold_closed');
    assert.equal(f.request('ledger', 'settle', budgetRequest('settle', { claim_id: claimId, outcome: 'settled', actual_micro: 1 })).body.code, 'hold_closed');
    assert.equal(f.request('ledger', 'admit', admitRequest(f.sid, 2)).body.code, 'budget_denied');
  });

  for (const outcome of ['settled', 'unknown']) {
    it(`lost settlement ack: ${outcome} is recovered exactly and closed holds reject claims`, () => {
      const f = fixture({ caps: { session: 500 } });
      const hold = admit(f);
      const claimId = claim(f, hold);
      const doc = budgetRequest('settle', { claim_id: claimId, outcome, ...(outcome === 'settled' ? { actual_micro: 37 } : {}) });
      const first = f.request('ledger', 'settle', doc);
      assert.equal(first.status, 200);
      assert.equal(first.body.body.charged_micro, outcome === 'settled' ? 37 : 100);
      assert.deepEqual(f.request('ledger', 'settle', doc), first);
      assert.deepEqual(f.request('ledger', 'recover', recoverRequest(hold)), first);
      assert.deepEqual(f.request('ledger', 'recover', recoverRequest(hold)), first);
      assert.equal(f.request('ledger', 'settle', `${JSON.stringify(doc)}\n`).body.code, 'idempotency_conflict');
      assert.equal(f.request('ledger', 'claim', claimRequest(hold)).body.code, 'hold_closed');
      const next = f.request('ledger', 'admit', admitRequest(f.sid, 2));
      assert.equal(next.body.body.remaining_micro, 500 - 100 - first.body.body.charged_micro);
      validDocuments(first.body);
    });
  }

  it('takeover before claim fences old workers and holds; current workers may only recover the old hold', () => {
    const f = fixture();
    const hold = admit(f);
    f.host.takeover(f.sid);
    assert.equal(f.request('ledger', 'claim', claimRequest(hold)).body.code, 'fenced_generation');
    assert.equal(f.request('ledger', 'recover', recoverRequest(hold)).body.code, 'fenced_generation');
    assert.equal(holds(f).status, 200, 'enumeration is an epoch-fenced read, not a generation-fenced write');
    const token = f.token({ gen: 2 });
    assert.equal(f.request('ledger', 'claim', claimRequest(hold, { worker_generation: 2 }), { token }).body.code, 'fenced_generation');
    const recovered = f.request('ledger', 'recover', recoverRequest(hold, { worker_generation: 2 }), { token });
    assert.equal(recovered.body.body.closed_reason, 'void');
    assert.equal(f.request('ledger', 'claim', claimRequest(hold, { worker_generation: 2 }), { token }).body.code, 'hold_closed');
    const fresh = f.request('ledger', 'admit', admitRequest(f.sid, 2, { worker_generation: 2 }), { token });
    assert.equal(fresh.status, 200);
  });

  it('takeover after committed claim preserves the claim boundary and conservatively charges recovery', () => {
    const f = fixture();
    const hold = admit(f);
    const committed = f.request('ledger', 'claim', claimRequest(hold));
    f.host.takeover(f.sid);
    assert.ok(committed.body.body.claim_id, 'the committed claim remains a dispatch permit');
    assert.equal(f.request('ledger', 'settle', budgetRequest('settle', { claim_id: committed.body.body.claim_id, outcome: 'unknown' })).body.code, 'fenced_generation');
    const recovered = f.request('ledger', 'recover', recoverRequest(hold, { worker_generation: 2 }), { token: f.token({ gen: 2 }) });
    assert.equal(recovered.body.body.closed_reason, 'unknown');
    assert.equal(recovered.body.body.charged_micro, 100);
  });

  it('epoch changes precede stale-generation, replay, claim and closed-hold checks', () => {
    const f = fixture();
    const hold = admit(f);
    claim(f, hold);
    f.host.takeover(f.sid);
    f.host.revoke(f.sid);
    for (const [action, doc] of [['admit', admitRequest(f.sid)], ['claim', claimRequest(hold)],
      ['recover', recoverRequest(hold)], ['settle', budgetRequest('settle', { claim_id: randomUUID(), outcome: 'unknown' })]]) {
      const response = f.request('ledger', action, doc);
      assert.equal(response.body.code, 'revoked');
      assert.equal(response.status, 409);
    }
    assert.equal(holds(f).body.code, 'revoked');
    assert.equal(f.request('ledger', 'claim', claimRequest(hold), { token: f.token({ gen: 2, auth_epoch: 2 }) }).body.code, 'revoked', 'tombstone refuses even newly minted claims');
  });

  it('keyset next_cursor survives recovering every earlier page and is authoritative without journal holds', () => {
    const f = fixture();
    const expected = Array.from({ length: 5 }, (_, i) => admit(f, i));
    claim(f, expected[1]);
    let cursor = null;
    const seen = [];
    do {
      const response = holds(f, `&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers['cache-control'], 'no-store');
      validDocuments(response.body);
      for (const hold of response.body.body.holds) {
        seen.push(hold.hold_id);
        assert.equal(f.request('ledger', 'recover', recoverRequest(hold.hold_id)).status, 200);
      }
      cursor = response.body.body.next_cursor;
    } while (cursor);
    assert.deepEqual(seen, expected);
    assert.deepEqual(holds(f).body.body.holds, []);
    assert.equal(f.request('journal', 'records').body.length, 0);
    for (const query of ['&limit=0', '&limit=1001', '&cursor=garbage', `&cursor=${randomUUID()}:1`]) {
      assert.equal(holds(f, query).status, 400);
    }
    assert.equal(f.request('ledger', 'holds').status, 400);
  });

  for (const [scope, reason] of [['session', 'session_cap'], ['principalDay', 'principal_day_cap'], ['tenantDay', 'tenant_day_cap']]) {
    it(`denies ${reason} with 402 and reserves unsettled claims`, () => {
      const f = fixture({ caps: { [scope]: 100 } });
      claim(f, admit(f));
      const doc = admitRequest(f.sid, 2);
      const denied = f.request('ledger', 'admit', doc);
      assert.equal(denied.status, 402);
      assert.equal(denied.body.code, 'budget_denied');
      assert.equal(denied.body.document.body.denied, reason);
      validDocuments(denied.body);
      assert.deepEqual(f.request('ledger', 'admit', doc), denied);
    });
  }

  it('missing evidence has a durable denied verdict; restoring evidence requires a new attempt', () => {
    const f = fixture({ session: { evidence: false } });
    const doc = admitRequest(f.sid);
    const denied = f.request('ledger', 'admit', doc);
    assert.equal(denied.status, 402);
    assert.equal(denied.body.document.body.denied, 'no_evidence');
    f.host.setEvidence(f.sid, true);
    assert.deepEqual(f.request('ledger', 'admit', doc), denied);
    assert.equal(f.request('ledger', 'admit', admitRequest(f.sid, 2)).status, 200);
    assert.equal(f.request('ledger', 'admit', admitRequest(f.sid, 1, { max_micro: 1 })).body.code, 'idempotency_conflict');
  });

  it('principal/day and tenant/day caps aggregate sessions while unrelated tenants remain separate', () => {
    for (const scope of ['principalDay', 'tenantDay']) {
      const f = fixture({ caps: { [scope]: 100 } });
      admit(f);
      const other = randomUUID();
      f.host.createSession(authorization(other));
      const otherResponse = f.host.request({ method: 'POST', path: `/ledger/sessions/${other}/admit`, token: f.token({ sid: other }), body: admitRequest(other) });
      assert.equal(otherResponse.status, 402);
      const foreign = randomUUID();
      f.host.createSession(authorization(foreign, { tid: 'tenant-2' }));
      assert.equal(f.host.request({ method: 'POST', path: `/ledger/sessions/${foreign}/admit`, token: f.token({ sid: foreign, tid: 'tenant-2' }), body: admitRequest(foreign) }).status, 200);
    }
  });

  it('principal cap is bound to the person actor and daily reservations remain on their admission day', () => {
    const f = fixture({ caps: { principalDay: 100 } });
    admit(f);
    const other = randomUUID();
    f.host.createSession(authorization(other, { participants: [{ participant_ref: 'person-2', role: 'owner', notice_ref: 'notice-test' }] }));
    assert.equal(f.host.request({ method: 'POST', path: `/ledger/sessions/${other}/admit`, token: f.token({ sid: other, act: { sub: 'person-2' } }), body: admitRequest(other) }).status, 200);
    f.advance(86400);
    assert.equal(f.request('ledger', 'admit', admitRequest(f.sid, 2)).status, 200);
  });

  it('tenant/day caps aggregate two different persons and reset on the next admission day', () => {
    const f = fixture({ caps: { tenantDay: 150 } });
    admit(f);
    const other = randomUUID();
    f.host.createSession(authorization(other, { participants: [{ participant_ref: 'person-2', role: 'owner', notice_ref: 'notice-test' }] }));
    const request = (n) => f.host.request({ method: 'POST', path: `/ledger/sessions/${other}/admit`,
      token: f.token({ sid: other, act: { sub: 'person-2' } }), body: admitRequest(other, n) });
    const denied = request(1);
    assert.equal(denied.status, 402);
    assert.equal(denied.body.code, 'budget_denied');
    assert.equal(denied.body.document.body.denied, 'tenant_day_cap');
    validDocuments(denied.body);
    f.advance(86400);
    assert.deepEqual(request(1), denied, 'the original denied attempt stays denied across days');
    const nextDay = request(2);
    assert.equal(nextDay.status, 200);
    assert.equal(nextDay.body.body.remaining_micro, 50);
    validDocuments(nextDay.body);
    assert.equal(holds(f).body.body.holds.length, 1, 'the previous day reservation remains open');
  });

  it('foreign holds, claims, sessions and invalid settlement/body fields fail without consuming or closing holds', () => {
    const f = fixture();
    const hold = admit(f);
    const claimId = claim(f, hold);
    const cases = [
      ['claim', claimRequest(randomUUID()), 404], ['recover', recoverRequest(randomUUID()), 404],
      ['admit', admitRequest(randomUUID()), 403], ['admit', admitRequest(f.sid, 2, { currency: 'USD' }), 400],
      ['claim', claimRequest(hold, { auth_epoch: 2 }), 409], ['recover', recoverRequest(hold, { worker_generation: 2 }), 409],
      ['settle', budgetRequest('settle', { claim_id: randomUUID(), outcome: 'unknown' }), 404],
      ['settle', budgetRequest('settle', { claim_id: claimId, outcome: 'settled' }), 400],
      ['settle', budgetRequest('settle', { claim_id: claimId, outcome: 'unknown', actual_micro: 1 }), 400],
      ['settle', budgetRequest('settle', { claim_id: claimId, outcome: 'settled', actual_micro: 101 }), 400],
      ['claim', admitRequest(f.sid, 2), 400], ['admit', admitRequest(f.sid, 2, { attempt_id: 'malformed' }), 400],
    ];
    for (const [action, doc, status] of cases) assert.equal(f.request('ledger', action, doc).status, status);
    const foreign = randomUUID();
    f.host.createSession(authorization(foreign));
    for (const [action, doc] of [['claim', claimRequest(hold)], ['recover', recoverRequest(hold)],
      ['settle', budgetRequest('settle', { claim_id: claimId, outcome: 'unknown' })]]) {
      assert.equal(f.host.request({ method: 'POST', path: `/ledger/sessions/${foreign}/${action}`, token: f.token({ sid: foreign }), body: doc }).status, 404);
    }
    assert.equal(holds(f).body.body.holds.length, 1);
    assert.equal(f.request('ledger', 'recover', recoverRequest(hold)).body.body.charged_micro, 100);
  });
});
