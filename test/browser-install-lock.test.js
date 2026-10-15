import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installOnce } from '../scripts/browser-install-lock.js';

test('cold-cache parallel processes install exactly once under an atomic lock', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ait199-install-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executable = join(dir, 'browser'), lockPath = join(dir, 'install.lock'), count = join(dir, 'downloads');
  const source = `import { installOnce } from ${JSON.stringify(new URL('../scripts/browser-install-lock.js', import.meta.url).href)};
    import { appendFile, writeFile } from 'node:fs/promises';
    await installOnce({executable: ${JSON.stringify(executable)}, lockPath: ${JSON.stringify(lockPath)}, pollMs: 10,
      install: async () => { await appendFile(${JSON.stringify(count)}, 'download\\n');
        await new Promise(r => setTimeout(r, 150)); await writeFile(${JSON.stringify(executable)}, 'ready', {mode: 0o755}); }});`;
  await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', x => { stderr += x; });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  assert.equal(await readFile(count, 'utf8'), 'download\n');
  await assert.rejects(access(lockPath), { code: 'ENOENT' });
});

test('failed installation releases its lock so another process can retry', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ait199-install-fail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const options = { executable: join(dir, 'browser'), lockPath: join(dir, 'install.lock') };
  await assert.rejects(installOnce({ ...options, install: async () => { throw new Error('download failed'); } }), /download failed/u);
  await assert.rejects(access(options.lockPath), { code: 'ENOENT' });
});
