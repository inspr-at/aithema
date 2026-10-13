// Chrome screenshots use 8-bit RGB/RGBA. Compare paint while allowing the compositor's
// one-unit gradient dithering; a visible stroke changes channels by much more than that.
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
function pixels(png) {
  const parts = []; let width, height, channels;
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset), kind = png.toString('ascii', offset + 4, offset + 8), data = png.subarray(offset + 8, offset + 8 + size);
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      assert.equal(data[8], 8); assert.ok([2, 6].includes(data[9])); channels = data[9] === 6 ? 4 : 3;
    }
    if (kind === 'IDAT') parts.push(data); offset += size + 12;
  }
  const raw = inflateSync(Buffer.concat(parts)), stride = width * channels, result = Buffer.alloc(stride * height);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[offset++]; assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x, left = x >= channels ? result[index - channels] : 0;
      const up = y ? result[index - stride] : 0, corner = y && x >= channels ? result[index - stride - channels] : 0;
      let prediction = 0;
      if (filter === 1) prediction = left;
      if (filter === 2) prediction = up;
      if (filter === 3) prediction = Math.floor((left + up) / 2);
      if (filter === 4) {
        const p = left + up - corner, dl = Math.abs(p - left), du = Math.abs(p - up), dc = Math.abs(p - corner);
        prediction = dl <= du && dl <= dc ? left : du <= dc ? up : corner;
      }
      result[index] = (raw[offset++] + prediction) & 255;
    }
  }
  return { width, height, channels, result };
}
export function samePaint(a, b) {
  if (a.equals(b)) return true;
  const x = pixels(a), y = pixels(b);
  assert.deepEqual([x.width, x.height, x.channels], [y.width, y.height, y.channels]);
  return x.result.every((value, i) => Math.abs(value - y.result[i]) <= 1);
}
