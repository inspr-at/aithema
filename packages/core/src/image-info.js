import { PluginError } from './invocation.js';
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const fail = () => { throw new PluginError('invalid-output'); };
/** Header/container validation only; dimensions must come from bytes, not requests.
 * Uint8Array/DataView keep this reader usable by browser hosts and the local kit. */
export function imageInfo(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength) return fail();
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new PluginError('limit');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at, size) => String.fromCharCode(...bytes.subarray(at, at + size));
  const u24 = at => bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16;
  let width = 0, height = 0, mediaType, end = -1, extended = -1, alpha = false;
  if (text(0, 8) === '\x89PNG\r\n\x1a\n') {
    mediaType = 'image/png'; let offset = 8, pixels = false;
    while (offset + 12 <= bytes.length) {
      const size = view.getUint32(offset), type = text(offset + 4, 4);
      if (offset + size + 12 > bytes.length) return fail();
      if (offset === 8 && (type !== 'IHDR' || size !== 13)) return fail();
      if (type === 'IHDR') {
        if (offset !== 8 || size !== 13) return fail();
        width = view.getUint32(offset + 8); height = view.getUint32(offset + 12);
      }
      if (type === 'IDAT') pixels = true;
      if (type === 'IEND') {
        if (size !== 0 || offset + 12 !== bytes.length || !pixels) return fail();
        end = offset; break;
      }
      offset += size + 12;
    }
    if (end < 0) return fail();
  } else if (bytes.length >= 20 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
    mediaType = 'image/webp'; let offset = 12, pixels = false;
    if (view.getUint32(4, true) + 8 !== bytes.length) return fail();
    while (offset + 8 <= bytes.length) {
      const type = text(offset, 4), size = view.getUint32(offset + 4, true), at = offset + 8;
      if (at + size + size % 2 > bytes.length) return fail();
      if (type === 'VP8X' && size === 10) {
        extended = offset; width = 1 + u24(at + 4); height = 1 + u24(at + 7);
      } else if (type === 'VP8 ' && size >= 10 && text(at + 3, 3) === '\x9d\x01\x2a') {
        pixels = true;
        if (extended < 0) { width = view.getUint16(at + 6, true) & 0x3fff; height = view.getUint16(at + 8, true) & 0x3fff; }
      } else if (type === 'VP8L' && size >= 5 && bytes[at] === 0x2f) {
        pixels = true; const bits = view.getUint32(at + 1, true);
        if (extended < 0) { width = 1 + (bits & 0x3fff); height = 1 + ((bits >>> 14) & 0x3fff); }
        alpha = ((bits >>> 28) & 1) === 1;
      }
      offset = at + size + size % 2;
    }
    if (!pixels || offset !== bytes.length) return fail();
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
    mediaType = 'image/jpeg'; let offset = 2;
    const frames = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf];
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) return fail();
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (offset + 2 > bytes.length || marker === 0xd9 || marker === 0xda) break;
      const size = view.getUint16(offset);
      if (size < 2 || offset + size > bytes.length) return fail();
      if (frames.includes(marker)) {
        if (size < 11 || size !== 8 + 3 * bytes[offset + 7]) return fail();
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); break;
      }
      offset += size;
    }
  } else return fail();
  if (width < 1 || height < 1 || width > 16384 || height > 16384) return fail();
  return { mediaType, width, height, end, extended, alpha };
}
