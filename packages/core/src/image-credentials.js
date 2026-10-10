import { imageInfo } from './image-info.js';

const text = (bytes, at, size) => String.fromCharCode(...bytes.subarray(at, at + size));
const viewOf = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const record = manifestByteLength => ({ c2pa: manifestByteLength ? 'present' : 'absent',
  manifestByteLength, verification: 'not-verified' });

// Read ISO boxes without interpreting assertions, certificates or signatures.
function boxHeader(bytes, at) {
  if (at + 8 > bytes.length) return null;
  const view = viewOf(bytes), size = view.getUint32(at);
  if (size === 1) {
    if (at + 16 > bytes.length || view.getUint32(at + 8) !== 0) return null;
    const length = view.getUint32(at + 12);
    return length >= 16 ? { length, header: 16, type: text(bytes, at + 4, 4) } : null;
  }
  return size === 0 || size >= 8 ? { length: size || bytes.length - at, header: 8, type: text(bytes, at + 4, 4) } : null;
}
function c2paStoreLength(bytes) {
  let total = 0;
  for (let at = 0; at < bytes.length;) {
    const box = boxHeader(bytes, at);
    if (!box || at + box.length > bytes.length) return 0;
    if (box.type === 'jumb') {
      let child = at + box.header, first = true, c2pa = false;
      while (child < at + box.length) {
        const entry = boxHeader(bytes, child);
        if (!entry || child + entry.length > at + box.length) return 0;
        const start = child + entry.header, end = child + entry.length;
        // JUMBF description: content-type UUID, toggles, optional NUL-terminated label.
        if (first && entry.type === 'jumd' && end - start >= 22 && bytes[start + 16] & 2) {
          c2pa = text(bytes, start + 17, 5) === 'c2pa\0';
        }
        first = false; child += entry.length;
      }
      if (c2pa) total += box.length;
    }
    at += box.length;
  }
  return total;
}

function jpegManifestLength(bytes) {
  const view = viewOf(bytes), instances = new Map();
  let at = 2;
  while (at < bytes.length) {
    if (bytes[at++] !== 0xff) return 0;
    while (bytes[at] === 0xff) at++;
    const marker = bytes[at++];
    if (marker === 0xd9) break;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (at + 2 > bytes.length) return 0;
    const length = view.getUint16(at), end = at + length, start = at + 2;
    if (length < 2 || end > bytes.length) return 0;
    if (marker === 0xeb && end - start >= 16 && text(bytes, start, 2) === 'JP') {
      const instance = view.getUint16(start + 2), sequence = view.getUint32(start + 4);
      const fragment = bytes.subarray(start + 8, end), box = boxHeader(fragment, 0);
      const group = instances.get(instance) ?? { fragments: new Map(), invalid: false };
      if (!sequence || !box || box.type !== 'jumb' || group.fragments.has(sequence)) group.invalid = true;
      else group.fragments.set(sequence, { bytes: fragment, box });
      instances.set(instance, group);
    }
    at = end;
    if (marker === 0xda) {
      // Skip scan data, stuffed FF bytes and restart markers. APP11 may follow a scan.
      while (at < bytes.length) {
        if (bytes[at] !== 0xff) { at++; continue; }
        let next = at + 1;
        while (bytes[next] === 0xff) next++;
        if (bytes[next] === 0 || bytes[next] >= 0xd0 && bytes[next] <= 0xd7) { at = next + 1; continue; }
        break;
      }
    }
  }
  let total = 0;
  for (const group of instances.values()) {
    const first = group.fragments.get(1);
    if (group.invalid || !first) continue;
    const pieces = [first.bytes]; let length = first.bytes.length, complete = true;
    for (let sequence = 2; sequence <= group.fragments.size; sequence++) {
      const fragment = group.fragments.get(sequence);
      // Each continuation repeats the superbox header; count it only once.
      if (!fragment || fragment.box.length !== first.box.length || fragment.box.header !== first.box.header ||
        !fragment.bytes.subarray(0, first.box.header).every((byte, i) => byte === first.bytes[i])) { complete = false; break; }
      const piece = fragment.bytes.subarray(fragment.box.header);
      pieces.push(piece); length += piece.length;
    }
    if (!complete || length !== first.box.length) continue;
    const store = new Uint8Array(length); let offset = 0;
    for (const piece of pieces) { store.set(piece, offset); offset += piece.length; }
    total += c2paStoreLength(store);
  }
  return total;
}

/** Structural credential presence only. A present manifest is not a verified signature. */
export function imageCredentials(bytes) {
  const { mediaType } = imageInfo(bytes), view = viewOf(bytes);
  if (mediaType === 'image/jpeg') return record(jpegManifestLength(bytes));
  const png = mediaType === 'image/png'; let total = 0;
  for (let at = png ? 8 : 12; at < bytes.length;) {
    const length = view.getUint32(at + (png ? 0 : 4), !png);
    const type = text(bytes, at + (png ? 4 : 0), 4);
    if (type === (png ? 'caBX' : 'C2PA')) total += length;
    at += length + (png ? 12 : 8 + length % 2);
  }
  return record(total);
}
