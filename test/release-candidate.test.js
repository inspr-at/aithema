import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCandidate } from '../release/candidate.mjs';

test('candidate builds twice, installs outside the workspace, mounts handlers/components, updates and rolls back', { timeout: 180_000 }, () => {
  const output = process.env.AITHEMA_EVIDENCE_DIR ? join(process.env.AITHEMA_EVIDENCE_DIR, 'candidate') : mkdtempSync(join(tmpdir(), 'aithema-candidate-'));
  mkdirSync(output, { recursive: true });
  const evidence = buildCandidate(output);
  assert.equal(evidence.reproducible, true);
  assert.equal(evidence.consumer.installed.runtime_exports, 'all');
  assert.ok(evidence.consumer.installed.symbols >= 30);
  assert.equal(evidence.consumer.rollback.verified_packages, 15);
});
