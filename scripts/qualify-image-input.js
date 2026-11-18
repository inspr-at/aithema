// Production dependency smoke; run only in CI or the admitted remote lane.
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createImageInput } from '@inspr/aithema-plugin-image-input';
const source = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#e02030' } }).png().toBuffer();
const result = await createImageInput().normalize(source, { filename: 'fixture.png' }, { deadlineAt: Date.now() + 25000 });
assert.equal(result.status, 'staged-ready');
assert.equal(result.w, 1); assert.equal(result.h, 1); assert.ok(result.bytes.length > 0);
console.log(JSON.stringify({ qualification: 'image-input-production', platform: process.platform, arch: process.arch, normalized: true }));
