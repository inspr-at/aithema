import { it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { AuditWriter, restartLoss } from '../runtime/audit/index.js';
import { sha256Hex } from '../contracts/validate.js';
import { authorizationFor, bytes, fixture, output, record, textSession, valid } from './fixtures/e2e/support.mjs';
import { flush } from './engine-helpers.test.js';
import { crash } from './fixtures/e2e/run-crash.mjs';

it('(c) process crash loses the best-effort tail and restart advertises the previous acknowledged audit boundary', async (t) => {
  const path = crash('audit', 'audit.tail');
  const f = fixture(t, { path, initialize: false, handler: output });
  assert.deepEqual(f.records('audit.event').map((r) => r.document.data.audit_seq), [1]);
  await f.engine.resume({ authorizationFor, lastAckedAuditSeq: 1, replay: false });
  const marker = f.records('audit.restart').at(-1).document;
  assert.deepEqual(restartLoss(marker), { previous_generation: 1, after_audit_seq: 1, possibly_lost: true, upper_bound: null, gap_detection: false });
  const audit = new AuditWriter({ port: f.port, authority: f.client.authority, lastAckedAuditSeq: 1, now: f.clock.wallNow, clock: f.clock });
  assert.equal((await audit.bestEffort({ name: 'synthetic.resumed' })).audit_seq, 2);
});

for (const [boundary, reason, charged] of [
  ['budget.admit_before_journal', 'void', 0], ['budget.after_admit', 'void', 0],
  ['budget.claim_before_response', 'unknown', 100], ['budget.after_claim', 'unknown', 100],
  ['budget.during_request', 'unknown', 100], ['budget.after_provider', 'unknown', 100],
  ['budget.settle_response_lost', 'settled', 7],
]) {
  it(`(c) budget process crash ${boundary}: authoritative enumeration, ${reason} recovery, repeated result and no second dispatch`, async (t) => {
    const path = crash('budget', boundary);
    const f = fixture(t, { path, initialize: false, handler: output });
    const open = (await f.budget.listOpen()).holds;
    const holdId = open[0]?.hold_id ?? f.records('budget.hold').at(-1).document.data.hold_id;
    assert.equal(open.length, reason === 'settled' ? 0 : 1);
    if (boundary === 'budget.admit_before_journal') assert.equal(f.records('budget.hold').some((r) => r.document.data.hold_id === holdId), false);
    await f.engine.resume({ authorizationFor, replay: false });
    assert.equal((await f.budget.listOpen()).holds.length, 0);
    assert.equal(f.calls.length, 0, 'recovery itself never resends an old request');
    const auth = f.client.authority;
    const recovery = { hold_id: holdId, worker_generation: auth.gen, auth_epoch: auth.auth_epoch };
    const expected = { hold_id: holdId, closed_reason: reason, charged_micro: charged };
    for (let i = 0; i < 3; i++) assert.deepEqual(await f.budget.recover(recovery), expected);
    await assert.rejects(f.budget.claim({ ...recovery, request_sha256: sha256Hex('retry forbidden') }), { code: 'hold_closed' });
    await f.engine.replay();
    const fresh = f.records('budget.hold').filter((r) => r.document.writer.generation === 2);
    assert.ok(fresh.length > 0);
    assert.ok(fresh.every((r) => r.document.data.hold_id !== holdId));
    assert.deepEqual(await f.budget.recover(recovery), expected);
    valid(f.engine.state);
  });
}

it('(c) aggregate session cap mid-session stops every paid lane while bounded text capture remains available', async (t) => {
  const f = fixture(t, { cap: 114, handler: output });
  await f.engine.start();
  const port = textSession(f);
  await port.submitTurn({ text: 'Please export entries.' }); await port.idle();
  assert.equal(f.calls.length, 2); // Costs 14; a third maximum reservation is allowed.
  await port.submitTurn({ text: 'Capture a second export detail.' }); await port.idle();
  assert.equal(f.budget.paidState, 'BUDGET_DENIED');
  assert.equal(f.calls.length, 3);
  const turns = f.records('turn').length;
  for (let i = 0; i < 3; i++) {
    const response = await port.submitTurn({ text: `Free export detail ${i}.` }); await port.idle();
    assert.equal(response.reaction.status, 'denied');
  }
  await f.clock.advance(30_000);
  assert.equal(f.records('turn').length, turns + 3);
  assert.equal(f.calls.length, 3);
  assert.equal(f.records('budget.hold').filter((r) => r.document.data.lane === 'design').length, 0);
  assert.ok(f.engine.design.state.intents.length > 0);
  assert.equal(f.engine.design.state.intents.every((intent) => intent.state === 'blocked'), true);
  const max = 'x'.repeat(8001);
  await assert.rejects(port.submitTurn({ text: max }), { code: 'invalid_turn' });
  assert.equal(f.records('turn').length, turns + 3);
  assert.equal(f.budget.textCaptureAllowed, true);
  const { durability } = await port.view(); assert.equal(durability.unacknowledged, 0);
});

it('(c) host outage bounds the text buffer at five unacknowledged plus fifteen captured turns and ends with an export', async (t) => {
  let f, down = false;
  f = fixture(t, { handler: output, journalOverrides: { append: (original, auth) => {
    if (down) throw new Error('Host unavailable'); return f.journal.append(original, auth);
  } } });
  await f.engine.start(); down = true;
  for (let i = 0; i < 5; i++) await assert.rejects(f.client.append(bytes(record('turn', {
    speaker: 'person', participant_ref: 'fixture-person', channel: 'text', trust: 'authenticated_person', lang: 'en', body: `Buffered ${i}`,
  }))));
  const overflow = bytes(record('turn', { speaker: 'person', participant_ref: 'fixture-person', channel: 'text', trust: 'authenticated_person', lang: 'en', body: 'Capture next' }));
  await assert.rejects(f.client.append(overflow));
  assert.equal(f.client.state, 'CAPTURE_ONLY');
  for (let i = 0; i < 15; i++) f.client.captureTurn(bytes(record('turn', {
    speaker: 'person', participant_ref: 'fixture-person', channel: 'text', trust: 'authenticated_person', lang: 'en', body: `Captured ${i}`,
  })));
  assert.throws(() => f.client.captureTurn(overflow), { status: 413 });
  const exported = f.client.exportUnacknowledged();
  assert.equal(exported.unacknowledged.length, 5); assert.equal(exported.captured_turns.length, 15);
  assert.throws(() => f.engine.passSpec(), (e) => e.reason === 'journal_stopped');
  await f.clock.advance(600_000);
  assert.equal(f.client.state, 'ENDED');
  assert.equal(f.client.exportUnacknowledged().captured_turns.length, 15);
  assert.equal(f.calls.length, 0);
});

it('(c) second claim is refused while its first claim is still open, and all open holds recover on restart', async (t) => {
  const f = fixture(t); await f.engine.start();
  const holds = [];
  for (let i = 1; i <= 3; i++) holds.push(await f.budget.admit({ attempt_id: `${f.auth.sid}:1:spec:${i}`, sid: f.auth.sid,
    worker_generation: 1, auth_epoch: 1, lane: 'spec', max_micro: 100, currency: 'EUR' }));
  const request = { hold_id: holds[0].hold_id, worker_generation: 1, auth_epoch: 1, request_sha256: sha256Hex('fixed outbound bytes') };
  await f.budget.claim(request);
  await assert.rejects(f.budget.claim(request), { code: 'already_claimed' });
  await assert.rejects(f.budget.claim({ ...request, request_sha256: sha256Hex('changed outbound bytes') }), { code: 'already_claimed' });
  f.engine.close();
  const fresh = fixture(t, { path: f.path, initialize: false });
  await fresh.engine.resume({ authorizationFor, replay: false });
  assert.equal((await fresh.budget.listOpen()).holds.length, 0);
  for (const [i, hold] of holds.entries()) assert.deepEqual(await fresh.budget.recover({ hold_id: hold.hold_id, worker_generation: 2, auth_epoch: 1 }),
    { hold_id: hold.hold_id, closed_reason: i === 0 ? 'unknown' : 'void', charged_micro: i === 0 ? 100 : 0 });
});

for (const change of ['takeover', 'withdrawal']) {
  for (const committed of [false, true]) {
    it(`(c) ${change} ${committed ? 'after' : 'before'} claim commitment fences new dispatch; committed output is discarded and maximally charged`, async (t) => {
      let f;
      const waiting = Promise.withResolvers();
      f = fixture(t, { handler: async (lane, payload) => { await waiting.promise; return output(lane, payload); } });
      await f.engine.start(); const seq = f.personTurn();
      const records = (kind) => f.journal.recordsAfter(0, { ...f.auth, auth_epoch: change === 'withdrawal' ? 2 : 1 })
        .filter((r) => r.document.kind === kind);
      const changeAuthority = () => {
        if (change === 'takeover') f.journal.takeover(f.auth);
        else { f.journal.append(bytes(record('authz.epoch', { epoch: 2, reason: 'withdrawal' }, { writer: { kind: 'host' } })), { ...f.auth, writer_kind: 'host' }); f.authz.revoke(2); }
      };
      if (!committed) {
        changeAuthority();
        await assert.rejects(async () => f.engine.react(seq));
        assert.equal(f.calls.length, 0); assert.equal(records('budget.claim').length, 0);
      } else {
        const reaction = f.engine.react(seq);
        const result = Promise.allSettled([reaction]);
        await flush(); assert.equal(f.records('budget.claim').length, 1);
        changeAuthority(); waiting.resolve(); await result; await f.engine.drain();
        assert.equal(f.calls.length, 1); assert.equal(records('reaction').length, 0);
        const holdId = records('budget.hold')[0].document.data.hold_id;
        const db = new DatabaseSync(f.path, { readOnly: true }); t.after(() => db.close());
        const row = db.prepare('SELECT closed_reason FROM budget_holds WHERE hold_id = ?').get(holdId);
        assert.equal(row.closed_reason, 'unknown');
        const claim = db.prepare('SELECT settled_micro FROM budget_claims WHERE hold_id = ?').get(holdId);
        assert.equal(claim.settled_micro, 100);
        assert.equal(records('budget.claim').length, 1);
      }
    });
  }
}

it('(c) scenario 8: hold journal precedes claim, committed claim/claim audit precede provider effect and session end precedes its effect', async (t) => {
  let f;
  const order = [];
  let db;
  f = fixture(t, { ledgerOverrides: { claim: (original, auth) => {
    const holdId = JSON.parse(original).body.hold_id;
    assert.ok(f.records('budget.hold').some((r) => r.document.data.hold_id === holdId)); order.push('hold');
    return f.ledger.claim(original, auth);
  } }, handler: (lane, payload) => {
    const claim = f.records('budget.claim').at(-1).document;
    assert.ok(db.prepare('SELECT claim_id FROM budget_claims WHERE claim_id = ?').get(claim.data.claim_id));
    order.push('claim', 'provider'); return output(lane, payload);
  } });
  db = new DatabaseSync(f.path, { readOnly: true }); t.after(() => db.close());
  await f.engine.start(); const port = textSession(f); await port.submitTurn({ text: 'Please export entries.' }); await port.idle(); await f.engine.drain();
  assert.deepEqual(order.slice(0, 3), ['hold', 'claim', 'provider']);
  const audit = new AuditWriter({ port: f.port, authority: f.auth, now: f.clock.wallNow, clock: f.clock });
  await audit.critical('session.end', { reason: 'person', host_mode: 'review', export: 'offered' }, (ack) => {
    assert.equal(f.records('session.end').at(-1).document.seq, ack.document.seq); f.engine.close();
  });
  assert.throws(() => f.engine.passSpec(), (e) => e.reason === 'engine_stopped');
});

for (const committed of [false, true]) {
  it(`(c) epoch write-ahead refuses to run the effect on ${committed ? 'lost' : 'missing'} acknowledgement; restart declares possibly lost audit tail`, async (t) => {
    let f, fail = false, effects = 0;
    f = fixture(t, { journalOverrides: { append: (original, auth) => {
      const doc = JSON.parse(original);
      if (fail && doc.kind === 'authz.epoch') { if (committed) f.journal.append(original, auth); throw new Error('Lost host ack'); }
      if (fail && doc.kind === 'audit.event') throw new Error('Volatile tail lost');
      return f.journal.append(original, auth);
    } } });
    const audit = new AuditWriter({ port: f.port, authority: f.auth, now: f.clock.wallNow, clock: f.clock });
    await audit.bestEffort({ name: 'synthetic.started' });
    fail = true; const lost = await audit.bestEffort({ name: 'synthetic.tail' }); assert.equal(lost.acked, false);
    const hostAudit = new AuditWriter({ port: f.port, authority: { ...f.auth, writer_kind: 'host' }, now: f.clock.wallNow, clock: f.clock });
    await assert.rejects(hostAudit.critical('authz.epoch', { epoch: 2, reason: 'change' }, () => effects++));
    assert.equal(effects, 0);
    // Epoch-changing hosts require a refreshed grant after their atomic write.
    const auth = { ...f.auth, auth_epoch: committed ? 2 : 1 };
    const records = (kind) => f.journal.recordsAfter(0, auth).filter((r) => r.document.kind === kind);
    assert.equal(records('authz.epoch').length, committed ? 1 : 0);
    f.journal.takeover(auth);
    const restarted = new AuditWriter({ port: f.port, authority: { ...auth, gen: 2 }, lastAckedAuditSeq: 1,
      now: f.clock.wallNow, clock: f.clock });
    fail = false; await restarted.start();
    const marker = records('audit.restart').at(-1).document;
    assert.deepEqual(restartLoss(marker), { previous_generation: 1, after_audit_seq: 1, possibly_lost: true, upper_bound: null, gap_detection: false });
    const next = await restarted.bestEffort({ name: 'synthetic.resumed' }); assert.equal(next.audit_seq, 2);
    valid(marker);
  });
}
