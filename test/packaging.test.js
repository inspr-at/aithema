import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildRelease, resolveReleaseSource } from '../release/build-release.mjs';
import {
  npmEnvForCache,
  primeConsumerCache,
  resolveExplicitNpmCache,
  resolvePrimeOutDir,
} from '../release/prime-consumer-cache.mjs';
import { sha256 } from '../release/lib/digest.mjs';
import {
  FLOW_SHELL_TARBALL_SHA256,
  FLOW_SHELL_VERSION,
} from '../workspace/flow-assets.js';
import {
  commitEpochSeconds,
  expandAllowlistPaths,
  readAllowlistAtCommit,
  resolveCommit,
  validateArchivePath,
} from '../release/lib/git.mjs';
import {
  expandAllowlistPathsFromTree,
  hasGitMetadata,
} from '../release/lib/tree.mjs';
import {
  LEGACY_SEMVER_PUBLIC,
  canonicalManifestText,
  publishImmutableReleasePair,
  stableArtifactFilename,
  stableManifestFilename,
  stableReleaseDirname,
  verifyReleasePair,
} from '../release/lib/manifest.mjs';
import {
  assertIndexUnchanged,
  commitAll,
  createTempRepo,
  git,
  indexTree,
  runPublishRace,
  seedMinimalPackageTree,
  stagingResidue,
  trashTemp,
} from './fixtures/packaging-support.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const PRIVATE_FIXTURE_VERSION = '0.0.0';
const ARTIFACT_NAME = stableArtifactFilename(VERSION);
const MANIFEST_NAME = stableManifestFilename(VERSION);
const RELEASE_DIRNAME = stableReleaseDirname(VERSION);
const PRIVATE_ARTIFACT_NAME = stableArtifactFilename(PRIVATE_FIXTURE_VERSION);
const PRIVATE_MANIFEST_NAME = stableManifestFilename(PRIVATE_FIXTURE_VERSION);
const PRIVATE_RELEASE_DIRNAME = stableReleaseDirname(PRIVATE_FIXTURE_VERSION);
const COORDINATE = `npm:@inspr/aithema-core@${VERSION}.tgz`;
const FLOW_SHELL_ARTIFACT = `inspr-flow-shell-${FLOW_SHELL_VERSION}.tgz`;

/**
 * npm --offline cannot replay GitHub Release HTTP tarball fetches. The primed
 * cache still stores the exact bytes by integrity; the consumer proof replays
 * those bytes as a file: override without changing the published GitHub pin.
 * @param {string} cacheDir
 * @param {string} integrity
 */
