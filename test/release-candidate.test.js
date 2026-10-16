import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('candidate builds twice, installs outside the workspace, mounts handlers/components, updates and rolls back', { timeout: 180_000 }, () => {
  const output = process.env.AITHEMA_EVIDENCE_DIR ? join(process.env.AITHEMA_EVIDENCE_DIR, 'candidate') : mkdtempSync(join(tmpdir(), 'aithema-candidate-'));
  mkdirSync(output, { recursive: true });
  execFileSync('npm', ['run', 'release:candidate', '--', output], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'pipe', timeout: 180_000,
  });
  const evidence = JSON.parse(readFileSync(join(output, 'candidate-evidence.json')));
  const version = JSON.parse(readFileSync(new URL('../release/version.json', import.meta.url)));
  assert.equal(evidence.version, version.version);
  assert.equal(evidence.consumer.release_sequence, version.release_sequence);
  assert.equal(evidence.reproducible, true);
  assert.equal(evidence.consumer.installed.runtime_exports, 'all');
  assert.ok(evidence.consumer.installed.symbols >= 30);
  assert.equal(evidence.consumer.rollback.verified_packages, 15);
});
