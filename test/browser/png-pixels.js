import assert from 'node:assert/strict';
import { pixels } from '../../scripts/png-pixels.js';
export { pixels };

// Legacy paint probes permit one-level gradient dithering across their tiny clips.
// Evidence verdicts use scripts/evidence-diff.js and its icon-only policy.
export function samePaint(a, b) {
  if (a.equals(b)) return true;
  const x = pixels(a), y = pixels(b);
  assert.deepEqual([x.width, x.height, x.channels], [y.width, y.height, y.channels]);
  return x.result.every((value, i) => Math.abs(value - y.result[i]) <= 1);
}
