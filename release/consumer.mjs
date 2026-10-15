import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRelease, rollbackArtifact } from './pack.mjs';
import { sha256 } from './lib/digest.mjs';
import { compareVersions } from './lib/version.mjs';

export function testConsumer(directory, { offline = true } = {}) {
  directory = resolve(directory);
  const manifest = verifyRelease(directory), scratch = mkdtempSync(join(tmpdir(), 'aithema-consumer-'));
  const modules = manifest.artifacts.filter(artifact => artifact.kind === 'module');
  const sourceLock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url)));
  const pin = { version: manifest.version, version_scheme: manifest.version_scheme, release_channel: manifest.release_channel,
    release_sequence: manifest.release_sequence, source_commit: manifest.source.commit,
    manifest_sha256: 'sha256:' + sha256(readFileSync(join(directory, 'release-set.json'))),
    packages: modules.map(({ name, path, sha256 }) => ({ name, path, sha256 })) };
  const npm = args => execFileSync('npm', [...args, ...(offline ? ['--offline'] : []), '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  try {
    const hostPackage = { name: 'aithema-scratch-host', version: '0.0.0', private: true, type: 'module',
      dependencies: { 'happy-dom': sourceLock.packages['node_modules/happy-dom'].version } };
    const locked = { name: hostPackage.name, version: hostPackage.version, lockfileVersion: 3, requires: true, packages: { '': hostPackage } };
    // Resolve the exact external closure from the source lock. npm ci caches the
    // tarballs, but does not necessarily cache registry metadata for npm install.
    function external(name, from = '', optional = false) {
      let ancestor = from, path;
      while (ancestor) {
        const candidate = `${ancestor}/node_modules/${name}`;
        if (sourceLock.packages[candidate]) { path = candidate; break; }
        ancestor = posix.dirname(ancestor); if (ancestor === '.') ancestor = '';
      }
      path ??= `node_modules/${name}`;
      const pkg = sourceLock.packages[path];
      if (!pkg) { if (optional) return; throw new Error(`Missing locked dependency: ${name}`); }
      if (locked.packages[path]) return;
      locked.packages[path] = { ...pkg }; delete locked.packages[path].dev;
      for (const dependency of Object.keys(pkg.dependencies ?? {})) external(dependency, path);
      for (const dependency of Object.keys(pkg.optionalDependencies ?? {})) external(dependency, path, true);
      for (const dependency of Object.keys(pkg.peerDependencies ?? {})) external(dependency, path, pkg.peerDependenciesMeta?.[dependency]?.optional);
    }
    const moduleNames = new Set(modules.map(artifact => artifact.name));
    for (const artifact of modules) {
      const path = join(directory, artifact.path), metadata = JSON.parse(execFileSync('tar', ['-xOzf', path, 'package/package.json']));
      const specifier = `file:artifacts/${artifact.path}`; hostPackage.dependencies[artifact.name] = specifier;
      locked.packages[`node_modules/${artifact.name}`] = { name: artifact.name, version: manifest.version, resolved: specifier,
        integrity: 'sha512-' + createHash('sha512').update(readFileSync(path)).digest('base64'),
        dependencies: metadata.dependencies ?? {}, engines: metadata.engines, license: metadata.license, ...(metadata.bin ? { bin: metadata.bin } : {}) };
      for (const name of Object.keys(metadata.dependencies ?? {})) if (!moduleNames.has(name)) external(name);
    }
    external('happy-dom');
    writeFileSync(join(scratch, 'package.json'), JSON.stringify(hostPackage));
    writeFileSync(join(scratch, 'package-lock.json'), JSON.stringify(locked, null, 2) + '\n');
    cpSync(new URL('./consumer-smoke.mjs', import.meta.url), join(scratch, 'smoke.mjs'));
    cpSync(new URL('../docs/embedding.md', import.meta.url), join(scratch, 'embedding.md'));
    writeFileSync(join(scratch, 'deployment-pin.json'), JSON.stringify(pin, null, 2) + '\n');
    mkdirSync(join(scratch, 'artifacts'));
    for (const artifact of modules) cpSync(join(directory, artifact.path), join(scratch, 'artifacts', artifact.path));
    const install = () => npm(['install', '--save-exact', ...modules.map(artifact => './artifacts/' + artifact.path)]);
    const smoke = () => JSON.parse(execFileSync(process.execPath, ['smoke.mjs'], { cwd: scratch, encoding: 'utf8', timeout: 60_000 }).trim());
    npm(['ci']); const installed = smoke();
    for (const [path, pkg] of Object.entries(locked.packages)) {
      if (path) assert.equal(JSON.parse(readFileSync(join(scratch, path, 'package.json'))).version, pkg.version);
    }
    const lockedBytes = readFileSync(join(scratch, 'package-lock.json'));
    rmSync(join(scratch, 'node_modules'), { recursive: true }); npm(['ci']); const reinstalled = smoke();
    assert.equal(reinstalled.version, installed.version);
    assert.deepEqual(readFileSync(join(scratch, 'package-lock.json')), lockedBytes);
    // 0.10.1 is a private monolith with a different API, not the new split modules.
    // Exercise the actual dependency replacement boundary without claiming data/API compatibility.
    const legacy = JSON.parse(readFileSync(new URL('./history.json', import.meta.url))).releases.at(-1);
    assert.equal(legacy.version, '0.10.1');
    assert.equal(compareVersions({ ...legacy }, manifest, manifest.migration), -1);
    const retained = join(scratch, 'retained'); mkdirSync(retained);
    for (const name of ['release-set.json', ...manifest.artifacts.map(artifact => artifact.path)]) cpSync(join(directory, name), join(retained, name));
    const legacyDeclaration = JSON.parse(readFileSync(join(scratch, 'package.json')));
    legacyDeclaration.dependencies['@inspr/aithema-core'] = '0.10.1';
    writeFileSync(join(scratch, 'package.json'), JSON.stringify(legacyDeclaration));
    install(); const updated = smoke();
    // Roll back a damaged deployment to the separately retained manifest and bytes.
    rmSync(join(scratch, 'node_modules'), { recursive: true });
    rmSync(join(scratch, 'artifacts'), { recursive: true });
    mkdirSync(join(scratch, 'artifacts'));
    for (const artifact of modules) {
      rollbackArtifact(retained, manifest, artifact.coordinate);
      cpSync(join(retained, artifact.path), join(scratch, 'artifacts', artifact.path));
    }
    npm(['ci']);
    const rolledBack = smoke(); assert.equal(rolledBack.version, manifest.version);
    const evidence = { schema: 'aithema-consumer-evidence/1', ...pin, installed, locked_reinstall: reinstalled,
      update: { from: legacy.version, to: updated.version, scope: 'dependency pin replacement and anchored ordering; no legacy API/database migration',
        legacy_source_commit: legacy.source_commit, legacy_install: 'not applicable: private, retired monolith; no compatible split package release' },
      rollback: { retained_manifest_sha256: pin.manifest_sha256, verified_packages: modules.length, smoke: rolledBack } };
    writeFileSync(join(directory, 'consumer-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    writeFileSync(join(directory, 'deployment-pin.json'), JSON.stringify(pin, null, 2) + '\n');
    cpSync(join(scratch, 'package-lock.json'), join(directory, 'consumer-package-lock.json'));
    const deployment = join(directory, 'consumer-deployment'); mkdirSync(deployment);
    for (const name of ['package.json', 'package-lock.json', 'smoke.mjs', 'embedding.md', 'deployment-pin.json', 'artifacts']) {
      cpSync(join(scratch, name), join(deployment, name), { recursive: true });
    }
    return evidence;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(testConsumer(process.argv[2] ?? 'dist/release', { offline: !process.argv.includes('--online') })));
}