function cachedIntegrityTarball(cacheDir, integrity) {
  const hex = Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex');
  return join(cacheDir, '_cacache', 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
}

/**
 * @param {string} path
 */
function removeTemp(path) {
  trashTemp(path);
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
 * A throwaway repository holding one complete, committed package tree.
 * @param {string} prefix
 * @returns {{ repo: string, commit: string }}
 */
function seededFixtureRepo(prefix) {
  const repo = createTempRepo(prefix);
  seedMinimalPackageTree(repo);
  commitAll(repo, 'seed fixture');
  return { repo, commit: resolveCommit(repo) };
}

describe('AIT-10 reproducible packaging', () => {
  it('resolveReleaseSource pins the current commit and rejects option-like refs', () => {
    const source = resolveReleaseSource(repoRoot);
    assert.match(source.commit, /^[0-9a-f]{40}$/);
    if (hasGitMetadata(repoRoot)) {
      assert.equal(source.commit, resolveCommit(repoRoot));
      assert.equal(source.fromTree, false);
    } else {
      assert.equal(source.fromTree, true);
    }
    assert.throws(() => resolveReleaseSource(repoRoot, '--help'), /invalid commit ref/);
    assert.throws(() => resolveReleaseSource(repoRoot, '--upload-pack=touch'), /invalid commit ref/);
  });

  it('allowlist stays closed and rejects unsafe archive path shapes', () => {
    const allowlist = hasGitMetadata(repoRoot)
      ? readAllowlistAtCommit(repoRoot, resolveCommit(repoRoot))
      : JSON.parse(readFileSync(join(repoRoot, 'release/allowlist.json'), 'utf8'));
    const paths = hasGitMetadata(repoRoot)
      ? expandAllowlistPaths(repoRoot, resolveCommit(repoRoot), allowlist.paths)
      : expandAllowlistPathsFromTree(repoRoot, allowlist.paths);
    assert.ok(paths.length > 0);
    assert.throws(() => validateArchivePath('-etc/passwd'), /looks like an option/);
    assert.throws(() => validateArchivePath('a\nb'), /control characters/);
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
    assert.equal(paths.includes('test/baseline.test.js'), false);
    assert.equal(paths.includes('release/build-release.mjs'), false);
  });

  it('resolves any supplied ref to an immutable commit and records that sha', () => {
    const { repo, commit } = seededFixtureRepo('aithema-pack-refs-');
    const outDir = mkdtempSync(join(tmpdir(), 'aithema-pack-refs-out-'));
    try {
      git(repo, ['tag', 'fixture-release-tag']);
      const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
      for (const ref of ['HEAD', branch, 'fixture-release-tag', commit]) {
        const built = buildRelease({ repoRoot: repo, commit: ref, outDir });
        assert.equal(built.manifest.source.commit, commit);
        assert.match(built.manifest.source.commit, /^[0-9a-f]{40}$/);
        assert.equal(built.commit, commit);
      }

      const treeSha = git(repo, ['rev-parse', 'HEAD^{tree}']);
      assert.throws(
        () => buildRelease({ repoRoot: repo, commit: treeSha, outDir }),
        /release source must be a commit object, got tree/,
      );
      assert.throws(
        () => buildRelease({ repoRoot: repo, commit: '--output=/tmp/pwned', outDir }),
        /invalid commit ref/,
      );
      assert.throws(
        () => buildRelease({ repoRoot: repo, commit: 'refs/heads/no-such-branch', outDir }),
        /rev-parse|Command failed/,
      );
      assert.throws(() => commitEpochSeconds(repo, treeSha), /requires a commit object, got tree/);
    } finally {
      removeTemp(repo);
      removeTemp(outDir);
    }
  });

  it('refuses to widen the release source through a caller-supplied allowlist', () => {
    const { repo, commit } = seededFixtureRepo('aithema-pack-widen-');
    const outDir = mkdtempSync(join(tmpdir(), 'aithema-pack-widen-out-'));
    try {
      const committed = readAllowlistAtCommit(repo, commit);
      assert.throws(
        () => buildRelease({
          repoRoot: repo,
          commit,
          allowlist: { ...committed, paths: [...committed.paths, 'release/'] },
          outDir,
        }),
        /cannot be widened through build options/,
      );
      assert.throws(
        () => buildRelease({
          repoRoot: repo,
          commit,
          allowlist: { ...committed, forbidden_patterns: [] },
          outDir,
        }),
        /cannot be widened through build options/,
      );

      // An equal allowlist written in a different key order is still the commit's allowlist.
      const reordered = {
        forbidden_patterns: [...committed.forbidden_patterns],
        paths: [...committed.paths],
        description: committed.description,
      };
      const built = buildRelease({ repoRoot: repo, commit, allowlist: reordered, outDir });
      assert.equal(built.paths.some((path) => path.startsWith('release/')), false);
      assert.equal(built.paths.some((path) => path.startsWith('test/')), false);
      assert.equal(listTarballPaths(built.artifactPath).some((entry) => entry.includes('/release/')), false);
    } finally {
      removeTemp(repo);
      removeTemp(outDir);
    }
  });

  it('refuses a publication inventory whose version does not match package.json', () => {
    const { repo } = seededFixtureRepo('aithema-pack-inventory-mismatch-');
    const outDir = mkdtempSync(join(tmpdir(), 'aithema-pack-inventory-mismatch-out-'));
    try {
      const inventoryPath = join(repo, 'release/publication-inventory.json');
      const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
      inventory.version = '9.9.9';
      writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
      commitAll(repo, 'mismatched inventory version');
      assert.throws(
        () => buildRelease({ repoRoot: repo, outDir }),
        /does not match package.json version/,
      );
    } finally {
      removeTemp(repo);
      removeTemp(outDir);
    }
  });

  it('builds only from the pinned commit, ignoring a dirty worktree, and leaves the index alone', () => {
    const { repo, commit } = seededFixtureRepo('aithema-pack-pin-');
    const outA = mkdtempSync(join(tmpdir(), 'aithema-pack-pin-a-'));
    const outB = mkdtempSync(join(tmpdir(), 'aithema-pack-pin-b-'));
    try {
      const indexBefore = indexTree(repo);
      const first = buildRelease({ repoRoot: repo, commit, outDir: outA });
      const dirtyPackage = '{"name":"mutated","version":"9.9.9"}\n';
      writeFileSync(join(repo, 'package.json'), dirtyPackage, 'utf8');
      writeFileSync(join(repo, 'worker-result.txt'), 'operator residue\n', 'utf8');
      const second = buildRelease({ repoRoot: repo, commit, outDir: outB });

      assert.equal(first.artifactSha256, second.artifactSha256);
      assert.equal(first.manifestText, second.manifestText);
      assert.equal(second.manifest.version, VERSION);
      assert.equal(second.manifest.private, true);
      assert.equal(second.manifest.version_scheme, LEGACY_SEMVER_PUBLIC);
      assert.equal(second.manifest.release_channel, 'github-runtime-tgz');
      assertIndexUnchanged(repo, indexBefore);
      assert.equal(readFileSync(join(repo, 'package.json'), 'utf8'), dirtyPackage);
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

  it('rejects an older commit whose allowlisted inventory is incomplete', () => {
    const repo = createTempRepo('aithema-pack-incomplete-');
    const outDir = mkdtempSync(join(tmpdir(), 'aithema-pack-incomplete-out-'));
    try {
      seedMinimalPackageTree(repo);
      git(repo, [
        'add', '--',
        'LICENSE', 'NOTICES.json', 'README.md', 'RUNBOOK.md',
        'package.json', 'package-lock.json', 'examples', 'runtime', 'workspace', 'release',
      ]);
      git(repo, ['commit', '-m', 'incomplete inventory']);
      const incomplete = resolveCommit(repo);
      commitAll(repo, 'complete inventory');
      const complete = resolveCommit(repo);

      assert.notEqual(incomplete, complete);
      assert.throws(
        () => buildRelease({ repoRoot: repo, commit: incomplete, outDir }),
        /allowlisted directory missing at|allowlisted path missing at/,
      );
      const built = buildRelease({ repoRoot: repo, commit: complete, outDir });
      assert.equal(built.manifest.source.commit, complete);
    } finally {
      removeTemp(repo);
      removeTemp(outDir);
    }
  });

  it('rejects committed symlink and gitlink fixtures in an isolated repository', () => {
    const fixtureRepo = createTempRepo('aithema-pack-malicious-');
    try {
      seedMinimalPackageTree(fixtureRepo, {
        paths: ['package.json', 'package-lock.json', 'LICENSE', 'NOTICES.json', 'README.md', 'RUNBOOK.md', 'lib/'],
        forbidden_patterns: ['^\\.env'],
      });
      commitAll(fixtureRepo, 'seed fixture');
      const symlinkPath = join(fixtureRepo, 'lib', 'escape-link.js');
      symlinkSync('package.json', symlinkPath);
      commitAll(fixtureRepo, 'tracked symlink');
      assert.throws(
        () => buildRelease({ repoRoot: fixtureRepo }),
        /allowlisted symlink rejected/,
      );

      const cleanRepo = createTempRepo('aithema-pack-gitlink-');
      try {
        seedMinimalPackageTree(cleanRepo, {
          paths: ['package.json', 'package-lock.json', 'LICENSE', 'NOTICES.json', 'README.md', 'RUNBOOK.md', 'lib/'],
          forbidden_patterns: ['^\\.env'],
        });
        commitAll(cleanRepo, 'seed fixture');
        git(cleanRepo, ['commit', '--allow-empty', '-m', 'gitlink target']);
        const linkCommit = git(cleanRepo, ['rev-parse', 'HEAD']);
        git(cleanRepo, [
          'update-index', '--add', '--cacheinfo',
          `160000,${linkCommit},lib/submodule`,
        ]);
        git(cleanRepo, ['commit', '-m', 'tracked gitlink']);
        assert.throws(
          () => buildRelease({ repoRoot: cleanRepo }),
          /allowlisted gitlink rejected/,
        );
      } finally {
        removeTemp(cleanRepo);
      }
    } finally {
      removeTemp(fixtureRepo);
    }
  });

  it('excludes untracked operator residue in an isolated repository without touching it', () => {
    const fixtureRepo = createTempRepo('aithema-pack-untracked-');
    const outDir = mkdtempSync(join(tmpdir(), 'aithema-pack-untracked-out-'));
    try {
      seedMinimalPackageTree(fixtureRepo);
      commitAll(fixtureRepo, 'seed fixture');
      writeFileSync(join(fixtureRepo, '.env'), 'synthetic-adversarial-fixture\n', 'utf8');
      writeFileSync(join(fixtureRepo, 'worker-result.txt'), 'synthetic-adversarial-fixture\n', 'utf8');
      mkdirSync(join(fixtureRepo, '.data', 'packaging-adversarial'), { recursive: true });
      writeFileSync(join(fixtureRepo, '.data/packaging-adversarial/operator.sqlite'), 'fixture\n', 'utf8');
      const result = buildRelease({ repoRoot: fixtureRepo, outDir });
      const listed = listTarballPaths(result.artifactPath);
      assert.equal(listed.some((entry) => entry.includes('.env')), false);
      assert.equal(listed.some((entry) => entry.includes('operator.sqlite')), false);
      assert.equal(listed.some((entry) => entry.includes('worker-result.txt')), false);
      assert.equal(existsSync(join(fixtureRepo, '.env')), true);
    } finally {
      removeTemp(fixtureRepo);
      removeTemp(outDir);
    }
  });

  it('produces byte-identical tarball and manifest bytes from independent output dirs', () => {
    const outA = mkdtempSync(join(tmpdir(), 'aithema-pack-a-'));
    const outB = mkdtempSync(join(tmpdir(), 'aithema-pack-b-'));
    const source = resolveReleaseSource(repoRoot);
    try {
      const first = buildRelease({ repoRoot, ...source, outDir: outA });
      const second = buildRelease({ repoRoot, ...source, outDir: outB });
      assert.equal(first.artifactSha256, second.artifactSha256);
      assert.equal(first.manifestText, second.manifestText);
      assert.equal(first.manifest.artifacts[0].path, ARTIFACT_NAME);
      assert.equal(first.releaseDir, join(outA, RELEASE_DIRNAME));
      assert.equal(first.publication.status, 'published');
      assert.equal(
        readFileSync(first.artifactPath).compare(readFileSync(second.artifactPath)),
        0,
      );

      // A byte-identical repeat into an already published coordinate is idempotent.
      const repeat = buildRelease({ repoRoot, ...source, outDir: outA });
      assert.equal(repeat.publication.status, 'identical');
      assert.equal(repeat.artifactSha256, first.artifactSha256);
      assert.deepEqual(stagingResidue(outA), []);
    } finally {
      removeTemp(outA);
      removeTemp(outB);
    }
  });

  it('verifies a published pair by re-hashing the artifact against its own manifest', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'aithema-pack-verify-'));
    const source = resolveReleaseSource(repoRoot);
    try {
      const built = buildRelease({ repoRoot, ...source, outDir });
      const verified = verifyReleasePair(built.releaseDir, MANIFEST_NAME);
      assert.equal(verified.sha256, `sha256:${built.artifactSha256}`);
      assert.equal(verified.manifest.source.commit, source.commit);
      assert.equal(verified.manifest.schema, 'aithema-release-manifest/0.1');
      assert.deepEqual(Object.keys(verified.manifest.source).sort(), ['commit', 'lock_digest', 'tree_digest']);
      assert.equal(verified.artifactPath, built.artifactPath);

      writeFileSync(built.artifactPath, 'tampered-after-publication\n', 'utf8');
      assert.throws(
        () => verifyReleasePair(built.releaseDir, MANIFEST_NAME),
        /published artifact digest mismatch/,
      );
    } finally {
      removeTemp(outDir);
    }
  });

  it('refuses changed manifest bytes even when the artifact digest still matches', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'aithema-pack-manifest-collision-'));
    const source = resolveReleaseSource(repoRoot);
    try {
      const first = buildRelease({ repoRoot, ...source, outDir });
      const manifest = JSON.parse(readFileSync(first.manifestPath, 'utf8'));
      manifest.source.commit = '0'.repeat(40);
      writeFileSync(first.manifestPath, canonicalManifestText(manifest), 'utf8');
      assert.throws(
        () => buildRelease({ repoRoot, ...source, outDir }),
        /refusing to overwrite non-identical manifest/,
      );
      assert.throws(
        () => buildRelease({ repoRoot, ...source, outDir }),
        /refusing to overwrite non-identical manifest/,
      );
      assert.deepEqual(stagingResidue(outDir), []);
    } finally {
      removeTemp(outDir);
    }
  });

  it('refuses non-identical artifacts, symlinked coordinates, and unrelated occupants', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'aithema-pack-collision-'));
    const source = resolveReleaseSource(repoRoot);
    try {
      const first = buildRelease({ repoRoot, ...source, outDir });
      writeFileSync(first.artifactPath, 'different-bytes\n', 'utf8');
      assert.throws(
        () => buildRelease({ repoRoot, ...source, outDir }),
        /refusing to overwrite non-identical artifact/,
      );

      const symlinkDir = mkdtempSync(join(tmpdir(), 'aithema-pack-symlink-out-'));
      const realDir = mkdtempSync(join(tmpdir(), 'aithema-pack-real-out-'));
      mkdirSync(join(realDir, RELEASE_DIRNAME));
      symlinkSync(join(realDir, RELEASE_DIRNAME), join(symlinkDir, RELEASE_DIRNAME));
      assert.throws(
        () => buildRelease({ repoRoot, ...source, outDir: symlinkDir }),
        /must not follow symlinks/,
      );

      const fileDir = mkdtempSync(join(tmpdir(), 'aithema-pack-file-out-'));
      writeFileSync(join(fileDir, RELEASE_DIRNAME), 'not a release directory\n', 'utf8');
      assert.throws(
        () => buildRelease({ repoRoot, ...source, outDir: fileDir }),
        /occupied by a non-directory/,
      );

      const occupiedDir = mkdtempSync(join(tmpdir(), 'aithema-pack-occupied-out-'));
      mkdirSync(join(occupiedDir, RELEASE_DIRNAME));
      writeFileSync(join(occupiedDir, RELEASE_DIRNAME, 'unrelated.txt'), 'keep me\n', 'utf8');
      assert.throws(
        () => buildRelease({ repoRoot, ...source, outDir: occupiedDir }),
        /holds unrelated files/,
      );
      assert.equal(existsSync(join(occupiedDir, RELEASE_DIRNAME, 'unrelated.txt')), true);
      assert.deepEqual(stagingResidue(occupiedDir), []);

      removeTemp(symlinkDir);
      removeTemp(realDir);
      removeTemp(fileDir);
      removeTemp(occupiedDir);
    } finally {
      removeTemp(outDir);
    }
  });

  it('leaves nothing published and no residue when publication fails midway, then recovers', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'aithema-pack-injected-failure-'));
    const source = resolveReleaseSource(repoRoot);
    try {
      const releaseDir = join(outDir, RELEASE_DIRNAME);
      assert.throws(
        () => publishImmutableReleasePair({
          releaseDir,
          artifactName: ARTIFACT_NAME,
          artifactBytes: Buffer.from('staged-artifact-bytes\n', 'utf8'),
          manifestName: MANIFEST_NAME,
          // Fails only after the artifact is already staged: a mid-publish crash.
          manifestText: { not: 'a string' },
          artifactCoordinate: COORDINATE,
        }),
        /must be of type string/,
      );
      assert.equal(existsSync(releaseDir), false);
      assert.deepEqual(stagingResidue(outDir), []);

      // The coordinate is free, so a normal build still succeeds: no wedged state.
      const built = buildRelease({ repoRoot, ...source, outDir });
      assert.equal(built.publication.status, 'published');
      verifyReleasePair(built.releaseDir, MANIFEST_NAME);
    } finally {
      removeTemp(outDir);
    }
  });

  it('reports a half-published coordinate and accepts the pair once it is whole again', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'aithema-pack-half-published-'));
    const parkDir = mkdtempSync(join(tmpdir(), 'aithema-pack-parked-manifest-'));
    const source = resolveReleaseSource(repoRoot);
    try {
      const built = buildRelease({ repoRoot, ...source, outDir });
      const parked = join(parkDir, MANIFEST_NAME);
      renameSync(built.manifestPath, parked);
      assert.throws(
        () => buildRelease({ repoRoot, ...source, outDir }),
        /refusing to leave mismatched artifact\/manifest pair/,
      );
      assert.equal(existsSync(built.artifactPath), true);
      assert.deepEqual(stagingResidue(outDir), []);

      // Documented safe recovery: restore (or trash) the coordinate, then rebuild.
      renameSync(parked, built.manifestPath);
      const healed = buildRelease({ repoRoot, ...source, outDir });
      assert.equal(healed.publication.status, 'identical');
      verifyReleasePair(healed.releaseDir, MANIFEST_NAME);
    } finally {
      removeTemp(parkDir);
      removeTemp(outDir);
    }
  });

  it('keeps exactly one coherent pair when concurrent builders publish different bytes', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'aithema-pack-race-different-'));
    try {
      const payloads = { alpha: 'alpha-release-bytes\n', beta: 'beta-release-bytes\n' };
      const results = await runPublishRace({ outDir, version: PRIVATE_FIXTURE_VERSION, payloads });
      const codes = Object.values(results).map((entry) => entry.code);
      assert.equal(codes.filter((code) => code === 0).length, 1, JSON.stringify(results));
      assert.equal(codes.filter((code) => code === 1).length, 1, JSON.stringify(results));

      const loser = Object.values(results).find((entry) => entry.code === 1);
      assert.match(loser.stderr, /refusing to overwrite non-identical (artifact|manifest)/);

      const releaseDir = join(outDir, PRIVATE_RELEASE_DIRNAME);
      const verified = verifyReleasePair(releaseDir, PRIVATE_MANIFEST_NAME);
      const published = readFileSync(join(releaseDir, PRIVATE_ARTIFACT_NAME), 'utf8');
      assert.ok(Object.values(payloads).includes(published));
      assert.equal(verified.sha256, `sha256:${sha256(published)}`);
      assert.deepEqual(readdirSync(releaseDir).sort(), [PRIVATE_ARTIFACT_NAME, PRIVATE_MANIFEST_NAME].sort());
      assert.deepEqual(stagingResidue(outDir), []);
    } finally {
      removeTemp(outDir);
    }
  });

  it('lets concurrent builders of byte-identical bytes both succeed exactly once', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'aithema-pack-race-identical-'));
    try {
      const payloads = { one: 'same-release-bytes\n', two: 'same-release-bytes\n' };
      const results = await runPublishRace({ outDir, version: PRIVATE_FIXTURE_VERSION, payloads });
      for (const entry of Object.values(results)) {
        assert.equal(entry.code, 0, entry.stderr);
      }
      const statuses = Object.values(results)
        .map((entry) => JSON.parse(entry.stdout.trim()).status)
        .sort();
      assert.deepEqual(statuses, ['identical', 'published']);
      verifyReleasePair(join(outDir, PRIVATE_RELEASE_DIRNAME), PRIVATE_MANIFEST_NAME);
      assert.deepEqual(stagingResidue(outDir), []);
    } finally {
      removeTemp(outDir);
    }
  });

  it('verifies canonical AGPL license surface and dependency notices', () => {
    const license = spawnSync(process.execPath, ['release/verify-license.mjs'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(license.status, 0, license.stderr || license.stdout);
    const notices = JSON.parse(readFileSync(join(repoRoot, 'NOTICES.json'), 'utf8'));
    assert.equal(notices.package.license, 'AGPL-3.0-only');
    assert.ok(notices.dependencies.length >= 4);
  });

  it('clean consumer installs the tarball offline and resolves every import from its own node_modules', () => {
    const buildDir = mkdtempSync(join(tmpdir(), 'aithema-pack-consumer-build-'));
    const unprimedDir = mkdtempSync(join(tmpdir(), 'aithema-pack-consumer-unprimed-'));
    const consumerDir = mkdtempSync(join(tmpdir(), 'aithema-pack-consumer-'));
    const cacheDir = mkdtempSync(join(tmpdir(), 'aithema-pack-npm-cache-'));
    const source = resolveReleaseSource(repoRoot);
    try {
      assert.throws(() => resolveExplicitNpmCache(''), /implicit global npm cache/);
      assert.throws(() => resolvePrimeOutDir(join(repoRoot, 'dist')), /into dist/);

      const built = buildRelease({ repoRoot, ...source, outDir: buildDir });
      const vendorUnprimed = join(unprimedDir, 'vendor');
      mkdirSync(vendorUnprimed, { recursive: true });
      copyFileSync(built.artifactPath, join(vendorUnprimed, ARTIFACT_NAME));
      writeFileSync(join(unprimedDir, 'package.json'), `${JSON.stringify({
        name: 'aithema-clean-consumer-unprimed',
        private: true,
        type: 'module',
        dependencies: {
          '@inspr/aithema-core': `file:./vendor/${ARTIFACT_NAME}`,
        },
      }, null, 2)}\n`, 'utf8');

      const unprimed = spawnSync(
        'npm',
        ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--offline'],
        {
          cwd: unprimedDir,
          encoding: 'utf8',
          timeout: 300_000,
          env: { ...npmEnvForCache(cacheDir), npm_config_offline: 'true' },
        },
      );
      assert.notEqual(unprimed.status, 0);
      assert.match(`${unprimed.stderr}\n${unprimed.stdout}`, /ENOTCACHED/);

      primeConsumerCache({ artifactPath: built.artifactPath, cacheDir });

      const vendorDir = join(consumerDir, 'vendor');
      mkdirSync(vendorDir, { recursive: true });
      copyFileSync(built.artifactPath, join(vendorDir, ARTIFACT_NAME));
      const flowIntegrity = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'))
        .packages['node_modules/@inspr/flow-shell'].integrity;
      const flowTarball = cachedIntegrityTarball(cacheDir, flowIntegrity);
      copyFileSync(flowTarball, join(vendorDir, FLOW_SHELL_ARTIFACT));
      assert.equal(sha256(readFileSync(join(vendorDir, FLOW_SHELL_ARTIFACT))), FLOW_SHELL_TARBALL_SHA256);
      writeFileSync(join(consumerDir, 'package.json'), `${JSON.stringify({
        name: 'aithema-clean-consumer-proof',
        private: true,
        type: 'module',
        dependencies: {
          '@inspr/aithema-core': `file:./vendor/${ARTIFACT_NAME}`,
          '@inspr/flow-shell': `file:./vendor/${FLOW_SHELL_ARTIFACT}`,
        },
        overrides: {
          '@inspr/flow-shell': `file:./vendor/${FLOW_SHELL_ARTIFACT}`,
        },
      }, null, 2)}\n`, 'utf8');

      const install = spawnSync(
        'npm',
        ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--offline'],
        {
          cwd: consumerDir,
          encoding: 'utf8',
          timeout: 300_000,
          env: { ...npmEnvForCache(cacheDir), npm_config_offline: 'true' },
        },
      );
      assert.equal(
        install.status,
        0,
        `offline install failed after named packument prime.\n${install.stderr || install.stdout}`,
      );

      // The proof only counts when it runs from inside the consumer installation.
      copyFileSync(join(repoRoot, 'release', 'consumer-proof.mjs'), join(consumerDir, 'consumer-proof.mjs'));
      const proof = spawnSync(process.execPath, ['consumer-proof.mjs'], {
        cwd: consumerDir,
        encoding: 'utf8',
        timeout: 300_000,
        env: { ...process.env, NODE_PATH: undefined },
      });
      assert.equal(proof.status, 0, proof.stderr || proof.stdout);
      const payload = JSON.parse(proof.stdout.trim().split('\n').at(-1) ?? '{}');
      assert.equal(payload.ok, true);

      const installRoot = `${pathToFileURL(join(realpathSync(consumerDir), 'node_modules')).href}/`;
      assert.equal(payload.install_root, installRoot);
      for (const specifier of [
        '@inspr/aithema-core',
        '@inspr/aithema-core/runtime',
        '@inspr/aithema-core/workspace',
        '@inspr/flow-shell',
        'unpdf',
      ]) {
        assert.ok(
          payload.resolved[specifier]?.startsWith(installRoot),
          `${specifier} resolved to ${payload.resolved[specifier]}, expected under ${installRoot}`,
        );
      }
      assert.ok(payload.resolved['@inspr/aithema-core'].includes('/node_modules/@inspr/aithema-core/'));
      assert.equal(payload.resolved['@inspr/aithema-core'].startsWith(pathToFileURL(repoRoot).href), false);
      assert.equal(lstatSync(join(consumerDir, 'node_modules', '@inspr', 'aithema-core')).isDirectory(), true);
    } finally {
      removeTemp(buildDir);
      removeTemp(unprimedDir);
      removeTemp(consumerDir);
      removeTemp(cacheDir);
    }
  });

  it('negative control: the consumer proof fails when the package is not installed', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'aithema-pack-negative-control-'));
    try {
      writeFileSync(join(emptyDir, 'package.json'), `${JSON.stringify({
        name: 'aithema-negative-control',
        private: true,
        type: 'module',
      }, null, 2)}\n`, 'utf8');
      copyFileSync(join(repoRoot, 'release', 'consumer-proof.mjs'), join(emptyDir, 'consumer-proof.mjs'));
      assert.equal(existsSync(join(emptyDir, 'node_modules')), false);

      const proof = spawnSync(process.execPath, ['consumer-proof.mjs'], {
        cwd: emptyDir,
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, NODE_PATH: undefined },
      });
      assert.notEqual(proof.status, 0);
      assert.equal(proof.stdout.includes('"ok":true'), false);
      assert.match(
        proof.stderr,
        /ERR_MODULE_NOT_FOUND|Cannot find package|did not resolve from the consumer installation/,
      );
    } finally {
      removeTemp(emptyDir);
    }
  });
});
