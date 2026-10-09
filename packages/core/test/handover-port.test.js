import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandover, reduceHandover, handoverView, handoverKey,
  assertHandoverPort, createFakeHandoverHost, handoverConformance } from '../src/index.js';
const start = () => createHandover({ sessionId: 'session-1' });
const request = (s = start(), revision = 'r1') => reduceHandover(s, { type: 'request', revision });
const result = (s, status, data = {}) => reduceHandover(s, { type: 'result', revision: s.revision,
  attempt: handoverView(s).attempt, status, receiptId: 'host-receipt', ...data });

test('handover exposes idle/preparing/sent and only a preparing transition requests delivery', () => {
  const idle = start(), prepared = request(idle);
  assert.equal(handoverView(idle).status, 'idle');
  assert.equal(prepared.state.status, 'preparing');
  assert.deepEqual(prepared.delivery, { sessionId: 'session-1', revision: 'r1',
    idempotencyKey: handoverKey('session-1', 'r1'), attempt: 1 });
  assert.equal(prepared.events[0].type, 'handover.state');
  const sent = result(prepared.state, 'sent');
  assert.equal(sent.state.status, 'sent');
  assert.equal(sent.events[0].data.receiptId, 'host-receipt');
  assert.equal(sent.delivery, null);
  assert.deepEqual(idle, start());
});

test('repeated requests and preparing deliveries are inert and cannot start another revision', () => {
  const s = request().state;
  for (const revision of ['r1', 'r2']) assert.deepEqual(request(s, revision), { state: s, events: [], delivery: null });
  assert.equal(reduceHandover(s, { type: 'retry', revision: 'r1' }).delivery, null);
});

test('failed delivery requires an explicit retry and reuses the revision key', () => {
  let s = request().state;
  const originalKey = handoverView(s).idempotencyKey;
  s = result(s, 'failed', { error: 'private provider error never published' }).state;
  assert.equal(handoverView(s).canRetry, true);
  assert.equal(handoverView(s).error, 'delivery-failed');
  assert.equal(request(s).delivery, null);
  const retry = reduceHandover(s, { type: 'retry', revision: 'r1' });
  assert.equal(retry.delivery.idempotencyKey, originalKey);
  assert.equal(retry.delivery.attempt, 2);
  assert.equal(retry.state.status, 'preparing');
  assert.equal(result(retry.state, 'sent').state.status, 'sent');
});

test('sent revisions remain idempotent after delivering a later session revision', () => {
  let s = result(request().state, 'sent').state;
  s = result(request(s, 'r2').state, 'sent', { receiptId: 'second-receipt' }).state;
  assert.equal(s.attempts.length, 2);
  assert.equal(request(s, 'r1').delivery, null);
  assert.equal(request(s, 'r2').delivery, null);
  assert.equal(reduceHandover(s, { type: 'retry', revision: 'r1' }).delivery, null);
  assert.equal(request(s, 'r3').delivery.revision, 'r3');
});

test('an older failed revision cannot be retried after a newer revision is current', () => {
  const failed = result(request().state, 'failed').state;
  const current = request(failed, 'r2').state;
  for (const s of [current, result(current, 'sent').state, result(current, 'failed').state]) {
    assert.deepEqual(reduceHandover(s, { type: 'retry', revision: 'r1' }), { state: s, events: [], delivery: null });
    assert.equal(s.revision, 'r2');
  }
});

test('handover history is bounded without allowing an old revision to deliver again', () => {
  let s = start(), blocked = false;
  for (let n = 0; n < 200; n += 1) {
    const prepared = request(s, `revision-${n}`);
    if (prepared.delivery === null) {
      assert.equal(prepared.events[0]?.type, 'handover.limit-reached');
      assert.equal(prepared.events[0]?.data.reason, 'revision-limit');
      assert.equal(prepared.state, s);
      blocked = true; break;
    }
    s = result(prepared.state, 'sent').state;
  }
  assert.equal(blocked, true);
  assert.ok(s.attempts.length <= 100);
  assert.equal(request(s, 'revision-0').delivery, null);
  assert.equal(request(s, s.revision).delivery, null);
});

test('the current failed revision remains retryable at the handover history bound', () => {
  let s = start();
  for (let n = 0; n < 100; n += 1) s = result(request(s, `revision-${n}`).state, n === 99 ? 'failed' : 'sent').state;
  assert.equal(request(s, 'overflow').delivery, null);
  const retried = reduceHandover(s, { type: 'retry', revision: s.revision });
  assert.equal(retried.delivery.attempt, 2);
  assert.equal(retried.delivery.idempotencyKey, handoverKey(s.sessionId, s.revision));
});

test('stale results cannot complete a retry or another revision', () => {
  let s = result(request().state, 'failed').state;
  s = reduceHandover(s, { type: 'retry', revision: 'r1' }).state;
  assert.equal(result(s, 'sent', { attempt: 1 }).state, s);
  assert.equal(result(s, 'sent', { revision: 'r2' }).state, s);
  assert.equal(result(s, 'sent', { attempt: 2 }).state.status, 'sent');
});

