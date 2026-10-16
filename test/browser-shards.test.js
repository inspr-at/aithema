import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { assertBrowserShardCoverage, browserShardCount, browserShards, browserTestWeights, browserShardTotals, packBrowserTests, discoverBrowserTests, selectBrowserTests } from '../scripts/browser-shards.js';

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
