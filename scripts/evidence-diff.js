// AIT-230 policy: exact RGBA outside composer SVG bounds; at most three changed
// pixels per shot, RGB delta <= 1, inside those bounds. Alpha is always exact.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pixels } from './png-pixels.js';

export const evidenceTolerance = Object.freeze({ iconMaxChannelDelta: 1, iconMaxChangedPixels: 3, outsideMaxChannelDelta: 0 });

export function diffEvidencePixels(a, b, iconBoxes = []) {
  assert.deepEqual([a.width, a.height], [b.width, b.height], 'Evidence dimensions differ');
  for (const box of iconBoxes) assert.ok(['x', 'y', 'width', 'height'].every(key => Number.isFinite(box[key])) &&
    box.width > 0 && box.height > 0, 'Invalid icon bounding box');
  let changedPixels = 0, toleratedPixels = 0, rejectedPixels = 0, maxChannelDelta = 0;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    const i = (y * a.width + x) * a.channels, j = (y * b.width + x) * b.channels;
    const delta = Math.max(...[0, 1, 2].map(c => Math.abs(a.result[i + c] - b.result[j + c])));
    const alphaSame = (a.channels === 4 ? a.result[i + 3] : 255) === (b.channels === 4 ? b.result[j + 3] : 255);
    if (!delta && alphaSame) continue;
    changedPixels++; maxChannelDelta = Math.max(maxChannelDelta, delta);
    const inIcon = iconBoxes.some(r => x >= Math.floor(r.x) && x < Math.ceil(r.x + r.width) &&
      y >= Math.floor(r.y) && y < Math.ceil(r.y + r.height));
    if (inIcon && alphaSame && delta <= evidenceTolerance.iconMaxChannelDelta) toleratedPixels++;
    else rejectedPixels++;
  }
  return { match: rejectedPixels === 0 && toleratedPixels <= evidenceTolerance.iconMaxChangedPixels,
    changedPixels, toleratedPixels, rejectedPixels, maxChannelDelta };
}

export function compareEvidenceDirectories(before, after) {
  const metadata = directory => JSON.parse(readFileSync(join(directory, 'ait-225-evidence.json'), 'utf8'));
  const a = metadata(before), b = metadata(after);
  const names = directory => readdirSync(directory).filter(name => /^ait-225-.*\.png$/u.test(name)).sort();
  const files = names(before);
  assert.deepEqual(files, names(after), 'Evidence file sets differ');
  const expected = ['de', 'en'].flatMap(locale => ['light', 'dark'].flatMap(theme => [
    ...['1440', '390'].flatMap(width => ['card', 'bounded-options'].map(state => `ait-225-${locale}-${theme}-${width}-${state}.png`)),
    ...[508, 420, 320].map(height => `ait-225-${locale}-${theme}-390-keyboard-${height}.png`),
  ])).sort();
  assert.deepEqual(files, expected, 'AIT-225 evidence requires the original 28 states');
  assert.deepEqual([...a.files].sort(), files); assert.deepEqual([...b.files].sort(), files);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const rows = files.map(file => {
    const boxes = a.captures?.[file]?.iconBoxes;
    assert.ok(Array.isArray(boxes), `${file}: missing capture icon bounds`);
    assert.deepEqual(boxes, b.captures?.[file]?.iconBoxes, `${file}: icon geometry differs`);
    const x = readFileSync(join(before, file)), y = readFileSync(join(after, file));
    return { file, iconBoxes: boxes, beforeSha256: hash(x), afterSha256: hash(y), ...diffEvidencePixels(pixels(x), pixels(y), boxes) };
  });
  return { policy: evidenceTolerance, before: a.commit, after: b.commit, matched: rows.filter(r => r.match).length, total: rows.length, rows };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [before, after] = process.argv.slice(2);
  assert.ok(before && after, 'Usage: node scripts/evidence-diff.js BEFORE_DIR AFTER_DIR');
  const result = compareEvidenceDirectories(before, after);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.matched === result.total ? 0 : 1;
}
