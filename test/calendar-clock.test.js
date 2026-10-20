import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Run the existing assertions outside their former calendar windows. Each child
// gets one advancing Date clock; its server forks inherit the same preload.
const root = fileURLToPath(new URL('../', import.meta.url));
const cases = [
  ['Grok certificate after its former 2099 expiry', '2101-01-01T12:00:00Z',
    'configuration snapshots', ['plugins/grok-voice/test/configuration.test.js']],
  ['conversation admission after the 2027 host epoch', '2028-10-20T12:00:00Z',
    'expiry during wallet admission|admitted but undispatched', ['packages/server/test/conversation-limits.test.js']],
  ['daily snapshots across a future UTC midnight', '2028-10-20T23:59:59Z',
    'retirement removes accounting|reservations, actual usage', ['packages/server/test/retention.test.js', 'packages/server/test/voice-cap.test.js']],
  ['SQLite retention on the same future clock', '2028-10-20T12:00:00Z',
    'last activity uses server events', ['packages/server/test/retention.test.js']],
  ['OIDC future iat at its former literal instant', '2096-10-02T07:06:40Z',
    'refuses future iat', ['demo/test/operator-login.test.js']],
  ['observability before its fixed wire epoch', '2020-01-01T12:00:00Z',
    'independent v1 callback', ['plugins/elevenlabs/test/observability-wire.test.js']],
  ['transcript expiry before its former year-2000 fixture', '1999-01-01T12:00:00Z',
    'module erase and retirement|active unjournalled hold', ['test/visitor-tier-host.test.js']],
];
for (const [name, now, pattern, files] of cases) test(`AIT-402 calendar: ${name}`, { timeout: 40_000 }, () => {
  const run = spawnSync(process.execPath, ['--test', '--test-concurrency=2',
    '--import', `./test/fixtures/calendar-clock.js?now=${now}`,
    `--test-name-pattern=${pattern}`, ...files], {
    cwd: root, encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH, TZ: 'UTC' },
  });
  assert.equal(run.status, 0, `${run.error ?? ''}\n${run.stdout}\n${run.stderr}`);
});
