import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

// Four shards measured at 44d496a, PR #129 CI run 38457517452:
// browser runtimes 402.566s / 373.275s / 394.868s / 189.105s;
// whole jobs, including setup/evidence, 422s / 389s / 411s / 204s.
// Shards 1/3/4 passed. Shard 2 failed a 680px German footer-fit assertion,
// not its timeout; its duration is an incomplete measurement.
// Email-ask runs each behaviour once per language/width and captures both
// themes from each settled state: 153.965s remotely on mbp2606 (296 checks).
export const browserShards = [
  // 402.566s CI; 350.166s mbp2606
  ['test/browser/visitor-credit-tiers.test.js'],
  // 373.275s CI (footer-fit failure)
  [
    'test/browser/start2-display-matrix.test.js',
    'test/browser/demo.test.js',
    'test/browser/start-look.test.js',
    'test/browser/start2-display-continuity.test.js',
  ],
  // 394.868s CI
  [
    'test/browser/start2-display.test.js',
    'test/browser/orb-reveal.test.js',
    'test/browser/question-card.test.js',
    'test/browser/start-journey.test.js',
    'test/browser/html-preview.test.js',
    'test/browser/host-surface.test.js',
    'test/browser/confirmation-design.test.js',
  ],
  // 189.105s CI; 153.965s mbp2606
  ['test/browser/email-ask.test.js', 'test/browser/footer-width-sweep.test.js'],
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
