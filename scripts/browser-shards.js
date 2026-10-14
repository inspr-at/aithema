import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

// AIT-177 per-file measurements: PR #150 ci run 38588609753 at 05f2509.
// Sum every top-level test, including the dynamically named DE/EN orb tests.
// Main 27dbafb (38580264760) and recent PR #145 (38585047142) corroborate
// the heavy files. Previous main whole jobs: 428 / 475 / 447 / 456 s;
// PR #145 reached 498 s in shard 3. Keep four shared-runner jobs.
// Visitor DE/EN split at the existing language boundary, with all 12 matrix
// combinations retained: independently measured 197.80 / 199.60 s in PR CI.
// Planned test totals: 423.54 / 426.40 / 416.14 / 423.48 s,
// plus setup, evidence and worker overhead (13-24 s): about 8-10% headroom.
export const browserShards = [
  // 423.54s; per-file seconds: 219.52, 98.04, 46.85, 30.14, 20.76, 8.23
  [
    'test/browser/email-ask.test.js',
    'test/browser/confirmation-design.test.js',
    'test/browser/voice-presentation.test.js',
    'test/browser/operator-login.test.js',
    'test/browser/footer-width-sweep.test.js',
    'test/browser/html-preview.test.js',
  ],
  // 426.40s; per-file seconds: 199.60, 99.55, 86.36, 25.59, 15.30
  [
    'test/browser/visitor-credit-tiers-en.test.js',
    'test/browser/start2-display-continuity.test.js',
    'test/browser/orb-reveal.test.js',
    'test/browser/audio-replay.test.js',
    'test/browser/question-card.test.js',
  ],
  // 416.14s; per-file seconds: 197.80, 110.35, 48.81, 43.07, 16.12
  [
    'test/browser/visitor-credit-tiers.test.js',
    'test/browser/email-mail-space.test.js',
    'test/browser/demo.test.js',
    'test/browser/admin-pages.test.js',
    'test/browser/start-journey.test.js',
  ],
  // 423.48s; per-file seconds: 195.93, 194.66, 25.04, 7.85
  [
    'test/browser/start2-display.test.js',
    'test/browser/start2-display-matrix.test.js',
    'test/browser/start-look.test.js',
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
