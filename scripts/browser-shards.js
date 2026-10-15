import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

// AIT-191: slowest successful per-file observation in seconds across CI runs
// 38692613866, 38701239296 and 38704006618 (attempt noted on each entry).
// AIT-190's expanded pause matrix is remeasured in CI 38718269610.
// Sum top-level test durations only; nested subtests are already included.
// These estimates exclude setup, file-process overhead and evidence upload.
export const browserTestWeights = {
  'test/browser/admin-pages.test.js': 46.687, // CI 38692613866-1
  'test/browser/audio-replay.test.js': 30.572, // CI 38692613866-1
  'test/browser/confirmation-design.test.js': 97.374, // CI 38692613866-1
  'test/browser/credit-hold.test.js': 48.490, // CI 38704006618-1
  'test/browser/demo.test.js': 84.780, // CI 38704006618-1
  'test/browser/email-ask.test.js': 224.498, // CI 38704006618-1
  'test/browser/email-mail-space.test.js': 112.919, // CI 38704006618-1
  'test/browser/footer-width-sweep.test.js': 12.829, // CI 38704006618-1
  'test/browser/host-surface.test.js': 8.220, // CI 38704006618-1
  'test/browser/html-preview.test.js': 35.666, // CI 38701239296-1
  'test/browser/operator-login.test.js': 40.451, // CI 38704006618-1
  'test/browser/orb-reveal.test.js': 87.600, // CI 38701239296-1
  'test/browser/pause-phone.test.js': 148.431, // CI 38718269610-1, AIT-190 desktop matrix
  'test/browser/question-card.test.js': 18.767, // CI 38704006618-1
  'test/browser/safeguards.test.js': 8.407, // CI 38704006618-1
  'test/browser/start-journey.test.js': 17.298, // CI 38704006618-1
  'test/browser/start-look.test.js': 28.083, // CI 38704006618-1
  'test/browser/start2-display-continuity.test.js': 122.791, // CI 38704006618-1
  'test/browser/start2-display-geometry.test.js': 43.284, // CI 38704006618-2
  'test/browser/start2-display-matrix.test.js': 176.803, // CI 38701239296-1
  'test/browser/start2-display.test.js': 195.234, // CI 38704006618-2
  'test/browser/tick-followups.test.js': 78.181, // CI 38704006618-1
  'test/browser/visitor-credit-tiers-en.test.js': 144.541, // CI 38704006618-1
  'test/browser/visitor-credit-tiers.test.js': 142.004, // CI 38704006618-1
  'test/browser/voice-presentation.test.js': 70.395, // CI 38704006618-1
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
