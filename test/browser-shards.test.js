import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { plannedSeconds, assertMeasuredWeight, measuredSeconds, timingMinimumSamples } from '../scripts/browser-timings.js';
import { provisionalSplitFiles, readBrowserTestWeights, assertBrowserShardHeadroom, assertBrowserShardBudget, assertBrowserShardCoverage, browserShardCount, browserShards, browserTestWeights, browserShardTotals, packBrowserTests, discoverBrowserTests, selectBrowserTests } from '../scripts/browser-shards.js';

const measuredWeight = (seconds = 90) => {
  const samples = [{ runId: '123', attempt: 1, sha: 'b'.repeat(40), observedAt: '2026-10-16T12:00:00Z',
    tests: [{ name: 'fixture', seconds }] }];
  return { seconds: plannedSeconds(samples), evidence: 'CI artifact measurement',
    timing: { schema: 1, window: 20, workload: 'a'.repeat(64), samples } };
};

function retainPlan(name, packing) {
  if (!process.env.AITHEMA_EVIDENCE_DIR) return;
  mkdirSync(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true });
  writeFileSync(join(process.env.AITHEMA_EVIDENCE_DIR, `browser-shards-${name}.json`),
    JSON.stringify(packing, null, 2) + '\n');
}

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

test('AIT-624: nightly includes all sixteen browser shards exactly once', () => {
  const workflow = readFileSync(new URL('../.github/workflows/nightly.yml', import.meta.url), 'utf8');
  const indices = JSON.parse(/shard: (\[[^\n]+\])/u.exec(workflow)[1]);
  assert.deepEqual(indices, Array.from({ length: 16 }, (_, index) => index + 1));
  assertBrowserShardCoverage(discoverBrowserTests(), indices.map(index => selectBrowserTests(['--shard', `${index}/${browserShards.length}`]).files));
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

test('AIT-558: the shard guard test runs without npm on PATH', () => {
  const result = spawnSync(process.execPath, ['--test', '--test-name-pattern=^the shard guard command prints',
    'test/browser-shards.test.js'], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8',
    env: { PATH: '' },
  });
  assert.match(result.stdout, /the shard guard command prints/u, result.stdout + result.stderr);
  assert.equal(result.status, 0, result.stdout + result.stderr);
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

for (const name of ['email-unlock-reply', 'identity-unlock', 'clarify-now', 'clarify-now-status']) {
  test(`repository weights reject an unmeasured reservation for ${name}`, () => {
    // Patch only the child process's file reads: exercise repositoryRoot without
    // changing the real measurements or their trusted CI provenance.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const read = fs.readFileSync;
      fs.readFileSync = (path, ...args) => String(path).endsWith('/${name}.weight.json')
        ? JSON.stringify({ seconds: 45, evidence: 'unmeasured reservation', provisional: true })
        : read(path, ...args);
      syncBuiltinESMExports();
      await import('./scripts/browser-shards.js');
    `], { cwd: new URL('../', import.meta.url), encoding: 'utf8' });
    assert.equal(result.status, 1, `${name}: an unmeasured repository weight must fail`);
    assert.match(result.stderr, /Missing rolling p95 CI timing samples/u);
  });
}

test('AIT-558: both clarify halves use measured CI observations without provisional bypasses', () => {
  for (const name of ['clarify-now', 'clarify-now-status']) {
    const measurement = JSON.parse(readFileSync(new URL(`../test/browser/${name}.weight.json`, import.meta.url)));
    assertMeasuredWeight(measurement);
    assert.equal(measurement.provisional, undefined);
  }
});

for (const state of ['stale', 'warming']) {
  test(`AIT-558: ${state} clarify observations remain valid after a workload edit`, () => {
    const setup = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { plannedSeconds } from ${JSON.stringify(new URL('../scripts/browser-timings.js', import.meta.url).href)};
      const read = fs.readFileSync;
      fs.readFileSync = (path, ...args) => {
        const bytes = read(path, ...args);
        if (!['clarify-now', 'clarify-now-status'].some(name => String(path).endsWith('/' + name + '.weight.json'))) return bytes;
        const measurement = JSON.parse(bytes);
        measurement.timing.workload = 'f'.repeat(64);
        if (${state === 'warming'}) {
          measurement.timing.samples = measurement.timing.samples.slice(-1);
          measurement.seconds = plannedSeconds(measurement.timing.samples);
        }
        return JSON.stringify(measurement);
      };
      syncBuiltinESMExports();
    `;
    const result = spawnSync(process.execPath, ['--test', '--test-name-pattern=^AIT-558: both clarify halves',
      '--import', `data:text/javascript,${encodeURIComponent(setup)}`, 'test/browser-shards.test.js'], {
      cwd: new URL('../', import.meta.url), encoding: 'utf8', env: {},
    });
    assert.match(result.stdout, /AIT-558: both clarify halves/u, result.stdout + result.stderr);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}

test('current measured packing keeps every shard at or below the 405s headroom target', () => {
  assertBrowserShardHeadroom();
});

test('AIT-624: current measured workloads fit sixteen bins without changing either limit', t => {
  assert.equal(browserShardCount, 16);
  const files = discoverBrowserTests();
  const packing = packBrowserTests(files);
  retainPlan('current', packing);
  assert.equal(packing.shards.length, 16);
  assertBrowserShardCoverage(files, packing.shards);
  assertBrowserShardBudget(packing.totals);
  t.diagnostic(`Current sixteen-bin seconds: ${packing.totals.map(total => total.toFixed(3)).join(', ')}`);
  assertBrowserShardHeadroom(packing);
});

test('AIT-624: sixteen bins retain 405s headroom with AIT-506 and AIT-524 measured growth', t => {
  const files = discoverBrowserTests();
  // Reserve the moved pre-split CI work independently of the current weight's
  // own samples, without the provisional 25% margin retired by AIT-558.
  assert.ok(browserTestWeights['test/browser/clarify-now-status.test.js'] >= 242.898533946,
    'the moved status work remains reserved at the pre-split measured floor');
  assert.ok(browserTestWeights['test/browser/clarify-now.test.js']
    + browserTestWeights['test/browser/clarify-now-status.test.js']
    >= 378.094,
    'the halves cover the inherited combined reservation');
  // AIT-597: AIT-506's combined entrance matrix is now inside start-journey's
  // mature rolling-main series. Keep AIT-532's inherited 205s + 180s projection
  // as a lower bound instead of adding the same growth twice.
  const weights = { ...browserTestWeights,
    'test/browser/start-journey.test.js': Math.max(browserTestWeights['test/browser/start-journey.test.js'], 205 + 180),
  };
  const packing = packBrowserTests(files, weights, browserShardCount);
  retainPlan('growth', packing);
  assert.equal(packing.shards.length, 16);
  assertBrowserShardCoverage(files, packing.shards, weights);
  assertBrowserShardBudget(packing.totals);
  t.diagnostic(`Growth sixteen-bin seconds: ${packing.totals.map(total => total.toFixed(3)).join(', ')}`);
  assertBrowserShardHeadroom(packing, weights);
});

test('AIT-558: the growth guard rejects measured status work below the independent moved-work floor', () => {
  const setup = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const read = fs.readFileSync;
    fs.readFileSync = (path, ...args) => String(path).endsWith('/clarify-now-status.weight.json')
      ? JSON.stringify(${JSON.stringify(measuredWeight(190))}) : read(path, ...args);
    syncBuiltinESMExports();
  `;
  const result = spawnSync(process.execPath, ['--test', '--test-name-pattern=^AIT-624: sixteen bins retain',
    '--import', `data:text/javascript,${encodeURIComponent(setup)}`, 'test/browser-shards.test.js'], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', env: {},
  });
  assert.match(result.stdout, /AIT-624: sixteen bins retain/u, result.stdout + result.stderr);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /the moved status work remains reserved/u);
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

// AIT-597: pause-phone and host-surface split along whole top-level tests.
// Recorded seed inputs (r2 evidence): each half's moved per-test CI p95 sum
// and the provisional seed derived from it, ceil(1.25 * sum).
const splitSeeds = {
  'pause-phone': [260.625918641, 326], 'pause-phone-uploads': [192.373785211, 241],
  'host-surface': [271.585382161, 340], 'host-surface-email': [158.596611386, 199],
  // AIT-603 PR-A r15: moved out of demo.test.js; PR CI 44990458538-1 (no main series yet).
  'phone-dock': [244.38179801, 306],
  // AIT-618 r6: moved out of phone-dock.test.js; remote test lane run on ed1ebc3e (no main series yet).
  'phone-keyboard-settle': [23.821721917, 30],
};

test('AIT-597: split halves keep seed arithmetic from the moved CI work and let live weights roll forward', () => {
  for (const [name, [moved, seed]] of Object.entries(splitSeeds)) {
    assert.equal(Math.ceil(moved * 1.25), seed, `${name}: ceil(1.25 * moved CI p95)`);
  }
  // The seeds never reserved less than the mature pre-split series (48d2c753).
  assert.ok(splitSeeds['pause-phone'][1] + splitSeeds['pause-phone-uploads'][1] >= 453);
  assert.ok(splitSeeds['host-surface'][1] + splitSeeds['host-surface-email'][1] >= 430.182);
  // Live weights are invariants only: a measured refresh or a re-reservation
  // (for example #488's) replaces the seeds without editing this test.
  assert.deepEqual([...provisionalSplitFiles].sort(), Object.keys(splitSeeds).map(name => `test/browser/${name}.test.js`).sort());
  for (const file of discoverBrowserTests()) {
    const measurement = JSON.parse(readFileSync(new URL(`../${file.replace(/\.test\.js$/u, '.weight.json')}`, import.meta.url)));
    const weight = browserTestWeights[file];
    assert.ok(Number.isFinite(weight) && weight > 0, `${file}: positive weight`);
    // Diagnostic floors only ever raise a weight above its file's seconds.
    assert.ok(weight >= measurement.seconds, file);
    if (measurement.provisional === true) {
      assert.ok(provisionalSplitFiles.has(file), `${file}: provisional only for the four split files`);
      continue;
    }
    assert.doesNotThrow(() => assertMeasuredWeight(measurement), file);
    if (measurement.timing.samples.length >= timingMinimumSamples) {
      assert.ok(weight >= measuredSeconds(measurement.timing.samples), `${file}: at least the mature measured series`);
    }
  }
});

test('AIT-597: the provisional bypass covers only the four split files', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const read = fs.readFileSync;
    fs.readFileSync = (path, ...args) => String(path).endsWith('/start-look.weight.json')
      ? JSON.stringify({ seconds: 45, evidence: 'unmeasured reservation', provisional: true })
      : read(path, ...args);
    syncBuiltinESMExports();
    await import('./scripts/browser-shards.js');
  `], { cwd: new URL('../', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Missing rolling p95 CI timing samples/u);
});

test('AIT-597: every moved top-level test is registered by exactly one browser file', () => {
  const all = discoverBrowserTests().map(file => [file, readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')]);
  const callers = pattern => all.filter(([, text]) => pattern.test(text)).map(([file]) => file);
  assert.deepEqual(callers(/^documentUploadCheck\(\);$/mu), ['test/browser/pause-phone-uploads.test.js']);
  assert.deepEqual(callers(/^pausedImageInputCheck\(\);$/mu), ['test/browser/pause-phone.test.js']);
  assert.deepEqual(callers(/\bcombinedOfferCheck\b|\binlineOfferCheck\b/u), ['test/browser/host-surface-email.test.js']);
  const widths = all.flatMap(([file, text]) => [...text.matchAll(/^imageInputCheck\((\[[^\]]*\])\);$/gmu)].map(match => [file, JSON.parse(match[1])]));
  assert.deepEqual(widths, [
    ['test/browser/pause-phone-uploads.test.js', [1440]],
    ['test/browser/pause-phone.test.js', [390]],
    ['test/browser/start-look.test.js', [1024]],
  ]);
  for (const name of ['AIT-506 combined offer', 'AIT-507 integration', 'AIT-517: pinned contact', 'AIT-507 inline offer']) {
    assert.equal(all.filter(([, text]) => text.includes(`test('${name}`)).length, 1, name);
  }
});

test('AIT-597: mature rolling-main series replace the eleven superseded floors', () => {
  for (const name of ['email-ask', 'start2-display-geometry', 'voice-presentation', 'question-card', 'start2-display',
    'tick-followups', 'html-preview', 'email-mail-space', 'visitor-credit-tiers', 'audio-replay', 'composed-media']) {
    const measurement = JSON.parse(readFileSync(new URL(`../test/browser/${name}.weight.json`, import.meta.url)));
    // AIT-558 rule: maturity at retirement is point-in-time evidence; a
    // workload edit may restart the series with the standard warmup margin.
    assert.doesNotThrow(() => assertMeasuredWeight(measurement), name);
    assert.equal(browserTestWeights[`test/browser/${name}.test.js`], measurement.seconds, `${name}: no diagnostic floor`);
  }
});

// AIT-597 r3: a mature (>= five-sample) series for one top-level fixture test.
const matureWeight = (seconds, workload = 'f') => {
  const samples = Array.from({ length: 5 }, (_, index) => ({ runId: String(900 + index), attempt: 1, sha: 'c'.repeat(40),
    observedAt: '2026-11-20T12:00:00Z', tests: [{ name: 'fixture', seconds }] }));
  return { seconds: plannedSeconds(samples), evidence: 'CI artifact measurement',
    timing: { schema: 1, window: 20, workload: workload.repeat(64), samples } };
};

function rerunWithWeights(pattern, stubs) {
  const setup = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const stubs = ${JSON.stringify(stubs)};
    const read = fs.readFileSync;
    fs.readFileSync = (path, ...args) => {
      const name = Object.keys(stubs).find(name => String(path).endsWith('/' + name + '.weight.json'));
      return name ? JSON.stringify(stubs[name]) : read(path, ...args);
    };
    syncBuiltinESMExports();
  `;
  return spawnSync(process.execPath, ['--test', `--test-name-pattern=${pattern}`,
    '--import', `data:text/javascript,${encodeURIComponent(setup)}`, 'test/browser-shards.test.js'], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', env: {},
  });
}

test('AIT-597: split halves accept measured and re-reserved live weights', () => {
  // First measured refresh (mature, flag removed) and the projected #488
  // provisional re-reservation ceil(1.25 * (192.374 + 81)) = 342s. The 342s
  // fixture is self-contained, so it stays valid whatever the live file holds.
  for (const stub of [matureWeight(273), { seconds: 342, provisional: true,
    evidence: 'AIT-597 fixture: provisional re-reservation ceil(1.25 * (192.374 + 81)) = 342s' }]) {
    const result = rerunWithWeights('^AIT-597: split halves keep', { 'pause-phone-uploads': stub });
    assert.match(result.stdout, /AIT-597: split halves keep/u, result.stdout + result.stderr);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});

test('AIT-597 r4: the re-reservation fixture stays valid when the live file is a measured series', () => {
  // After a valid measured refresh to 273s, the live file has no provisional
  // flag and carries measured samples; the 342s fixture must not inherit them.
  const result = rerunWithWeights('^AIT-597: split halves accept', { 'pause-phone-uploads': matureWeight(273) });
  assert.match(result.stdout, /AIT-597: split halves accept/u, result.stdout + result.stderr);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('AIT-597: a restarted workload series with the warmup margin keeps the floor retirement green', () => {
  // A legitimate workload edit restarts the series: one sample, 25% warmup.
  const samples = [{ runId: '901', attempt: 1, sha: 'c'.repeat(40), observedAt: '2026-11-20T12:00:00Z',
    tests: [{ name: 'fixture', seconds: 222 }] }];
  assert.equal(plannedSeconds(samples), 277.5);
  assert.equal(plannedSeconds(Array.from({ length: 5 }, (_, index) => ({ ...samples[0], runId: String(910 + index) }))), 222);
  const restarted = { seconds: plannedSeconds(samples), evidence: 'CI artifact measurement',
    timing: { schema: 1, window: 20, workload: 'e'.repeat(64), samples } };
  const result = rerunWithWeights('^AIT-597: mature rolling-main series replace', { 'email-ask': restarted });
  assert.match(result.stdout, /AIT-597: mature rolling-main series replace/u, result.stdout + result.stderr);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('AIT-597: the growth guard still rejects a real overflow', t => {
  // Math.max(start-journey, 205 + 180) must pass measured growth through: a
  // mature 421s start-journey series puts a shard above the 420s ceiling.
  const result = rerunWithWeights('^AIT-624: sixteen bins retain', { 'start-journey': matureWeight(421) });
  assert.match(result.stdout, /AIT-624: sixteen bins retain/u, result.stdout + result.stderr);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const failure = /Planned browser shard exceeds 420s: [^\n']*/u.exec(result.stdout);
  assert.ok(failure, result.stdout + result.stderr);
  assert.ok(failure[0].split(' / ').some(total => Number(total.replace(/^.*: /u, '')) > 420), failure[0]);
  t.diagnostic(`stubbed growth run failed as intended: ${failure[0]}`);
});
