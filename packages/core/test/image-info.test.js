import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageInfo, MAX_IMAGE_BYTES, validateUIReferences } from '../src/index.js';
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aK0kAAAAASUVORK5CYII=', 'base64'));
const webp = Uint8Array.from(Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64'));
// APP metadata before a progressive frame; this reader validates headers, not pixels.
const jpeg = Uint8Array.from([255, 216, 255, 224, 0, 4, 0, 0, 255, 194, 0, 11, 8, 0, 2, 0, 3, 1, 1, 17, 0, 255, 217]);
test('shared headers recognize PNG, WebP and JPEG dimensions in offset byte views', () => {
  for (const [bytes, mediaType, width, height] of [[png, 'image/png', 1, 1], [webp, 'image/webp', 1, 1], [jpeg, 'image/jpeg', 3, 2]]) {
    const padded = new Uint8Array(bytes.length + 8); padded.set(bytes, 4);
    const info = imageInfo(padded.subarray(4, -4));
    assert.deepEqual({ mediaType: info.mediaType, width: info.width, height: info.height }, { mediaType, width, height });
  }
});
test('shared headers reject truncation, unknown signatures, invalid dimensions and oversized bytes', () => {
  const zeroPng = png.slice(); zeroPng.fill(0, 16, 20);
  const zeroJpeg = jpeg.slice(); zeroJpeg.fill(0, 15, 17);
  for (const bytes of [new Uint8Array(), Uint8Array.of(1, 2), png.subarray(0, -1), webp.subarray(0, -1), jpeg.subarray(0, -1), zeroPng, zeroJpeg]) {
    assert.throws(() => imageInfo(bytes), { code: 'invalid-output' });
  }
  assert.throws(() => imageInfo(new Uint8Array(MAX_IMAGE_BYTES + 1)), { code: 'limit' });
});
test('core validates private reference bytes and rejects a JPEG labelled as PNG', () => {
  const reference = { bytes: jpeg, mediaType: 'image/jpeg', role: 'upload' };
  assert.deepEqual(validateUIReferences([reference]), [reference]);
  assert.throws(() => validateUIReferences([{ ...reference, mediaType: 'image/png' }]), { code: 'invalid-output' });
});
