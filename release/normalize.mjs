import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './lib/digest.mjs';
import { verifyRelease } from './pack.mjs';

// JSON objects are canonicalized recursively; arrays retain their contract order.
export function canonicalJSON(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonicalJSON(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function removeRequired(object, key, valid) {
  if (!Object.hasOwn(object, key) || !valid(object[key])) throw new Error(`Normalization requires valid ${key}`);
  delete object[key];
}
const hash = bytes => 'sha256:' + sha256(bytes);
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
const mode = value => ['candidate', 'release'].includes(value);
const runtimePath = (kind, path) => kind === 'workspace'
  ? ['release/runtime.json', 'packages/server/src/release-runtime.json'].includes(path)
  : path === 'release-runtime.json';
const provenancePath = (kind, path) => kind === 'workspace' && path === 'release/source-provenance.json';

/** Bind member bytes, not tar headers or compression. Only the design's exact
 * leaves are removed. Required removed leaves must exist; all other keys stay.
 * verifyRelease also recomputes provenance.runtime_tree_digest from the full
 * unnormalized workspace and checks module/runtime bindings before returning.
 */
export function normalizedDigest(directory) {
  const archives = [];
  const manifest = structuredClone(verifyRelease(directory, { onArtifact(artifact, members) {
    const normalizedMembers = [...members].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, bytes]) => {
      if (runtimePath(artifact.kind, path)) {
        const runtime = JSON.parse(bytes);
        removeRequired(runtime, 'mode', mode);
        return [path, hash(canonicalJSON(runtime))];
      }
      if (provenancePath(artifact.kind, path)) {
        const provenance = JSON.parse(bytes);
        removeRequired(provenance, 'runtime_tree_digest', digest);
        return [path, hash(canonicalJSON(provenance))];
      }
      return [path, hash(bytes)];
    });
    archives.push({ path: artifact.path, members: normalizedMembers });
  } }));
  removeRequired(manifest, 'mode', mode);
  removeRequired(manifest.packing, 'run', value => typeof value === 'string' && value.length > 0);
  const normalizeInventory = (files, kind) => {
    for (const file of files) if (runtimePath(kind, file.path) || provenancePath(kind, file.path)) {
      removeRequired(file, 'sha256', digest);
      removeRequired(file, 'size', value => Number.isSafeInteger(value) && value >= 0);
    }
  };
  normalizeInventory(manifest.files, 'workspace');
  for (const artifact of manifest.artifacts) {
    removeRequired(artifact, 'sha256', digest);
    if (artifact.kind === 'module') normalizeInventory(artifact.files, 'module');
  }
  archives.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return hash(canonicalJSON({ manifest, archives }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(normalizedDigest(resolve(process.argv[2] ?? 'dist/release')));
}
