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
// AIT-314: main-only re-derivation; per-file evidence is in the CI guide.
// Mature rolling-main series replace the old ticket floors. Geometry's fresh
// two-sample weight (216.968s, including 25%) already exceeds its old 196s floor.
// Keep the conservative PR floors for these changed workloads until at least
// five matching main samples confirm them; older workload hashes do not count.
// Footer: two main samples, p95 work 36.447s, warmup weight 45.559s.
browserTestWeights['test/browser/footer-width-sweep.test.js'] = Math.max(
  browserTestWeights['test/browser/footer-width-sweep.test.js'], 46);
// Voice: three main samples, p95 work 138.653s, warmup weight 173.317s.
browserTestWeights['test/browser/voice-presentation.test.js'] = Math.max(
  browserTestWeights['test/browser/voice-presentation.test.js'], 174.746);

// AIT-304: successful PR #284 CI 39120863347, head bb069809, shard 4/7:
// complete footer file with viewport evidence: 16.313871563s + 12.941360072s
// + 22.817818013s = 52.073049648s. ceil(observed * 1.25) = 66s, superseding
// the 63s provisional remote floor. PR CI 39120378507 at c12e5bbb, shard
// 1/7, passed all 19 display tests: 205.342187533s; ceil(*1.25) = 257s.
// Retain that display floor (39120863347 remeasured 197.598731313s) for
// the unchanged full-wording assertions' accessible-name extraction.
// PR/remote samples remain diagnostic, outside trusted rolling-main history.
for (const [file, seconds] of Object.entries({
  'test/browser/footer-width-sweep.test.js': 66,
  'test/browser/start2-display.test.js': 257,
})) browserTestWeights[file] = Math.max(browserTestWeights[file], seconds);

// AIT-357: PR #306 CI 39149165863, head 480a839e, shard 2/7:
// footer file 4/4 PASS, summed top-level work 70.230831338s including the
// held-receipt matrix. ceil(observed * 1.25) = 88s. The run's separate host
// chrome regression was fixed with exact formatted sizing; this diagnostic
// floor stays outside trusted rolling-main history until matching main samples.
browserTestWeights['test/browser/footer-width-sweep.test.js'] = Math.max(
  browserTestWeights['test/browser/footer-width-sweep.test.js'], 88);

// AIT-327: all 34 tests passed in PR CI 39139806265, head d9161661,
// shard 5/7: summed top-level work 133.288818152s.
// ceil(observed * 1.25) = 167s; supersedes AIT-321's 158s floor.
// Keep this diagnostic floor until matching rolling-main samples mature;
// PR observations do not enter trusted main timing history.
browserTestWeights['test/browser/consent-lines.test.js'] = Math.max(
  browserTestWeights['test/browser/consent-lines.test.js'], 167);

// AIT-341 P1: mbp2606 committed-head run b7727c6d05-67262, 2026-10-18:
// 6.228956916s isolation + 19.702862417s backdrop + 5.178417708s strict-host
// = 31.110237041s top-level work (5 pass, 2 executing todos, zero skips).
// PR #300 CI 39142459751, head ba53e5ee, shard 1/7: 7.923580988s isolation
// + 19.621596825s backdrop + 5.233819894s strict-host = 32.778997707s.
// ceil(CI observed * 1.25) = 41s, superseding the 39s remote floor. Keep
// this diagnostic floor outside trusted rolling-main history until matching
// successful main samples can replace it.
browserTestWeights['test/browser/html-preview.test.js'] = Math.max(
  browserTestWeights['test/browser/html-preview.test.js'], 41);

