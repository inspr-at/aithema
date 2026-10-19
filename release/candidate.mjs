import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './lib/digest.mjs';
import { testConsumer } from './consumer.mjs';
import { verifyRelease } from './pack.mjs';
import { normalizedDigest } from './normalize.mjs';

export function buildCandidate(output, sourceRef = 'HEAD') {
  mkdirSync(output, { recursive: true });
  const root = fileURLToPath(new URL('../', import.meta.url));
  const npm = args => execFileSync('npm', ['run', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  const first = join(output, 'first'), second = join(output, 'second');
  npm(['release:pack', '--', first, '--candidate', sourceRef]);
  npm(['release:pack', '--', second, '--candidate', sourceRef]);
  npm(['release:verify', '--', first]); npm(['release:verify', '--', second]);
  const manifest = verifyRelease(first);
  if (!readFileSync(join(first, 'release-set.json')).equals(readFileSync(join(second, 'release-set.json')))) throw new Error('Manifest is not reproducible');
  for (const artifact of manifest.artifacts) {
    if (!readFileSync(join(first, artifact.path)).equals(readFileSync(join(second, artifact.path)))) throw new Error(`Nonreproducible archive: ${artifact.path}`);
  }
  const consumer = testConsumer(first);
  const evidence = { schema: 'aithema-candidate-evidence/1', version: manifest.version, source_commit: manifest.source.commit,
    built_at: new Date().toISOString(), runner: process.env.GITHUB_ACTIONS ? 'GitHub Actions' : 'mbp2606',
    toolchain: { node: process.versions.node, tar: execFileSync('tar', ['--version'], { encoding: 'utf8' }).split('\n')[0] },
    reproducible: true, builds: 2, manifest_sha256: 'sha256:' + sha256(readFileSync(join(first, 'release-set.json'))),
    normalized_digest: normalizedDigest(first),
    artifacts: manifest.artifacts.map(({ path, name, sha256 }) => ({ path, name, sha256 })), consumer };
  writeFileSync(join(output, 'candidate-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  return evidence;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(buildCandidate(resolve(process.argv[2] ?? 'dist/candidate'), process.argv[3])));
