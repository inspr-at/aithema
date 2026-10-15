// Temporary remote-only mutation proof; removed after evidence is captured.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const mutations = [
  ['mismatched generation retains hold', 'packages/server/src/budget.js',
    "      if (record.generationId && record.generationId !== evidence.generationId) throw new PluginError('not-admitted');", ''],
  ['second 4xx propagates', 'packages/core/src/safeguards.js',
    "error.providerErrorClass !== '4xx'", 'true'],
  ['usage token floor determines settlement', 'packages/server/src/plugin-runtime.js',
    'plugin.usageCost?.(usage, record.model) ?? 0', '0'],
  ['later lower estimate preserves floor', 'packages/server/src/plugin-runtime.js',
    'previous?.estimated ? previous.chargedMicro : 0', '0'],
];
for (const [name, path, before, after] of mutations) test(`red-before: ${name}`, () => {
  const original = readFileSync(path, 'utf8');
  assert.ok(original.includes(before));
  try {
    writeFileSync(path, original.replace(before, after));
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', `--test-name-pattern=${name}`, 'test/plugin-contract-behaviour.test.js'], { encoding: 'utf8', env: childEnv });
    console.log(result.stdout, result.stderr);
    assert.equal(result.status, 1, 'the behaviour test must fail under the mutation');
    assert.match(result.stdout, /AssertionError|ERR_ASSERTION/);
  } finally { writeFileSync(path, original); }
});
