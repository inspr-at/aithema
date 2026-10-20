import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { plannedSeconds } from '../scripts/browser-timings.js';
import { readBrowserTestWeights, assertBrowserShardHeadroom, assertBrowserShardBudget, assertBrowserShardCoverage, browserShardCount, browserShards, browserTestWeights, browserShardTotals, packBrowserTests, discoverBrowserTests, selectBrowserTests } from '../scripts/browser-shards.js';

const measuredWeight = (seconds = 90) => {
  const samples = [{ runId: '123', attempt: 1, sha: 'b'.repeat(40), observedAt: '2026-10-16T12:00:00Z',
    tests: [{ name: 'fixture', seconds }] }];
  return { seconds: plannedSeconds(samples), evidence: 'CI artifact measurement',
    timing: { schema: 1, window: 20, workload: 'a'.repeat(64), samples } };
};

test('CI shards cover every browser test file exactly once; local command runs the same full set', () => {
  assertBrowserShardCoverage();
  const files = discoverBrowserTests();
  const ciFiles = browserShards.flatMap((_, index) => selectBrowserTests(['--shard', `${index + 1}/${browserShards.length}`]).files);
  assert.deepEqual(ciFiles.sort(), files);
  assert.deepEqual(selectBrowserTests().files, files);
  assert.deepEqual(selectBrowserTests([`--shard=1/${browserShards.length}`, '--test-name-pattern=AIT-131']), {
    files: browserShards[0], nodeArgs: ['--test-name-pattern=AIT-131'],
  });
});

test('the actual CI matrix runs every manifest shard exactly once', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const indices = JSON.parse(/shard: (\[[^\n]+\])/u.exec(workflow)[1]);
  const ciShards = indices.map(index => selectBrowserTests(['--shard', `${index}/${browserShards.length}`]).files);
  assertBrowserShardCoverage(discoverBrowserTests(), ciShards);
});

test('coverage guard rejects a newly added test missing from all shards', () => {
  assert.throws(() => assertBrowserShardCoverage(['a.test.js', 'new.test.js'], [['a.test.js']]), /Unassigned browser test: new\.test\.js/u);
});

test('coverage guard rejects duplicate assignments across shards and within one shard', () => {
  for (const shards of [[['a.test.js'], ['a.test.js']], [['a.test.js', 'a.test.js']]]) {
    assert.throws(() => assertBrowserShardCoverage(['a.test.js'], shards), /assigned 2 times: a\.test\.js/u);
  }
});

test('coverage guard rejects removed files and empty shards', () => {
  assert.throws(() => assertBrowserShardCoverage(['a.test.js'], [['a.test.js', 'removed.test.js']]), /Unknown browser test: removed\.test\.js/u);
  assert.throws(() => assertBrowserShardCoverage(['a.test.js'], [['a.test.js'], []]), /Empty browser shard/u);
  assert.throws(() => assertBrowserShardCoverage([], []), /Empty browser shard/u);
});

test('invalid shard selectors fail instead of silently dropping coverage', () => {
  const total = browserShards.length;
  for (const args of [['--shard'], ['--shard', `0/${total}`], ['--shard', `${total + 1}/${total}`], ['--shard', '1/3'], ['--shard', 'bad'], ['--shard', `1/${total}`, '--shard', `2/${total}`]]) {
    assert.throws(() => selectBrowserTests(args), new RegExp(`Use --shard N/${total}`, 'u'));
  }
});

test('LPT packing is complete and independent of file and weight insertion order', () => {
  const files = discoverBrowserTests();
  const reversedWeights = Object.fromEntries(Object.entries(browserTestWeights).reverse());
  const packed = packBrowserTests([...files].reverse(), reversedWeights);
  assert.deepEqual(packed, { shards: browserShards, totals: browserShardTotals });
  assert.equal(packed.shards.length, browserShardCount);
  assert.ok(Math.max(...packed.totals) <= 420, `Planned browser shard exceeds 7 min: ${packed.totals}`);
  assert.deepEqual(packed.shards.flat().sort(), files);
  assert.equal(new Set(packed.shards.flat()).size, files.length);
  const total = Object.values(browserTestWeights).reduce((sum, weight) => sum + weight, 0);
  const largest = Math.max(...Object.values(browserTestWeights));
  // List scheduling bound: average load + (1 - 1/m) times the largest job.
  assert.ok(Math.max(...packed.totals) <= total / browserShardCount + (1 - 1 / browserShardCount) * largest);
});

