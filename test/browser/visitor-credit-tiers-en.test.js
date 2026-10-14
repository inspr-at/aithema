// AIT-177: shard the complete visitor matrix at its existing language boundary.
import { test } from 'node:test';
import { visitorCreditMatrix } from './visitor-credit-tiers-helpers.js';

test('AIT-135 A2 D: every visitor state, EN, light/dark, 1440/1024/390; zero displacement', { timeout: 480_000 },
  t => visitorCreditMatrix(t, ['en']));
