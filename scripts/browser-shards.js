import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

// AIT-177: per-file medians from PR #150 runs 38592417042 and
// 38610111325 (attempts 1/2). Greedy longest-first assignment keeps four jobs.
// Split the heaviest repeated file (integrated display matrix, ~212 s) at
// its existing B1–B8/r2/r3 describe blocks; all assertions/scenarios retained.
// Whole-job timings include setup/upload and vary with shared-runner load;
// remeasure them in CI rather than treating these sums as whole-job times.
export const browserShards = [
  // 428.12s median file work; 210.92, 104.76, 42.93, 37.90, 15.99, 15.63
  [
    'test/browser/email-ask.test.js',
    'test/browser/confirmation-design.test.js',
    'test/browser/voice-presentation.test.js',
    'test/browser/start2-display-geometry.test.js',
    'test/browser/question-card.test.js',
    'test/browser/start-journey.test.js',
  ],
  // 428.11s median file work; 199.16, 109.65, 47.45, 39.68, 19.53, 12.64
  [
    'test/browser/visitor-credit-tiers-en.test.js',
    'test/browser/email-mail-space.test.js',
    'test/browser/demo.test.js',
    'test/browser/admin-pages.test.js',
    'test/browser/html-preview.test.js',
    'test/browser/footer-width-sweep.test.js',
  ],
  // 427.47s median file work; 190.69, 117.84, 85.52, 25.65, 7.78
  [
    'test/browser/visitor-credit-tiers.test.js',
    'test/browser/start2-display-continuity.test.js',
    'test/browser/orb-reveal.test.js',
    'test/browser/start-look.test.js',
    'test/browser/host-surface.test.js',
  ],
  // 428.15s median file work; 177.59, 175.36, 40.71, 27.32, 7.16
  [
    'test/browser/start2-display.test.js',
    'test/browser/start2-display-matrix.test.js',
    'test/browser/operator-login.test.js',
    'test/browser/audio-replay.test.js',
    'test/browser/safeguards.test.js',
  ],
];

export function discoverBrowserTests() {
  return readdirSync(new URL('../test/browser/', import.meta.url), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.js'))
    .map(entry => `test/browser/${entry.name}`).sort();
}

export function assertBrowserShardCoverage(files = discoverBrowserTests(), shards = browserShards) {
  const counts = new Map();
  for (const file of shards.flat()) counts.set(file, (counts.get(file) ?? 0) + 1);
  const errors = [];
  if (shards.length === 0 || shards.some(shard => shard.length === 0)) errors.push('Empty browser shard');
  for (const file of files) if (!counts.has(file)) errors.push(`Unassigned browser test: ${file}`);
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
  console.log(`Browser shard coverage: ${discoverBrowserTests().length} files, exactly once across ${browserShards.length} shards.`);
}
