import { createHash } from 'node:crypto';
import { IPTC_DIGITAL_SOURCE, PluginError, imageInfo, MAX_IMAGE_BYTES } from '@inspr/aithema-core';
export const promptDigest = prompt => `sha256:${createHash('sha256').update(prompt).digest('hex')}`;
const fail = () => { throw new PluginError('invalid-output'); };
export function decodeImage(encoded) {
  if (typeof encoded !== 'string' || !encoded.length) return fail();
  if (encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new PluginError('limit');
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) return fail();
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) return fail();
  return new Uint8Array(bytes);
}
const xmlEscape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  return (crc ^ 0xffffffff) >>> 0;
}
// START provenance.ts port: XMP metadata, no C2PA signature or local watermark claim.
function embed(bytes, info, provenance) {
  const record = Buffer.from(JSON.stringify(provenance)).toString('base64url');
  const xmp = Buffer.from(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" xmlns:aithema="urn:inspr:aithema:provenance:1" Iptc4xmpExt:DigitalSourceType="${xmlEscape(provenance.digitalSourceType)}" aithema:Record="${record}"/></rdf:RDF></x:xmpmeta>`);
  const source = Buffer.from(bytes);
  // Replace all existing XMP blocks while preserving every other chunk.
  const chunks = []; let offset = info.mediaType === 'image/png' ? 8 : 12;
  while (offset < source.length) {
    const png = info.mediaType === 'image/png';
    const size = png ? source.readUInt32BE(offset) : source.readUInt32LE(offset + 4);
    const type = source.toString('ascii', offset + (png ? 4 : 0), offset + (png ? 8 : 4));
    const at = offset + 8, next = offset + size + (png ? 12 : 8 + size % 2);
    const xmpBlock = png ? ['iTXt', 'tEXt', 'zTXt'].includes(type) &&
      source.subarray(at, at + size).subarray(0, 18).equals(Buffer.from('XML:com.adobe.xmp\0', 'binary')) : type === 'XMP ';
    if (!xmpBlock) {
      if (!png && offset === info.extended) source[at] |= 0x04;
      chunks.push(source.subarray(offset, next));
    }
    offset = next;
  }

  if (info.mediaType === 'image/png') {
    const data = Buffer.concat([Buffer.from('XML:com.adobe.xmp\0\0\0\0\0', 'binary'), xmp]);
    const chunk = Buffer.alloc(data.length + 12); chunk.writeUInt32BE(data.length); chunk.write('iTXt', 4); data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    return Buffer.concat([source.subarray(0, 8), ...chunks.slice(0, -1), chunk, chunks.at(-1)]);
  }
  const chunk = Buffer.alloc(8 + xmp.length + xmp.length % 2); chunk.write('XMP '); chunk.writeUInt32LE(xmp.length, 4); xmp.copy(chunk, 8);
  let output;
  if (info.extended >= 0) output = Buffer.concat([source.subarray(0, 12), ...chunks, chunk]);
  else {
    const vp8x = Buffer.alloc(18); vp8x.write('VP8X'); vp8x.writeUInt32LE(10, 4); vp8x[8] = 0x04 | (info.alpha ? 0x10 : 0);
    vp8x.writeUIntLE(info.width - 1, 12, 3); vp8x.writeUIntLE(info.height - 1, 15, 3);
    output = Buffer.concat([source.subarray(0, 12), vp8x, ...chunks, chunk]);
  }
  output.writeUInt32LE(output.length - 8, 4); return output;
}
export function imageArtifact(bytes, { prompt, model, operation, now = Date.now() }) {
  const info = imageInfo(bytes);
  if (!['image/png', 'image/webp'].includes(info.mediaType)) return fail();
  const provenance = { version: 1, origin: operation === 'edit' ? 'ai-manipulated' : 'ai-generated', modality: 'image',
    digitalSourceType: IPTC_DIGITAL_SOURCE[operation === 'edit' ? 'manipulated' : 'generated'], generatedAt: new Date(now).toISOString(),
    generator: { provider: 'openai', model }, techniques: ['embedded-metadata', 'response-field'],
    assurances: { digitallySigned: false, imperceptibleWatermark: 'provider-status-unknown' } };
  const marked = embed(bytes, info, provenance);
  if (marked.length > MAX_IMAGE_BYTES) throw new PluginError('limit');
  return { bytes: new Uint8Array(marked), mediaType: info.mediaType, width: info.width, height: info.height, promptDigest: promptDigest(prompt),
    provenance: { ...provenance, subject: { contentDigest: `sha-256=:${createHash('sha256').update(marked).digest('base64')}:`, mediaType: info.mediaType } } };
}
