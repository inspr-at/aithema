// One sequential mbp2606 invocation: the mutation proof must never overlap tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const exec = promisify(execFile);
test('AIT-201 isolated sequential validation and viewport evidence', { timeout: 800_000 }, async () => {
  const results = [], childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
  for (const [name, command, args] of [
    ['role-order-proof', process.execPath, ['--test', 'test/fixtures/lane-race-proof.js']],
    ['unit', 'npm', ['test']],
    ['touched-browsers', process.execPath, ['--test', '--test-concurrency=1', 'test/browser/lane-race-kit.test.js', 'test/browser/understanding-failure.test.js']],
  ]) {
    const started = performance.now(); let status = 0, stdout, stderr;
    try { ({ stdout, stderr } = await exec(command, args, { env: childEnv, timeout: 600_000, maxBuffer: 32 * 1024 * 1024 })); }
    catch (error) { status = error.code ?? 1; stdout = error.stdout ?? ''; stderr = error.stderr ?? ''; }
    const lines = (stdout + stderr).split('\n');
    const counts = lines.flatMap(line => /(?:ℹ|#) tests (\d+)/u.exec(line)?.[1] ?? []).map(Number);
    const minimum = name === 'unit' ? 1000 : name === 'touched-browsers' ? 10 : 1;
    if (!counts.some(count => count >= minimum)) status = 'missing-test-count';
    if (name === 'role-order-proof' && !['AIT-198 RED:', 'AIT-198 GREEN:'].every(marker => stdout.includes(marker))) status = 'missing-proof';
    const summary = lines.filter(line => /AIT-198 (RED|GREEN)|[ℹ#] (tests|pass|fail|cancelled|duration_ms)|✖/u.test(line));
    results.push({ name, status, durationMs: Math.round(performance.now() - started), summary });
    console.log(`AIT-201 ${name}: status ${status}`); console.log(summary.join('\n'));
    if (status) console.log(lines.slice(-180).join('\n'));
  }
  if (process.env.AITHEMA_EVIDENCE_DIR) {
    await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true });
    await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, 'ait201-validation.json'), JSON.stringify(results, null, 2));
  }
  assert.ok(results.every(result => result.status === 0), JSON.stringify(results));
});
