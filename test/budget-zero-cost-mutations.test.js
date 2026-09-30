import { it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Copy real files: ESM follows symlinks back to the unmutated source tree.
// Only offline SQLite fixtures and stub providers run in these children.
const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'aithema-zero-budget-mutations-'));
for (const directory of ['contracts', 'lib', 'runtime', 'test/fixtures']) {
  cpSync(join(root, directory), join(scratch, directory), { recursive: true });
}
for (const name of ['budget-zero-cost', 'engine-zero-cost', 'engine-helpers']) {
  cpSync(join(root, `test/${name}.test.js`), join(scratch, `test/${name}.test.js`));
}
const originals = new Map(['contracts/index.json', 'runtime/budget/local.js', 'runtime/settings/resolver.js']
  .map((path) => [path, readFileSync(join(root, path), 'utf8')]));

function replace(source, before, after) {
  assert.equal(source.split(before).length, 2, 'mutation must identify exactly one source site');
  return source.replace(before, after);
}
function downgrade(source, contract) {
  const index = JSON.parse(source);
  const entry = index.contracts.find((row) => row.contract === contract);
  assert.equal(entry.minor, 1);
  entry.minor = 0;
  return JSON.stringify(index);
}

const loopbackPattern = 'share one loopback authority';
const mutations = [
  ['budget reader minor', 'contracts/index.json', 'budget-zero-cost', 'reader minor 1 accepts budget|minor-1 budget admission',
    (source) => downgrade(source, 'aithema.budget.message')],
  ['journal reader minor', 'contracts/index.json', 'budget-zero-cost', 'reader minor 1 accepts record|minor-1 budget admission',
    (source) => downgrade(source, 'aithema.journal.record')],
  ['shared loopback predicate narrowed to one IPv4 address', 'runtime/budget/local.js', 'engine-zero-cost', loopbackPattern,
    (source) => replace(source, "host.startsWith('127.')", "host === '127.0.0.1'")],
  ['shared loopback predicate accepts a DNS suffix impersonation', 'runtime/budget/local.js', 'engine-zero-cost', loopbackPattern,
    (source) => replace(source, "isIP(host) === 4 && host.startsWith('127.')", "host.startsWith('127.')")],
  ['budget qualification bypasses the shared predicate', 'runtime/budget/local.js', 'engine-zero-cost', loopbackPattern,
    (source) => replace(source, 'return isLoopbackHost(new URL(row.template.endpoint).hostname);', 'return true;')],
  ['settings endpoint bypasses the shared predicate', 'runtime/settings/resolver.js', 'engine-zero-cost', loopbackPattern,
    (source) => replace(source, 'const loopback = isLoopbackHost(url.hostname);', 'const loopback = true;')],
  ['settings local allowlist bypasses the shared predicate', 'runtime/settings/resolver.js', 'engine-zero-cost', loopbackPattern,
    (source) => replace(source, '!hosts.every(isLoopbackHost)', 'false')],
  ['settings proxy rejects a valid loopback subnet host', 'runtime/settings/resolver.js', 'engine-zero-cost', loopbackPattern,
    (source) => replace(source, '!isLoopbackHost(new URL(settings.hosting.proxy).hostname)', 'true')],
  ['settings template rejects a valid loopback subnet host', 'runtime/settings/resolver.js', 'engine-zero-cost', loopbackPattern,
    (source) => replace(source, '!isLoopbackHost(new URL(template.endpoint).hostname)', 'true')],
];

function regression(suite, pattern) {
  return spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=${pattern}`, `test/${suite}.test.js`], {
    cwd: scratch, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
}
const baselines = new Set();
for (const [name, path, suite, pattern, mutate] of mutations) {
  it(`AIT-88 mutation proof: ${name} turns its regression red`, () => {
    for (const [originalPath, source] of originals) writeFileSync(join(scratch, originalPath), source);
    const baselineId = `${suite}:${pattern}`;
    if (!baselines.has(baselineId)) {
      const baseline = regression(suite, pattern), report = baseline.stdout + baseline.stderr;
      assert.equal(baseline.error, undefined, report);
      assert.equal(baseline.status, 0, `Unmutated regression must be green:\n${report}`);
      assert.match(report, /# pass [1-9][0-9]*/, 'pattern must run a passing baseline test');
      baselines.add(baselineId);
    }
    writeFileSync(join(scratch, path), mutate(originals.get(path)));
    const child = regression(suite, pattern), report = child.stdout + child.stderr;
    assert.equal(child.error, undefined, report);
    assert.equal(child.status, 1, report);
    assert.doesNotMatch(report, /SyntaxError|ERR_MODULE_NOT_FOUND/);
    assert.match(report, /# fail [1-9][0-9]*/);
    assert.match(report, /failureType: 'testCodeFailure'/);
  });
}
