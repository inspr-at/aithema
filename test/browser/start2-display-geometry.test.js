// AIT-177: original B1–B8, r2 menu and r3 status describe blocks, with every viewport retained.
import { test } from 'node:test';
import { displayMatrix } from './start2-display-matrix-helpers.js';

test('AIT-131 integrated geometry: B1–B8, r2 menu and r3 status, both themes and languages',
  { timeout: 180_000 }, t => displayMatrix(t, 'geometry'));

import { firstPaintCheck } from './first-paint-check.js';
test('AIT-210: header and rail reserve first-paint geometry before upgrade and fonts settle',
  { timeout: 90_000 }, firstPaintCheck);

import { scrollbarFirstPaintCheck } from './scrollbar-first-paint-check.js';
test('AIT-276: classic scrollbars and wider actions reserve the mounted rail on first paint',
  { timeout: 90_000 }, scrollbarFirstPaintCheck);

import { compactFooterCheck } from './compact-footer-check.js';
test('AIT-299: hidden footer labels restore full fit without moving controls under the pointer',
  { timeout: 90_000 }, compactFooterCheck);

import { legalFooterFitCheck } from './compact-footer-check.js';
test('AIT-309: legal hosts without credits respect every compact fit at 900/1024/1180/1440, DE/EN, light/dark',
  { timeout: 90_000 }, legalFooterFitCheck);
