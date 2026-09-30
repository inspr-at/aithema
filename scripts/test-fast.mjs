#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const releaseTests = new Set(['packaging.test.js', 'source-export.test.js']);
const tests = readdirSync(resolve(repoRoot, 'test'), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js') && !releaseTests.has(entry.name))
  .map((entry) => `test/${entry.name}`)
  .sort();

// An empty argument list would make Node discover the slow release tests too.
if (tests.length === 0) throw new Error('no fast test files found');
const result = spawnSync(process.execPath, [
  '--test',
  `--test-concurrency=${availableParallelism()}`,
  ...tests,
], { cwd: repoRoot, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.status ?? 1;
