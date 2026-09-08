import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { admitRelease, assertAdmissibleReleaseRef, assertReleaseRefMatchesVersion, assertStrictSemVer } from '../release/admit-release.mjs';
import { buildRelease } from '../release/build-release.mjs';
import { buildSourceExport, resolveSourceExport } from '../release/build-source.mjs';
import { gitBlobSha1, sha256 } from '../release/lib/digest.mjs';
import {
  expandAllowlistPaths,
  readSourceAllowlistAtCommit,
  resolveCommit,
  validateArchivePath,
} from '../release/lib/git.mjs';
import {
  assertManifestBinding,
  assertVersionScheme,
  canonicalManifestText,
  LEGACY_SEMVER_PRIVATE,
  LEGACY_SEMVER_PUBLIC,
  publishImmutableReleasePair,
  stableManifestFilename,
  stableReleaseDirname,
} from '../release/lib/manifest.mjs';
import { parseSourceProvenance } from '../release/lib/provenance.mjs';
import {
  canonicalSourceManifestText,
  stableSourceManifestFilename,
  verifySourceReleasePair,
} from '../release/lib/source-manifest.mjs';
import {
  CANONICAL_ARTIFACT_TOOLCHAIN,
  GNU_TAR_FALLBACK_FLAGS,
  assertCanonicalReleaseToolchain,
  identifyTarFamily,
} from '../release/lib/tarball.mjs';
import { planForgeAssetRetention, retainForgeAssets } from '../release/retain-forge-assets.mjs';
import {
  expandAllowlistPathsFromTree,
  hasGitMetadata,
} from '../release/lib/tree.mjs';
import {
  commitAll,
  createTempRepo,
  git,
  seedMinimalPackageTree,
  trashTemp,
} from './fixtures/packaging-support.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const PRIVATE_FIXTURE_VERSION = '0.0.0';
const SOURCE_MANIFEST = stableSourceManifestFilename(VERSION);
const PRIVATE_LINEAGE_COMMIT = '2ba95dad95fc4fee315faeb43c07a09d0d911e33';

/**
 * @param {string} path
 */
function removeTemp(path) {
  trashTemp(path);
}

/**
 * @param {string} archivePath
 * @param {string} destDir
 */