// AIT-312: seven bins restore headroom beneath the unchanged hard ceiling.
export const browserShardCount = 7;
export const browserShardBudget = 420;
export const browserShardHeadroomTarget = 400;

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
  // AIT-312: refine LPT with deterministic whole-file moves/swaps. Minimize
  // makespan first, then squared load; never worsen LPT's makespan bound.
  // Strict improvement and stable iteration order make the result repeatable.
  const score = loads => [Math.max(...loads), loads.reduce((sum, load) => sum + load * load, 0)];
  const better = (a, b) => a[0] < b[0] - 1e-9 || (Math.abs(a[0] - b[0]) <= 1e-9 && a[1] < b[1] - 1e-9);
  for (;;) {
    let best = score(totals), change;
    for (let from = 0; from < shardCount; from++) {
      for (let to = from + 1; to < shardCount; to++) {
        for (let left = -1; left < shards[from].length; left++) {
          for (let right = -1; right < shards[to].length; right++) {
            if (left === -1 && right === -1) continue;
            if (left === -1 && shards[to].length <= 1 || right === -1 && shards[from].length <= 1) continue;
            const delta = (left === -1 ? 0 : weightOf(shards[from][left])) -
              (right === -1 ? 0 : weightOf(shards[to][right]));
            const candidate = [...totals];
            candidate[from] -= delta;
            candidate[to] += delta;
            const next = score(candidate);
            if (better(next, best)) {
              best = next;
              change = { from, to, left, right, candidate };
            }
          }
        }
      }
    }
    if (!change) break;
    const { from, to, left, right, candidate } = change;
    const a = left === -1 ? [] : shards[from].splice(left, 1);
    const b = right === -1 ? [] : shards[to].splice(right, 1);
    shards[from].push(...b);
    shards[to].push(...a);
    totals.splice(0, totals.length, ...candidate);
  }
  // A local optimum can still miss the planning target. Try a bounded,
  // deterministic whole-file placement before asking for capacity changes.
  // If it cannot find a fit, retain the plan so the guard reports its files.
  if (Math.max(...totals) > browserShardHeadroomTarget &&
      totals.reduce((sum, total) => sum + total, 0) <= shardCount * browserShardHeadroomTarget) {
    const fitted = Array.from({ length: shardCount }, () => []);
    const loads = Array(shardCount).fill(0);
    const milliseconds = file => Math.ceil(weightOf(file) * 1000 - 1e-9);
    let remainingNodes = 100_000;
    function place(index) {
      if (--remainingNodes < 0) return false;
      if (index === sortedFiles.length) return true;
      const file = sortedFiles[index], seenLoads = new Set();
      const bins = loads.map((_, bin) => bin).sort((a, b) => loads[a] - loads[b] || a - b);
      for (const bin of bins) {
        if (seenLoads.has(loads[bin]) || loads[bin] + milliseconds(file) > browserShardHeadroomTarget * 1000) continue;
        seenLoads.add(loads[bin]);
        loads[bin] += milliseconds(file);
        fitted[bin].push(file);
        if (place(index + 1)) return true;
        fitted[bin].pop();
        loads[bin] -= milliseconds(file);
        if (remainingNodes < 0) return false;
      }
      return false;
    }
    if (place(0)) return { shards: fitted, totals: loads.map(load => load / 1000) };
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

// Separate planning guard: report the overloaded bins and their measured files
// so capacity/workload changes can be reviewed without weakening the hard cap.
export function assertBrowserShardHeadroom(packing = browserPacking, weights = browserTestWeights) {
  const overloaded = packing.totals.flatMap((total, index) => total > browserShardHeadroomTarget
    ? [`Shard ${index + 1}/${packing.shards.length}: ${total.toFixed(3)}s; files: ${packing.shards[index]
      .map(file => `${file} (${weights[file].toFixed(3)}s)`).join(', ')}`] : []);
  if (overloaded.length) {
    throw new Error(`Browser shard headroom target exceeded (${browserShardHeadroomTarget}s; hard ceiling remains ${browserShardBudget}s). Review measured workloads and repack; do not lower weights without evidence.\n${overloaded.join('\n')}`);
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
  assertBrowserShardHeadroom();
  browserShardTotals.forEach((total, index) => {
    console.log(`Browser shard ${index + 1}/${browserShards.length}: projected file work ${total.toFixed(3)}s (${browserShards[index].length} files).`);
  });
  console.log(`Browser shard coverage: ${discoverBrowserTests().length} files, exactly once across ${browserShards.length} shards.`);
}
