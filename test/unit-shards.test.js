import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverUnitTests, readUnitWeights, packUnitTests, assertUnitCoverage, assertUnitHeadroom } from '../scripts/unit-shards.js';
import * as results from '../scripts/check-unit-results.js';

const expected = { runId: '123', sha: 'a'.repeat(40), attempt: 2, shardAttempts: [2, 1] };
const plan = { shards: [['a'], ['b']] };
const summary = file => ({ type: 'test:summary', success: true, duration_ms: 1000,
  ...(file ? { file } : {}), counts: { tests: 1, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0 } });
const manifests = () => ['a', 'b'].map((file, index) => [
  { type: 'run', schema: 1, ...expected, attempt: expected.shardAttempts[index], shard: `${index + 1}/2`, files: [file] },
  summary(file), summary(),
]);

test('AIT-456: one unknown new unit file fits the plan without a main timing import', () => {
  const files = [...discoverUnitTests(), 'test/new-average-file.test.js'];
  const packing = packUnitTests(files, readUnitWeights());
  assertUnitCoverage(files, packing.shards);
  assert.doesNotThrow(() => assertUnitHeadroom(packing));
  assert.throws(() => assertUnitHeadroom(packUnitTests(['slow'], { slow: 421 }, 1)), /exceeds 420/u);
});

test('AIT-456: a partial rerun accepts each shard latest successful attempt and proves the count', () => {
  assert.equal(results.assertUnitResults(manifests(), plan, expected), 2);
  const stale = manifests(); stale[0][0].attempt = 1;
  assert.throws(() => results.assertUnitResults(stale, plan, expected), /provenance/u);
  const future = manifests(); future[1][0].attempt = 3;
  assert.throws(() => results.assertUnitResults(future, plan, expected), /provenance/u);
  const duplicate = manifests(); duplicate[0].push(summary('a'));
  assert.throws(() => results.assertUnitResults(duplicate, plan, expected), /exactly-once/u);
});

test('AIT-456: measured overruns and missing or invalid durations fail closed', () => {
  const current = { ...expected, attempt: 1, shardAttempts: [1, 1] };
  for (const duration of [395001, 0, -1, NaN, Infinity, undefined]) {
    const rows = manifests(); rows[0][0].attempt = 1; rows[0][2].duration_ms = duration;
    assert.throws(() => results.assertUnitResults(rows, plan, current), /duration|exceeds 420/u);
  }
  const boundary = manifests(); boundary[0][0].attempt = 1; boundary[0][2].duration_ms = 395000;
  assert.equal(results.assertUnitResults(boundary, plan, current), 2);
});
