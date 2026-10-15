import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRelease, rollbackArtifact } from './pack.mjs';
import { sha256 } from './lib/digest.mjs';
import { compareVersions } from './lib/version.mjs';

export function testConsumer(directory, { offline = true } = {}) {
  directory = resolve(directory);
  const manifest = verifyRelease(directory), scratch = mkdtempSync(join(tmpdir(), 'aithema-consumer-'));
  const modules = manifest.artifacts.filter(artifact => artifact.kind === 'module');
  const pin = { version: manifest.version, version_scheme: manifest.version_scheme, release_channel: manifest.release_channel,
    release_sequence: manifest.release_sequence, source_commit: manifest.source.commit,
    manifest_sha256: 'sha256:' + sha256(readFileSync(join(directory, 'release-set.json'))),
    packages: modules.map(({ name, path, sha256 }) => ({ name, path, sha256 })) };
  const npm = args => execFileSync('npm', [...args, ...(offline ? ['--offline'] : []), '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  try {
    writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'aithema-scratch-host', private: true, type: 'module' }));
    cpSync(new URL('./consumer-smoke.mjs', import.meta.url), join(scratch, 'smoke.mjs'));
    cpSync(new URL('../docs/embedding.md', import.meta.url), join(scratch, 'embedding.md'));
    writeFileSync(join(scratch, 'deployment-pin.json'), JSON.stringify(pin, null, 2) + '\n');
    const install = () => npm(['install', '--save-exact', ...modules.map(artifact => join(directory, artifact.path)), 'happy-dom@20.11.2']);
    const smoke = () => JSON.parse(execFileSync(process.execPath, ['smoke.mjs'], { cwd: scratch, encoding: 'utf8', timeout: 60_000 }).trim());
    install(); const installed = smoke();
    const locked = readFileSync(join(scratch, 'package-lock.json'));
    rmSync(join(scratch, 'node_modules'), { recursive: true }); npm(['ci']); const reinstalled = smoke();
    assert.equal(reinstalled.version, installed.version);
    assert.deepEqual(readFileSync(join(scratch, 'package-lock.json')), locked);
    // 0.10.1 is a private monolith with a different API, not the new split modules.
    // Exercise the actual dependency replacement boundary without claiming data/API compatibility.
    const legacy = JSON.parse(readFileSync(new URL('./history.json', import.meta.url))).releases.at(-1);
    assert.equal(legacy.version, '0.10.1');
    assert.equal(compareVersions({ ...legacy }, manifest, manifest.migration), -1);
    const retained = join(scratch, 'retained'); mkdirSync(retained);
    for (const name of ['release-set.json', ...manifest.artifacts.map(artifact => artifact.path)]) cpSync(join(directory, name), join(retained, name));
    const hostPackage = JSON.parse(readFileSync(join(scratch, 'package.json')));
    hostPackage.dependencies['@inspr/aithema-core'] = '0.10.1';
    writeFileSync(join(scratch, 'package.json'), JSON.stringify(hostPackage));
    install(); const updated = smoke();
    // Roll back a damaged deployment to the separately retained manifest and bytes.
    rmSync(join(scratch, 'node_modules'), { recursive: true });
    for (const artifact of modules) rollbackArtifact(retained, manifest, artifact.coordinate);
    npm(['install', '--save-exact', ...modules.map(artifact => join(retained, artifact.path)), 'happy-dom@20.11.2']);
    const rolledBack = smoke(); assert.equal(rolledBack.version, manifest.version);
    const evidence = { schema: 'aithema-consumer-evidence/1', ...pin, installed, locked_reinstall: reinstalled,
      update: { from: legacy.version, to: updated.version, scope: 'dependency pin replacement and anchored ordering; no legacy API/database migration',
        legacy_source_commit: legacy.source_commit, legacy_install: 'not applicable: private, retired monolith; no compatible split package release' },
      rollback: { retained_manifest_sha256: pin.manifest_sha256, verified_packages: modules.length, smoke: rolledBack } };
    writeFileSync(join(directory, 'consumer-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    writeFileSync(join(directory, 'deployment-pin.json'), JSON.stringify(pin, null, 2) + '\n');
    cpSync(join(scratch, 'package-lock.json'), join(directory, 'consumer-package-lock.json'));
    return evidence;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(testConsumer(process.argv[2] ?? 'dist/release', { offline: !process.argv.includes('--online') })));
}
