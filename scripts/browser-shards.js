import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

// AIT-177: PR #150 CI 38623276426, including main 0a7a8a7, measured
// whole jobs 408 / 445 / 344 / 407 s. Move question-card and footer from 2
// to 3: their measured file work gives the longest job >10% headroom.
// Integrated display keeps all original B1–B8/r2/r3 describe blocks in a
// separate file. Visitor render waits retain every state and assertion.
// Below are measured file-work sums; whole-job times also include setup,
// worker cleanup and evidence upload (PNG archives use compression-level 0).
export const browserShards = [
  // 392.22s file work; 208.12, 94.28, 37.07, 33.33, 12.67, 6.75
  [
    'test/browser/email-ask.test.js',
    'test/browser/confirmation-design.test.js',
    'test/browser/admin-pages.test.js',
    'test/browser/start2-display-geometry.test.js',
    'test/browser/start-journey.test.js',
    'test/browser/host-surface.test.js',
  ],
  // 392.87s file work; 189.47, 117.06, 86.34
  [
    'test/browser/start2-display.test.js',
    'test/browser/start2-display-continuity.test.js',
    'test/browser/orb-reveal.test.js',
  ],
  // 368.31s file work; 157.90, 88.16, 43.96, 27.70, 8.09, 5.64, 14.95, 21.92
  [
    'test/browser/start2-display-matrix.test.js',
    'test/browser/email-mail-space.test.js',
    'test/browser/voice-presentation.test.js',
    'test/browser/operator-login.test.js',
    'test/browser/html-preview.test.js',
    'test/browser/safeguards.test.js',
    'test/browser/question-card.test.js',
    'test/browser/footer-width-sweep.test.js',
  ],
  // 389.96s file work; 148.14, 145.75, 47.05, 22.56, 26.46
  [
    'test/browser/visitor-credit-tiers-en.test.js',
    'test/browser/visitor-credit-tiers.test.js',
    'test/browser/demo.test.js',
    'test/browser/audio-replay.test.js',
    'test/browser/start-look.test.js',
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
