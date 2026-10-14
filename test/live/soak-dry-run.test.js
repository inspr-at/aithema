import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSoak } from './soak.js';

// Explicit remote invocation only; excluded from npm test and CI's four shards.
test('AIT-139: five-minute fake voice soak, actual WAV capture, CDP disruption and zero spend', { timeout: 390_000 }, async t => {
  const { report, output } = await runSoak({ mode: 'fake', minutes: 5, maxDuration: 5,
    output: process.env.AITHEMA_EVIDENCE_DIR });
  t.diagnostic(`AIT-139 reports: ${output}; stop=${report.stopReason}; status=${report.status}`);
  assert.equal(report.stopReason, 'max-duration');
  assert.equal(report.status, 'passed');
  assert.ok(report.elapsedMs >= 300_000 && report.elapsedMs < 310_000);
  assert.ok(report.client.turns >= 10);
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
