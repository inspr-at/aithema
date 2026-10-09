import { createHash } from 'node:crypto';
import { IPTC_DIGITAL_SOURCE, PluginError } from '@inspr/aithema-core';
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const fail = () => { throw new PluginError('invalid-output'); };
export const promptDigest = prompt => `sha256:${createHash('sha256').update(prompt).digest('hex')}`;
/** Read actual dimensions; provider request dimensions are not evidence of output size. */
export function imageInfo(value) {
  if (!(value instanceof Uint8Array) || !value.byteLength) return fail();
  if (value.byteLength > MAX_IMAGE_BYTES) throw new PluginError('limit');
  const bytes = Buffer.from(value);
  let width = 0, height = 0, mediaType, end = -1, extended = -1, alpha = false;
  if (bytes.subarray(0, 8).equals(PNG)) {
    mediaType = 'image/png'; let offset = 8, pixels = false;
    while (offset + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
      if (offset + size + 12 > bytes.length) return fail();
      if (offset === 8 && (type !== 'IHDR' || size !== 13)) return fail();
      if (type === 'IHDR' && size === 13) { width = bytes.readUInt32BE(offset + 8); height = bytes.readUInt32BE(offset + 12); }
      if (type === 'IDAT') pixels = true;
      if (type === 'IEND') { if (size !== 0 || offset + 12 !== bytes.length || !pixels) return fail(); end = offset; break; }
      offset += size + 12;
    }
    if (end < 0) return fail();
  } else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.length >= 20) {
    mediaType = 'image/webp'; let offset = 12, pixels = false;
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) return fail();
    while (offset + 8 <= bytes.length) {
      const type = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), at = offset + 8;
      if (at + size + size % 2 > bytes.length) return fail();
      if (type === 'VP8X' && size === 10) {
        extended = offset; width = 1 + bytes.readUIntLE(at + 4, 3); height = 1 + bytes.readUIntLE(at + 7, 3);
      } else if (type === 'VP8 ' && size >= 10 && bytes.toString('hex', at + 3, at + 6) === '9d012a') {
        pixels = true;
        if (extended < 0) { width = bytes.readUInt16LE(at + 6) & 0x3fff; height = bytes.readUInt16LE(at + 8) & 0x3fff; }
      } else if (type === 'VP8L' && size >= 5 && bytes[at] === 0x2f) {
        pixels = true; const bits = bytes.readUInt32LE(at + 1);
        if (extended < 0) { width = 1 + (bits & 0x3fff); height = 1 + ((bits >>> 14) & 0x3fff); }
        alpha = ((bits >>> 28) & 1) === 1;
      }
      offset = at + size + size % 2;
    }
    if (!pixels || offset !== bytes.length) return fail();
  } else return fail();
  if (width < 1 || height < 1 || width > 16384 || height > 16384) return fail();
  return { mediaType, width, height, end, extended, alpha };
}
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
  if (info.mediaType === 'image/png') {
    const data = Buffer.concat([Buffer.from('XML:com.adobe.xmp\0\0\0\0\0', 'binary'), xmp]);
    const chunk = Buffer.alloc(data.length + 12); chunk.writeUInt32BE(data.length); chunk.write('iTXt', 4); data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    return Buffer.concat([source.subarray(0, info.end), chunk, source.subarray(info.end)]);
  }
  const chunk = Buffer.alloc(8 + xmp.length + xmp.length % 2); chunk.write('XMP '); chunk.writeUInt32LE(xmp.length, 4); xmp.copy(chunk, 8);
  let output;
  if (info.extended >= 0) { output = Buffer.concat([source, chunk]); output[info.extended + 8] |= 0x04; }
  else {
    const vp8x = Buffer.alloc(18); vp8x.write('VP8X'); vp8x.writeUInt32LE(10, 4); vp8x[8] = 0x04 | (info.alpha ? 0x10 : 0);
    vp8x.writeUIntLE(info.width - 1, 12, 3); vp8x.writeUIntLE(info.height - 1, 15, 3);
    output = Buffer.concat([source.subarray(0, 12), vp8x, source.subarray(12), chunk]);
  }
  output.writeUInt32LE(output.length - 8, 4); return output;
}
export function imageArtifact(bytes, { prompt, model, operation, now = Date.now() }) {
  const info = imageInfo(bytes), provenance = { version: 1, origin: operation === 'edit' ? 'ai-manipulated' : 'ai-generated', modality: 'image',
    digitalSourceType: IPTC_DIGITAL_SOURCE[operation === 'edit' ? 'manipulated' : 'generated'], generatedAt: new Date(now).toISOString(),
    generator: { provider: 'openai', model }, techniques: ['embedded-metadata', 'response-field'],
    assurances: { digitallySigned: false, imperceptibleWatermark: 'provider-status-unknown' } };
  const marked = embed(bytes, info, provenance);
  if (marked.length > MAX_IMAGE_BYTES) throw new PluginError('limit');
  return { bytes: new Uint8Array(marked), mediaType: info.mediaType, width: info.width, height: info.height, promptDigest: promptDigest(prompt),
    provenance: { ...provenance, subject: { contentDigest: `sha-256=:${createHash('sha256').update(marked).digest('base64')}:`, mediaType: info.mediaType } } };
}
