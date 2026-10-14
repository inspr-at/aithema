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
});
