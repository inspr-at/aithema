// Temporary CI-only AIT-222 reproduction; removed after the investigation.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
assert.equal(process.platform, 'linux', 'heavy reproduction belongs on CI');
const directory = await mkdtemp(join(tmpdir(), 'ait-222-'));
try {
  const target = new URL('../packages/core/test/extractor-process.test.js', import.meta.url).href;
  const files = await Promise.all(Array.from({ length: 500 }, async (_, index) => {
    const file = join(directory, `extractor-${index}.mjs`);
    await writeFile(file, `import ${JSON.stringify(target)};\n`);
    return file;
  }));
  for (const { name, repeats, pattern, count } of [
    { name: 'crash-only', repeats: 500, pattern: '^child crash without', count: 500 },
    { name: 'complete file', repeats: 50, count: 700 },
  ]) {
    console.log(`AIT-222: ${process.version}, ${name}, ${repeats} copies, concurrency 8, no CPU workers`);
    const child = spawn(process.execPath, ['--test', '--test-reporter=spec', '--test-concurrency=8',
      '--test-timeout=90000', '--import', new URL('./unit-watchdog.js', import.meta.url).href,
      ...(pattern ? [`--test-name-pattern=${pattern}`] : []), ...files.slice(0, repeats)],
      { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-8192); process.stdout.write(chunk); });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, name);
    assert.match(output, new RegExp(`ℹ tests ${count}\\b`, 'u'), 'every requested test must execute');
    console.log(`AIT-222: ${name}, ${repeats} repetitions passed`);
  }
} finally { await rm(directory, { recursive: true, force: true }); }
