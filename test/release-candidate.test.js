import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizedDigest } from '../release/normalize.mjs';

function candidateEnv() {
  return {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    CHROME_PATH: process.env.CHROME_PATH,
    npm_config_cache: process.env.npm_config_cache, NPM_CONFIG_CACHE: process.env.NPM_CONFIG_CACHE,
    AITHEMA_CANONICAL_RELEASE: process.env.AITHEMA_CANONICAL_RELEASE,
  };
}

test('candidate builds twice, installs outside the workspace, mounts handlers/components, updates and rolls back', { timeout: 180_000 }, () => {
  const output = process.env.AITHEMA_EVIDENCE_DIR ? join(process.env.AITHEMA_EVIDENCE_DIR, 'candidate') : mkdtempSync(join(tmpdir(), 'aithema-candidate-'));
  mkdirSync(output, { recursive: true });
  const env = candidateEnv();
  execFileSync('npm', ['run', 'release:candidate', '--', output], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), env, stdio: 'pipe', timeout: 180_000,
  });
  const evidence = JSON.parse(readFileSync(join(output, 'candidate-evidence.json')));
  assert.equal(evidence.runner, hostname());
  const version = JSON.parse(readFileSync(new URL('../release/version.json', import.meta.url)));
  assert.equal(evidence.version, version.version);
  assert.equal(evidence.normalized_digest, normalizedDigest(join(output, 'first')));
  assert.equal(evidence.consumer.release_sequence, version.release_sequence);
  assert.equal(evidence.reproducible, true);
  assert.equal(evidence.consumer.installed.runtime_exports, 'all');
  assert.equal(evidence.consumer.update.from, version.migration.last_legacy_version);
  const consumerLock = JSON.parse(readFileSync(join(output, 'first/consumer-package-lock.json')));
  assert.equal(consumerLock.packages['node_modules/axe-core'], undefined, 'evidence-only axe is absent from the isolated consumer closure');
  for (const smoke of [evidence.consumer.installed, evidence.consumer.locked_reinstall, evidence.consumer.rollback.smoke]) {
    assert.equal(smoke.verified_packages, 16);
    assert.equal(smoke.grok.call, 'joined PCM/STT/admitted reasoning/TTS/relay');
    assert.equal(smoke.grok.child_claims, 2);
    assert.equal(smoke.grok.provider_calls, 0);
    assert.equal(smoke.grok.qualification, 'not yet qualified in live use');
    assert.ok(smoke.verified_files > 100);
    assert.equal(smoke.conversation.turns, 1);
    assert.equal(smoke.conversation.consent, 'granted');
    assert.equal(smoke.conversation.overview, 'current, settled and content verified');
  }
  assert.ok(evidence.consumer.installed.symbols >= 30);
  assert.equal(evidence.consumer.rollback.verified_packages, 16);
});

test('candidate evidence outside CI records os.hostname() on another host', { timeout: 180_000 }, () => {
  const output = mkdtempSync(join(tmpdir(), 'aithema-candidate-host-'));
  const env = candidateEnv();
  // mbp2606 is the test host, so exercise a different OS hostname as well.
  // Patch only the OS boundary; run the real evidence builder and its checks.
  const script = `
    import os from 'node:os';
    import { syncBuiltinESMExports } from 'node:module';
    import assert from 'node:assert/strict';
    os.hostname = () => 'candidate-host.example.test';
    syncBuiltinESMExports();
    const { buildCandidate } = await import('./release/candidate.mjs');
    const evidence = buildCandidate(process.argv[1]);
    assert.equal(evidence.runner, os.hostname());
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script, output], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), env, stdio: 'pipe', timeout: 180_000,
  });
  const evidence = JSON.parse(readFileSync(join(output, 'candidate-evidence.json')));
  assert.equal(evidence.runner, 'candidate-host.example.test');
});

test('candidate evidence in CI records GitHub Actions and the run id', { timeout: 180_000 }, () => {
  const output = mkdtempSync(join(tmpdir(), 'aithema-candidate-ci-'));
  execFileSync('npm', ['run', 'release:candidate', '--', output], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...candidateEnv(), GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '370123456' },
    stdio: 'pipe', timeout: 180_000,
  });
  const evidence = JSON.parse(readFileSync(join(output, 'candidate-evidence.json')));
  assert.equal(evidence.runner, 'GitHub Actions 370123456');
});
