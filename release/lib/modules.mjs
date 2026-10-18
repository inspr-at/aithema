import { posix } from 'node:path';

// Composed voice coordinators/adapters are retained only in the source archive.
const excluded = new Set(['packages/server/src/local-voice.js', 'packages/server/src/composed-voice.js',
  // The unexported ElevenLabs component adapter remains a source-only proof.
  'plugins/elevenlabs/src/components.js']);

const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export function moduleFiles(files, pkg) {
  const folder = posix.dirname(pkg.path), prefix = folder + '/';
  const members = new Map();
  for (const [path, bytes] of files) {
    if (!path.startsWith(prefix)) continue;
    const local = path.slice(prefix.length);
    if (excluded.has(path)) continue;
    let content = bytes;
    if (/\.(?:js|ts)$/u.test(local)) {
      content = Buffer.from(bytes.toString().replace(/(\b(?:from\s*|import\s*(?:\(\s*)?))(['"`])(\.{1,2}\/[^'"`\n]+)\2/gu, (match, introducer, quote, specifier) => {
        const target = posix.normalize(posix.join(posix.dirname(path), specifier));
        if (excluded.has(target)) throw new Error(`Unpackaged dependency: ${path} -> ${specifier}`);
        if (target.startsWith(prefix)) return match;
        const metadataPath = target.replace(/\/src\/.+$/u, '/package.json');
        const targetBytes = files.get(metadataPath);
        if (!targetBytes) throw new Error(`Unpackaged dependency: ${path} -> ${specifier}`);
        const metadata = JSON.parse(targetBytes);
        const subpath = './' + target.split('/src/')[1].replace(/\.(?:d\.ts|js)$/u, '');
        if (!metadata.exports?.[subpath]) throw new Error(`Missing package export: ${metadata.name}/${subpath}`);
        return introducer + quote + metadata.name + '/' + subpath.slice(2) + quote;
      }));
    }
    members.set(local, content);
  }
  members.set('LICENSE', files.get('LICENSE'));
  members.set('README.md', files.get('docs/embedding.md'));
  // Keep source provenance and rights notes available in each package.
  members.set('SOURCE.md', files.get('README.md'));
  members.set('release-runtime.json', files.get('release/runtime.json'));
  const metadata = JSON.parse(members.get('package.json'));
  metadata.files = [...new Set([...members.keys()].map(path => path.split('/')[0]))].filter(path => path !== 'package.json');
  members.set('package.json', json(metadata));
  return members;
}
