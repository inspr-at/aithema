#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const releaseProofFiles = new Set([
  'package.json',
  'package-lock.json',
  'test/packaging.test.js',
  'test/source-export.test.js',
  'test/fixtures/packaging-support.mjs',
]);

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function needsReleaseProof(path) {
  return releaseProofFiles.has(path)
    || path.startsWith('release/')
    || path.startsWith('bin/')
    || /^scripts\/.*(?:export|packag)/.test(path);
}

try {
  const [baseRef, ...extra] = process.argv.slice(2);
  if (!baseRef || baseRef.startsWith('-') || extra.length) {
    throw new Error('expected one base commit ref');
  }
  const base = git(['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`]).trim();
  // Disable rename detection so moving a release file away still triggers proof.
  // Keep index and worktree diffs separate: their changes can cancel in diff HEAD.
  const changes = [
    git(['diff', '--name-only', '-z', '--no-renames', `${base}...HEAD`, '--']),
    git(['diff', '--name-only', '-z', '--no-renames', '--cached', '--']),
    git(['diff', '--name-only', '-z', '--no-renames', '--']),
    git(['ls-files', '--others', '--exclude-standard', '-z']),
  ].flatMap((output) => output.split('\0').filter(Boolean));
  const required = changes.some(needsReleaseProof);
  process.stdout.write(`release-proof: ${required ? 'required' : 'not-required'}\n`);
} catch {
  process.stderr.write('release-proof: unable to compare base ref (expected one valid commit ref)\n');
  process.exitCode = 2;
}
