// Run through remote-browser.sh unit scripts/extractor-crash-stress.js.
// Distinct wrappers make Node execute the complete file 50 times, four at a
// time, while two bounded CPU workers add scheduling pressure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';

test('extractor process file survives 50 repetitions under CPU pressure', { timeout: 600_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ait-222-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pressure = Array.from({ length: 2 }, () => new Worker(
    'const until = Date.now() + 540000; while (Date.now() < until) Math.sqrt(Math.random());', { eval: true }));
  t.after(() => Promise.all(pressure.map(worker => worker.terminate())));
  const target = new URL('../packages/core/test/extractor-process.test.js', import.meta.url).href;
  const files = await Promise.all(Array.from({ length: 50 }, async (_, index) => {
    const file = join(directory, `extractor-${index}.mjs`);
    await writeFile(file, `import ${JSON.stringify(target)};\n`);
    return file;
  }));
  console.log(`AIT-222 stress: ${process.version}, ${process.platform}, 50 files, concurrency 4, CPU workers 2`);
  const child = spawn(process.execPath, ['--test', '--test-concurrency=4', '--test-timeout=90000', ...files],
    { stdio: ['ignore', 'inherit', 'inherit'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0);
});
