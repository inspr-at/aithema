import { posix } from 'node:path';

// Keep the legacy prototype entrypoint excluded. Supported coordinators and
// composed helpers ship from server/src/voice-coordinator.js and src/composed/.
const excluded = new Set(['packages/server/src/local-voice.js', 'packages/server/src/composed-voice.js',
  // The unexported ElevenLabs component adapter remains a source-only proof.
  'plugins/elevenlabs/src/components.js']);

// Members the packer adds at every package root: [package path, workspace source].
const generated = [['LICENSE', 'LICENSE'], ['README.md', 'docs/embedding.md'],
  // Keep source provenance and rights notes available in each package.
  ['SOURCE.md', 'README.md'], ['release-runtime.json', 'release/runtime.json']];

// AIT-592: resolve a new URL asset as the installed package does, in package space with URL
// semantics (query and hash dropped, %2e%2e is .., names %-decoded). The installed root has
// an unknown name, so a target that leaves the root and names its way back resolves
// differently under two root names; it is undefined then, and outside the root.
const packageTarget = (local, specifier) => {
  const [target, other] = ['package', 'package-other'].map(root => {
    try {
      const { pathname } = new URL(specifier, `file:///${root}/${local.split('/').map(encodeURIComponent).join('/')}`);
      return pathname.startsWith(`/${root}/`) ? pathname.slice(root.length + 2) : undefined;
    } catch { return undefined; }
  });
  // An encoded / is not a valid file URL path (fileURLToPath throws).
  if (target === undefined || target !== other || /%2f/iu.test(target)) return undefined;
  try { return decodeURIComponent(target); } catch { return undefined; }
};

const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const exportTargets = value => typeof value === 'string' ? [value] : Object.values(value ?? {}).flatMap(exportTargets);
export function moduleFiles(files, pkg) {
  const folder = posix.dirname(pkg.path), prefix = folder + '/';
  const members = new Map();
  // The final member set: packaged sources plus the generated root members.
  const packaged = new Set([...[...files.keys()].filter(path => path.startsWith(prefix) && !excluded.has(path)).map(path => path.slice(prefix.length)),
    ...generated.filter(([, source]) => files.has(source)).map(([member]) => member)]);
  for (const [path, bytes] of files) {
    if (!path.startsWith(prefix)) continue;
    const local = path.slice(prefix.length);
    if (excluded.has(path)) continue;
    let content = bytes;
    if (/\.(?:js|ts)$/u.test(local)) {
      content = Buffer.from(bytes.toString().replace(/(\b(?:from\s*|import\s*(?:\(\s*)?))(['"`])(\.{1,2}\/[^'"`\n]+)\2/gu, (match, introducer, quote, specifier) => {
        const target = posix.normalize(posix.join(posix.dirname(path), specifier));
        const declaration = path.endsWith('.d.ts') && files.has(target.replace(/\.js$/u, '.d.ts'));
        if (excluded.has(target) || !files.has(target) && !declaration) throw new Error(`Unpackaged dependency: ${path} -> ${specifier}`);
        if (target.startsWith(prefix)) return match;
        const metadataPath = target.replace(/\/src\/.+$/u, '/package.json');
        const targetBytes = files.get(metadataPath);
        if (!targetBytes) throw new Error(`Unpackaged dependency: ${path} -> ${specifier}`);
        const metadata = JSON.parse(targetBytes);
        if (metadata.private === true) throw new Error(`Unpackaged dependency: ${path} -> ${specifier}`);
        const sourcePath = './' + posix.relative(posix.dirname(metadataPath), target);
        const subpath = Object.entries(metadata.exports ?? {}).find(([, value]) => exportTargets(value).includes(sourcePath))?.[0];
        if (!subpath) throw new Error(`Missing package export: ${metadata.name}/${sourcePath}`);
        return introducer + quote + metadata.name + (subpath === '.' ? '' : '/' + subpath.slice(2)) + quote;
        // AIT-592: a new URL asset (.js, .json, .wasm, any extension) must be a member of this package.
      }).replace(/new\s+URL\(\s*(['"])((?:\\[\s\S]|(?!\1)[^\\\n])*\\[\s\S](?:\\[\s\S]|(?!\1)[^\\\n])*|\.{1,2}\/[^'"\n]+)\1\s*,\s*import\.meta\.url\s*\)/gu, (match, _quote, specifier) => {
        // A raw literal with a backslash (escape sequence) fails closed: the raw text is never cooked or resolved.
        if (specifier.includes('\\') || !packaged.has(packageTarget(local, specifier))) throw new Error(`Unpackaged dependency: ${path} -> ${specifier}`);
        return match;
      }));
    }
    members.set(local, content);
  }
  for (const [member, source] of generated) members.set(member, files.get(source));
  const metadata = JSON.parse(members.get('package.json'));
  metadata.files = [...new Set([...members.keys()].map(path => path.split('/')[0]))].filter(path => path !== 'package.json');
  members.set('package.json', json(metadata));
  return members;
}
