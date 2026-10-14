import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

// AIT-177 round 3 merges AIT-173 credit-hold and AIT-181 safeguards coverage.
// Timings: main 8ad4827 CI 38630840942 (whole jobs 462/468/488/449s)
// and PR #150 at 7ecb72f CI 38627899478 (423/418/412/430s).
// Use the larger measured file work for unchanged files, PR timings for its
// split display/visitor files, and main timings for new or changed coverage.
// Four balanced bins below leave >10% of the 600s whole-job budget for
// setup, worker cleanup, timing variance and uncompressed PNG evidence upload.
// Every integrated B1–B8/r2/r3 block and visitor assertion remains covered.
export const browserShards = [
  // 431.49s measured file work; 219.52, 98.31, 44.44, 37.88, 15.69, 15.66
  [
    'test/browser/email-ask.test.js',
    'test/browser/confirmation-design.test.js',
    'test/browser/voice-presentation.test.js',
    'test/browser/audio-replay.test.js',
    'test/browser/question-card.test.js',
    'test/browser/start-journey.test.js',
  ],
  // 433.29s measured file work; 189.39, 110.26, 58.91, 38.59, 28.14, 7.99
  [
    'test/browser/start2-display.test.js',
    'test/browser/email-mail-space.test.js',
    'test/browser/demo.test.js',
    'test/browser/operator-login.test.js',
    'test/browser/start-look.test.js',
    'test/browser/safeguards.test.js',
  ],
  // 426.84s measured file work; 170.41, 117.63, 93.09, 37.25, 8.46
  [
    'test/browser/start2-display-matrix.test.js',
    'test/browser/start2-display-continuity.test.js',
    'test/browser/orb-reveal.test.js',
    'test/browser/start2-display-geometry.test.js',
    'test/browser/html-preview.test.js',
  ],
  // 426.88s measured file work; 156.41, 154.47, 47.34, 39.86, 20.66, 8.14
  [
    'test/browser/visitor-credit-tiers-en.test.js',
    'test/browser/visitor-credit-tiers.test.js',
    'test/browser/credit-hold.test.js',
    'test/browser/admin-pages.test.js',
    'test/browser/footer-width-sweep.test.js',
    'test/browser/host-surface.test.js',
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
