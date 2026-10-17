import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { moduleFiles } from '../release/lib/modules.mjs';
import { execFileSync } from 'node:child_process';
import { reserveVersion } from '../release/lib/version.mjs';
import { packRelease, verifyRelease, rollbackArtifact, releasePaths, admittedPath } from '../release/pack.mjs';
import { startChild } from './helpers.js';
import { installPackedOffline } from '../scripts/release-prep-install.js';
const root = new URL('../', import.meta.url);

function installFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'aithema-install-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const shared = join(directory, 'shared');
  const digest = Buffer.alloc(64, 0xab);
  const content = join('_cacache', 'content-v2', 'sha512', 'ab', 'ab', digest.toString('hex').slice(4));
  mkdirSync(join(shared, content, '..'), { recursive: true });
  writeFileSync(join(shared, content), 'cached tarball');
  // This unrelated index entry must never enter the private cache.
  mkdirSync(join(shared, '_cacache', 'index-v5'));
  writeFileSync(join(shared, '_cacache', 'index-v5', 'unrelated'), 'private cache metadata');
  const integrity = `sha512-${digest.toString('base64')}`;
  writeFileSync(join(directory, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
    '': {}, 'node_modules/production': { integrity },
    'node_modules/dev-only': { dev: true, integrity: 'sha512-not-supported-dev-entry' },
    'node_modules/workspace': { link: true },
  } }));
  return { directory, shared, content };
}

