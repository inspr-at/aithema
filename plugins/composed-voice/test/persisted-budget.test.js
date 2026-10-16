import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeQualificationBudget, openPersistedQualificationBudget } from '../src/persisted-budget.js';

const specification = (attemptId, maxMicro = 10_000_000, more = {}) => ({ attemptId, maxMicro, lane: 'candidate',
  provider: 'fixture', accountRef: 'fixture-account', endpoint: 'https://fixture.invalid/stream', model: 'fixture-1', operation: 'stream', role: 'stt', request: { seconds: 30 }, ...more });
const verifyCeiling = async attempt => ({ ...attempt, verified: true, reference: 'offline-account-price-attestation', expiresAt: Date.now() + 60_000 });
const ports = { verifyCeiling, verifyReceipt: async receipt => receipt.serverAuthenticated === true };
const receipt = (attemptId, chargedMicro, more = {}) => ({ attemptId, chargedMicro, provider: 'fixture', accountRef: 'fixture-account', endpoint: 'https://fixture.invalid/stream', model: 'fixture-1',
  operation: 'stream', estimated: false, serverAuthenticated: true, receiptId: `receipt-${attemptId}`, ...more });
async function fixture(t, capMicro = 25_000_000) {
  const directory = await mkdtemp(join(tmpdir(), 'qualification-budget-')), path = join(directory, 'budget.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true }));
  initializeQualificationBudget({ path, capMicro });
  return { path, open: (overrides = {}) => openPersistedQualificationBudget({ path, ...ports, ...overrides }) };
}

test('durable budget commits a shared reservation and dispatch before provider code; restores after restart', async t => {
  const h = await fixture(t), a = h.open(), observer = h.open(); t.after(() => observer.close());
  const claim = await a.admit(specification('candidate'));
  assert.equal(observer.snapshot().exposureMicro, 10_000_000);
  await claim.dispatch(async () => {
    assert.equal(observer.snapshot().records[0].state, 'dispatched');
    claim.report({ attemptId: 'candidate', outcome: 'completed', chargedMicro: 1, usage: { estimated: true } });
  });
  a.close(); const restored = h.open(); t.after(() => restored.close());
  assert.equal(restored.snapshot().exposureMicro, 10_000_000);
  await assert.rejects(restored.admit(specification('candidate')), { code: 'already-claimed' });
  const baseline = await restored.admit(specification('baseline', 15_000_000, { lane: 'baseline', role: 'reasoning' }));
  await baseline.attempt.consume(); baseline.report({ attemptId: 'baseline', outcome: 'uncertain' });
  await assert.rejects(restored.admit(specification('retry', 1, { retryOf: 'candidate', role: 'tts' })), { code: 'not-admitted' });
  assert.equal(observer.snapshot().exposureMicro, 25_000_000);
});

test('every dispatch verifies its exact ceiling again, including expiry and request identity', async t => {
  const h = await fixture(t); let valid = true, calls = 0;
  const budget = h.open({ verifyCeiling: async attempt => { calls++; assert.equal(attempt.request.seconds, 30); return valid ? verifyCeiling(attempt) : { ...await verifyCeiling(attempt), expiresAt: 0 }; } });
  t.after(() => budget.close());
  const claim = await budget.admit(specification('a')); valid = false;
  await assert.rejects(claim.dispatch(() => assert.fail('must not dispatch')), { code: 'not-admitted' });
  assert.equal(calls, 2); assert.equal(budget.snapshot().records[0].state, 'reserved');
  const wrong = h.open({ verifyCeiling: async attempt => ({ ...await verifyCeiling(attempt), model: 'different' }) }); t.after(() => wrong.close());
  await assert.rejects(wrong.admit(specification('b')), { code: 'not-admitted' });
});

test('authenticated receipts reconcile all lanes/components/retries without another terminal', async t => {
  const h = await fixture(t), budget = h.open(); t.after(() => budget.close());
  for (const [index, role] of ['stt', 'tts', 'reasoning'].entries()) {
    const attemptId = `a-${role}`, lane = index ? 'baseline' : 'candidate';
    const claim = await budget.admit(specification(attemptId, 2_000_000, { role, lane, ...(index ? { retryOf: 'a-stt' } : {}) }));
    await claim.attempt.consume(); claim.report({ attemptId, outcome: 'uncertain' });
    await assert.rejects(budget.reconcile(receipt(attemptId, 1, { serverAuthenticated: false })), { code: 'not-admitted' });
    await assert.rejects(budget.reconcile(receipt(attemptId, 1, { model: 'wrong' })), { code: 'not-admitted' });
    await budget.reconcile(receipt(attemptId, 100)); await budget.reconcile(receipt(attemptId, 100));
    await assert.rejects(budget.reconcile(receipt(attemptId, 101)), { code: 'already-claimed' });
    assert.throws(() => claim.report({ attemptId, outcome: 'completed', chargedMicro: 0 }), { code: 'already-claimed' });
  }
  assert.equal(budget.snapshot().exposureMicro, 300);
  const restarted = h.open(); t.after(() => restarted.close()); assert.equal(restarted.snapshot().exposureMicro, 300);
});

test('overrun is committed and permanently blocks dispatch after restart and lower reconciliation', async t => {
  const h = await fixture(t), budget = h.open();
  const a = await budget.admit(specification('overrun', 1)), b = await budget.admit(specification('waiting', 1));
  await a.attempt.consume();
  assert.throws(() => a.report({ attemptId: 'overrun', outcome: 'completed', chargedMicro: 2 }), { code: 'limit' });
  await assert.rejects(b.attempt.consume(), { code: 'not-admitted' });
  await budget.reconcile(receipt('overrun', 0)); assert.equal(budget.snapshot().blocked, true);
  budget.close(); const restarted = h.open(); t.after(() => restarted.close());
  await assert.rejects(restarted.admit(specification('new', 0)), { code: 'not-admitted' });
});

test('concurrent writers cannot overbook; interrupted dispatch retains maximum and run identity forbids rerun', async t => {
  const h = await fixture(t), a = h.open(), b = h.open(); t.after(() => { a.close(); b.close(); });
  const outcomes = await Promise.allSettled([a.admit(specification('a', 20_000_000)), b.admit(specification('b', 20_000_000))]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  const admitted = outcomes.find(x => x.status === 'fulfilled').value;
  await assert.rejects(admitted.dispatch(async () => { throw new Error('transport lost'); }), /transport lost/);
  assert.equal(b.snapshot().records[0].outcome, 'uncertain'); assert.equal(b.snapshot().exposureMicro, 20_000_000);
  a.claimRun('operator-run-1'); assert.throws(() => b.claimRun('operator-run-1'), { code: 'not-admitted' });
  assert.throws(() => initializeQualificationBudget({ path: h.path }));
  assert.throws(() => openPersistedQualificationBudget({ path: ':memory:', ...ports }));
});

test('process death keeps full exposure until explicit uncertain orphan settlement, then receipt reconciliation', async t => {
  const { spawnSync } = await import('node:child_process');
  const h = await fixture(t);
  const code = `
    const { openPersistedQualificationBudget } = await import(${JSON.stringify(new URL('../src/persisted-budget.js', import.meta.url).href)});
    const budget = openPersistedQualificationBudget({ path: process.argv[1],
      verifyCeiling: async a => ({ ...a, verified: true, reference: 'offline-crash-proof', expiresAt: Date.now() + 60000 }), verifyReceipt: async () => true });
    const claim = await budget.admit(${JSON.stringify(specification('killed-provider', 25_000_000))});
    await claim.attempt.consume();
    process.kill(process.pid, 'SIGKILL');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, h.path], { env: { PATH: process.env.PATH }, timeout: 15_000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr.toString());
  const restored = h.open(); t.after(() => restored.close());
  assert.equal(restored.snapshot().records[0].state, 'dispatched'); assert.equal(restored.snapshot().exposureMicro, 25_000_000);
  await assert.rejects(restored.admit(specification('after-crash', 1)), { code: 'not-admitted' });
  await assert.rejects(restored.reconcile(receipt('killed-provider', 5)), { code: 'not-admitted' });
  restored.settleOrphan('killed-provider');
  assert.equal(restored.snapshot().records[0].state, 'settled');
  assert.equal(restored.snapshot().records[0].outcome, 'uncertain');
  assert.equal(restored.snapshot().exposureMicro, 25_000_000);
  await assert.rejects(restored.admit(specification('after-settlement', 1)), { code: 'not-admitted' });
  await restored.reconcile(receipt('killed-provider', 5));
  assert.equal(restored.snapshot().exposureMicro, 5);
  const restarted = h.open(); t.after(() => restarted.close()); assert.equal(restarted.snapshot().exposureMicro, 5);
});

test('concurrent in-flight receipts cannot release reservations or overbook the $25 cap', async t => {
  const h = await fixture(t), a = h.open(), b = h.open(); t.after(() => { a.close(); b.close(); });
  const claims = await Promise.all([a.admit(specification('a', 15_000_000)), b.admit(specification('b', 10_000_000))]);
  await Promise.all(claims.map(claim => claim.attempt.consume()));
  assert.throws(() => a.settleOrphan('a'), { code: 'not-admitted' });
  const assertInvariant = () => {
    const snapshot = b.snapshot();
    const committedAndReserved = snapshot.records.reduce((sum, row) => sum +
      (row.state === 'settled' ? row.exposureMicro : row.maxMicro), 0);
    assert.equal(snapshot.exposureMicro, committedAndReserved);
    assert.ok(committedAndReserved <= 25_000_000);
  };
  const results = await Promise.allSettled([
    a.reconcile(receipt('a', 0)), b.reconcile(receipt('b', 0)),
    a.admit(specification('extra-a', 1)), b.admit(specification('extra-b', 1)),
  ]);
  for (const result of results) { assert.equal(result.status, 'rejected'); assert.equal(result.reason.code, 'not-admitted'); }
  assertInvariant(); assert.equal(b.snapshot().exposureMicro, 25_000_000);
  claims[0].report({ attemptId: 'a', outcome: 'uncertain' });
  assertInvariant(); assert.equal(b.snapshot().exposureMicro, 25_000_000);
  await a.reconcile(receipt('a', 5_000_000)); assertInvariant();
  const admissions = await Promise.allSettled([
    a.admit(specification('replacement-a', 10_000_000)), b.admit(specification('replacement-b', 10_000_000)),
    b.reconcile(receipt('b', 0)),
  ]);
  assert.equal(admissions.filter(result => result.status === 'fulfilled').length, 1);
  assertInvariant(); assert.equal(b.snapshot().exposureMicro, 25_000_000);
  claims[1].report({ attemptId: 'b', outcome: 'uncertain' }); assertInvariant();
});
