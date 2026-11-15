import { test } from 'node:test';
import assert from 'node:assert/strict';

for (const format of ['png', 'jpeg', 'webp', 'gif']) test(`AIT-510: ${format} normalized in isolation with bounded pixels and no metadata`, async () => {
  const { default: sharp } = await import('sharp');
  const { createImageInput } = await import('../src/index.js');
  const source = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#e02030' } })
    .withMetadata({ orientation: 6 }).toFormat(format).toBuffer();
  const image = await createImageInput().normalize(source, { filename: `fixture.${format}`, mediaType: `image/${format}` },
    { signal: new AbortController().signal, deadlineAt: Date.now() + 25000 });
  assert.equal(image.status, 'staged-ready');
  assert.ok(image.w > 0 && image.h > 0 && Math.max(image.w, image.h) <= 1568 && image.w * image.h <= 1_150_000);
  const metadata = await sharp(image.bytes).metadata();
  assert.equal(metadata.exif, undefined); assert.equal(metadata.orientation, undefined);
  assert.ok(['jpeg', 'png'].includes(metadata.format));
  const pixel = await sharp(image.bytes).resize(1, 1).removeAlpha().raw().toBuffer();
  assert.ok(pixel[0] > 200 && pixel[1] < 70 && pixel[2] < 90, 'the fixture pixels survive normalization');
});
test('AIT-510: GIF uses the first frame only', async () => {
  const { default: sharp } = await import('sharp');
  const { createImageInput } = await import('../src/index.js');
  const frames = Buffer.from([255, 0, 0, 0, 0, 255]);
  const gif = await sharp(frames, { raw: { width: 1, height: 2, channels: 3, pageHeight: 1 } }).gif({ delay: [100, 100] }).toBuffer();
  const result = await createImageInput().normalize(gif, { filename: 'fixture.gif' }, { deadlineAt: Date.now() + 25000 });
  assert.equal(result.status, 'staged-ready');
  assert.equal(result.w, 1); assert.equal(result.h, 1);
  const pixel = await sharp(result.bytes).raw().toBuffer();
  assert.ok(pixel[0] > 240 && pixel[2] < 10);
});
for (const [filename, bytes, reason] of [['fixture.heic', Buffer.from('heic'), 'unsupported'], ['empty.png', Buffer.alloc(0), 'empty'], ['broken.png', Buffer.from([137,80,78,71,13,10,26,10]), 'malformed']]) {
  test(`AIT-510: ${filename} reports ${reason}`, async () => {
    const { createImageInput } = await import('../src/index.js');
    const result = await createImageInput().normalize(bytes, { filename }, { deadlineAt: Date.now() + 25000 });
    assert.equal(result.status, 'staged-refused'); assert.equal(result.reason, reason);
    assert.equal(result.bytes, undefined);
  });
}

test('AIT-510: alpha stays PNG and the normalized pixels retain transparency', async () => {
  const { default: sharp } = await import('sharp'); const { createImageInput } = await import('../src/index.js');
  const source = await sharp({ create: { width: 2, height: 1, channels: 4, background: { r: 200, g: 0, b: 0, alpha: .5 } } }).png().toBuffer();
  const result = await createImageInput().normalize(source, { filename: 'alpha.png' }, { deadlineAt: Date.now() + 25000 });
  assert.equal(result.status, 'staged-ready'); assert.equal(result.mediaType, 'image/png');
  const pixel = await sharp(result.bytes).raw().toBuffer(); assert.ok(pixel[3] >= 126 && pixel[3] <= 129);
});
test('AIT-510: oversized image dimensions are refused before pixel decoding', async () => {
  const { default: sharp } = await import('sharp'); const { createImageInput } = await import('../src/index.js');
  const source = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ff0000' } }).png().toBuffer();
  source.writeUInt32BE(100000, 16); source.writeUInt32BE(100000, 20);
  let crc = 0xffffffff;
  for (const byte of source.subarray(12, 29)) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  source.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29);
  const result = await createImageInput().normalize(source, { filename: 'huge.png' }, { deadlineAt: Date.now() + 25000 });
  assert.equal(result.status, 'staged-refused'); assert.equal(result.reason, 'dimensions'); assert.equal(result.bytes, undefined);
});
