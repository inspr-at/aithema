import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateQualification, createQualificationBudget, runOfflineQualification } from '../src/qualification.js';

const sample = (overrides = {}) => ({ reference: 'Grüß Gott Müller GmbH 42', hypothesis: 'Grüß Gott Müller GmbH 42',
  entities: [{ expected: 'Müller GmbH', actual: 'Müller GmbH' }, { expected: '42', actual: '42' }],
  speechEndAt: 100, firstAudioAt: 1000, bargeInAt: 1200, stoppedAt: 1400, ...overrides });

test('AIT-160: qualification fixes thresholds and keeps blind listening pending offline', () => {
  const result = evaluateQualification([sample(), sample({ firstAudioAt: 1500 })]);
  assert.equal(result.wer, 0); assert.equal(result.entityAccuracy, 1);
  assert.equal(result.firstAudioMs.p50, 900); assert.equal(result.firstAudioMs.p95, 1400);
  assert.equal(result.bargeInStopMs, 200); assert.equal(result.automatedPass, true);
  assert.equal(result.qualified, false); assert.equal(result.blindPreference, 'pending');
  assert.equal(evaluateQualification([sample({ stoppedAt: 1501 })]).automatedPass, false);
  assert.equal(evaluateQualification([sample({ hypothesis: 'Grüß Gott Meier' })]).automatedPass, false);
  assert.equal(evaluateQualification([sample({ firstAudioAt: 1601 })]).automatedPass, false);
  assert.throws(() => evaluateQualification([]));
  assert.throws(() => evaluateQualification([sample({ firstAudioAt: null })]));
});

test('AIT-160: one total $25 reservation cap includes baseline, retries and uncertain dispatch', () => {
  const budget = createQualificationBudget();
  const a = budget.reserve({ attemptId: 'voxtral', maxMicro: 20_000_000 }); a.consume();
  const b = budget.reserve({ attemptId: 'baseline', maxMicro: 5_000_000 }); b.consume();
  assert.throws(() => budget.reserve({ attemptId: 'retry', maxMicro: 1 }), { code: 'not-admitted' });
  a.report({ attemptId: 'voxtral', outcome: 'uncertain' });
  b.report({ attemptId: 'baseline', outcome: 'completed', chargedMicro: 4_000_000 });
  assert.equal(budget.snapshot().exposureMicro, 24_000_000);
  assert.throws(() => a.report({ attemptId: 'voxtral', outcome: 'completed', chargedMicro: 0 }), { code: 'already-claimed' });
  assert.throws(() => budget.reserve({ attemptId: 'voxtral', maxMicro: 1 }), { code: 'already-claimed' });
  assert.throws(() => createQualificationBudget({ capMicro: 25_000_001 }));
});

test('AIT-160: offline corpus runs both candidate and baseline without provider transports', async () => {
  const result = await runOfflineQualification();
  assert.equal(result.mode, 'offline'); assert.equal(result.spendMicro, 0);
  assert.equal(result.candidate.automatedPass, true); assert.equal(result.baseline.automatedPass, true);
  assert.equal(result.candidate.qualified, false); assert.ok(result.samples >= 6);
  assert.equal(result.evidence, 'synthetic-coordinator-only');
});

test('AIT-160: restored uncertain exposure and over-ceiling charges cannot reopen the hard cap', () => {
  const budget = createQualificationBudget(), attempt = budget.reserve({ attemptId: 'overrun', maxMicro: 1 }); attempt.consume();
  assert.throws(() => attempt.report({ attemptId: 'overrun', outcome: 'completed', chargedMicro: 2 }), { code: 'limit' });
  const restored = createQualificationBudget(budget.snapshot());
  assert.throws(() => restored.reserve({ attemptId: 'new', maxMicro: 0 }), { code: 'not-admitted' });
  assert.throws(() => createQualificationBudget({ records: [{ attemptId: 'bad', maxMicro: 100, exposureMicro: 0, state: 'dispatched' }] }));
});

test('AIT-160: WER counts weighted insertions/deletions and ignores punctuation without losing umlauts', () => {
  const result = evaluateQualification([sample({ reference: 'Grüß Gott!', hypothesis: 'grüß gott' }),
    sample({ reference: 'Müller GmbH', hypothesis: 'Mueller große GmbH' })]);
  assert.equal(result.wer, 0.5);
});

test('AIT-160: estimated vendor usage keeps its entire reservation inside the hard spend cap', () => {
  for (const field of ['estimated', 'costEstimated']) {
    const budget = createQualificationBudget(), attempt = budget.reserve({ attemptId: 'estimated-stt', maxMicro: 25_000_000 });
    attempt.consume(); attempt.report({ attemptId: 'estimated-stt', outcome: 'completed', chargedMicro: 100,
      usage: { upstreamMicro: 100, [field]: true } });
    assert.equal(budget.snapshot().exposureMicro, 25_000_000);
    assert.throws(() => budget.reserve({ attemptId: 'next', maxMicro: 1 }), { code: 'not-admitted' });
  }
});

test('AIT-160 round 2: offline qualification admits every TTS fragment with a unique claim', async () => {
  const result = await runOfflineQualification({ replyText: 'Welche Firma? Bitte nennen Sie den Namen.' });
  // Each candidate and baseline sample needs one STT and two TTS claims.
  assert.equal(result.componentAttempts, result.samples * 2 * 3);
  assert.equal(result.candidate.automatedPass, true);
  assert.equal(result.baseline.automatedPass, true);
  assert.equal(result.spendMicro, 0);
});