test('packed offline install copies only locked production content into a unique cache and keeps temp dirs alive', t => {
  const { directory, shared, content } = installFixture(t);
  const caches = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    let installs = 0;
    installPackedOffline(directory, { run(command, args, options) {
      assert.equal(command, 'npm');
      assert.equal(options.cwd, directory);
      const logs = args[args.indexOf('--logs-dir') + 1];
      assert.ok(logs.endsWith('/cache/_logs'));
      assert.ok(!logs.startsWith(shared));
      if (args[0] === 'config') {
        assert.deepEqual(args.slice(0, 5), ['config', 'get', 'cache', '--offline', '--logs-max=0']);
        return `${shared}\n`;
      }
      installs++;
      assert.deepEqual(args.slice(0, 6), ['ci', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund']);
      const cache = args[args.indexOf('--cache') + 1]; caches.push(cache);
      assert.ok(statSync(options.env.TMPDIR).isDirectory());
      assert.equal(join(cache, '..'), join(options.env.TMPDIR, '..'));
      assert.equal(readFileSync(join(cache, content), 'utf8'), 'cached tarball');
      assert.notEqual(statSync(join(cache, content)).ino, statSync(join(shared, content)).ino);
      assert.equal(existsSync(join(cache, '_cacache', 'index-v5')), false);
      writeFileSync(join(cache, content), 'private mutation');
      assert.equal(readFileSync(join(shared, content), 'utf8'), 'cached tarball');
      return Buffer.alloc(0);
    } });
    assert.equal(installs, 1);
    assert.equal(existsSync(join(caches.at(-1), '..')), false, 'cleanup follows child completion');
  }
  assert.notEqual(caches[0], caches[1]);
  assert.equal(readFileSync(join(shared, '_cacache', 'index-v5', 'unrelated'), 'utf8'), 'private cache metadata');
});

test('packed offline install fails once with value-free SIGABRT, exit and missing-log diagnostics', async t => {
  for (const failure of [
    { status: null, signal: 'SIGABRT', stdout: '', stderr: '', log: true },
    { status: 1, signal: null, stdout: 'private stdout', stderr: 'private stderr', log: true },
    { code: 'ENOENT', log: false },
  ]) await t.test(failure.signal ?? failure.code ?? 'exit 1', t => {
    const { directory, shared } = installFixture(t);
    let installs = 0, cache;
    assert.throws(() => installPackedOffline(directory, { run(command, args) {
      if (args[0] === 'config') return shared;
      installs++; cache = args[args.indexOf('--cache') + 1];
      if (failure.log) {
        const logs = args[args.indexOf('--logs-dir') + 1]; mkdirSync(logs, { recursive: true });
        writeFileSync(join(logs, '2026-10-17T00_00_00_000Z-debug-0.log'), [
          '0 verbose title private old entry',
          ...Array.from({ length: 22 }, (_, i) => `${i + 1} silly reify private config/path/url`),
          '23 verbose argv private token arguments', '24 error code ENOTCACHED',
          '25 error stack private credential payload', 'private multiline continuation',
          '27 verbose node v24.20.0', '28 verbose npm 11.10.0', '29 verbose exit 1',
        ].join('\n'));
      }
      throw Object.assign(new Error('private child error'), failure);
    } }), error => {
      assert.match(error.message, /failed during npm ci/u);
      assert.ok(error.message.includes(`status=${failure.status ?? 'null'}`));
      assert.ok(error.message.includes(`signal=${failure.signal ?? 'none'}`));
      assert.ok(error.message.includes(`code=${failure.code ?? 'none'}`));
      assert.ok(error.message.includes(`stdout_bytes=${Buffer.byteLength(failure.stdout ?? '')}`));
      assert.ok(error.message.includes(`stderr_bytes=${Buffer.byteLength(failure.stderr ?? '')}`));
      if (failure.log) {
        const tail = error.message.split('values omitted):\n')[1];
        assert.equal(tail.split('\n').length, 20);
        assert.match(tail, /24 error code ENOTCACHED/u);
        assert.match(tail, /27 verbose node v24\.20\.0/u);
        assert.doesNotMatch(tail, /0 verbose title/u);
      } else assert.match(error.message, /npm debug log unavailable/u);
      assert.doesNotMatch(error.message, /private|token|credential|payload/u);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(installs, 1, 'an abort or ordinary failure is never retried');
    assert.equal(existsSync(join(cache, '..')), false, 'diagnostics precede cleanup');
    assert.equal(readFileSync(join(shared, '_cacache', 'index-v5', 'unrelated'), 'utf8'), 'private cache metadata');
  });
});

test('dry-run pack repeats identical bytes and manifest, pins dependencies, and binds rollback to exact bytes', async t => {
  const fixture = mkdtempSync(join(tmpdir(), 'aithema-pack-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  for (const path of releasePaths(root)) { const dest = join(fixture, path); mkdirSync(join(dest, '..'), { recursive: true }); cpSync(new URL(path, root), dest); }
  const git = (...args) => execFileSync('git', args, { cwd: fixture, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  cpSync(new URL('.gitattributes', root), join(fixture, '.gitattributes'));
  writeFileSync(join(fixture, 'release/archive-source.txt'), '$Format:%H$\n$Format:%ct$\n');
  git('init'); git('add', '.'); git('-c', 'user.name=Release fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
  const a = packRelease({ root: fixture, output: join(fixture, 'out-a'), dryRun: true });
  const b = packRelease({ root: fixture, output: join(fixture, 'out-b'), dryRun: true });
  assert.deepEqual(readFileSync(a.artifactPath), readFileSync(b.artifactPath)); assert.deepEqual(a.manifest, b.manifest);
  const archiveRoot = join(fixture, 'archive-source'); mkdirSync(archiveRoot);
  execFileSync('tar', ['-x', '-C', archiveRoot], { input: execFileSync('git', ['archive', 'HEAD'], { cwd: fixture, maxBuffer: 32 * 1024 * 1024 }) });
  const fromArchive = packRelease({ root: archiveRoot, output: join(fixture, 'out-archive'), dryRun: true });
  assert.deepEqual(fromArchive.manifest, a.manifest);
  for (const artifact of a.manifest.artifacts) assert.deepEqual(readFileSync(join(fromArchive.directory, artifact.path)), readFileSync(join(a.directory, artifact.path)));
  assert.equal(a.manifest.mode, 'dry-run'); assert.equal(a.manifest.source.commit, git('rev-parse', 'HEAD'));
  assert.ok(a.manifest.artifacts[0].sha256.startsWith('sha256:'));
  assert.ok(a.manifest.packages.some(p => p.name === '@inspr/aithema-ui'));
  assert.ok(a.manifest.packages.some(p => p.name === '@inspr/aithema-plugin-elevenlabs'));
  verifyRelease(a.directory);
  assert.equal(a.manifest.artifacts.filter(artifact => artifact.kind === 'module').length, 15);
  // Inspect actual packed bytes, including unexported files, for dangling imports.
  for (const artifact of a.manifest.artifacts.filter(artifact => artifact.kind === 'module')) {
    const archive = join(a.directory, artifact.path);
    const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
    const members = new Set(entries);
    if (artifact.name === '@inspr/aithema-plugin-elevenlabs') assert.ok(!members.has('package/src/components.js'));
    const unpacked = join(fixture, artifact.name.replaceAll('/', '-'));
    mkdirSync(unpacked);
    execFileSync('tar', ['-xzf', archive, '-C', unpacked]);
    for (const path of entries.filter(path => /\.(?:js|ts)$/u.test(path))) {
      const source = readFileSync(join(unpacked, path), 'utf8');
      for (const [, , specifier] of source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)(['"`])(\.{1,2}\/[^'"`\n]+)\1/gu)) {
        const target = posix.normalize(posix.join(posix.dirname(path), specifier));
        const declaration = path.endsWith('.d.ts') && members.has(target.replace(/\.js$/u, '.d.ts'));
        assert.ok(members.has(target) || declaration, `${artifact.name}: ${path} imports absent ${target}`);
      }
      assert.doesNotMatch(source, /@inspr\/aithema-plugin-elevenlabs\/(?:src\/)?components(?:\.js)?/u);
    }
  }

  writeFileSync(join(a.directory, 'release-set.json'), JSON.stringify({ ...a.manifest, artifacts: a.manifest.artifacts.slice(0, -1) }));
  assert.throws(() => verifyRelease(a.directory), /Incomplete artifact set/);
  writeFileSync(join(a.directory, 'release-set.json'), JSON.stringify(a.manifest));
  const sidecar = join(a.directory, 'release-set.json');
  writeFileSync(sidecar, JSON.stringify({ ...a.manifest, source: { ...a.manifest.source, commit: '1'.repeat(40) } }));
  assert.throws(() => verifyRelease(a.directory), /source commit/i);
  writeFileSync(sidecar, JSON.stringify(a.manifest));
  assert.throws(() => rollbackArtifact(a.directory, { ...a.manifest, mode: 'release' }, a.manifest.artifacts[0].coordinate), /dry-run/i);
  assert.throws(() => rollbackArtifact(a.directory, a.manifest, a.manifest.artifacts[0].coordinate), /dry-run/i);
  const extracted = join(fixture, 'extracted'); mkdirSync(extracted); execFileSync('tar', ['-xzf', a.artifactPath, '-C', extracted]);
  assert.equal(existsSync(join(extracted, 'package/plugins/composed-voice/ops')), false, 'OPS qualification stays source-only');
  installPackedOffline(join(extracted, 'package'));
  const demo = await startChild(join(extracted, 'package/demo/server.js'), join(fixture, 'packed-demo.sqlite'));
  try {
    assert.equal((await fetch(`${demo.url}/healthz`)).status, 200);
    assert.equal((await fetch(`${demo.url}/composed/qualification`)).status, 404);
    assert.equal((await fetch(`${demo.url}/composed/relay`, { method: 'POST', body: new Uint8Array(1280) })).status, 404);
  } finally { await demo.kill(); }
  const consumer = `import { SQLiteStorage, createHandlers, createMemoryConsentLedger, exportSession, createLocalHTML, createLocalImages } from '@inspr/aithema-server';
    import { createSession, createMockReasoning } from '@inspr/aithema-core';
    import { manifest as reasoningManifest } from '@inspr/aithema-plugin-openrouter';
    import { manifest as imageManifest } from '@inspr/aithema-plugin-openai-images';
    import { readFileSync } from 'node:fs';
    const runtime = JSON.parse(readFileSync('release/runtime.json'));
    if ([createMockReasoning().manifest, createLocalHTML().manifest, createLocalImages().manifest, reasoningManifest, imageManifest].some(manifest => manifest.version !== runtime.version || manifest.apiVersion !== '^1.0.0')) throw new Error('Public plugin version mapping drift');
    const storage = new SQLiteStorage(':memory:');
    const handlers = createHandlers({ storage, consent: createMemoryConsentLedger() });
    await handlers.resume();
    const bytes = exportSession(createSession(), [], [], { commit: '2'.repeat(40) });
    if (!bytes.includes(Buffer.from(runtime.source.commit)) || bytes.includes(Buffer.from('2'.repeat(40)))) throw new Error('Export source commit drift');
    await handlers.close(); storage.close();
    console.log('PASS packed consumer imports/handler startup and artifact-bound export provenance');`;
  assert.match(execFileSync(process.execPath, ['--input-type=module', '-e', consumer], { cwd: join(extracted, 'package'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), /PASS packed consumer/u);
  const isolated = join(fixture, 'isolated-packed-server');
  cpSync(join(extracted, 'package/packages/server'), isolated, { recursive: true });
  const isolatedInfo = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', "import { releaseInfo } from './src/release-info.js'; console.log(JSON.stringify(releaseInfo));"], { cwd: isolated, encoding: 'utf8', stdio: 'pipe' }));
  assert.equal(isolatedInfo.source.commit, a.manifest.source.commit);
  assert.equal(isolatedInfo.version, a.manifest.version);
  const pkg = JSON.parse(readFileSync(join(extracted, 'package/packages/server/package.json')));
  assert.equal(pkg.version, a.manifest.version); assert.equal(pkg.dependencies['@inspr/aithema-core'], a.manifest.version);
  const lock = JSON.parse(readFileSync(join(extracted, 'package/package-lock.json')));
  assert.equal(lock.packages['packages/server'].version, pkg.version);
  assert.equal(lock.packages['packages/server'].dependencies['@inspr/aithema-core'], pkg.version);
  const declared = JSON.parse(readFileSync(join(fixture, 'release/version.json')));
  const reserved = reserveVersion({ ...declared, status: 'unreserved', migration: { ...declared.migration, first_calendar_version: null } }, { now: '2026-10-14T08:00:00Z', publishGo: true });
  writeFileSync(join(fixture, 'release/version.json'), JSON.stringify(reserved)); git('add', 'release/version.json');
  git('-c', 'user.name=Release fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'reserved fixture');
  const released = packRelease({ root: fixture, output: join(fixture, 'released'), ref: 'refs/tags/v' + reserved.version });
  const rollback = rollbackArtifact(released.directory, released.manifest, released.manifest.artifacts[0].coordinate);
  assert.equal(rollback.sha256, released.manifest.artifacts[0].sha256);
  assert.equal(rollback.deploymentEvent.action, 'rollback');
  assert.throws(() => rollbackArtifact(released.directory, { ...released.manifest, version: '261014080001.0.0' }, rollback.coordinate), /mismatch/i);
  writeFileSync(a.artifactPath, 'tampered'); assert.throws(() => verifyRelease(a.directory), /digest/i);
  assert.throws(() => packRelease({ root: fixture, output: join(fixture, 'real-release'), dryRun: false, ref: 'refs/tags/v0.10.1' }), /tag.*match/i);
});

test('packing evidence names its run accurately and references CI validation', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'aithema-pack-evidence-'));
  for (const path of releasePaths(root)) { const dest = join(fixture, path); mkdirSync(join(dest, '..'), { recursive: true }); cpSync(new URL(path, root), dest); }
  const git = (...args) => execFileSync('git', args, { cwd: fixture, stdio: 'pipe' }).toString().trim();
  cpSync(new URL('.gitattributes', root), join(fixture, '.gitattributes'));
  writeFileSync(join(fixture, 'release/archive-source.txt'), '$Format:%H$\n$Format:%ct$\n');
  git('init'); git('add', '.'); git('-c', 'user.name=Release fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
  const packed = packRelease({ root: fixture, output: join(fixture, 'out'), dryRun: true });
  assert.equal(packed.manifest.packing?.run, process.env.GITHUB_RUN_ID ?? 'offline-test');
  assert.equal(packed.manifest.validation.run, undefined);
  assert.equal(packed.manifest.validation.reference, `https://github.com/inspr-at/aithema/commit/${git('rev-parse', 'HEAD')}/checks`);
});

test('server release metadata imports with only its own package present', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'aithema-server-isolated-'));
  cpSync(new URL('packages/server/src', root), join(fixture, 'src'), { recursive: true });
  cpSync(new URL('packages/server/package.json', root), join(fixture, 'package.json'));
  const output = execFileSync(process.execPath, ['--input-type=module', '-e',
    "import { releaseInfo } from './src/release-info.js'; console.log(JSON.stringify(releaseInfo));"], { cwd: fixture, encoding: 'utf8', stdio: 'pipe' });
  assert.equal(JSON.parse(output).version, JSON.parse(readFileSync(join(fixture, 'package.json'))).version);
});

test('module packer refuses same-package imports of every excluded source file', () => {
  for (const [folder, excluded] of [
    ['plugins/elevenlabs', 'components.js'],
    ['packages/server', 'local-voice.js'],
    ['packages/server', 'composed-voice.js'],
    ['packages/core', 'voice-components.js'],
  ]) {
    const pkg = { path: `${folder}/package.json` };
    const files = new Map([
      [pkg.path, Buffer.from(JSON.stringify({ name: '@fixture/module' }))],
      [`${folder}/src/${excluded}`, Buffer.from('export const hidden = true;')],
      ['LICENSE', Buffer.from('AGPL-3.0-only')],
      ['README.md', Buffer.from('Fixture')],
      ['docs/embedding.md', Buffer.from('Fixture')],
      ['release/runtime.json', Buffer.from('{}')],
    ]);
    for (const source of [
      `import { hidden } from './${excluded}';`,
      `export { hidden } from "./${excluded}";`,
      `import './${excluded}';`,
      `import('./${excluded}');`,
      'import(`./' + excluded + '`);',
    ]) {
      files.set(`${folder}/src/index.js`, Buffer.from(source));
      assert.throws(() => moduleFiles(files, pkg), /Unpackaged dependency/u, `${folder}: ${source}`);
    }
    files.set(`${folder}/src/index.js`, Buffer.from("export { ok } from './included.js';"));
    files.set(`${folder}/src/included.js`, Buffer.from('export const ok = true;'));
    const members = moduleFiles(files, pkg);
    assert.ok(!members.has(`src/${excluded}`));
    assert.match(members.get('src/index.js').toString(), /included\.js/u);
  }
});


test('AIT-160: every OPS qualification module is excluded from release admission', () => {
  const ops = 'plugins/composed-voice/ops';
  for (const file of [...readdirSync(new URL(ops, root)), 'future-helper.mjs']) {
    assert.equal(admittedPath(`${ops}/${file}`), false, `${file} must stay source-only`);
  }
  assert.ok(!releasePaths(root).some(path => path.startsWith(`${ops}/`)));
});
