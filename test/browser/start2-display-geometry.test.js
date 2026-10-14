// AIT-177: original B1–B8, r2 menu and r3 status describe blocks, with every viewport retained.
import { test } from 'node:test';
import { displayMatrix } from './start2-display-matrix-helpers.js';

test('AIT-131 integrated geometry: B1–B8, r2 menu and r3 status, both themes and languages',
  { timeout: 180_000 }, t => displayMatrix(t, 'geometry'));