function extractTarball(archivePath, destDir) {
  mkdirSync(destDir, { recursive: true });
  execFileSync('tar', ['-xzf', archivePath, '-C', destDir], { stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * @param {string} archivePath
 * @returns {string[]}
 */
function listTarballPaths(archivePath) {
  const output = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' });
  return output.trim().split('\n').filter(Boolean);
}

/**
 * @param {string} repo
 * @param {object} [allowlist]
 */
function seedSourceExportTree(repo, allowlist) {
  seedMinimalPackageTree(repo, allowlist);
  for (const rel of [
    'release/source-allowlist.json',
    'release/build-source.mjs',
    'release/publication-inventory.json',
    'release/lib/source-manifest.mjs',
    'release/lib/tree.mjs',
    'release/lib/provenance.mjs',
    'release/admit-release.mjs',
    'release/retain-forge-assets.mjs',
    '.gitignore',
    'test/baseline.test.js',
    '.github/workflows/ci.yml',
    '.github/workflows/release.yml',
  ]) {
    const dest = join(repo, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(repoRoot, rel), dest);
  }
  if (allowlist) {
    writeFileSync(join(repo, 'release/source-allowlist.json'), `${JSON.stringify(allowlist, null, 2)}\n`, 'utf8');
  }
}

/**
 * One-commit Git fixture copied from the on-disk tree. Used when this suite
 * runs inside an extracted non-Git source so tests never need private history.
 * @param {string} prefix
 */
function materializeGitFixtureFromTree(prefix) {
  const repo = createTempRepo(prefix);
  const allowlist = JSON.parse(readFileSync(join(repoRoot, 'release/source-allowlist.json'), 'utf8'));
  const paths = expandAllowlistPathsFromTree(repoRoot, allowlist.paths);
  for (const rel of paths) {
    if (rel === 'release/source-provenance.json') continue;
    const dest = join(repo, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(repoRoot, rel), dest);
  }
  commitAll(repo, 'synthetic public-source fixture');
  return repo;
}

/**
 * @param {(repo: string) => void} fn
 */
function withGitSource(fn) {
  const repo = hasGitMetadata(repoRoot) ? repoRoot : materializeGitFixtureFromTree('aithema-git-source-');
  try {
    fn(repo);
  } finally {
    if (repo !== repoRoot) removeTemp(repo);
  }
}

describe('AIT-11 public source export', () => {
  it('resolveSourceExport pins the current commit and rejects option-like refs', () => {
    const source = resolveSourceExport(repoRoot);
    assert.match(source.commit, /^[0-9a-f]{40}$/);
    if (hasGitMetadata(repoRoot)) {
      assert.equal(source.commit, resolveCommit(repoRoot));
      assert.equal(source.fromTree, false);
    } else {
      assert.equal(source.fromTree, true);
    }
    assert.throws(() => resolveSourceExport(repoRoot, '--help'), /invalid commit ref/);
  });

  it('source allowlist stays closed and excludes worker-only files', () => {
    const allowlist = hasGitMetadata(repoRoot)
      ? readSourceAllowlistAtCommit(repoRoot, resolveCommit(repoRoot))
      : JSON.parse(readFileSync(join(repoRoot, 'release/source-allowlist.json'), 'utf8'));
    const paths = hasGitMetadata(repoRoot)
      ? expandAllowlistPaths(repoRoot, resolveCommit(repoRoot), allowlist.paths)
      : expandAllowlistPathsFromTree(repoRoot, allowlist.paths);
    assert.ok(paths.length > 0);
    assert.throws(() => validateArchivePath('-etc/passwd'), /looks like an option/);
    if (hasGitMetadata(repoRoot)) {
      assert.throws(
        () => expandAllowlistPaths(repoRoot, resolveCommit(repoRoot), ['../package.json']),
        /traversal rejected/,
      );
    } else {
      assert.throws(
        () => expandAllowlistPathsFromTree(repoRoot, ['../package.json']),
        /traversal rejected/,
      );
    }
    assert.equal(paths.includes('AGENTS.md'), false);
    assert.equal(paths.includes('test/packaging.test.js'), true);
    assert.equal(paths.includes('release/build-source.mjs'), true);
    assert.equal(paths.includes('release/publication-inventory.json'), true);
    assert.equal(paths.includes('.github/workflows/ci.yml'), true);
  });

  it('refuses to widen the export through a caller-supplied allowlist', () => {
    const repo = createTempRepo('aithema-source-widen-');
    const outDir = mkdtempSync(join(tmpdir(), 'aithema-source-widen-out-'));
    try {
      seedSourceExportTree(repo);
      commitAll(repo, 'seed source export tree');
      const commit = resolveCommit(repo);
      const committed = readSourceAllowlistAtCommit(repo, commit);
      assert.throws(
        () => buildSourceExport({
          repoRoot: repo,
          commit,
          allowlist: { ...committed, paths: [...committed.paths, 'AGENTS.md'] },
          outDir,
        }),
        /cannot be widened through build options/,
      );
    } finally {
      removeTemp(repo);
      removeTemp(outDir);
    }
  });

  it('builds only from the pinned commit and ignores a dirty worktree', () => {
    const repo = createTempRepo('aithema-source-pin-');
    const outA = mkdtempSync(join(tmpdir(), 'aithema-source-pin-a-'));
    const outB = mkdtempSync(join(tmpdir(), 'aithema-source-pin-b-'));
    try {
      seedSourceExportTree(repo);
      commitAll(repo, 'seed source export tree');
      const commit = resolveCommit(repo);
      const first = buildSourceExport({ repoRoot: repo, commit, outDir: outA });
      writeFileSync(join(repo, 'AGENTS.md'), 'operator-only\n', 'utf8');
      writeFileSync(join(repo, 'worker-result.txt'), 'operator residue\n', 'utf8');
      const second = buildSourceExport({ repoRoot: repo, commit, outDir: outB });
      assert.equal(first.artifactSha256, second.artifactSha256);
      assert.equal(first.manifestText, second.manifestText);
      assert.equal(
        listTarballPaths(second.artifactPath).some((entry) => entry.includes('AGENTS.md')),
        false,
      );
      assert.equal(
        listTarballPaths(second.artifactPath).some((entry) => entry.includes('worker-result.txt')),
        false,
      );
    } finally {
      removeTemp(repo);
      removeTemp(outA);
      removeTemp(outB);
    }
  });

  it('rejects committed symlink fixtures in an isolated repository', () => {
    const fixtureRepo = createTempRepo('aithema-source-malicious-');
    try {
      seedSourceExportTree(fixtureRepo, {
        paths: ['package.json', 'package-lock.json', 'LICENSE', 'NOTICES.json', 'README.md', 'RUNBOOK.md', 'lib/', 'release/'],
        forbidden_patterns: ['^\\.env'],
      });
      commitAll(fixtureRepo, 'seed fixture');
      symlinkSync('package.json', join(fixtureRepo, 'lib', 'escape-link.js'));
      commitAll(fixtureRepo, 'tracked symlink');
      assert.throws(
        () => buildSourceExport({ repoRoot: fixtureRepo }),
        /allowlisted symlink rejected/,
      );
    } finally {
      removeTemp(fixtureRepo);
    }
  });

  it('records private provenance without claiming export tree equals private Git tree', () => {
    withGitSource((repo) => {
      const outDir = mkdtempSync(join(tmpdir(), 'aithema-source-provenance-'));
      const source = resolveSourceExport(repo);
      try {
        const built = buildSourceExport({ repoRoot: repo, commit: source.commit, allowlist: source.allowlist, outDir });
        const provenancePath = join(repo, 'release/source-provenance.json');
        const expectedPrivate = existsSync(provenancePath)
          ? parseSourceProvenance(readFileSync(provenancePath, 'utf8')).private_source_commit
          : source.commit;
        assert.equal(built.manifest.source.private_source_commit, expectedPrivate);
        assert.equal(built.manifest.source.current_source_commit, source.commit);
        if (hasGitMetadata(repoRoot) && repo === repoRoot) {
          assert.equal(built.manifest.source.private_source_commit, PRIVATE_LINEAGE_COMMIT);
          assert.notEqual(built.manifest.source.current_source_commit, PRIVATE_LINEAGE_COMMIT);
        }
        assert.notEqual(built.manifest.source.tree_digest, `sha256:${source.commit}`);
        assert.match(built.manifest.source.tree_digest, /^sha256:[0-9a-f]{64}$/);
        assert.match(built.manifest.source.normalization_note, /not identical/i);
        verifySourceReleasePair(built.releaseDir, SOURCE_MANIFEST);
      } finally {
        removeTemp(outDir);
      }
    });
  });

  it('produces byte-identical source export bytes from independent output dirs', () => {
    withGitSource((repo) => {
      const outA = mkdtempSync(join(tmpdir(), 'aithema-source-a-'));
      const outB = mkdtempSync(join(tmpdir(), 'aithema-source-b-'));
      const source = resolveSourceExport(repo);
      try {
        const first = buildSourceExport({ repoRoot: repo, commit: source.commit, allowlist: source.allowlist, outDir: outA });
        const second = buildSourceExport({ repoRoot: repo, commit: source.commit, allowlist: source.allowlist, outDir: outB });
        assert.equal(first.artifactSha256, second.artifactSha256);
        assert.equal(first.manifestText, second.manifestText);
        assert.equal(first.publication.status, 'published');
        const repeat = buildSourceExport({ repoRoot: repo, commit: source.commit, allowlist: source.allowlist, outDir: outA });
        assert.equal(repeat.publication.status, 'identical');
      } finally {
        removeTemp(outA);
        removeTemp(outB);
      }
    });
  });

  it('independent extracted source installs, runs full npm test, and matches git-mode release', () => {
    if (process.env.AITHEMA_SOURCE_PROOF === '1') return;
    withGitSource((repo) => {
      const buildDir = mkdtempSync(join(tmpdir(), 'aithema-source-build-'));
      const extractDir = mkdtempSync(join(tmpdir(), 'aithema-source-extract-'));
      const gitOut = mkdtempSync(join(tmpdir(), 'aithema-source-git-out-'));
      const treeOut = mkdtempSync(join(tmpdir(), 'aithema-source-tree-out-'));
      const source = resolveSourceExport(repo);
      try {
        const exported = buildSourceExport({
          repoRoot: repo,
          commit: source.commit,
          allowlist: source.allowlist,
          outDir: buildDir,
        });
        extractTarball(exported.artifactPath, extractDir);
        assert.equal(hasGitMetadata(extractDir), false);
        assert.equal(existsSync(join(extractDir, 'release/source-provenance.json')), true);
        assert.equal(existsSync(join(extractDir, 'AGENTS.md')), false);

        const install = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
          cwd: extractDir,
          encoding: 'utf8',
          timeout: 300_000,
        });
        assert.equal(install.status, 0, install.stderr || install.stdout);

        if (hasGitMetadata(repoRoot)) {
          const env = {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            USER: process.env.USER,
            LANG: process.env.LANG,
            AITHEMA_SOURCE_PROOF: '1',
          };
          if (process.env.npm_config_cache) env.npm_config_cache = process.env.npm_config_cache;
          const tests = spawnSync('npm', ['test'], {
            cwd: extractDir,
            encoding: 'utf8',
            timeout: 300_000,
            env,
          });
          const output = `${tests.stdout}\n${tests.stderr}`;
          assert.equal(tests.status, 0, output);
          assert.match(output, /fail 0/);
          assert.match(output, /tests 1\d\d/);
        }

        const gitRelease = buildRelease({ repoRoot: repo, commit: source.commit, outDir: gitOut });
        const treeRelease = buildRelease({ repoRoot: extractDir, outDir: treeOut });
        assert.equal(treeRelease.publication.status, 'published');
        assert.equal(treeRelease.manifest.source.commit, gitRelease.manifest.source.commit);
        assert.equal(treeRelease.manifest.source.tree_digest, gitRelease.manifest.source.tree_digest);
        assert.equal(treeRelease.manifest.source.lock_digest, gitRelease.manifest.source.lock_digest);
        assert.equal(treeRelease.artifactSha256, gitRelease.artifactSha256);
        assert.equal(treeRelease.manifestText, gitRelease.manifestText);
        assert.equal(exported.manifest.version, VERSION);
        assert.equal(exported.manifest.version_scheme, LEGACY_SEMVER_PUBLIC);
        assert.equal(exported.manifest.release_channel, 'github-source');
        assert.equal(exported.manifest.private, true);
        assert.equal(gitRelease.manifest.version, VERSION);
        assert.equal(gitRelease.manifest.version_scheme, LEGACY_SEMVER_PUBLIC);
        assert.equal(gitRelease.manifest.release_channel, 'github-runtime-tgz');
        assert.equal(gitRelease.manifest.private, true);
        if (hasGitMetadata(repoRoot) && repo === repoRoot) {
          assert.equal(exported.manifest.source.private_source_commit, PRIVATE_LINEAGE_COMMIT);
          assert.equal(exported.manifest.source.current_source_commit, source.commit);
          assert.equal(gitRelease.manifest.source.commit, source.commit);
        }

        const repeat = buildRelease({ repoRoot: extractDir, outDir: gitOut });
        assert.equal(repeat.publication.status, 'identical');
      } finally {
        removeTemp(buildDir);
        removeTemp(extractDir);
        removeTemp(gitOut);
        removeTemp(treeOut);
      }
    });
  });

  it('refuses tree-mode release when exported content no longer matches provenance', () => {
    withGitSource((repo) => {
      const buildDir = mkdtempSync(join(tmpdir(), 'aithema-source-tamper-build-'));
      const extractDir = mkdtempSync(join(tmpdir(), 'aithema-source-tamper-extract-'));
      const outDir = mkdtempSync(join(tmpdir(), 'aithema-source-tamper-out-'));
      try {
        const exported = buildSourceExport({ repoRoot: repo, outDir: buildDir });
        extractTarball(exported.artifactPath, extractDir);
        writeFileSync(join(extractDir, 'lib/index.js'), `${readFileSync(join(extractDir, 'lib/index.js'), 'utf8')}\n`, 'utf8');
        assert.throws(
          () => buildRelease({ repoRoot: extractDir, outDir }),
          /tree-mode provenance mismatch/,
        );
      } finally {
        removeTemp(buildDir);
        removeTemp(extractDir);
        removeTemp(outDir);
      }
    });
  });

  it('preserves private_source_commit across public git init and a later public commit', () => {
    const repo = createTempRepo('aithema-source-chain-');
    const firstOut = mkdtempSync(join(tmpdir(), 'aithema-source-chain-first-'));
    const extractDir = mkdtempSync(join(tmpdir(), 'aithema-source-chain-extract-'));
    const publicOut = mkdtempSync(join(tmpdir(), 'aithema-source-chain-public-'));
    const laterOut = mkdtempSync(join(tmpdir(), 'aithema-source-chain-later-'));
    try {
      seedSourceExportTree(repo);
      commitAll(repo, 'private analog');
      const privateCommit = resolveCommit(repo);
      const first = buildSourceExport({ repoRoot: repo, commit: privateCommit, outDir: firstOut });
      assert.equal(first.manifest.source.private_source_commit, privateCommit);
      assert.equal(first.manifest.source.current_source_commit, privateCommit);

      extractTarball(first.artifactPath, extractDir);
      const provenance = parseSourceProvenance(readFileSync(join(extractDir, 'release/source-provenance.json'), 'utf8'));
      assert.equal(provenance.private_source_commit, privateCommit);
      assert.equal(provenance.current_source_commit, privateCommit);

      git(extractDir, ['init']);
      git(extractDir, ['config', 'user.email', 'public-fixture@example.invalid']);
      git(extractDir, ['config', 'user.name', 'Public Fixture']);
      commitAll(extractDir, 'public initial history');
      const publicCommit = resolveCommit(extractDir);
      assert.notEqual(publicCommit, privateCommit);

      const publicExport = buildSourceExport({ repoRoot: extractDir, outDir: publicOut });
      assert.equal(publicExport.manifest.source.private_source_commit, privateCommit);
      assert.equal(publicExport.manifest.source.current_source_commit, publicCommit);

      writeFileSync(join(extractDir, 'README.md'), `${readFileSync(join(extractDir, 'README.md'), 'utf8')}\n`, 'utf8');
      commitAll(extractDir, 'subsequent public commit');
      const laterCommit = resolveCommit(extractDir);
      const laterExport = buildSourceExport({ repoRoot: extractDir, outDir: laterOut });
      assert.equal(laterExport.manifest.source.private_source_commit, privateCommit);
      assert.equal(laterExport.manifest.source.current_source_commit, laterCommit);
      assert.notEqual(laterCommit, publicCommit);
    } finally {
      removeTemp(repo);
      removeTemp(firstOut);
      removeTemp(extractDir);
      removeTemp(publicOut);
      removeTemp(laterOut);
    }
  });

  it('publication inventory documents prerequisites and outstanding coordinator gates', () => {
    const inventory = JSON.parse(readFileSync(join(repoRoot, 'release/publication-inventory.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'));
    const notices = JSON.parse(readFileSync(join(repoRoot, 'NOTICES.json'), 'utf8'));
    assert.equal(inventory.schema, 'aithema-publication-inventory/0.1');
    assert.equal(inventory.version, VERSION);
    assert.equal(pkg.version, VERSION);
    assert.equal(pkg.private, true);
    assert.equal(lock.version, VERSION);
    assert.equal(lock.packages[''].version, VERSION);
    assert.equal(notices.package.version, VERSION);
    assert.equal(notices.package.private, true);
    assert.equal(inventory.version_scheme, LEGACY_SEMVER_PUBLIC);
    assert.equal(inventory.release_channels.runtime_package, 'github-runtime-tgz');
    assert.equal(inventory.release_channels.public_source_candidate, 'github-source');
    assert.equal(inventory.package_registry.publish, false);
    assert.equal(inventory.package_registry.npm_private_flag, true);
    assert.equal(inventory.package_registry.namespace_claim, false);
    assert.equal(inventory.public_repository_target, 'inspr-at/aithema');
    assert.ok(Array.isArray(inventory.outstanding_coordinator_gates));
    assert.ok(inventory.outstanding_coordinator_gates.length >= 3);
    assert.match(inventory.test_prerequisites.system.join(' '), /trash/i);
    assert.equal(inventory.ci.auto_publish_on_push, false);
    assert.equal(inventory.exports.public_source_candidate.script, 'source:export');
    assert.match(inventory.handoff.review_extract, /mkdir -p/);
    assert.match(inventory.ci.retained_forge_assets, /retain-forge-assets/);
    assert.match(inventory.ci.retained_forge_assets, /refs\/tags\//);
    assert.match(inventory.ci.canonical_toolchain_enforcement, /AITHEMA_CANONICAL_RELEASE/);
    assert.match(inventory.ci.ephemeral_transfer, /upload-artifact/);
    assert.equal(inventory.reproducibility.canonical_toolchain.tar_family, 'gnu');
    assert.equal(inventory.reproducibility.canonical_toolchain.timestamp_policy, 'git-committer-epoch-seconds');
    assert.equal(inventory.reproducibility.runtime_manifest_schema, 'aithema-release-manifest/0.1');
    assert.match(inventory.handoff.provenance_note, /source\.commit/);
  });

  it('negative control: tampered source manifest is rejected on rebuild', () => {
    withGitSource((repo) => {
      const outDir = mkdtempSync(join(tmpdir(), 'aithema-source-tamper-'));
      const source = resolveSourceExport(repo);
      try {
        const first = buildSourceExport({ repoRoot: repo, commit: source.commit, allowlist: source.allowlist, outDir });
        const manifest = JSON.parse(readFileSync(first.manifestPath, 'utf8'));
        manifest.source.private_source_commit = '0'.repeat(40);
        writeFileSync(first.manifestPath, canonicalSourceManifestText(manifest), 'utf8');
        assert.throws(
          () => buildSourceExport({ repoRoot: repo, commit: source.commit, allowlist: source.allowlist, outDir }),
          /refusing to overwrite non-identical source manifest/,
        );
        assert.equal(existsSync(first.artifactPath), true);
      } finally {
        removeTemp(outDir);
      }
    });
  });

  it('runtime tree digest uses git blob ids, GNU fallback flags stay aligned, and admission validates SemVer', () => {
    const repo = createTempRepo('aithema-blob-id-');
    try {
      const path = join(repo, 'blob.txt');
      writeFileSync(path, 'hello provenance\n');
      assert.equal(gitBlobSha1(readFileSync(path)), git(repo, ['hash-object', 'blob.txt']));
    } finally {
      removeTemp(repo);
    }
    assert.deepEqual(GNU_TAR_FALLBACK_FLAGS, [
      '--create',
      '--format=gnu',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '--no-recursion',
    ]);
    assert.equal(identifyTarFamily('tar (GNU tar) 1.35\nCopyright (C) 2023 Free Software Foundation, Inc.'), 'gnu');
    assert.equal(identifyTarFamily('bsdtar 3.5.3 - libarchive 3.5.3 zlib/1.2.11'), 'bsd');
    assert.equal(CANONICAL_ARTIFACT_TOOLCHAIN.tar_family, 'gnu');
    assert.equal(CANONICAL_ARTIFACT_TOOLCHAIN.ci_runner, 'ubuntu-latest');
    assert.equal(CANONICAL_ARTIFACT_TOOLCHAIN.timestamp_policy, 'git-committer-epoch-seconds');
    assert.equal(
      assertCanonicalReleaseToolchain({
        requireCanonical: false,
        tarVersionText: 'bsdtar 3.5.3 - libarchive 3.5.3',
        nodeVersion: '20.0.0',
      }).enforced,
      false,
    );
    assert.equal(
      assertCanonicalReleaseToolchain({
        requireCanonical: true,
        tarVersionText: 'tar (GNU tar) 1.35',
        nodeVersion: '22.11.0',
      }).enforced,
      true,
    );
    assert.throws(
      () => assertCanonicalReleaseToolchain({
        requireCanonical: true,
        tarVersionText: 'bsdtar 3.5.3 - libarchive 3.5.3',
        nodeVersion: '22.11.0',
      }),
      /requires gnu tar/,
    );
    assert.throws(
      () => assertCanonicalReleaseToolchain({
        requireCanonical: true,
        tarVersionText: 'tar (GNU tar) 1.35',
        nodeVersion: '20.11.0',
      }),
      /requires Node 22/,
    );
    assert.equal(assertStrictSemVer('0.0.0'), '0.0.0');
    assert.equal(assertStrictSemVer(VERSION), VERSION);
    assert.throws(() => assertStrictSemVer('0.0.0" || true'), /invalid strict SemVer/);
    assert.equal(assertAdmissibleReleaseRef('refs/heads/main'), 'refs/heads/main');
    assert.throws(() => assertAdmissibleReleaseRef('refs/heads/feat/x'), /limited to main/);
    assert.equal(assertReleaseRefMatchesVersion('refs/tags/v0.0.0', PRIVATE_FIXTURE_VERSION), 'v0.0.0');
    assert.equal(assertReleaseRefMatchesVersion(`refs/tags/v${VERSION}`, VERSION), `v${VERSION}`);
    assert.equal(assertReleaseRefMatchesVersion('refs/heads/main', VERSION), null);
    assert.throws(
      () => assertReleaseRefMatchesVersion('refs/tags/v0.0.0', VERSION),
      /does not match coordinate/,
    );
    assert.throws(
      () => assertReleaseRefMatchesVersion('refs/tags/v9.9.9', VERSION),
      /does not match coordinate/,
    );
    assert.throws(
      () => admitRelease({ repoRoot, version: VERSION, ref: 'refs/tags/v9.9.9' }),
      /does not match coordinate/,
    );
    assert.throws(
      () => admitRelease({ repoRoot, version: '9.9.9' }),
      /does not match coordinate/,
    );
    assert.equal(assertVersionScheme(LEGACY_SEMVER_PRIVATE), LEGACY_SEMVER_PRIVATE);
    assert.equal(assertVersionScheme(LEGACY_SEMVER_PUBLIC), LEGACY_SEMVER_PUBLIC);
    assert.throws(
      () => assertVersionScheme('legacy-semver'),
      /explicit legacy-semver discriminator/,
    );
  });

  it('public git init, re-export, and later commit keep git/non-Git runtime manifests on current source', () => {
    const repo = createTempRepo('aithema-runtime-chain-');
    const firstOut = mkdtempSync(join(tmpdir(), 'aithema-runtime-chain-first-'));
    const extractDir = mkdtempSync(join(tmpdir(), 'aithema-runtime-chain-extract-'));
    const publicOut = mkdtempSync(join(tmpdir(), 'aithema-runtime-chain-public-'));
    const publicExtract = mkdtempSync(join(tmpdir(), 'aithema-runtime-chain-public-extract-'));
    const sharedOut = mkdtempSync(join(tmpdir(), 'aithema-runtime-chain-shared-'));
    const laterOut = mkdtempSync(join(tmpdir(), 'aithema-runtime-chain-later-'));
    const laterExtract = mkdtempSync(join(tmpdir(), 'aithema-runtime-chain-later-extract-'));
    const laterShared = mkdtempSync(join(tmpdir(), 'aithema-runtime-chain-later-shared-'));
    try {
      seedSourceExportTree(repo);
      commitAll(repo, 'private analog');
      const privateCommit = resolveCommit(repo);
      const first = buildSourceExport({ repoRoot: repo, commit: privateCommit, outDir: firstOut });
      extractTarball(first.artifactPath, extractDir);

      git(extractDir, ['init']);
      git(extractDir, ['config', 'user.email', 'public-fixture@example.invalid']);
      git(extractDir, ['config', 'user.name', 'Public Fixture']);
      commitAll(extractDir, 'public initial history');
      const publicCommit = resolveCommit(extractDir);
      assert.notEqual(publicCommit, privateCommit);

      const publicExport = buildSourceExport({ repoRoot: extractDir, outDir: publicOut });
      assert.equal(publicExport.manifest.source.private_source_commit, privateCommit);
      assert.equal(publicExport.manifest.source.current_source_commit, publicCommit);
      extractTarball(publicExport.artifactPath, publicExtract);
      assert.equal(hasGitMetadata(publicExtract), false);
      const publicProvenance = parseSourceProvenance(
        readFileSync(join(publicExtract, 'release/source-provenance.json'), 'utf8'),
      );
      assert.equal(publicProvenance.private_source_commit, privateCommit);
      assert.equal(publicProvenance.current_source_commit, publicCommit);

      const gitRelease = buildRelease({ repoRoot: extractDir, outDir: sharedOut });
      assert.equal(gitRelease.publication.status, 'published');
      assert.equal(gitRelease.manifest.schema, 'aithema-release-manifest/0.1');
      assert.deepEqual(Object.keys(gitRelease.manifest.source).sort(), ['commit', 'lock_digest', 'tree_digest']);
      assert.equal(gitRelease.manifest.source.commit, publicCommit);
      assert.notEqual(gitRelease.manifest.source.commit, privateCommit);

      const treeRelease = buildRelease({ repoRoot: publicExtract, outDir: sharedOut });
      assert.equal(treeRelease.publication.status, 'identical');
      assert.equal(treeRelease.manifest.source.commit, publicCommit);
      assert.equal(treeRelease.manifest.source.tree_digest, gitRelease.manifest.source.tree_digest);
      assert.equal(treeRelease.manifest.source.lock_digest, gitRelease.manifest.source.lock_digest);
      assert.equal(treeRelease.artifactSha256, gitRelease.artifactSha256);
      assert.equal(treeRelease.manifestText, gitRelease.manifestText);

      assert.throws(
        () => buildRelease({ repoRoot: publicExtract, commit: privateCommit, outDir: sharedOut }),
        /does not match current_source_commit/,
      );

      const colliding = JSON.parse(gitRelease.manifestText);
      colliding.source.commit = privateCommit;
      assert.throws(
        () => publishImmutableReleasePair({
          releaseDir: join(sharedOut, stableReleaseDirname(VERSION)),
          artifactName: gitRelease.manifest.artifacts[0].path,
          artifactBytes: gitRelease.artifactBytes,
          manifestName: stableManifestFilename(VERSION),
          manifestText: canonicalManifestText(colliding),
          artifactCoordinate: gitRelease.manifest.artifacts[0].coordinate,
        }),
        /refusing to overwrite non-identical manifest/,
      );

      writeFileSync(join(extractDir, 'README.md'), `${readFileSync(join(extractDir, 'README.md'), 'utf8')}\n`, 'utf8');
      commitAll(extractDir, 'subsequent public commit');
      const laterCommit = resolveCommit(extractDir);
      assert.notEqual(laterCommit, publicCommit);
      const laterExport = buildSourceExport({ repoRoot: extractDir, outDir: laterOut });
      assert.equal(laterExport.manifest.source.private_source_commit, privateCommit);
      assert.equal(laterExport.manifest.source.current_source_commit, laterCommit);
      extractTarball(laterExport.artifactPath, laterExtract);

      const laterGit = buildRelease({ repoRoot: extractDir, outDir: laterShared });
      const laterTree = buildRelease({ repoRoot: laterExtract, outDir: laterShared });
      assert.equal(laterGit.manifest.source.commit, laterCommit);
      assert.equal(laterTree.publication.status, 'identical');
      assert.equal(laterTree.manifestText, laterGit.manifestText);
      assert.equal(laterTree.artifactSha256, laterGit.artifactSha256);
      assert.notEqual(laterGit.artifactSha256, gitRelease.artifactSha256);
      assert.throws(
        () => buildRelease({ repoRoot: extractDir, outDir: sharedOut }),
        /refusing to overwrite non-identical (artifact|manifest)/,
      );
    } finally {
      removeTemp(repo);
      removeTemp(firstOut);
      removeTemp(extractDir);
      removeTemp(publicOut);
      removeTemp(publicExtract);
      removeTemp(sharedOut);
      removeTemp(laterOut);
      removeTemp(laterExtract);
      removeTemp(laterShared);
    }
  });

  it('frozen runtime schema 0.1 stays compatible and fails closed on extra source keys', () => {
    const privateFixture = {
      schema: 'aithema-release-manifest/0.1',
      version_scheme: LEGACY_SEMVER_PRIVATE,
      version: PRIVATE_FIXTURE_VERSION,
      private: true,
      release_channel: 'private-source',
      source: {
        commit: 'a'.repeat(40),
        tree_digest: `sha256:${'b'.repeat(64)}`,
        lock_digest: `sha256:${'c'.repeat(64)}`,
      },
      artifacts: [{
        coordinate: `npm:@inspr/aithema-core@${PRIVATE_FIXTURE_VERSION}.tgz`,
        path: `inspr-aithema-core-${PRIVATE_FIXTURE_VERSION}.tgz`,
        sha256: `sha256:${'d'.repeat(64)}`,
      }],
    };
    assertManifestBinding(privateFixture);
    const publicDeclared = {
      ...privateFixture,
      version_scheme: LEGACY_SEMVER_PUBLIC,
      version: VERSION,
      release_channel: 'github-runtime-tgz',
      artifacts: [{
        coordinate: `npm:@inspr/aithema-core@${VERSION}.tgz`,
        path: `inspr-aithema-core-${VERSION}.tgz`,
        sha256: `sha256:${'d'.repeat(64)}`,
      }],
    };
    assertManifestBinding(publicDeclared);
    assert.throws(
      () => assertManifestBinding({
        ...privateFixture,
        source: { ...privateFixture.source, current_source_commit: 'e'.repeat(40) },
      }),
      /frozen schema 0.1/,
    );
    assert.throws(
      () => assertManifestBinding({ ...privateFixture, schema: 'aithema-release-manifest/0.2' }),
      /aithema-release-manifest\/0.1/,
    );
  });

  it('forge asset retention is idempotent on identical bytes and refuses replacements', () => {
    const digestA = `sha256:${sha256('runtime-tgz')}`;
    const digestB = `sha256:${sha256('runtime-manifest')}`;
    const digestC = `sha256:${sha256('source-tgz')}`;
    const digestD = `sha256:${sha256('source-manifest')}`;
    const localAssets = [
      { name: 'inspr-aithema-core-0.0.0.tgz', sha256: digestA },
      { name: 'inspr-aithema-core-0.0.0.manifest.json', sha256: digestB },
      { name: 'inspr-aithema-core-source-0.0.0.tgz', sha256: digestC },
      { name: 'inspr-aithema-core-source-0.0.0.manifest.json', sha256: digestD },
    ];
    assert.equal(
      planForgeAssetRetention({ ref: 'refs/heads/main', version: PRIVATE_FIXTURE_VERSION, localAssets }).action,
      'skip',
    );
    assert.equal(
      planForgeAssetRetention({ ref: 'refs/tags/0.0.0', version: PRIVATE_FIXTURE_VERSION, localAssets }).action,
      'create',
    );
    assert.equal(
      planForgeAssetRetention({ ref: 'refs/tags/v0.0.0', version: PRIVATE_FIXTURE_VERSION, localAssets }).action,
      'create',
    );
    assert.throws(
      () => planForgeAssetRetention({ ref: 'refs/tags/v9.9.9', version: PRIVATE_FIXTURE_VERSION, localAssets: [] }),
      /does not match coordinate/,
    );
    assert.throws(
      () => planForgeAssetRetention({ ref: 'refs/tags/9.9.9', version: PRIVATE_FIXTURE_VERSION, localAssets }),
      /does not match coordinate/,
    );
    assert.throws(
      () => planForgeAssetRetention({ ref: 'refs/tags/0.0.0', version: VERSION, localAssets }),
      /does not match coordinate/,
    );
    assert.equal(
      planForgeAssetRetention({
        ref: 'refs/tags/0.0.0',
        version: PRIVATE_FIXTURE_VERSION,
        localAssets,
        existingAssetDigests: Object.fromEntries(localAssets.map((asset) => [asset.name, asset.sha256])),
      }).action,
      'identical',
    );
    const missingPlan = planForgeAssetRetention({
      ref: 'refs/tags/0.0.0',
      version: PRIVATE_FIXTURE_VERSION,
      localAssets,
      existingAssetDigests: Object.fromEntries(
        localAssets.slice(1).map((asset) => [asset.name, asset.sha256]),
      ),
    });
    assert.equal(missingPlan.action, 'upload-missing');
    assert.deepEqual(missingPlan.missing, ['inspr-aithema-core-0.0.0.tgz']);
    const conflict = planForgeAssetRetention({
      ref: 'refs/tags/0.0.0',
      version: PRIVATE_FIXTURE_VERSION,
      localAssets,
      existingAssetDigests: {
        ...Object.fromEntries(localAssets.map((asset) => [asset.name, asset.sha256])),
        'inspr-aithema-core-0.0.0.tgz': `sha256:${sha256('other-bytes')}`,
      },
    });
    assert.equal(conflict.action, 'conflict');
    assert.deepEqual(conflict.conflicts, ['inspr-aithema-core-0.0.0.tgz']);

    const workflow = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8');
    assert.match(workflow, /retain-forge-assets\.mjs/);
    assert.match(workflow, /AITHEMA_CANONICAL_RELEASE: '1'/);
    assert.match(workflow, /upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
    assert.equal(workflow.includes('--clobber'), false);
    for (const match of workflow.matchAll(/^\s+run:\s*(.+)$/gm)) {
      assert.equal(match[1].includes('${{'), false, match[1]);
    }
  });

  it('refuses a mismatched release tag before any forge I/O', () => {
    const log = [];
    const forge = {
      viewRelease(tag) {
        log.push(['view', tag]);
        return null;
      },
      downloadAsset(tag, name) {
        log.push(['download', tag, name]);
        return Buffer.from('unused');
      },
      createRelease(input) {
        log.push(['create', input.tag, input.title]);
      },
      uploadAssets(tag, files) {
        log.push(['upload', tag, ...files]);
      },
    };
    const distRoot = join(repoRoot, 'dist-must-not-be-read-on-tag-mismatch');
    for (const ref of ['refs/tags/v9.9.9', 'refs/tags/9.9.9']) {
      assert.throws(
        () => retainForgeAssets({
          repoRoot,
          distRoot,
          version: VERSION,
          ref,
          forge,
        }),
        /does not match coordinate/,
      );
    }
    assert.deepEqual(log, []);
  });

  it('retains admitted forge assets through a synthetic adapter without replacing bytes', () => {
    const repo = createTempRepo('aithema-forge-retain-');
    try {
      seedSourceExportTree(repo);
      commitAll(repo, 'seed retain fixture');
      const distRoot = join(repo, 'dist');
      buildRelease({ repoRoot: repo, outDir: distRoot });
      buildSourceExport({ repoRoot: repo, outDir: distRoot });
      const created = [];
      const uploaded = [];
      const downloaded = [];
      const store = new Map();
      const forge = {
        viewRelease() {
          if (!store.size) return null;
          return { names: [...store.keys()] };
        },
        downloadAsset(_tag, name) {
          downloaded.push(name);
          return store.get(name);
        },
        createRelease({ files }) {
          created.push(files);
          for (const file of files) {
            store.set(file.split('/').pop(), readFileSync(file));
          }
        },
        uploadAssets(_tag, files) {
          uploaded.push(files);
          for (const file of files) {
            store.set(file.split('/').pop(), readFileSync(file));
          }
        },
      };
      const first = retainForgeAssets({
        repoRoot: repo,
        distRoot,
        version: VERSION,
        ref: `refs/tags/${VERSION}`,
        forge,
      });
      assert.equal(first.action, 'create');
      assert.equal(created.length, 1);
      const repeat = retainForgeAssets({
        repoRoot: repo,
        distRoot,
        version: VERSION,
        ref: `refs/tags/${VERSION}`,
        forge,
      });
      assert.equal(repeat.action, 'identical');
      assert.equal(uploaded.length, 0);
      store.set('unexpected-remote.txt', Buffer.from('not-an-admitted-asset\n'));
      const withStray = retainForgeAssets({
        repoRoot: repo,
        distRoot,
        version: VERSION,
        ref: `refs/tags/v${VERSION}`,
        forge,
      });
      assert.equal(withStray.action, 'identical');
      assert.equal(downloaded.includes('unexpected-remote.txt'), false);
      store.delete(`inspr-aithema-core-${VERSION}.manifest.json`);
      const recovered = retainForgeAssets({
        repoRoot: repo,
        distRoot,
        version: VERSION,
        ref: `refs/tags/${VERSION}`,
        forge,
      });
      assert.equal(recovered.action, 'upload-missing');
      assert.deepEqual(recovered.missing, [`inspr-aithema-core-${VERSION}.manifest.json`]);
      assert.equal(uploaded.length, 1);
      const skipped = retainForgeAssets({
        repoRoot: repo,
        distRoot,
        version: VERSION,
        ref: 'refs/heads/main',
        forge,
      });
      assert.equal(skipped.action, 'skip');

      const originalTgz = readFileSync(join(distRoot, `inspr-aithema-core-${VERSION}`, `inspr-aithema-core-${VERSION}.tgz`));
      store.set(`inspr-aithema-core-${VERSION}.tgz`, Buffer.from('mutated-release-bytes\n'));
      assert.throws(
        () => retainForgeAssets({
          repoRoot: repo,
          distRoot,
          version: VERSION,
          ref: `refs/tags/${VERSION}`,
          forge,
        }),
        /refusing to replace non-identical GitHub Release assets/,
      );
      assert.notEqual(originalTgz.equals(store.get(`inspr-aithema-core-${VERSION}.tgz`)), true);
    } finally {
      removeTemp(repo);
    }
  });
});
