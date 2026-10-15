// Focused follow-up for the initial display capture's entrance/scroll race.
import { test } from 'node:test';
import { compareBrowsers } from './browser-comparison.js';

test('AIT-199: paired display evidence after the workspace entry and scroll anchor settle',
  { timeout: 180_000 }, t => compareBrowsers(t, [['test/browser/start2-display.test.js', 'AIT-192|AIT-155:']]));
