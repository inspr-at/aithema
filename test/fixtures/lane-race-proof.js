// Run ONLY in its isolated remote archive, never alongside the ordinary suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
const prompt = new URL('../../packages/core/src/prompts.js', import.meta.url);
test('AIT-198 role-order mutation red → restored green', { timeout: 30_000 }, async () => {
  const original = await readFile(prompt, 'utf8');
  const before = original.indexOf("      ...(lane === 'understanding' ? [{ role: 'user', content: JSON.stringify({ kind: 'analysis-instruction',");
  assert.ok(before > 0);
  // Remove only AIT-198's appended user-final instruction, retaining the rest of
  // the real prompt and exercising the real provider adapter and lane code.
  const end = original.indexOf(' }) }] : [])', before) + ' }) }] : [])'.length;
  assert.ok(end > before);
  const args = ['--test', '--test-name-pattern=AIT-198 reply published', 'test/lane-race-kit.test.js'];
  let red;
  try {
    await writeFile(prompt, original.slice(0, before) + original.slice(end));
    red = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15_000, env: childEnv });
  } finally { await writeFile(prompt, original); }
  assert.notEqual(red.status, 0); assert.match(red.stdout + red.stderr, /provider must accept|OpenRouter request failed/);
  console.log('AIT-198 RED: user-final instruction removed; real lane rejected (400 invalid_request_error, no usage).');
  const green = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15_000, env: childEnv });
  assert.equal(green.status, 0, green.stdout + green.stderr);
  assert.equal(await readFile(prompt, 'utf8'), original);
  console.log('AIT-198 GREEN: prompts.js restored byte-for-byte; reply-before-analysis test passes.');
});
