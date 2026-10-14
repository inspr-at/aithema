import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

// AIT-177 measurements: main 27dbafb, ci run 38580264760; corroborated by
// main bb55b49 (38576748175) and PR #145 (38585047142). Main whole jobs:
// 428 / 475 / 447 / 456 s, including setup and evidence upload.
// Top-level test durations summed per file (seconds), in manifest order:
// 219.32, 96.06, 56.85, 23.18, 16.52, 7.94;
// 212.26, 108.54, 40.46, 27.78, 20.58, 8.47;
// 407.93/2, 198.06, 12.46;
// 407.93/2, 114.39, 42.68, 40.32, 16.01.
// Visitor DE/EN use the existing language boundary, retaining all 12 matrix
// combinations; half its measured total is a planning estimate until PR CI.
// Planned browser totals: 419.86 / 418.10 (+ greeting regression) / 414.48 /
// 417.37 s. Setup/evidence took 18-24 s on main: about 9% below 480 s.
export const browserShards = [
  [
    'test/browser/email-ask.test.js',
    'test/browser/confirmation-design.test.js',
    'test/browser/demo.test.js',
    'test/browser/orb-reveal.test.js',
    'test/browser/start-journey.test.js',
    'test/browser/host-surface.test.js',
  ],
  [
    'test/browser/start2-display-matrix.test.js',
    'test/browser/start2-display-continuity.test.js',
    'test/browser/operator-login.test.js',
    'test/browser/start-look.test.js',
    'test/browser/audio-replay.test.js',
    'test/browser/html-preview.test.js',
  ],
  [
    'test/browser/visitor-credit-tiers.test.js',
    'test/browser/start2-display.test.js',
    'test/browser/footer-width-sweep.test.js',
  ],
  [
    'test/browser/visitor-credit-tiers-en.test.js',
    'test/browser/email-mail-space.test.js',
    'test/browser/voice-presentation.test.js',
    'test/browser/admin-pages.test.js',
    'test/browser/question-card.test.js',
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
