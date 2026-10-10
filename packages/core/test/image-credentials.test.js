import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageCredentials } from '../src/index.js';
import { png, jpeg, webp, jumbf, box, pngChunk, webpChunk, jpegSegment, app11, withCredential, credentialFixtures } from '../../../test/image-fixtures.js';
const absent = { c2pa: 'absent', manifestByteLength: 0, verification: 'not-verified' };
const present = length => ({ c2pa: 'present', manifestByteLength: length, verification: 'not-verified' });
for (const [name, bytes] of credentialFixtures) test(`${name} structurally detects a credential without verifying its signature`, () => {
  const padded = Buffer.concat([Buffer.alloc(3), bytes, Buffer.alloc(4)]);
  assert.deepEqual(imageCredentials(padded.subarray(3, -4)), present(jumbf().length));
});
for (const [name, bytes] of [['PNG', png], ['JPEG', jpeg], ['WebP', webp]]) test(`${name} reports absent credentials on unmarked bytes`, () => {
  assert.deepEqual(imageCredentials(bytes), absent);
});
test('PNG and WebP ignore credential strings in unrelated chunks and empty credential chunks', () => {
  for (const bytes of [withCredential(png, { type: 'tEXt', payload: Buffer.from('caBX c2pa') }),
    withCredential(webp, { type: 'XMP ', payload: Buffer.from('C2PA c2pa') }),
    withCredential(png, { payload: Buffer.alloc(0) }), withCredential(webp, { payload: Buffer.alloc(0) })]) {
    assert.deepEqual(imageCredentials(bytes), absent);
  }
});
test('container truncation and oversized chunk lengths cannot fabricate credential presence', () => {
  for (const bytes of [withCredential(png), withCredential(webp)]) {
    assert.throws(() => imageCredentials(bytes.subarray(0, -1)), { code: 'invalid-output' });
    const broken = Buffer.from(bytes);
    if (bytes[0] === 137) broken.writeUInt32BE(0xffffffff, png.length - 12);
    else broken.writeUInt32LE(0xffffffff, webp.length + 4);
    assert.throws(() => imageCredentials(broken), { code: 'invalid-output' });
  }
});
test('JPEG reassembles numbered APP11 fragments and extended-length JUMBF boxes', () => {
  for (const extended of [false, true]) {
    const payload = jumbf('c2pa', { extended });
    assert.deepEqual(imageCredentials(withCredential(jpeg, { payload, fragmentAt: payload.length - 5 })), present(payload.length));
  }
});
test('JPEG rejects unrelated labels, textual spoofs, malformed boxes and incomplete fragments', () => {
  const payload = jumbf(), broken = Buffer.from(payload); broken.writeUInt32BE(payload.length + 1);
  const missingLabelFlag = Buffer.from(payload); missingLabelFlag[32] = 0;
  for (const bytes of [withCredential(jpeg, { payload: jumbf('c2pa.claim') }), withCredential(jpeg, { payload: broken }),
    withCredential(jpeg, { payload: missingLabelFlag }),
    withCredential(jpeg, { payload: box('jumb', box('cbor', Buffer.from('c2pa\0'))) }),
    Buffer.concat([jpeg.subarray(0, -2), jpegSegment(0xe1, payload), jpeg.subarray(-2)]),
    Buffer.concat([jpeg.subarray(0, -2), app11(payload.subarray(0, -1)), jpeg.subarray(-2)]),
    Buffer.concat([jpeg.subarray(0, -2), app11(payload, 2), jpeg.subarray(-2)]),
    Buffer.concat([jpeg.subarray(0, -2), app11(payload), app11(payload), jpeg.subarray(-2)])]) {
    assert.deepEqual(imageCredentials(bytes), absent);
  }
});
test('JPEG finds APP11 between scans without reading stuffed scan bytes as metadata', () => {
  const payload = jumbf();
  const bytes = Buffer.concat([jpeg.subarray(0, -2), jpegSegment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.from([1, 0xff, 0, 0xeb, 0xff, 0xd0, 2]), app11(payload), jpeg.subarray(-2)]);
  assert.deepEqual(imageCredentials(bytes), present(payload.length));
});
test('PNG and WebP count payload bytes without chunk headers or odd-length padding', () => {
  const payload = Buffer.from([1, 2, 3]);
  assert.deepEqual(imageCredentials(withCredential(png, { payload })), present(3));
  assert.deepEqual(imageCredentials(withCredential(webp, { payload })), present(3));
  const multiplePng = Buffer.concat([png.subarray(0, -12), pngChunk('caBX', payload), pngChunk('caBX', payload), png.subarray(-12)]);
  const multipleWebp = Buffer.concat([webp, webpChunk('C2PA', payload), webpChunk('C2PA', payload)]); multipleWebp.writeUInt32LE(multipleWebp.length - 8, 4);
  assert.deepEqual(imageCredentials(multiplePng), present(6)); assert.deepEqual(imageCredentials(multipleWebp), present(6));
});
