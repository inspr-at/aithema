import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

// Balanced using main 027746e CI run 38334109506, A2 PR CI run
// 38331186287, and AIT-138 d PR #117 CI run 38337837967.
// Top-level durations exclude nested tests: visitor-credit-tiers 345.610s;
// matrix 209.159s; remaining display 145.660s; continuity 45.348s;
// orb 86.337s; demo 51.826s; look 26.476s; question-card 17.223s;
// journey 13.973s; html 8.406s; host 7.586s.
export const browserShards = [
  // 345.610s
  ['test/browser/visitor-credit-tiers.test.js'],
  // 332.809s
  [
    'test/browser/start2-display-matrix.test.js',
    'test/browser/email-ask.test.js',
    'test/browser/demo.test.js',
    'test/browser/start-look.test.js',
    'test/browser/start2-display-continuity.test.js',
  ],
  // 279.185s
  [
    'test/browser/start2-display.test.js',
    'test/browser/orb-reveal.test.js',
    'test/browser/question-card.test.js',
    'test/browser/start-journey.test.js',
    'test/browser/html-preview.test.js',
    'test/browser/host-surface.test.js',
    'test/browser/confirmation-design.test.js',
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
