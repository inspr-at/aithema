import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffEvidencePixels } from '../scripts/evidence-diff.js';

const image = (channels = 4) => ({ width: 8, height: 8, channels, result: Buffer.alloc(64 * channels, 128) });
const icon = [{ x: 2.5, y: 2.5, width: 2, height: 2 }];
const change = (b, x, y, delta = 1, channel = 0) => { b.result[(y * 8 + x) * b.channels + channel] += delta; };

test('evidence requires exact paint outside icon bounds, including transcript and assistant marker', () => {
  const a = image(), b = image();
  assert.equal(diffEvidencePixels(a, b, icon).match, true);
  change(b, 1, 2);
  assert.equal(diffEvidencePixels(a, b, icon).match, false);
  assert.equal(diffEvidencePixels(a, b).rejectedPixels, 1);
  assert.throws(() => diffEvidencePixels(a, { ...b, width: 9 }), /dimensions/u);
  assert.throws(() => diffEvidencePixels(a, b, [{ x: NaN, y: 0, width: 1, height: 1 }]), /bounding box/u);
});

test('class R permits only three one-level RGB edge pixels per screenshot', () => {
  const a = image(), b = image();
  for (const [x, y] of [[2, 2], [3, 3], [4, 4]]) change(b, x, y);
  assert.deepEqual(diffEvidencePixels(a, b, icon), { match: true, changedPixels: 3, toleratedPixels: 3, rejectedPixels: 0, maxChannelDelta: 1 });
  change(b, 2, 3);
  assert.equal(diffEvidencePixels(a, b, icon).match, false, 'four changed pixels fail even within icons');
  change(b, 3, 3);
  assert.equal(diffEvidencePixels(a, b, icon).rejectedPixels, 1, 'two-level RGB change fails');
});

test('alpha and icon geometry changes receive no tolerance', () => {
  const a = image(), b = image(); change(b, 3, 3, 1, 3);
  assert.equal(diffEvidencePixels(a, b, icon).match, false);
  const c = image(); change(c, 5, 4);
  assert.equal(diffEvidencePixels(a, c, icon).match, false, 'no padding around icon bounding box');
});
