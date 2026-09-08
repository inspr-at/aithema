#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyReleasePair } from './lib/manifest.mjs';
import { verifySourceReleasePair } from './lib/source-manifest.mjs';
import { assertCanonicalReleaseToolchain } from './lib/tarball.mjs';

const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const defaultRepoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * @param {string} version
 * @returns {string}
 */
export function assertStrictSemVer(version) {
  if (typeof version !== 'string' || !STRICT_SEMVER.test(version)) {
    throw new Error(`invalid strict SemVer coordinate: ${JSON.stringify(version)}`);
  }
  return version;
}

/**
 * @param {string} ref
 * @returns {string}
 */
export function assertAdmissibleReleaseRef(ref) {
  if (ref === 'refs/heads/main') return ref;
  if (typeof ref === 'string' && /^refs\/tags\/v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(ref)) {
    return ref;
  }
  throw new Error(`release admission is limited to main or version tags, got ${JSON.stringify(ref)}`);
}

/**
 * A version tag must be exactly `{version}` or `v{version}`. A syntactically
 * valid tag for a different coordinate is refused before any forge I/O.
 * @param {string} [ref]
 * @param {string} version
 * @returns {string | null} tag name, or null for main / absent ref
 */
export function assertReleaseRefMatchesVersion(ref, version) {
  const coordinate = assertStrictSemVer(version);
  if (!ref) return null;
  assertAdmissibleReleaseRef(ref);
  if (ref === 'refs/heads/main') return null;
  const tag = ref.slice('refs/tags/'.length);
  if (tag !== coordinate && tag !== `v${coordinate}`) {
    throw new Error(
      `release tag ${JSON.stringify(tag)} does not match coordinate ${coordinate}; `
      + `expected refs/tags/${coordinate} or refs/tags/v${coordinate}`,
    );
  }
  return tag;
}

/**
 * @param {object} [options]
 */
export function admitRelease({
  repoRoot = defaultRepoRoot,
  version = process.env.RELEASE_VERSION,
  ref = process.env.RELEASE_REF,
  distRoot = join(repoRoot, 'dist'),
} = {}) {
  const coordinate = assertStrictSemVer(version);
  if (ref) assertReleaseRefMatchesVersion(ref, coordinate);
  assertCanonicalReleaseToolchain();
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  if (pkg.version !== coordinate) {
    throw new Error(`package.json version ${pkg.version} does not match coordinate ${coordinate}`);
  }
  const releaseDir = join(distRoot, `inspr-aithema-core-${coordinate}`);
  const sourceDir = join(distRoot, `inspr-aithema-core-source-${coordinate}`);
  const runtime = verifyReleasePair(releaseDir, `inspr-aithema-core-${coordinate}.manifest.json`);
  const source = verifySourceReleasePair(sourceDir, `inspr-aithema-core-source-${coordinate}.manifest.json`);
  return {
    version: coordinate,
    runtime,
    source,
  };
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  const result = admitRelease();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    version: result.version,
    runtime_sha256: result.runtime.sha256,
    source_sha256: result.source.sha256,
  }, null, 2)}\n`);
}
