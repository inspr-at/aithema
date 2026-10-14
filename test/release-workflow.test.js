import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
// npm ships this YAML parser; no new dependency is added to the repository.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
const yaml = require(join(npmRoot, 'npm/node_modules/yaml'));
test('workflow parses, only a matching pushed tag admits release packing, and PR pack has no upload', () => {
  const release = yaml.parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  assert.deepEqual(release.on.push.tags, ['v*']); assert.equal(release.on.pull_request, undefined);
  assert.equal(release.permissions.contents, 'read'); assert.equal(Object.keys(release.jobs).length, 1);
  assert.match(release.jobs.pack.if, /startsWith\(github.ref, 'refs\/tags\/'\)/u);
  const text = JSON.stringify(release); assert.doesNotMatch(text, /npm publish|gh release|git tag|git push|retain-forge/u);
  const ci = yaml.parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.equal(ci.on.pull_request, null); assert.deepEqual(ci.jobs.browser.strategy.matrix.shard, [1, 2, 3, 4]);
  assert.ok(ci.jobs.test.steps.some(step => step.run?.includes('release/dry-run.mjs')));
  assert.ok(ci.jobs.browser['timeout-minutes'] <= 8);
  assert.ok(ci.jobs.test['timeout-minutes'] <= 8);
  assert.ok(!ci.jobs.test.steps.some(step => step.uses?.includes('upload-artifact')));
});
