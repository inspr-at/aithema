import { activeTurns, HTML_MEDIA_TYPE, frameDocument, withAITextOrigin } from '@inspr/aithema-core';
import { createHash } from 'node:crypto';
import serverPackage from '../package.json' with { type: 'json' };

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// Literal message text cannot close its fence or manufacture a role/AI label.
function messageText(content) {
  const length = (content.match(/`+/gu) ?? []).reduce((max, run) => Math.max(max, run.length + 1), 3);
  const fence = '`'.repeat(length);
  return `${fence}text\n${content}\n${fence}\n`;
}
// Dependency-free, store-only ZIP. UTF-8 flags; fixed timestamp for reproducible exports.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function zipStore(files) {
  const locals = [], directory = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const filename = Buffer.from(name), bytes = Buffer.from(value), crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0x21, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    locals.push(header, filename, bytes);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    directory.push(central, filename); offset += header.length + filename.length + bytes.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22), count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
export function exportSession(session, artifacts = [], withheld = [], {
  exportedAt = new Date().toISOString(), commit = process.env.AITHEMA_COMMIT,
} = {}) {
  const json = value => JSON.stringify(value, null, 2) + '\n';
  const published = new Set(artifacts.map(a => a.id));
  const accounted = new Set([...published, ...withheld.map(a => a.id)]);
  const omissions = [...withheld, ...(session.concepts ?? []).filter(c => !accounted.has(c.id))
    .map(c => ({ id: c.id, reason: 'artifact-unavailable' }))];
  const concepts = (session.concepts ?? []).map(c => published.has(c.id) ? c : Object.fromEntries(
    ['id', 'requestId', 'createdAt', 'inputRevision', 'turnIds', 'referenceIds', 'disposition', 'archived', 'mediaType', 'width', 'height']
      .filter(key => Object.hasOwn(c, key)).map(key => [key, c[key]])));
  // Replies name the acknowledged model and response style that produced them.
  const engine = t => t.engine?.label ? ` · ${[t.engine.label, t.engine.effort && t.engine.effort !== 'none' ? t.engine.effort : null].filter(Boolean).join(' · ')}` : '';
  const { model = null, effort = null, voice = null, visuals = null } = session.settings ?? {};
  const files = {
    'transcript.json': json({ sessionId: session.id, processing: { preset: session.processingPreset ?? 'best', model, effort, voice, visuals },
      turns: activeTurns(session).map(withAITextOrigin) }),
    'transcript.md': '# Conversation\n\n' + activeTurns(session).map(t => `## ${t.role}${engine(t)}${t.provenance === 'browser-asserted' ? ' (browser-asserted)' : ''}${t.role === 'assistant' ? ' (AI-generated)' : ''}\n\n${messageText(t.content)}`).join('\n'),
    'understanding.json': json(session.understanding.inputRevision === null ? session.understanding : withAITextOrigin(session.understanding)),
    ...((session.uploads ?? []).length ? { 'uploads.json': json(session.uploads.map(u => u.state === 'withdrawn' || u.erased || u.withdrawn
      ? { id: u.id } : Object.fromEntries(['id', 'state', 'filename', 'mediaType', 'bytes', 'at', 'text', 'reason', 'truncated', 'extractor']
        .filter(key => u[key] !== undefined).map(key => [key, u[key]])))) } : {}),
    ...(concepts.length ? { 'concepts.json': json(concepts) } : {}),
    ...(artifacts.length || omissions.length ? { 'concepts-manifest.json': json({ version: 1,
      included: artifacts.map(a => ({ id: a.id, path: `concepts/${a.id}.${a.mediaType.split('/')[1]}`,
        ...(a.mediaType.startsWith('image/') ? { promptDigest: a.promptDigest, provenance: a.provenance } : {}) })), withheld: omissions }) } : {}),
    ...Object.fromEntries(artifacts.flatMap(a => [[`concepts/${a.id}.${a.mediaType.split('/')[1]}`, a.mediaType === HTML_MEDIA_TYPE
      ? frameDocument(new TextDecoder().decode(a.bytes), { standalone: true }) : a.bytes], [`concepts/${a.id}.provenance.json`, json(a.provenance)]])),
  };
  const originals = new Map(artifacts.map(a => [`concepts/${a.id}.${a.mediaType.split('/')[1]}`, Buffer.from(a.bytes)]));
  files['manifest.json'] = json({ version: 1, generator: { name: 'aithema', version: serverPackage.version,
    ...(typeof commit === 'string' && /^[a-f0-9]{7,40}$/u.test(commit) ? { commit } : {}) }, exportedAt,
    // The manifest excludes itself: its own exported-byte hash would be recursive.
    files: Object.entries(files).map(([path, value]) => {
      const bytes = Buffer.from(value), original = originals.get(path);
      return { path, sha256: sha256(bytes), ...(original && !bytes.equals(original) ? { originalSha256: sha256(original) } : {}) };
    }), withheld: omissions,
    erased: [...session.transcript.filter(t => t.erased || t.withdrawn).map(t => ({ kind: 'turn', id: t.id })),
      ...(session.uploads ?? []).filter(u => u.erased || u.withdrawn || u.state === 'withdrawn').map(u => ({ kind: 'upload', id: u.id })),
      ...omissions.filter(a => a.reason === 'erased').map(a => ({ kind: 'concept', id: a.id }))],
  });
  return zipStore(files);
}
