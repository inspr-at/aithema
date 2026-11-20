import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packRelease, releasePaths, verifyRelease } from '../release/pack.mjs';
import { normalizedDigest } from '../release/normalize.mjs';
import { releaseSet, version } from './fixtures/release-set.js';

// AIT-582: a packed tarball must never import across its package root.
const root = new URL('../', import.meta.url);
const moduleTarball = `inspr-fixture-${version.version}.tgz`;
const escaping = [
  ['static import', "import { x } from '../../core/src/x.js';\n"],
  ['static re-export', "export * from '../../core/src/x.js';\n"],
  ['bare import', "import '../../core/src/x.js';\n"],
  ['dynamic import', "export const load = () => import('../../core/src/x.js');\n"],
  ['new URL', "export const asset = new URL('../../core/src/x.js', import.meta.url);\n"],
];

for (const [label, source] of escaping) {
  test(`verify and normalize refuse a module tarball whose ${label} leaves package/`, t => {
    const { directory } = releaseSet(t, { mutateModule: members => members.set('src/escape.js', Buffer.from(source)) });
    const message = new RegExp(`Cross-package import in ${moduleTarball.replace(/\./gu, '\\.')}: package/src/escape\\.js .*'\\.\\./\\.\\./core/src/x\\.js' resolves to core/src/x\\.js, outside package/`, 'u');
    assert.throws(() => verifyRelease(directory), message);
    assert.throws(() => normalizedDigest(directory), message);
  });
}

test('verify accepts in-package relative imports and non-specifier strings and comments', t => {
  const scans = [];
  // Built through moduleFiles, so the module stays bound to the workspace. Comment-only
  // forms the rewrite itself would reject are covered by the scanner unit tests.
  // New files stay under src/: package.json `files` follows first-seen top-level order,
  // and the fixture Map (unlike a Git tree) is not sorted.
  const { directory } = releaseSet(t, { mutateFiles: files => {
    files.set('packages/server/src/a.js', Buffer.from("import { b } from './lib/b.js';\nexport const a = () => import('./index.js');\n"));
    files.set('packages/server/src/lib/b.js', Buffer.from([
      "export { fixture } from '../index.js';",
      '// see ../../core/src/x.js before changing this',
      "export const b = 'copied ../x.js', c = \"require('../x.js')\", d = `${c} ../../core/x.js`;",
      "export const e = /require\\('..\\/x.js'\\)/u.test(b) ? b.replace('../x.js', '') : null;",
    ].join('\n')));
    files.set('packages/server/src/index.d.ts', Buffer.from("export * from './index.js';\nexport type B = typeof import('./lib/b.js').b;\n"));
  } });
  verifyRelease(directory, { onImportScan: scan => scans.push(scan) });
  assert.deepEqual(scans, [
    { tarball: `aithema-reset-${version.version}.tgz`, scanned: 4 },
    { tarball: moduleTarball, scanned: 4 }, // src/index.js, src/a.js, src/lib/b.js, src/index.d.ts
  ]);
  assert.match(normalizedDigest(directory), /^sha256:[a-f0-9]{64}$/u);
});

function copiedRelease(t, extra = {}) {
  const fixture = mkdtempSync(join(tmpdir(), 'aithema-pack-imports-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  for (const path of releasePaths(root)) { const dest = join(fixture, path); mkdirSync(join(dest, '..'), { recursive: true }); cpSync(new URL(path, root), dest); }
  for (const [path, source] of Object.entries(extra)) writeFileSync(join(fixture, path), source);
  const git = (...args) => execFileSync('git', args, { cwd: fixture, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  cpSync(new URL('.gitattributes', root), join(fixture, '.gitattributes'));
  writeFileSync(join(fixture, 'release/archive-source.txt'), '$Format:%H$\n$Format:%ct$\n');
  git('init'); git('add', '.'); git('-c', 'user.name=Release fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
  return fixture;
}

test('pack fails when a packaged source escapes its package in a form the rewrite does not touch', t => {
  // modules.mjs rewrites from/import specifiers and only .js new URL targets; these two pass it unchanged.
  const fixture = copiedRelease(t, { 'packages/server/src/escape-fixture.js':
    "export const data = new URL('../../core/src/data.json', import.meta.url);\nexport const legacy = () => require('../../core/src/index.js');\n" });
  assert.throws(() => packRelease({ root: fixture, output: join(fixture, 'out'), dryRun: true }),
    /Cross-package import in inspr-aithema-server-[0-9.]+\.tgz: .*package\/src\/escape-fixture\.js new URL\(…, import\.meta\.url\) '\.\.\/\.\.\/core\/src\/data\.json' resolves to core\/src\/data\.json, outside package\/; package\/src\/escape-fixture\.js require\(\) '\.\.\/\.\.\/core\/src\/index\.js' resolves to core\/src\/index\.js, outside package\//u);
});

test('the real candidate release set has no cross-package import in any tarball', t => {
  const output = mkdtempSync(join(tmpdir(), 'aithema-pack-imports-real-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const { directory, manifest } = packRelease({ root: fileURLToPath(root), output: join(output, 'candidate') });
  const scans = [];
  verifyRelease(directory, { onImportScan: scan => scans.push(scan) });
  assert.deepEqual(scans.map(scan => scan.tarball), manifest.artifacts.map(artifact => artifact.path));
  assert.equal(scans.length, 18); // the workspace and 17 modules
  for (const scan of scans) {
    assert.ok(scan.scanned > 0, `${scan.tarball} has scanned members`);
    t.diagnostic(`import check: ${scan.tarball} scanned ${scan.scanned} files, 0 cross-package imports`);
  }
});
