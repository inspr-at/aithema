import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function crash(mode, boundary) {
  const path = join(mkdtempSync(join(tmpdir(), 'aithema-e2e-')), 'host.sqlite');
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./crash.mjs', import.meta.url)), path, mode, boundary],
    { encoding: 'utf8', timeout: 15_000 });
  assert.equal(child.status, 42, `${mode}/${boundary}: ${child.stderr}`);
  return path;
}
