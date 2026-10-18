import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { assertMeasuredWeight } from './browser-timings.js';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

// Each browser test owns its sibling rolling per-test p95 CI measurements.
// A 25% margin protects workloads with fewer than five CI samples.
export function readBrowserTestWeights(files = discoverBrowserTests(), root = repositoryRoot) {
  const tests = new Set(files);
  for (const entry of readdirSync(resolve(root, 'test/browser'), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.weight.json')) continue;
    const file = `test/browser/${entry.name.replace(/\.weight\.json$/u, '.test.js')}`;
    if (!tests.has(file)) {
      throw new Error(`Stale browser test weight: test/browser/${entry.name}; no matching test: ${file}`);
    }
  }
  const weights = {};
  for (const file of files) {
    const weightPath = file.replace(/\.test\.js$/u, '.weight.json');
    let measurement;
    try {
      measurement = JSON.parse(readFileSync(resolve(root, weightPath), 'utf8'));
    } catch (error) {
      throw new Error(`Missing or unreadable browser test weight: ${file}; add ${weightPath} (seconds and evidence). ${error.message}`);
    }
    if (!Number.isFinite(measurement?.seconds) || measurement.seconds <= 0 ||
        typeof measurement.evidence !== 'string' || !measurement.evidence.trim()) {
      throw new Error(`Invalid browser test weight: ${weightPath}; seconds must be positive finite seconds and evidence must describe the measurement`);
    }
    try { assertMeasuredWeight(measurement); }
    catch (error) { throw new Error(`Invalid browser test weight: ${weightPath}; ${error.message}`); }
    weights[file] = measurement.seconds;
  }
  return weights;
}

export const browserTestWeights = readBrowserTestWeights();
// AIT-299 round 2: successful geometry-file workload in PR #271 CI
// 39051814951, head 243f39b1a0, shard 6/6: 50.144063283s + 27.707064542s
// + 24.865161603s + 10.231788079s = 112.948077507s. Include the usual
// 25% warmup margin (141.186s) until rolling main catches up with the
// compact-label/focus-held regression. PR samples stay out of trusted main history.
browserTestWeights['test/browser/start2-display-geometry.test.js'] = Math.max(
  browserTestWeights['test/browser/start2-display-geometry.test.js'], 141.186);

// AIT-282: PR CI 39003398813, shard 2, head 25d0608ccc measured the
// existing html-preview workload at 7.923261s + 17.509594s = 25.432855s.
// Keep the observed work plus the 25% warmup margin until main catches up;
// PR diagnostics do not enter the trusted rolling-main measurement history.
browserTestWeights['test/browser/html-preview.test.js'] = Math.max(
  browserTestWeights['test/browser/html-preview.test.js'], 31.792);

// AIT-283 round 2: successful PR CI 39001400566, head 78466ae367,
// remeasured the changed display workloads. Follow AIT-276's provisional
// floor pattern without importing PR samples into the trusted main history.
// Each floor is observed top-level test work plus the 25% warmup margin;
// retain it until rolling main measurements catch up with this workload.
for (const [file, seconds] of Object.entries({
  'test/browser/start2-display.test.js': 185.675, // observed 148.539947409s
  'test/browser/start2-display-continuity.test.js': 58.570, // observed 46.855165671s
  'test/browser/start2-display-matrix.test.js': 65.560, // observed 52.447183619s
})) browserTestWeights[file] = Math.max(browserTestWeights[file], seconds);

// AIT-281: successful PR #257 CI shard 2/6, run 39009238280, head
// be9de77ee1: footer sweep 13.469106049s + complete 84-case role matrix
// with viewport evidence 20.030139096s = 33.499245145s. Keep the 25%
// warmup floor until rolling main history reflects the expanded workload.
browserTestWeights['test/browser/footer-width-sweep.test.js'] = Math.max(
  browserTestWeights['test/browser/footer-width-sweep.test.js'], 41.875);

// AIT-290: PR #262 CI 39014917676, head aff955f108, shard 1/6:
// all 19 start2-display tests passed after the host-polish helper learned
// rendered consent copy and child-safe action hits. Observed 177.450581640s;
// retain the 25% warmup floor until rolling main reflects this workload.
browserTestWeights['test/browser/start2-display.test.js'] = Math.max(
  browserTestWeights['test/browser/start2-display.test.js'], 221.814);

// AIT-290: all 29 consent tests passed in PR #262 CI 39014917676 and
// 39015342356 (heads aff955f108 / 3c84d426f6). Sum of nearest-rank per-test
// p95 across those two file executions: 112.589432365s; 25% margin: 140.737s.
// Round 3 adds the cached-final/scoping/200% text regression. That test
// passed in CI 39018865149 at 4.334407704s (the separate DE one-line test
// failed there and is not used as timing evidence). Add its 25% margin,
// 5.419s, to the prior green-workload floor: 146.156s. Keep this conservative
// floor until rolling main reflects the expanded narrow matrix.
browserTestWeights['test/browser/consent-lines.test.js'] = Math.max(
  browserTestWeights['test/browser/consent-lines.test.js'], 146.156);

// AIT-297 round 4: successful PR #270 CI 39055022047, head 645aa348b8,
// shard 4/6: all three host-surface tests passed with the full two-line
// reservation/72-state geometry matrix, main-title comparison and CI crops.
// Observed 8.047032567s + 6.522481617s + 71.246408578s
// = 85.815922762s. Retain the measured work plus 25% (107.270s)
// until rolling main covers this workload; PR samples remain diagnostic.
browserTestWeights['test/browser/host-surface.test.js'] = Math.max(
  browserTestWeights['test/browser/host-surface.test.js'], 107.270);

// AIT-302 round 2: full successful PR #274 CI 39106097121, head
// ca4ab97310, shard 2/6. Copy-table screenshot representatives retain all
// 133 source assertions without repainting source-only cases. Completed file:
// 51.803124071s + 18.453931710s + 36.807815884s + 15.853129671s
// = 122.918001336s; round up to 122.919s, then add 25% = 153.649s.
// Supersedes the partial-work 200.818s floor and the round-1 224.717s
// completed workload. PR observations stay outside trusted rolling-main history.
browserTestWeights['test/browser/voice-presentation.test.js'] = Math.max(
  browserTestWeights['test/browser/voice-presentation.test.js'], 153.649);

// Six bins and the seven-minute file-work budget are capacity policy.
export const browserShardCount = 6;
export const browserShardBudget = 420;

export function packBrowserTests(files, weights = browserTestWeights, shardCount = browserShardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new Error('Invalid browser shard count');
  const measuredWeights = Object.values(weights);
  if (measuredWeights.some(weight => !Number.isFinite(weight) || weight <= 0)) {
    throw new Error('Browser test weights must be positive finite seconds');
  }
  // Unknown files still get conservative placement; the coverage guard below
  // requires an explicit measurement before they can run in CI. Use at least
  // 225s, rounded up from the slowest initial observation, even for empty tables.
  const defaultWeight = Math.max(225, ...measuredWeights);
  const weightOf = file => Object.hasOwn(weights, file) ? weights[file] : defaultWeight;
  const comparePaths = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const sortedFiles = [...files].sort((a, b) => weightOf(b) - weightOf(a) || comparePaths(a, b));
  const shards = Array.from({ length: shardCount }, () => []);
  const totals = Array(shardCount).fill(0);
  for (const file of sortedFiles) {
    // Equal-load bins keep their index, so all ties are deterministic.
    const index = totals.indexOf(Math.min(...totals));
    shards[index].push(file);
    totals[index] += weightOf(file);
  }
  return { shards, totals };
}

const browserPacking = packBrowserTests(discoverBrowserTests());
export const browserShards = browserPacking.shards;
export const browserShardTotals = browserPacking.totals;

export function discoverBrowserTests() {
  return readdirSync(new URL('../test/browser/', import.meta.url), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.js'))
    .map(entry => `test/browser/${entry.name}`).sort();
}

export function assertBrowserShardCoverage(files = discoverBrowserTests(), shards = browserShards, weights = browserTestWeights) {
  const counts = new Map();
  for (const file of shards.flat()) counts.set(file, (counts.get(file) ?? 0) + 1);
  const errors = [];
  if (shards.length === 0 || shards.some(shard => shard.length === 0)) errors.push('Empty browser shard');
  for (const file of files) {
    if (!counts.has(file)) errors.push(`Unassigned browser test: ${file}`);
    if (!Object.hasOwn(weights, file)) errors.push(`Missing browser test weight: ${file}`);
  }
  for (const [file, count] of counts) {
    if (count !== 1) errors.push(`Browser test assigned ${count} times: ${file}`);
    if (!files.includes(file)) errors.push(`Unknown browser test: ${file}`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
}

export function assertBrowserShardBudget(totals = browserShardTotals) {
  if (totals.some(total => !Number.isFinite(total) || total < 0 || total > browserShardBudget)) {
    throw new Error(`Planned browser shard exceeds ${browserShardBudget}s: ${totals.join(' / ')}`);
  }
}

export function selectBrowserTests(args = []) {
  assertBrowserShardCoverage();
  assertBrowserShardBudget();
  const nodeArgs = [], selections = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--shard') selections.push(args[++i]);
    else if (args[i].startsWith('--shard=')) selections.push(args[i].slice('--shard='.length));
    else nodeArgs.push(args[i]);
  }
  if (selections.length === 0) return { files: discoverBrowserTests(), nodeArgs };
  const match = selections.length === 1 && /^(\d+)\/(\d+)$/u.exec(selections[0] ?? '');
  if (!match || Number(match[2]) !== browserShards.length || Number(match[1]) < 1 || Number(match[1]) > browserShards.length) {
    throw new Error(`Use --shard N/${browserShards.length}, where N is 1 through ${browserShards.length}`);
  }
  return { files: [...browserShards[Number(match[1]) - 1]], nodeArgs };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertBrowserShardCoverage();
  assertBrowserShardBudget();
  browserShardTotals.forEach((total, index) => {
    console.log(`Browser shard ${index + 1}/${browserShards.length}: projected file work ${total.toFixed(3)}s (${browserShards[index].length} files).`);
  });
  console.log(`Browser shard coverage: ${discoverBrowserTests().length} files, exactly once across ${browserShards.length} shards.`);
}
