// AIT-192: both locales share their server and browser process.
import { test } from 'node:test';
import { composerCreditReservationMatrix, visitorCreditMatrix } from './visitor-credit-tiers-helpers.js';

test('AIT-406: composer reserves every credit state across all widths, locales and themes', { timeout: 120_000 },
  composerCreditReservationMatrix);

test('AIT-135 A2 D: every visitor state, DE/EN, light/dark, rotating widths (full evidence matrix)', { timeout: 480_000 },
  t => visitorCreditMatrix(t, ['de', 'en']));
