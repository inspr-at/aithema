// Temporary CI-only AIT-222 reproduction; removed after the investigation.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
assert.equal(process.platform, 'linux', 'heavy reproduction belongs on CI');
const repeats = 500, concurrency = 8;
const directory = await mkdtemp(join(tmpdir(), 'ait-222-'));
try {
  const target = new URL('../packages/core/test/extractor-process.test.js', import.meta.url).href;
  const files = await Promise.all(Array.from({ length: repeats }, async (_, index) => {
    const file = join(directory, `extractor-${index}.mjs`);
    await writeFile(file, `import ${JSON.stringify(target)};\n`);
    return file;
  }));
  console.log(`AIT-222: ${process.version}, ${repeats} copies, concurrency ${concurrency}, no CPU workers`);
  // A standalone runner has no inherited test-worker context.
  const child = spawn(process.execPath, ['--test', '--test-reporter=spec', `--test-concurrency=${concurrency}`,
    '--test-timeout=90000', '--import', new URL('./unit-watchdog.js', import.meta.url).href,
    '--test-name-pattern=^child crash without', ...files], { stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0);
  console.log(`AIT-222: ${repeats} repetitions passed`);
} finally { await rm(directory, { recursive: true, force: true }); }
