// Explicit remote measurement batch; never part of CI's browser suite.
import { test } from 'node:test';
import { compareBrowsers } from './browser-comparison.js';

test('AIT-199: sequential full-Chrome/headless-shell screenshots, memory and same-browser noise evidence',
  { timeout: 840_000 }, t => compareBrowsers(t));
