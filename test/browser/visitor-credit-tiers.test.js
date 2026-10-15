// AIT-192: both locales share their server and browser process.
import { test } from 'node:test';
import { visitorCreditMatrix } from './visitor-credit-tiers-helpers.js';

test('AIT-135 A2 D: every visitor state, DE/EN, light/dark, rotating widths (full evidence matrix)', { timeout: 480_000 },
  t => visitorCreditMatrix(t, ['de', 'en']));
