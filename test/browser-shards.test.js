import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { assertBrowserShardCoverage, browserShards, discoverBrowserTests, selectBrowserTests } from '../scripts/browser-shards.js';

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
