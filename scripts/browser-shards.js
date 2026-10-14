import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

// AIT-177: four jobs, longest-file-first, using PR #150 CI per-file medians
// (38592417042, 38610111325, 38616918321). Split the integrated display
// matrix at its original B1–B8/r2/r3 describe blocks; retain every assertion.
// Visitor DE/EN after render waits: 129.16/130.48 s on mbp2606 with all 524
// viewport screenshots. Allow 20% runner uplift for the first CI calibration.
// These are file-work estimates; whole-job times must include setup/upload.
export const browserShards = [
  // 420.64s file work; 215.33, 104.00, 39.99, 38.00, 15.43, 7.90
  [
    'test/browser/email-ask.test.js',
    'test/browser/confirmation-design.test.js',
    'test/browser/admin-pages.test.js',
    'test/browser/start2-display-geometry.test.js',
    'test/browser/start-journey.test.js',
    'test/browser/host-surface.test.js',
  ],
  // 418.63s file work; 184.42, 118.55, 85.52, 15.64, 14.51
  [
    'test/browser/start2-display.test.js',
    'test/browser/start2-display-continuity.test.js',
    'test/browser/orb-reveal.test.js',
    'test/browser/question-card.test.js',
    'test/browser/footer-width-sweep.test.js',
  ],
  // 420.57s file work; 173.12, 143.18, 42.85, 39.76, 14.55, 7.11
  [
    'test/browser/start2-display-matrix.test.js',
    'test/browser/email-mail-space.test.js',
    'test/browser/voice-presentation.test.js',
    'test/browser/operator-login.test.js',
    'test/browser/html-preview.test.js',
    'test/browser/safeguards.test.js',
  ],
  // 415.09s file work; 156.57, 155.00, 48.43, 28.47, 26.63
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
