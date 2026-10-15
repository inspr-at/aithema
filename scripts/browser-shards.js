import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

// AIT-191 baseline: slowest successful per-file observations across CI runs
// 38692613866, 38701239296 and 38704006618. AIT-192 remeasures in CI runs
// 38714762515, 38715731356 and 38716800511 (all attempt 1). Changed matrices
// use their slowest new observation; unchanged files retain a slower historical
// maximum. All weights round UP to 10-second planning buckets; updated/slower
// observations also reserve one 10-second bucket for run variance.
// Sum top-level test durations only; nested subtests are already included.
// These estimates exclude setup, file-process overhead and evidence upload.
export const browserTestWeights = {
  'test/browser/admin-pages.test.js': 50.000, // CI 38692613866-1 (rounded up)
  'test/browser/audio-replay.test.js': 50.000, // CI 38716800511-1 (rounded up + 10s margin)
  'test/browser/confirmation-design.test.js': 80.000, // CI 38716800511-1 (rounded up + 10s margin)
  'test/browser/credit-hold.test.js': 70.000, // CI 38716800511-1 (rounded up + 10s margin)
  'test/browser/demo.test.js': 90.000, // CI 38704006618-1 (rounded up)
  'test/browser/email-ask.test.js': 120.000, // CI 38714762515-1 (rounded up + 10s margin)
  'test/browser/email-mail-space.test.js': 80.000, // CI 38715731356-1 (rounded up + 10s margin)
  'test/browser/footer-width-sweep.test.js': 30.000, // CI 38716800511-1 (rounded up + 10s margin)
  'test/browser/host-surface.test.js': 20.000, // CI 38715731356-1 (rounded up + 10s margin)
  'test/browser/html-preview.test.js': 40.000, // CI 38701239296-1 (rounded up)
  'test/browser/operator-login.test.js': 50.000, // CI 38704006618-1 (rounded up)
  'test/browser/orb-reveal.test.js': 90.000, // CI 38701239296-1 (rounded up)
  'test/browser/pause-phone.test.js': 110.000, // CI 38715731356-1 (rounded up + 10s margin)
  'test/browser/question-card.test.js': 20.000, // CI 38704006618-1 (rounded up)
  'test/browser/safeguards.test.js': 20.000, // CI 38716800511-1 (rounded up + 10s margin)
  'test/browser/start-journey.test.js': 20.000, // CI 38704006618-1 (rounded up)
  'test/browser/start-look.test.js': 40.000, // CI 38716800511-1 (rounded up + 10s margin)
  'test/browser/start2-display-continuity.test.js': 60.000, // CI 38714762515-1 (rounded up + 10s margin)
  'test/browser/start2-display-geometry.test.js': 50.000, // CI 38704006618-2 (rounded up)
  'test/browser/start2-display-matrix.test.js': 70.000, // CI 38715731356-1 (rounded up + 10s margin)
  'test/browser/start2-display.test.js': 110.000, // CI 38715731356-1 (rounded up + 10s margin)
  'test/browser/tick-followups.test.js': 80.000, // CI 38704006618-1 (rounded up)
  'test/browser/visitor-credit-tiers.test.js': 110.000, // CI 38715731356-1 (rounded up + 10s margin)
  'test/browser/voice-presentation.test.js': 90.000, // CI 38716800511-1 (rounded up + 10s margin)
};

export const browserShardCount = 4;

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

export function selectBrowserTests(args = []) {
  assertBrowserShardCoverage();
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
  browserShardTotals.forEach((total, index) => {
    console.log(`Browser shard ${index + 1}/${browserShards.length}: projected file work ${total.toFixed(3)}s (${browserShards[index].length} files).`);
  });
  console.log(`Browser shard coverage: ${discoverBrowserTests().length} files, exactly once across ${browserShards.length} shards.`);
}
