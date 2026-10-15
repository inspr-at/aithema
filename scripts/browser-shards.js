import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

// Each browser test owns its sibling .weight.json measurement (AIT-216).
// Keep slowest observations and round up to 10s plus 10s margin (AIT-191).
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
    weights[file] = measurement.seconds;
  }
  return weights;
}

export const browserTestWeights = readBrowserTestWeights();

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
