// AIT-611: the demo host test's teardown drain (test-only harness; nothing here ships).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostDrain } from './host-drain.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
const turns = async count => { for (let i = 0; i < count; i += 1) await turn(); };
// An injected deadline: the test fires it; no real clock takes part.
const clock = () => {
  const timers = [];
  return { timers, setTimer: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length - 1; }, clearTimer: id => { if (timers[id]) timers[id].cleared = true; } };
};

test('AIT-611 drain: nothing in flight settles at once, and the first drain runs onDrain', async () => {
  const time = clock(); let drains = 0;
  const harness = hostDrain({ fetch: async () => new Response('{}'), ...time, onDrain: () => { drains += 1; } });
  await harness.drain();
  assert.equal(drains, 1);
  assert.deepEqual(time.timers.map(timer => [timer.ms, timer.cleared]), [[5000, true]], 'one bounded deadline, cleared once settled');
});

test('AIT-611 drain: waits for open requests, their body reads and the follow-up requests their continuations start', async () => {
  const time = clock(), answer = Promise.withResolvers(), body = Promise.withResolvers(), follow = Promise.withResolvers();
  const seen = [];
  const harness = hostDrain({ ...time, fetch: url => {
    if (url === '/api/credits') return answer.promise;
    return follow.promise;
  } });
  // A page read: the request, then its body, then a continuation that starts a follow-up request.
  harness.fetch('/api/credits').then(response => response.json()).then(value => { seen.push(value); return harness.fetch('/api/identity'); }).then(() => seen.push('identity'));
  let settled = false; const drained = harness.drain().then(() => { settled = true; });
  await turns(5); assert.equal(settled, false, 'an open request keeps the drain waiting');
  answer.resolve({ json: () => body.promise });
  await turns(5); assert.equal(settled, false, 'an open body read keeps the drain waiting');
  body.resolve('credits');
  await turns(5); assert.equal(settled, false, 'a follow-up request started by a continuation keeps it waiting');
  follow.resolve(new Response('{}'));
  await drained;
  assert.deepEqual(seen, ['credits', 'identity'], 'every continuation ran before the drain settled');
  assert.equal(time.timers[0].cleared, true);
});

test('AIT-611 drain: a request still open when the deadline fires fails the drain and is named', async () => {
  const time = clock(), held = Promise.withResolvers();
  const harness = hostDrain({ ...time, fetch: () => held.promise });
  harness.fetch('/api/library?offset=0').catch(() => {});
  harness.fetch('/api/sessions/s1/settings', { method: 'POST' }).catch(() => {});
  const drained = harness.drain();
  await turns(3);
  assert.deepEqual(time.timers.map(timer => timer.ms), [5000]);
  time.timers[0].fn();
  await assert.rejects(drained, error => /deadline/u.test(error.message)
    && error.message.includes('GET /api/library?offset=0') && error.message.includes('POST /api/sessions/s1/settings'));
  held.resolve(new Response('{}'));
});

test('AIT-611 drain: a request finishing after the deadline fired does not turn the drain into a success', async () => {
  const time = clock(), held = Promise.withResolvers();
  const harness = hostDrain({ ...time, fetch: () => held.promise });
  harness.fetch('/api/handover').catch(() => {});
  const drained = harness.drain();
  await turns(3);
  // The race: the deadline fires, then the open call finishes before the drain's next turn.
  time.timers[0].fn();
  held.resolve(new Response('{}'));
  await assert.rejects(drained, error => /deadline/u.test(error.message) && error.message.includes('GET /api/handover'));
});

test('AIT-611 drain: the default deadline is 5 s', async () => {
  const time = clock();
  const harness = hostDrain({ fetch: () => new Promise(() => {}), setTimer: time.setTimer, clearTimer: time.clearTimer });
  harness.fetch('/api/credits');
  const drained = harness.drain();
  await turn();
  assert.equal(time.timers[0].ms, 5000);
  time.timers[0].fn();
  await assert.rejects(drained, /GET \/api\/credits/u);
});
