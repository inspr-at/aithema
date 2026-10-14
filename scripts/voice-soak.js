#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runSoak } from '../test/live/soak.js';

const { values } = parseArgs({ options: {
  mode: { type: 'string', default: 'fake' }, locale: { type: 'string', default: 'de' },
  minutes: { type: 'string', default: '5' }, 'max-duration': { type: 'string' }, 'cap-usd': { type: 'string', default: '8' },
  'rate-usd-per-minute': { type: 'string' }, 'stop-reserve-usd': { type: 'string' },
  output: { type: 'string' }, url: { type: 'string' }, profile: { type: 'string' }, diagnostics: { type: 'string' },
  ops: { type: 'boolean', default: false }, isolated: { type: 'boolean', default: false },
} });
try {
  const { report, output } = await runSoak({ ...values, maxDuration: values['max-duration'], capUsd: values['cap-usd'],
    rateUsd: values['rate-usd-per-minute'], reserveUsd: values['stop-reserve-usd'] });
  console.log(`AIT-139 ${report.status}: ${report.stopReason}; reports: ${output}`);
  if (report.status !== 'passed') process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