test('LPT breaks equal-weight ties by path and equal-load ties by shard index', () => {
  assert.deepEqual(packBrowserTests(['d', 'c', 'b', 'a'], { d: 10, b: 10, c: 10, a: 10 }, 2), {
    shards: [['a', 'c'], ['b', 'd']], totals: [20, 20],
  });
});

test('LPT makespan stays within (4/3 - 1/(3m)) of the optimal schedule', () => {
  // Exact optimum by exhaustive assignment for small varied fixtures, including
  // the tight 4-machine LPT example (LPT 15, optimum 12).
  for (const durations of [[7, 7, 6, 6, 5, 5, 4, 4, 4], [9, 3, 2, 2, 1], [8, 8, 8, 8], [2, 2, 2, 2, 2]]) {
    const weights = Object.fromEntries(durations.map((duration, index) => [`file-${index}`, duration]));
    let optimum = Infinity;
    const loads = [0, 0, 0, 0];
    function search(index) {
      if (index === durations.length) {
        optimum = Math.min(optimum, Math.max(...loads));
        return;
      }
      for (let shard = 0; shard < loads.length; shard++) {
        loads[shard] += durations[index];
        if (loads[shard] < optimum) search(index + 1);
        loads[shard] -= durations[index];
        if (loads[shard] === 0) break;
      }
    }
    search(0);
    const packed = packBrowserTests(Object.keys(weights), weights, 4);
    assert.ok(Math.max(...packed.totals) <= (4 / 3 - 1 / 12) * optimum + 1e-9);
  }
});

test('unmeasured files get conservative packing but fail the coverage guard', () => {
  const weights = { measured: 300 };
  const packed = packBrowserTests(['new', 'measured'], weights, 2);
  assert.deepEqual(packed, { shards: [['measured'], ['new']], totals: [300, 300] });
  assert.throws(() => assertBrowserShardCoverage(['new', 'measured'], packed.shards, weights), /Missing browser test weight: new/u);
  assert.deepEqual(packBrowserTests(['new'], {}, 1).totals, [225]);
});

test('invalid weights and shard counts fail before packing', () => {
  for (const weight of [0, -1, NaN, Infinity]) {
    assert.throws(() => packBrowserTests(['file'], { file: weight }), /positive finite/u);
  }
  for (const count of [0, -1, 1.5]) {
    assert.throws(() => packBrowserTests([], {}, count), /Invalid browser shard count/u);
  }
});


