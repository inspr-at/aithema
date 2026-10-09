// Generic Office readers ported from START src/lib/ooxml.ts, with PPTX and stricter ZIP bounds.
import { inflateRawSync, crc32 } from 'node:zlib';
import { inspectZip, ArchiveError } from '@inspr/aithema-core/extractor-zip';
import { EXTRACTOR_MEDIA_TYPES } from '@inspr/aithema-core/extractor';
import { serveExtractor } from '@inspr/aithema-core/extractor-process';
import { fileURLToPath } from 'node:url';

function readParts(bytes, entries, wanted) {
  const parts = new Map();
  for (const [name, entry] of entries) {
    if (!wanted(name)) continue;
    const raw = bytes.subarray(entry.dataAt, entry.dataAt + entry.compressedSize);
    const inflated = entry.method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) });
    if (inflated.length !== entry.size || crc32(inflated) !== entry.crc) throw new ArchiveError();
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(inflated);
    // Office parts cannot introduce entity definitions, external or recursive.
    if (/<!\s*(?:DOCTYPE|ENTITY)/iu.test(xml)) throw new ArchiveError();
    parts.set(name, xml);
  }
  return parts;
}
// Forward-only scans avoid START's former quadratic unterminated-tag behavior.
function* elements(xml, open, close) {
  const pattern = new RegExp(open.source, 'gu');
  let from = 0;
  for (;;) {
    pattern.lastIndex = from;
    const match = pattern.exec(xml);
    if (!match) return;
    const bodyAt = match.index + match[0].length, closeAt = xml.indexOf(close, bodyAt);
    if (closeAt < 0) throw new ArchiveError();
    yield { attrs: match[1] ?? '', body: xml.slice(bodyAt, closeAt) };
    from = closeAt + close.length;
  }
}
function entities(text) {
  const known = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{1,16});/gu, (whole, body) => {
    if (!body.startsWith('#')) return known[body] ?? whole;
    const code = body.startsWith('#x') ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
  });
}
function runs(xml, prefix, maxChars) {
  let text = '';
  const open = new RegExp(`<${prefix}t(?:\\s[^>]{0,512})?>`, 'u');
  for (const run of elements(xml, open, `</${prefix}t>`)) {
    text += entities(run.body);
    if (text.length > maxChars) break;
  }
  return text;
}
function docxText(xml, maxChars) {
  let text = '';
  const token = /<w:t(?:\s[^>]{0,512})?>|<\/w:p>|<w:tab\b[^>]{0,512}\/?>|<w:br\b[^>]{0,512}\/?>/gu;
  for (let match = token.exec(xml); match; match = token.exec(xml)) {
    const tag = match[0];
    if (tag.startsWith('</w:p>') || tag.startsWith('<w:br')) text += '\n';
    else if (tag.startsWith('<w:tab')) text += '\t';
    else {
      const bodyAt = match.index + tag.length, closeAt = xml.indexOf('</w:t>', bodyAt);
      if (closeAt < 0) throw new ArchiveError();
      text += entities(xml.slice(bodyAt, closeAt));
      token.lastIndex = closeAt + 6;
    }
    if (text.length > maxChars) break;
  }
  return text;
}
function sheetText(xml, strings, maxChars) {
  const rows = [];
  let chars = 0;
  for (const row of elements(xml, /<row\b[^>]{0,512}>/u, '</row>')) {
    const cells = [];
    for (const cell of elements(row.body, /<c\b([^>]{0,512})>/u, '</c>')) {
      const type = /\bt="([^"\n]{0,64})"/u.exec(cell.attrs)?.[1];
      const value = [...elements(cell.body, /<v(?:\s[^>]{0,512})?>/u, '</v>')][0]?.body;
      const decoded = value === undefined ? '' : entities(value);
      cells.push(type === 'inlineStr' ? runs(cell.body, '', maxChars) :
        type === 's' ? (/^\d{1,9}$/u.test(decoded) ? strings[Number(decoded)] ?? '' : '') : decoded);
      chars += cells.at(-1).length + 1;
      if (chars > maxChars) break;
    }
    while (cells.at(-1) === '') cells.pop();
    rows.push(cells.join('\t'));
    if (chars > maxChars) break;
  }
  return rows.join('\n');
}
const attribute = (attrs, name) => new RegExp(`\\b${name}="([^"\\n]{0,256})"`, 'u').exec(attrs)?.[1];
function orderedParts(document, rels, element, base, allowed) {
  const targets = new Map();
  for (const rel of rels.matchAll(/<Relationship\b([^>]{0,512})\/?>/gu)) {
    if (attribute(rel[1], 'TargetMode') === 'External') continue;
    const id = attribute(rel[1], 'Id'), target = attribute(rel[1], 'Target');
    if (id && target) targets.set(id, target.replace(new RegExp(`^/?(?:${base}/)?`, 'u'), ''));
  }
  return [...document.matchAll(new RegExp(`<${element}\\b([^>]{0,512})/?>`, 'gu'))].map(sheet => {
    const target = targets.get(attribute(sheet[1], 'r:id'));
    if (!target || !allowed.test(target)) throw new ArchiveError();
    return { part: `${base}/${target}`, label: entities(attribute(sheet[1], 'name') ?? '') };
  });
}
function collectParts(ordered, limits, render) {
  if (!ordered.length) throw new ArchiveError();
  if (ordered.length > limits.maxPages) throw new ArchiveError('limit');
  const segments = [];
  let chars = 0, truncated = false;
  for (const [index, part] of ordered.entries()) {
    const text = render(part, Math.max(1, limits.maxChars - chars)).trim();
    if (text) { segments.push({ text: text.slice(0, limits.maxChars - chars + 1), page: index + 1 }); chars += text.length + (segments.length > 1 ? 2 : 0); }
    if (chars >= limits.maxChars) { truncated = chars > limits.maxChars || index < ordered.length - 1; break; }
  }
  return { segments, truncated };
}
export function parseOOXML(bytes, mediaType, limits) {
  const entries = inspectZip(bytes, limits);
  const parts = readParts(bytes, entries, name => name === 'word/document.xml' || /^word\/(?:header|footer)\d*\.xml$/u.test(name) ||
    ['xl/workbook.xml', 'xl/sharedStrings.xml', 'xl/_rels/workbook.xml.rels', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels'].includes(name) ||
    /^xl\/worksheets\/[^/]+\.xml$/u.test(name) || /^ppt\/slides\/slide\d+\.xml$/u.test(name));
  if (mediaType === EXTRACTOR_MEDIA_TYPES.docx) {
    const body = parts.get('word/document.xml');
    if (!body || !/<w:document\b/u.test(body)) throw new ArchiveError();
    let text = docxText(body, limits.maxChars);
    for (const name of [...parts.keys()].filter(name => /^word\/(?:header|footer)/u.test(name)).sort()) {
      if (text.length > limits.maxChars) break;
      text += '\n\n' + docxText(parts.get(name), limits.maxChars - text.length);
    }
    return { segments: [{ text: text.slice(0, limits.maxChars + 1) }], truncated: text.length > limits.maxChars };
  }
  if (mediaType === EXTRACTOR_MEDIA_TYPES.xlsx) {
    const ordered = orderedParts(parts.get('xl/workbook.xml') ?? '', parts.get('xl/_rels/workbook.xml.rels') ?? '',
      'sheet', 'xl', /^worksheets\/[^/]+\.xml$/u);
    const strings = [...elements(parts.get('xl/sharedStrings.xml') ?? '', /<si\b[^>]{0,512}>/u, '</si>')]
      .map(entry => runs(entry.body, '', limits.maxChars));
    return collectParts(ordered, limits, ({ part, label }, allowance) => {
      if (!parts.has(part)) throw new ArchiveError();
      const body = sheetText(parts.get(part), strings, allowance);
      return body.trim() ? `## ${label}\n${body}` : '';
    });
  }
  if (mediaType === EXTRACTOR_MEDIA_TYPES.pptx) {
    if (!/<p:presentation\b/u.test(parts.get('ppt/presentation.xml') ?? '')) throw new ArchiveError();
    const slides = orderedParts(parts.get('ppt/presentation.xml'), parts.get('ppt/_rels/presentation.xml.rels') ?? '',
      'p:sldId', 'ppt', /^slides\/slide\d+\.xml$/u);
    return collectParts(slides, limits, ({ part }, allowance) => {
      if (!parts.has(part)) throw new ArchiveError();
      let text = '';
      for (const paragraph of elements(parts.get(part), /<a:p(?:\s[^>]{0,512})?>/u, '</a:p>')) {
        text += runs(paragraph.body, 'a:', allowance) + '\n';
        if (text.length > allowance) break;
      }
      return text;
    });
  }
  throw new ArchiveError('unsupported');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) serveExtractor(parseOOXML);
