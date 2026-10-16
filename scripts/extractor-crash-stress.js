// Run through remote-browser.sh unit scripts/extractor-crash-stress.js.
// Distinct wrappers make Node execute the complete file independently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const repeats = Number(process.env.AITHEMA_EXTRACTOR_STRESS_REPEATS ?? 500), concurrency = 8, cpuWorkers = 4;
test('extractor process file survives repeated execution under CPU pressure', { timeout: 600_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ait-222-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const execute = promisify(execFile);
  let executable = process.execPath;
  if (process.platform === 'darwin') {
    const archive = join(directory, 'node.tar.gz');
    await execute('/usr/bin/curl', ['-fsSL', 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-x64.tar.gz', '-o', archive]);
    assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'),
      '1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097');
    await execute('/usr/bin/tar', ['-xzf', archive, '-C', directory]);
    executable = join(directory, 'node-v24.21.0-darwin-x64/bin/node');
  }
  const pressure = Array.from({ length: cpuWorkers }, () => new Worker(
    'const until = Date.now() + 540000; while (Date.now() < until) Math.sqrt(Math.random());', { eval: true }));
  t.after(() => Promise.all(pressure.map(worker => worker.terminate())));
  const target = new URL('../packages/core/test/extractor-process.test.js', import.meta.url).href;
  const files = await Promise.all(Array.from({ length: repeats }, async (_, index) => {
    const file = join(directory, `extractor-${index}.mjs`);
    await writeFile(file, `import ${JSON.stringify(target)};\n`);
    return file;
  }));
  const { stdout: version } = await execute(executable, ['--version']);
  console.log(`AIT-222 stress: ${version.trim()}, ${process.platform}, ${repeats} files, concurrency ${concurrency}, CPU workers ${cpuWorkers}`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // This is an independent runner, not its parent's test worker.
  const pattern = process.env.AITHEMA_EXTRACTOR_STRESS_PATTERN;
  const child = spawn(executable, ['--test', '--test-reporter=spec', `--test-concurrency=${concurrency}`, '--test-timeout=90000',
    '--import', new URL('./unit-watchdog.js', import.meta.url).href,
    ...(pattern ? [`--test-name-pattern=${pattern}`] : []), ...files],
    { env, stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0);
  assert.match(output, new RegExp(`ℹ tests ${repeats * 14}\\b`, 'u'), 'every copy must actually execute its 14 tests');
  console.log(`AIT-222 completed: ${version.trim()}, ${repeats} full-file repetitions, concurrency ${concurrency}, CPU workers ${cpuWorkers}`);
});
