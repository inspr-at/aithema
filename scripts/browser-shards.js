import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

// AIT-177 measured per-file seconds: PR #150 ci run 38592417042 at da0dbe9.
// Previous whole jobs: 446 / 454 / 408 / 414 s (480 s headroom budget).
// Assign largest files first to the lightest shard: ~413 s of tests per job,
// plus ~18 s of measured setup/upload overhead targets ~10% headroom.
// Keep all scenarios and four shared-runner jobs; no file split is needed.
// operator-login remains isolated by scripts/test-browser.js in its own worker.
export const browserShards = [
  // 413.79s; per-file seconds: 220.22, 99.91, 41.48, 24.92, 19.24, 8.01
  [
    'test/browser/email-ask.test.js',
    'test/browser/orb-reveal.test.js',
    'test/browser/voice-presentation.test.js',
    'test/browser/start-look.test.js',
    'test/browser/audio-replay.test.js',
    'test/browser/host-surface.test.js',
  ],
  // 412.60s; per-file seconds: 199.16, 104.76, 96.05, 12.64
  [
    'test/browser/visitor-credit-tiers-en.test.js',
    'test/browser/confirmation-design.test.js',
    'test/browser/email-mail-space.test.js',
    'test/browser/footer-width-sweep.test.js',
  ],
  // 413.37s; per-file seconds: 193.27, 117.84, 42.80, 40.30, 14.35, 4.82
  [
    'test/browser/start2-display-matrix.test.js',
    'test/browser/start2-display-continuity.test.js',
    'test/browser/demo.test.js',
    'test/browser/admin-pages.test.js',
    'test/browser/start-journey.test.js',
    'test/browser/safeguards.test.js',
  ],
  // 412.81s; per-file seconds: 189.97, 157.70, 40.71, 15.99, 8.43
  [
    'test/browser/visitor-credit-tiers.test.js',
    'test/browser/start2-display.test.js',
    'test/browser/operator-login.test.js',
    'test/browser/question-card.test.js',
    'test/browser/html-preview.test.js',
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
