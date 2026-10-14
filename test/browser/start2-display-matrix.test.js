// AIT-177: keep the full state/evidence group separate from the geometry describe blocks.
import { test } from 'node:test';
import { displayMatrix } from './start2-display-matrix-helpers.js';

test('AIT-131 integrated display: real band, reveal, voice and display matrix at 390/1024/1440, both themes and languages',
  { timeout: 360_000 }, t => displayMatrix(t, 'evidence'));
