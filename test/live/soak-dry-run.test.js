import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSoak } from './soak.js';

// Explicit remote invocation only; excluded from npm test and CI's eight shards.
test('AIT-139: five-minute fake voice soak, actual WAV capture, CDP disruption and zero spend', { timeout: 390_000 }, async t => {
  const { report, output } = await runSoak({ mode: 'fake', minutes: 5, maxDuration: 5,
    output: process.env.AITHEMA_EVIDENCE_DIR });
  t.diagnostic(`AIT-139 reports: ${output}; stop=${report.stopReason}; status=${report.status}`);
  assert.equal(report.stopReason, 'max-duration');
  assert.equal(report.status, 'passed');
  assert.ok(report.elapsedMs >= 300_000 && report.elapsedMs < 310_000);
  assert.ok(report.client.turns >= 10);
  assert.equal(report.client.firstResponse.reference, 'speech-end');
  assert.equal(report.client.firstResponse.samples, report.client.turns);
  assert.equal(report.client.deadlineMisses, 0);
  assert.equal(report.client.unmeasurableSpeechEnds, 0);
  assert.ok(report.client.turnTimings.every(turn => turn.speechEndMs > turn.atMs && turn.firstResponseMs >= 0));
  assert.equal(report.client.events.filter(event => event.type === 'speech-end').length, report.client.turns);
  assert.ok(report.client.bargeIns >= 1);
  assert.ok(report.client.speechSamples > 0);
  assert.ok(report.client.overlapSamples > 0);
  assert.ok(report.server.recoveries >= 1);
  assert.equal(report.offlineRequestFailed, true);
  assert.equal(report.cost.confirmedMicro, 0);
  assert.equal(report.cost.uncertainMicro, 0);
  assert.equal(report.cost.reservedMicro, 0);
  assert.equal(report.cost.reconciled, true);
});
