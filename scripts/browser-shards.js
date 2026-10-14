import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

// AIT-177 measured per-file seconds: PR #150 ci run 38590273870 at 2d9c1b9.
// Include every top-level test, including the dynamically named DE/EN orb tests.
// Main 27dbafb (38580264760) and PR #145 (38585047142) corroborate the
// heavy files. Main whole jobs: 428 / 475 / 447 / 456 s; PR #145 shard 3:
// 498 s. Keep four shared-runner jobs and the complete test/evidence matrix.
// Visitor DE/EN split at the existing language boundary: all 12 combinations;
// independently measured 195.18 / 197.84 s (no assertion or scenario removed).
// This PR's prior jobs: 438 / 462 / 423 / 421 s. Move 29.87s audio replay
// from 2 to 3, then the measured journey file from 3 to 4 for ~10% headroom.
export const browserShards = [
  // 417.46s; per-file seconds: 218.83, 94.24, 43.89, 39.43, 12.48, 8.59
  [
    'test/browser/email-ask.test.js',
    'test/browser/confirmation-design.test.js',
    'test/browser/voice-presentation.test.js',
    'test/browser/operator-login.test.js',
    'test/browser/footer-width-sweep.test.js',
    'test/browser/html-preview.test.js',
  ],
  // 415.07s; per-file seconds: 197.84, 115.57, 86.26, 15.39
  [
    'test/browser/visitor-credit-tiers-en.test.js',
    'test/browser/start2-display-continuity.test.js',
    'test/browser/orb-reveal.test.js',
    'test/browser/question-card.test.js',
  ],
  // 417.73s; per-file seconds: 195.18, 106.42, 46.27, 39.99, 29.87
  [
    'test/browser/visitor-credit-tiers.test.js',
    'test/browser/email-mail-space.test.js',
    'test/browser/demo.test.js',
    'test/browser/admin-pages.test.js',
    'test/browser/audio-replay.test.js',
  ],
  // 415.91s; per-file seconds: 165.25, 192.72, 25.15, 17.78, 15.02
  [
    'test/browser/start2-display.test.js',
    'test/browser/start2-display-matrix.test.js',
    'test/browser/start-look.test.js',
    'test/browser/host-surface.test.js',
    'test/browser/start-journey.test.js',
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
