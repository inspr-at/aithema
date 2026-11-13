import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComposedBrowserMedia } from '../src/composed/client.js';
const tick = () => new Promise(setImmediate);
for (const elapsed of [false, true]) test(`AIT-502: relay deadline ${elapsed ? 'at' : 'before'} spend bound`, async t => {
  let clock = 100_000, recoveries = 0; const events = [], failure = Promise.withResolvers();
  const grant = { callId: 'call', providerSessionId: 'segment', expiresAt: clock + 60_000,
    opaque: { epoch: 1, spendDeadlineAt: clock + 60_000, browserLivenessDeadlineAt: clock + 60_000 } };
  const media = createComposedBrowserMedia({ now: () => clock, capture: async () => ({ stop() {} }), player: { play() {}, stop() {} },
    control: { recover() { recoveries++; throw new Error('offline'); } },
    openRelay: async () => ({ command: async () => {}, disconnect() {}, frames: { async *[Symbol.asyncIterator]() {
      await failure.promise; throw Object.assign(new Error('relay timeout'), { code: 'deadline' });
    } } }) });
  const session = await media.connect(grant); t.after(() => session.close());
  void (async () => { for await (const event of session.events) events.push(event); })();
  if (elapsed) clock += 60_000;
  failure.resolve(); for (let i = 0; i < 16; i++) await tick();
  assert.equal(recoveries, elapsed ? 0 : 3);
  assert.equal(events.some(e => e.type === 'ended' && e.reason === 'spend-deadline'), elapsed);
  if (!elapsed) assert.ok(events.some(e => e.type === 'waiting' && e.reason === 'recovery-failed'));
});
