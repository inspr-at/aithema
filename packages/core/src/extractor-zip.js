// Bounded, non-inflating ZIP inspection. Ported from START src/lib/ooxml.ts.
// Used for sniffing too: a string in arbitrary ZIP payload is not an Office part.
export class ArchiveError extends Error {
  constructor(reason = 'malformed') { super('Unreadable archive'); this.reason = reason; }
}
export function inspectZip(bytes, limits) {
  const fail = reason => { throw new ArchiveError(reason); };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = at => view.getUint16(at, true), u32 = at => view.getUint32(at, true);
  let end = -1;
  for (let at = bytes.length - 22, floor = Math.max(0, bytes.length - 22 - 65535); at >= floor; at--) {
    if (u32(at) === 0x06054b50 && at + 22 + u16(at + 20) === bytes.length) { end = at; break; }
  }
  if (end < 0 || u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10)) fail();
  const count = u16(end + 10), directorySize = u32(end + 12), directoryAt = u32(end + 16);
  if (count === 65535 || directoryAt === 0xffffffff || directorySize === 0xffffffff) fail();
  if (count > limits.maxEntries) fail('limit');
  if (!count || directoryAt + directorySize !== end) fail();
  const entries = new Map(), ranges = [];
  let cursor = directoryAt, total = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || u32(cursor) !== 0x02014b50) fail();
    const flags = u16(cursor + 8), method = u16(cursor + 10), crc = u32(cursor + 16);
    const compressedSize = u32(cursor + 20), size = u32(cursor + 24), localAt = u32(cursor + 42);
    const nameLength = u16(cursor + 28), next = cursor + 46 + nameLength + u16(cursor + 30) + u16(cursor + 32);
    if (next > end || u16(cursor + 34) || [compressedSize, size, localAt].includes(0xffffffff)) fail();
    if (flags & 1) fail('encrypted');
    // Bits 1/2 describe ordinary deflate compression options; bit 3 is a
    // data descriptor and bit 11 is UTF-8. None changes the size boundary.
    if (flags & ~(6 | 8 | 2048) || ![0, 8].includes(method)) fail();
    total += size;
    if (size > limits.maxPartBytes || total > limits.maxUncompressedBytes ||
      size > Math.max(1, compressedSize) * limits.maxCompressionRatio) fail('limit');
    if (method === 0 && compressedSize !== size) fail();
    let name;
    try { name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)); } catch { fail(); }
    if (!name || name.length > 512 || name.startsWith('/') || name.includes('\\') || name.includes('\0') ||
      name.split('/').includes('..') || entries.has(name)) fail();
    if (localAt + 30 > directoryAt || u32(localAt) !== 0x04034b50 ||
      u16(localAt + 6) !== flags || u16(localAt + 8) !== method) fail();
    const localNameLength = u16(localAt + 26), dataAt = localAt + 30 + localNameLength + u16(localAt + 28);
    if (dataAt + compressedSize > directoryAt) fail();
    if (decoder.decode(bytes.subarray(localAt + 30, localAt + 30 + localNameLength)) !== name) fail();
    if (!(flags & 8) && (u32(localAt + 14) !== crc || u32(localAt + 18) !== compressedSize || u32(localAt + 22) !== size)) fail();
    ranges.push([localAt, dataAt + compressedSize]);
    entries.set(name, { name, method, crc, size, compressedSize, dataAt });
    cursor = next;
  }
  if (cursor !== end) fail();
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.some((range, index) => index && range[0] < ranges[index - 1][1])) fail();
  return entries;
}