test('the shard guard command prints projected totals for every shard', () => {
  const result = spawnSync(process.execPath, ['scripts/browser-shards.js'], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  browserShardTotals.forEach((total, index) => {
    assert.ok(result.stdout.includes(`Browser shard ${index + 1}/${browserShardCount}: projected file work ${total.toFixed(3)}s`));
  });
  assert.ok(result.stdout.includes(`${discoverBrowserTests().length} files, exactly once across ${browserShardCount} shards.`));
});

test('LPT fixture packing is complete and independent of file and weight insertion order', () => {
  const weights = { a: 200, b: 130, c: 110, d: 90, e: 80, f: 60, g: 30, h: 20 };
  const files = Object.keys(weights);
  const reversedWeights = Object.fromEntries(Object.entries(weights).reverse());
  const packed = packBrowserTests([...files].reverse(), reversedWeights, 4);
  assert.deepEqual(packed, packBrowserTests(files, weights, 4));
  assert.equal(packed.shards.length, 4);
  assert.deepEqual(packed.shards.flat().sort(), [...files].sort());
  assert.equal(new Set(packed.shards.flat()).size, files.length);
  const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  const largest = Math.max(...Object.values(weights));
  // List scheduling bound: average load + (1 - 1/m) times the largest job.
  assert.ok(Math.max(...packed.totals) <= total / 4 + 3 * largest / 4);
});

test('per-file weights reject stale measurements after a test is removed or renamed', t => {
  const root = mkdtempSync(join(tmpdir(), 'browser-weights-stale-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'test/browser'), { recursive: true });
  const measurement = JSON.stringify(measuredWeight());
  writeFileSync(join(root, 'test/browser/old.weight.json'), measurement);
  assert.throws(() => readBrowserTestWeights([], root), /Stale browser test weight: test\/browser\/old\.weight\.json; no matching test: test\/browser\/old\.test\.js/u);
  writeFileSync(join(root, 'test/browser/new.weight.json'), measurement);
  assert.throws(() => readBrowserTestWeights(['test/browser/new.test.js'], root), /Stale browser test weight: test\/browser\/old\.weight\.json/u);
});

test('per-file weights require readable JSON, positive seconds and measurement evidence', t => {
  const root = mkdtempSync(join(tmpdir(), 'browser-weights-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'test/browser'), { recursive: true });
  const files = ['test/browser/new.test.js'];
  const path = join(root, 'test/browser/new.weight.json');
  assert.throws(() => readBrowserTestWeights(files, root), /Missing or unreadable.*new\.weight\.json/u);
  writeFileSync(path, '{broken');
  assert.throws(() => readBrowserTestWeights(files, root), /Missing or unreadable/u);
  for (const measurement of [null, {}, { seconds: 0, evidence: 'CI run' }, { seconds: -1, evidence: 'CI run' }, { seconds: '90', evidence: 'CI run' }, { seconds: 90 }, { seconds: 90, evidence: ' ' }]) {
    writeFileSync(path, JSON.stringify(measurement));
    assert.throws(() => readBrowserTestWeights(files, root), /Invalid browser test weight/u);
  }
  writeFileSync(path, JSON.stringify(measuredWeight()));
  assert.deepEqual(readBrowserTestWeights(files, root), { 'test/browser/new.test.js': 112.5 });
});

test('the command and browser selection enforce the unchanged 420s measured budget', () => {
  assert.doesNotThrow(() => assertBrowserShardBudget([419.999, 420]));
  for (const totals of [[420.001], [NaN], [Infinity], [-1]]) assert.throws(() => assertBrowserShardBudget(totals), /exceeds 420s/u);
});

test('weights cannot replace observations with an estimate or a manually lowered percentile', t => {
  const root = mkdtempSync(join(tmpdir(), 'browser-p95-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'test/browser'), { recursive: true });
  const file = 'test/browser/new.test.js', path = join(root, 'test/browser/new.weight.json');
  for (const measurement of [{ seconds: 90, evidence: 'estimate' }, { ...measuredWeight(), seconds: 89 }]) {
    writeFileSync(path, JSON.stringify(measurement));
    assert.throws(() => readBrowserTestWeights([file], root), /Invalid browser test weight/u);
  }
});

test('current measured packing keeps every shard at or below the 405s headroom target', () => {
  assertBrowserShardHeadroom();
});

test('headroom guard accepts 405s and reports overloaded totals and files below the hard ceiling', () => {
  const weights = { 'a.test.js': 200, 'b.test.js': 205, 'c.test.js': 0.001 };
  assert.doesNotThrow(() => assertBrowserShardHeadroom({ shards: [['a.test.js', 'b.test.js']], totals: [405] }, weights));
  const packing = { shards: [['a.test.js', 'b.test.js', 'c.test.js']], totals: [405.001] };
  assert.doesNotThrow(() => assertBrowserShardBudget(packing.totals));
  assert.throws(() => assertBrowserShardHeadroom(packing, weights), error => {
    assert.match(error.message, /target exceeded \(405s; hard ceiling remains 420s\)/u);
    assert.match(error.message, /Shard 1\/1: 405\.001s/u);
    for (const [file, seconds] of Object.entries(weights)) assert.ok(error.message.includes(`${file} (${seconds.toFixed(3)}s)`));
    assert.match(error.message, /do not lower weights without evidence/u);
    return true;
  });
});

test('whole-file refinement recovers headroom that greedy LPT leaves unused', () => {
  const weights = { a: 3, b: 3, c: 2, d: 2, e: 2 };
  // Greedy LPT gives 7 / 5; exchanging one 3s and one 2s file gives 6 / 6.
  const packed = packBrowserTests(Object.keys(weights), weights, 2);
  assert.deepEqual(packed.totals, [6, 6]);
  assert.deepEqual(packed.shards.flat().sort(), Object.keys(weights));
  assert.deepEqual(packBrowserTests(Object.keys(weights).reverse(), Object.fromEntries(Object.entries(weights).reverse()), 2), packed);
});
