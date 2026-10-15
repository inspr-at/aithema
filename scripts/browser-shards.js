import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

// AIT-191 baseline: slowest successful per-file observations across CI runs
// 38692613866, 38701239296 and 38704006618. AIT-192 benchmark browser jobs:
// 38714762515, 38715731356, 38716800511, 38717864470 and 38720349940 (attempt 1).
// Round 2: all 24 files remeasured in 38726471579-1 after merging AIT-190.
// New observations raise weights; slower historical observations remain.
// Changed matrices use their slowest benchmark observation; unchanged files
// retain a slower historical maximum. All weights round UP to 10-second planning
// buckets; updated/slower observations reserve another 10s for run variance.
// AIT-199 refresh: main 38732580354-1 and latest successful AIT-197/198 PR
// runs 38765085264-1 and 38770896962-1. Historical maxima remain the floor;
// latest observations below include AIT-190's expanded pause matrix.
// Headless-shell PR benchmarks: 38773142800-1 and 38773893654-1.
// Not on this base yet: AIT-197 consent-lines = 76.396s (38774634960-1),
// planning weight 90s; now merged AIT-198 understanding-failure = 32.829s (38770896962-1),
// planning weight 50s. Keep both entries below; discovery enables them
// automatically when their source files merge (no placeholder test files).
// Sum top-level test durations only; nested subtests are already included.
// Estimates exclude setup, file-process overhead and evidence upload. The final
// layout is validated separately against the 450s whole-job wall budget.
export const browserTestWeights = {
  'test/browser/admin-pages.test.js': 80.000, // AIT-199 latest max 62.782s, CI 38770896962-1; historical floor 80s
  'test/browser/audio-replay.test.js': 50.000, // AIT-199 latest max 30.882s, CI 38770896962-1; historical floor 50s
  'test/browser/confirmation-design.test.js': 90.000, // AIT-199 latest max 68.546s, CI 38732580354-1; historical floor 90s
  'test/browser/consent-lines.test.js': 90.000, // Incoming AIT-197: CI 38774634960-1, 76.396s rounded up + 10s
  'test/browser/credit-hold.test.js': 80.000, // AIT-199 latest max 62.079s, CI 38774634960-1; historical floor 70s
  'test/browser/demo.test.js': 90.000, // AIT-199 latest max 67.766s, CI 38770896962-1; historical floor 90s
  'test/browser/email-ask.test.js': 130.000, // AIT-199 latest max 99.923s, CI 38732580354-1; historical floor 130s
  'test/browser/email-mail-space.test.js': 80.000, // AIT-199 latest max 62.288s, CI 38773142800-1; historical floor 80s
  'test/browser/external-plugin.test.js': 20.000, // mbp2606 9eb0a6e76b-14883 (1.846s; rounded up + 10s margin)
  'test/browser/footer-width-sweep.test.js': 30.000, // AIT-199 latest max 13.022s, CI 38732580354-1; historical floor 30s
  'test/browser/host-surface.test.js': 20.000, // AIT-199 latest max 8.114s, CI 38732580354-1; historical floor 20s
  'test/browser/html-preview.test.js': 40.000, // AIT-199 latest max 9.122s, CI 38765085264-1; historical floor 40s
  'test/browser/lane-race-kit.test.js': 20.000, // CI 38784223838-1 (2.516s; rounded up + 10s margin)
  'test/browser/operator-login.test.js': 60.000, // AIT-199 latest max 42.284s, CI 38770896962-1; historical floor 60s
  'test/browser/orb-reveal.test.js': 100.000, // AIT-199 latest max 86.949s, CI 38770896962-1; historical floor 100s
  'test/browser/pause-phone.test.js': 200.000, // AIT-199 latest max 187.080s, CI 38732580354-1; historical floor 190s
  'test/browser/question-card.test.js': 30.000, // AIT-199 latest max 16.628s, CI 38732580354-1; historical floor 30s
  'test/browser/safeguards.test.js': 20.000, // AIT-199 latest max 8.451s, CI 38774634960-1; historical floor 20s
  'test/browser/start-journey.test.js': 30.000, // AIT-199 latest max 16.401s, CI 38765085264-1; historical floor 30s
  'test/browser/start-look.test.js': 40.000, // AIT-199 latest max 27.864s, CI 38770896962-1; historical floor 40s
  'test/browser/start2-display-continuity.test.js': 60.000, // AIT-199 latest max 40.700s, CI 38774634960-1; historical floor 60s
  'test/browser/start2-display-geometry.test.js': 60.000, // AIT-199 latest max 44.925s, CI 38770896962-1; historical floor 50s
  'test/browser/start2-display-matrix.test.js': 70.000, // AIT-199 latest max 52.528s, CI 38773142800-1; historical floor 70s
  'test/browser/start2-display.test.js': 110.000, // AIT-199 latest max 97.777s, CI 38765085264-1; historical floor 110s
  'test/browser/tick-followups.test.js': 90.000, // AIT-199 latest max 76.289s, CI 38732580354-1; historical floor 90s
  'test/browser/understanding-failure.test.js': 60.000, // AIT-212/213 expanded matrix: mbp2606 7ca3832ca3-18003, 44.890s rounded up + 10s
  'test/browser/visitor-credit-tiers.test.js': 110.000, // AIT-199 latest max 96.541s, CI 38770896962-1; historical floor 110s
  'test/browser/voice-presentation.test.js': 90.000, // AIT-199 latest max 68.021s, CI 38770896962-1; historical floor 90s
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