test('recovery of an interrupted delivery retains the key and leaves retry explicit', () => {
  const s = request().state;
  const recovered = reduceHandover(s, { type: 'recover' });
  assert.equal(recovered.state.status, 'failed');
  assert.equal(recovered.delivery, null);
  assert.equal(handoverView(recovered.state).error, 'delivery-interrupted');
  assert.equal(reduceHandover(recovered.state, { type: 'retry', revision: 'r1' }).delivery.idempotencyKey,
    handoverView(s).idempotencyKey);
  assert.equal(reduceHandover(start(), { type: 'recover' }).events.length, 0);
});

test('host delivery followed by process loss does not resend on recovery', async () => {
  const fixture = createFakeHandoverHost();
  const prepared = request(), receipt = await fixture.port.deliver(prepared.delivery);
  const recovered = reduceHandover(prepared.state, { type: 'recover' }).state;
  const retried = reduceHandover(recovered, { type: 'retry', revision: 'r1' });
  const repeated = await fixture.port.deliver(retried.delivery);
  assert.deepEqual(repeated, receipt);
  assert.equal(fixture.deliveryCount(), 1);
  const sent = result(retried.state, repeated.status, repeated);
  assert.equal(sent.state.status, 'sent');
});

test('keys distinguish sessions and revisions even with delimiter-like characters', () => {
  assert.notEqual(handoverKey('a:b', 'c'), handoverKey('a', 'b:c'));
  assert.notEqual(handoverKey('s1', 'r1'), handoverKey('s2', 'r1'));
  const revision = '__proto__';
  assert.equal(result(request(start(), revision).state, 'sent').state.status, 'sent');
});

test('handover validates host contract, identities, receipts and transition types', () => {
  assert.throws(() => assertHandoverPort({}));
  assert.throws(() => createHandover({ sessionId: '' }));
  assert.throws(() => handoverKey('s', 1));
  assert.throws(() => request(start(), ''));
  assert.throws(() => reduceHandover(start(), { type: 'unknown' }));
  assert.throws(() => result(request().state, 'queued'));
  assert.throws(() => result(request().state, 'sent', { receiptId: '' }));
  assert.equal(reduceHandover(start(), { type: 'retry', revision: 'r1' }).delivery, null);
});

test('fake host passes the full delivery, retry and concurrent idempotency kit', async () => {
  const fixture = createFakeHandoverHost();
  assert.deepEqual(await handoverConformance(fixture.port, fixture), { ok: true, failures: [] });
});

test('fake host returns isolated receipts and rejects a conflicting key before delivery', async () => {
  const fixture = createFakeHandoverHost(), prepared = request();
  const receipt = await fixture.port.deliver(prepared.delivery);
  receipt.receiptId = 'caller mutation';
  assert.notEqual((await fixture.port.deliver(prepared.delivery)).receiptId, receipt.receiptId);
  await assert.rejects(fixture.port.deliver({ ...prepared.delivery, revision: 'wrong' }));
  assert.equal(fixture.deliveryCount(), 1);
});

test('handover kit rejects a host that returns invalid receipts', async () => {
  const fixture = createFakeHandoverHost();
  const port = { deliver: async request => { await fixture.port.deliver(request); return { status: 'sent', receiptId: '' }; } };
  const result = await handoverConformance(port, fixture);
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes('confirmed delivery receipt'));
});

test('handover kit rejects delivery without deduplication', async () => {
  let count = 0, fail = false;
  const fixture = { failNext: () => { fail = true; }, deliveryCount: () => count,
    port: { async deliver() { count += 1; if (fail) { fail = false; throw new Error('fail'); }
      return { status: 'sent', receiptId: `receipt-${count}` }; } } };
  const result = await handoverConformance(fixture.port, fixture);
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes('one delivery per revision'));
  assert.ok(result.failures.includes('conflicting key accepted'));
});

test('handover kit rejects false success on an injected delivery failure', async () => {
  const fixture = createFakeHandoverHost();
  const result = await handoverConformance(fixture.port, { ...fixture, failNext: () => {} });
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes('failed delivery claimed sent'));
});

test('handover kit catches concurrent first-delivery races', async () => {
  const fixture = createFakeHandoverHost();
  let extra = 0;
  const port = { async deliver(request) {
    if (request.revision === 'r3') { await Promise.resolve(); extra += 1; return { status: 'sent', receiptId: `race-${extra}` }; }
    return fixture.port.deliver(request);
  } };
  const result = await handoverConformance(port, { ...fixture, deliveryCount: () => fixture.deliveryCount() + extra });
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes('concurrent delivery deduplication'));
});

test('handover kit fails closed for missing controls and bounds hanging delivery', async () => {
  assert.equal((await handoverConformance({})).ok, false);
  const fixture = createFakeHandoverHost();
  assert.equal((await handoverConformance(fixture.port)).ok, false);
  const result = await handoverConformance({ deliver: () => new Promise(() => {}) }, { ...fixture, timeoutMs: 10 });
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes('delivery failed'));
});
