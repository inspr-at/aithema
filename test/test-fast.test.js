import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { trashTemp } from './fixtures/packaging-support.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const script = fileURLToPath(new URL('../scripts/test-fast.mjs', import.meta.url));
const releaseTests = new Set(['packaging.test.js', 'source-export.test.js']);

function fastPlan() {
  return readdirSync(join(repoRoot, 'test'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js') && !releaseTests.has(entry.name))
    .map((entry) => `test/${entry.name}`)
    .sort();
}

describe('fast test runner', () => {
  it('excludes the release proofs and passes --test-concurrency', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'aithema-test-fast-'));
    t.after(() => trashTemp(dir));
    const fake = join(dir, 'fake-child-process.mjs');
    const preload = join(dir, 'preload.mjs');
    writeFileSync(fake, `export function spawnSync(command, args) {
  process.stdout.write(JSON.stringify({ command, args }) + '\\n');
  return { status: 0 };
}
`);
    writeFileSync(preload, `import { registerHooks } from 'node:module';
const fake = ${JSON.stringify(pathToFileURL(fake).href)};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'node:child_process') return { url: fake, shortCircuit: true };
    return next(specifier, context);
  },
});
`);
    for (const name of releaseTests) {
      assert.equal(existsSync(join(repoRoot, 'test', name)), true, `${name} must exist to prove it is excluded`);
    }
    const result = spawnSync(process.execPath, ['--import', preload, script], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const captured = JSON.parse(result.stdout);
    assert.equal(captured.command, process.execPath);
    assert.deepEqual(captured.args, ['--test', `--test-concurrency=${availableParallelism()}`, ...fastPlan()]);
    for (const name of releaseTests) assert.equal(captured.args.includes(`test/${name}`), false);
  });
});
