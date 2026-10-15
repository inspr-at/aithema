import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PRELIVE_CHECKS, createQualificationMediaProbe, runLiveQualification } from '../src/live-qualification.js';
import { initializeQualificationBudget } from '../src/persisted-budget.js';

const events = [ { kind: 'capture', voiced: true, captureAt: 100, durationMs: 40 },
  { kind: 'playback-start', firstAudioAt: 900, outputTimestamp: { contextTime: 0.9, performanceTime: 900 } },
  { kind: 'capture', voiced: true, captureAt: 1000, durationMs: 40 }, { kind: 'playback-stop', stoppedAt: 1100 } ];
const plan = () => ({ runId: 'fixture-run', corpus: [{ reference: 'Müller GmbH', expected: 'Müller GmbH' }],
  checks: Object.fromEntries(PRELIVE_CHECKS.map(key => [key, { verified: true, reference: 'offline-test-attestation', ...(key === 'ttsFinalFlag' ? { spelling: 'is_final' } : {}) }])),
  ceilingChecks: [{ provider: 'fixture', accountRef: 'fixture-account', endpoint: 'https://fixture.invalid/stream', model: 'fixture', operation: 'stream', maxMicro: 100, request: { seconds: 1 } }] });

test('OPS entry point refuses missing operator flag, persisted budget, checklist and pricing before dispatch', async () => {
  let calls = 0;
  const host = { runSample() { calls++; assert.fail(); }, verifyCeiling: async () => null, verifyReceipt() {}, reconcile() {} };
  await assert.rejects(runLiveQualification({ plan: plan(), host }), /operator-approved/);
  await assert.rejects(runLiveQualification({ operatorApproved: true, plan: { ...plan(), checks: {} }, host, outputDirectory: 'unused' }), /checklist/);
  await assert.rejects(runLiveQualification({ operatorApproved: true, plan: plan(), host, outputDirectory: 'unused' }), /path required/);
  assert.equal(calls, 0);
});

test('physical media probe rejects schedules without observed device playback and preserves real clock evidence', () => {
  const probe = createQualificationMediaProbe();
  probe.onTiming({ kind: 'playback-scheduled', scheduledAt: 900 });
  assert.throws(() => probe.evidence(), /Real capture/);
  for (const event of events) probe.onTiming(event);
  assert.equal(probe.evidence().speechEndAt, 140); assert.equal(probe.evidence().bargeInAt, 1000);
});

test('OPS harness produces blind PCM pairs and metrics with pending preference; ledger blocks repeated run', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ops-qualification-')), budgetPath = join(directory, 'budget.sqlite'), outputDirectory = join(directory, 'evidence');
  t.after(() => rm(directory, { recursive: true, force: true })); initializeQualificationBudget({ path: budgetPath });
  const host = {
    verifyCeiling: async attempt => ({ ...attempt, verified: true, reference: 'offline-fixture-price', expiresAt: Date.now() + 60_000 }),
    verifyReceipt: async () => true,
    async runSample({ lane, admit, onTiming }) {
      for (const role of ['stt', 'tts', 'reasoning']) {
        const attemptId = `${lane}-${role}`, admission = await admit({ attemptId, provider: 'fixture', accountRef: 'fixture-account', endpoint: 'https://fixture.invalid/stream', model: 'fixture', operation: 'stream',
          role, maxMicro: 100, request: { fixture: true } });
        await admission.dispatch(async () => admission.report({ attemptId, outcome: 'completed', chargedMicro: 1 }));
      }
      events.forEach(onTiming);
      return { hypothesis: 'Müller GmbH', entities: [{ expected: 'Müller GmbH', actual: 'Müller GmbH' }],
        ttsPCM: new Uint8Array([1, 2]), ttsFormat: { encoding: 'pcm_s16le', sampleRateHz: 24000, channels: 1 } };
    },
    async reconcile({ snapshot, reconcile }) {
      for (const row of snapshot.records.filter(row => !row.receipt)) await reconcile({ attemptId: row.attemptId,
        receiptId: row.attemptId, provider: row.provider, model: row.model, operation: row.operation, accountRef: row.accountRef, endpoint: row.endpoint, chargedMicro: 1, estimated: false });
    },
  };
  const options = { operatorApproved: true, plan: plan(), host, budgetPath, outputDirectory };
  const report = await runLiveQualification(options);
  assert.equal(report.candidate.wer, 0); assert.equal(report.candidate.firstAudioMs.p95, 760);
  assert.equal(report.candidate.bargeInStopMs, 100); assert.equal(report.candidate.qualified, false);
  assert.equal(report.budget.exposureMicro, 6); assert.equal(report.budget.records.length, 6);
  const blind = JSON.parse(await readFile(join(outputDirectory, 'blind.json')));
  assert.deepEqual(blind.map(row => row.label), ['A', 'B']); assert.ok(blind.every(row => !Object.hasOwn(row, 'lane')));
  assert.equal((await readFile(join(outputDirectory, blind[0].file))).subarray(0, 4).toString(), 'RIFF');
  assert.equal(JSON.parse(await readFile(join(outputDirectory, 'ops-answer-key.json'))).length, 2);
  await assert.rejects(runLiveQualification(options), /Run already claimed/);
});

test('unverified pricing and unresolved final-flag spelling prevent all sample/provider work', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ops-refusal-')), budgetPath = join(directory, 'budget.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true })); initializeQualificationBudget({ path: budgetPath });
  let calls = 0;
  const host = { runSample() { calls++; }, verifyCeiling: async () => null, verifyReceipt: async () => false, reconcile() { calls++; } };
  await assert.rejects(runLiveQualification({ operatorApproved: true, budgetPath, plan: plan(), host, outputDirectory: directory }), /Verified provider attempt ceiling/);
  const unresolved = plan(); unresolved.checks.ttsFinalFlag.spelling = 'isFinal';
  await assert.rejects(runLiveQualification({ operatorApproved: true, budgetPath, plan: unresolved, host, outputDirectory: directory }), /Adapter expects is_final/);
  assert.equal(calls, 0);
});
