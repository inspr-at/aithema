/**
 * One competing release publisher, used by the concurrent-publication oracle.
 *
 * Started by the parent test, it announces readiness, blocks on a shared barrier
 * file so every child enters `publishImmutableReleasePair` at the same moment,
 * and reports its outcome as JSON on stdout / a message on stderr.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { sha256 } from '../../release/lib/digest.mjs';
import {
  buildManifest,
  canonicalManifestText,
  publishImmutableReleasePair,
  stableArtifactFilename,
  stableManifestFilename,
  stableReleaseDirname,
} from '../../release/lib/manifest.mjs';

const outDir = process.env.RACE_OUT_DIR;
const barrierDir = process.env.RACE_BARRIER_DIR;
const tag = process.env.RACE_TAG;
const version = process.env.RACE_VERSION;
const payload = Buffer.from(process.env.RACE_PAYLOAD, 'utf8');

const artifactName = stableArtifactFilename(version);
const manifestName = stableManifestFilename(version);
const releaseDir = join(outDir, stableReleaseDirname(version));
const artifactCoordinate = `npm:@inspr/aithema-core@${version}.tgz`;
const artifactSha256 = sha256(payload);

const manifest = buildManifest({
  commit: sha256(`commit:${process.env.RACE_PAYLOAD}`).slice(0, 40),
  treeDigest: `sha256:${sha256(`tree:${process.env.RACE_PAYLOAD}`)}`,
  lockDigest: `sha256:${sha256('lock')}`,
  version,
  versionScheme: 'legacy-semver-private',
  releaseChannel: 'private-source',
  artifactCoordinate,
  artifactPath: artifactName,
  artifactSha256,
});
const manifestText = canonicalManifestText(manifest);

/**
 * @param {number} ms
 */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

writeFileSync(join(barrierDir, `ready-${tag}`), 'ready\n', 'utf8');
const goPath = join(barrierDir, 'go');
const deadline = Date.now() + 30_000;
while (!existsSync(goPath)) {
  if (Date.now() > deadline) {
    process.stderr.write(`barrier timeout for ${tag}\n`);
    process.exit(2);
  }
  sleep(2);
}

try {
  const result = publishImmutableReleasePair({
    releaseDir,
    artifactName,
    artifactBytes: payload,
    manifestName,
    manifestText,
    artifactCoordinate,
  });
  process.stdout.write(`${JSON.stringify({
    tag,
    status: result.status,
    concurrent: result.concurrent,
    residue: result.residue,
    artifact_sha256: artifactSha256,
  })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
