// Offline container fixtures; synthetic C2PA data has no valid signature.
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aK0kAAAAASUVORK5CYII=', 'base64');
export const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
export const jpeg = Buffer.from([255, 216, 255, 224, 0, 4, 0, 0, 255, 194, 0, 11, 8, 0, 2, 0, 3, 1, 1, 17, 0, 255, 217]);
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; }
  return (crc ^ 0xffffffff) >>> 0;
}
export function pngChunk(type, data) {
  const chunk = Buffer.alloc(data.length + 12); chunk.writeUInt32BE(data.length); chunk.write(type, 4); data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4); return chunk;
}
export function webpChunk(type, data) {
  const chunk = Buffer.alloc(8 + data.length + data.length % 2); chunk.write(type); chunk.writeUInt32LE(data.length, 4); data.copy(chunk, 8); return chunk;
}
export function box(type, data, extended = false) {
  const header = extended ? 16 : 8, result = Buffer.alloc(header + data.length);
  result.writeUInt32BE(extended ? 1 : result.length); result.write(type, 4);
  if (extended) result.writeBigUInt64BE(BigInt(result.length), 8);
  data.copy(result, header); return result;
}
export function jumbf(label = 'c2pa', { extended = false } = {}) {
  const description = Buffer.concat([Buffer.from('6332706100110010800000aa00389b71', 'hex'), Buffer.from([3]), Buffer.from(`${label}\0`)]);
  return box('jumb', Buffer.concat([box('jumd', description), box('cbor', Buffer.from([0xa0]))]), extended);
}
export function jpegSegment(marker, data) {
  const header = Buffer.alloc(4); header[0] = 0xff; header[1] = marker; header.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([header, data]);
}
export function app11(data, sequence = 1, instance = 1) {
  const header = Buffer.alloc(8); header.write('JP'); header.writeUInt16BE(instance, 2); header.writeUInt32BE(sequence, 4);
  return jpegSegment(0xeb, Buffer.concat([header, data]));
}
export function withCredential(bytes, { payload = jumbf(), type, fragmentAt } = {}) {
  if (bytes.equals(png)) return Buffer.concat([png.subarray(0, -12), pngChunk(type ?? 'caBX', payload), png.subarray(-12)]);
  if (bytes.equals(webp)) {
    const result = Buffer.concat([webp, webpChunk(type ?? 'C2PA', payload)]); result.writeUInt32LE(result.length - 8, 4); return result;
  }
  const header = payload.readUInt32BE(0) === 1 ? 16 : 8;
  const segments = fragmentAt ? [app11(payload.subarray(0, fragmentAt)), app11(Buffer.concat([payload.subarray(0, header), payload.subarray(fragmentAt)]), 2)] : [app11(payload)];
  // Put APP11 after SOF so detection must inspect more than the dimension header.
  return Buffer.concat([jpeg.subarray(0, -2), ...segments, jpeg.subarray(-2)]);
}
export const credentialFixtures = [['PNG', png], ['JPEG', jpeg], ['WebP', webp]].map(([name, bytes]) => [name, withCredential(bytes)]);
