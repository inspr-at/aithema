import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
export const unitShardCount = 2;
export const unitConcurrency = 3;
export const unitJobTargetSeconds = 420; // 70% of the unchanged ten-minute cap.
export const unitJobOverheadSeconds = 25; // measured ~13s + margin; pack/boot run in test.
export const unitUnknownFileSeconds = 180; // unchanged per-file watchdog limit.
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// Derive discovery from npm test itself so new package/plugin files cannot be
// omitted by a second, drifting manifest. No recursive browser/soak discovery.
export function unitTestCommand(root = repositoryRoot) {
  const command = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts.test.split(/\s+/u);
  if (command.shift() !== 'node') throw new Error('Expected the node unit test command');
  return command;
}
export function discoverUnitTests(root = repositoryRoot) {
  const patterns = unitTestCommand(root).filter(arg => arg.endsWith('*.test.js'));
  if (!patterns.length) throw new Error('Missing npm test file patterns');
  return [...new Set(globSync(patterns, { cwd: root }))].sort(compare);
}
export function readUnitWeights(root = repositoryRoot) {
  const measurement = JSON.parse(readFileSync(resolve(root, 'scripts/unit-timings.json'), 'utf8'));
  if (measurement.schema !== 1 || !measurement.runs?.length) throw new Error('Missing unit CI timing provenance');
  const weights = {};
  for (const [file, entry] of Object.entries(measurement.files)) {
    if (!entry.runIds?.length || entry.samples?.length !== entry.runIds.length ||
        new Set(entry.runIds).size !== entry.runIds.length ||
        entry.runIds.some(id => !measurement.runs.some(run => run.runId === id)) ||
        entry.samples.some(value => !Number.isFinite(value) || value <= 0)) {
      throw new Error(`Invalid unit duration: ${file}`);
    }
    const sorted = [...entry.samples].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    const floor = entry.floorSeconds ?? 0;
    if (!Number.isFinite(floor) || floor < 0 || (floor && !entry.evidence)) throw new Error(`Invalid measured unit floor: ${file}`);
    const expected = Math.max(floor, Math.ceil(p95 * (sorted.length < 5 ? 1.25 : 1) * 1000) / 1000);
    if (entry.seconds !== expected) throw new Error(`Unit weight differs from measured p95: ${file}`);
    weights[file] = entry.seconds;
  }
  return weights;
}
export function packUnitTests(files, weights, count = unitShardCount) {
  if (!Number.isInteger(count) || count < 1 || Object.values(weights).some(value => !Number.isFinite(value) || value <= 0)) {
    throw new Error('Invalid unit shard count or duration');
  }
  const weightOf = file => weights[file] ?? unitUnknownFileSeconds;
  const shards = Array.from({ length: count }, () => []), totals = Array(count).fill(0), largest = Array(count).fill(0);
  for (const file of [...files].sort((a, b) => weightOf(b) - weightOf(a) || compare(a, b))) {
    const index = totals.indexOf(Math.min(...totals));
    shards[index].push(file);
    totals[index] += weightOf(file);
    largest[index] = Math.max(largest[index], weightOf(file));
  }
  // List-scheduling upper bound for ANY execution order with three workers:
  // sum / workers + (1 - 1/workers) * longest file. Includes whole-worker
  // summaries, not just assertion work; do not assume Node preserves LPT order.
  const projected = totals.map((total, index) => unitJobOverheadSeconds + total / unitConcurrency +
    (1 - 1 / unitConcurrency) * largest[index]);
  return { shards, totals, projected };
}
export function assertUnitCoverage(files, shards) {
  const assigned = shards.flat();
  if (!shards.length || shards.some(shard => !shard.length) || new Set(assigned).size !== assigned.length ||
      JSON.stringify([...assigned].sort(compare)) !== JSON.stringify([...files].sort(compare))) {
    throw new Error('Unit shards must cover every npm test file exactly once, with no empty shards');
  }
}
export function assertUnitHeadroom(packing) {
  if (packing.projected.some(seconds => !Number.isFinite(seconds) || seconds > unitJobTargetSeconds)) {
    throw new Error(`Projected unit job exceeds ${unitJobTargetSeconds}s including overhead: ${packing.projected.map(n => n.toFixed(3)).join(' / ')}`);
  }
}
export function unitPlan() {
  const files = discoverUnitTests(), weights = readUnitWeights(), packing = packUnitTests(files, weights);
  assertUnitCoverage(files, packing.shards);
  assertUnitHeadroom(packing);
  return packing;
}
export function selectUnitShard(args, packing = unitPlan()) {
  const match = args.length === 2 && args[0] === '--shard' && /^(\d+)\/(\d+)$/u.exec(args[1]);
  if (!match || Number(match[2]) !== packing.shards.length || Number(match[1]) < 1 || Number(match[1]) > packing.shards.length) {
    throw new Error(`Use --shard N/${packing.shards.length}`);
  }
  return packing.shards[Number(match[1]) - 1];
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packing = unitPlan();
  packing.projected.forEach((seconds, index) => console.log(`Unit shard ${index + 1}/${unitShardCount}: ` +
    `${packing.shards[index].length} files; ${packing.totals[index].toFixed(3)}s worker work; projected job ${seconds.toFixed(3)}s / ${unitJobTargetSeconds}s target.`));
  console.log(`Unit coverage: ${packing.shards.flat().length} files, exactly once.`);
}
