import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);

test('AIT-510: production-only workspace installation loads the native normalizer on the admitted lane', { timeout: 180000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'aithema-image-production-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['package.json', 'package-lock.json']) cpSync(new URL('../' + name, import.meta.url), join(root, name));
  for (const group of ['packages', 'plugins']) {
    const source = new URL('../' + group + '/', import.meta.url);
    for (const name of readdirSync(source)) {
      const folder = new URL(name + '/', source);
      if (!existsSync(new URL('package.json', folder))) continue;
      const destination = join(root, group, name); mkdirSync(destination, { recursive: true });
      cpSync(new URL('package.json', folder), join(destination, 'package.json'));
      if (existsSync(new URL('src/', folder))) cpSync(new URL('src/', folder), join(destination, 'src'), {
        recursive: true, filter: path => !/^\.env/u.test(basename(path)) && !/\.age$/u.test(path),
      });
    }
  }
  mkdirSync(join(root, 'scripts')); cpSync(new URL('../scripts/qualify-image-input.js', import.meta.url), join(root, 'scripts/qualify-image-input.js'));
  await execute('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline'], { cwd: root, timeout: 120000, maxBuffer: 1024 * 1024 });
  assert.equal(existsSync(join(root, 'node_modules/happy-dom')), false, 'development tools are absent');
  const { stdout } = await execute(process.execPath, ['scripts/qualify-image-input.js'], { cwd: root, timeout: 30000, maxBuffer: 65536 });
  const result = JSON.parse(stdout.trim()); assert.equal(result.normalized, true); assert.equal(result.platform, process.platform);
  if (process.env.AITHEMA_EVIDENCE_DIR) {
    mkdirSync(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(process.env.AITHEMA_EVIDENCE_DIR, `image-production-${process.platform}-${process.arch}.json`), JSON.stringify(result) + '\n');
  }
});
