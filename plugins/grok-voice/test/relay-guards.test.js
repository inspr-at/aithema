import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComposedRelayRoute } from '../../composed-voice/src/network-relay.js';
import { createComposedBrowserMedia } from '../../composed-voice/src/client.js';
import { createComposedRelay } from '../../composed-voice/src/relay.js';
import { createNetworkRelayClient } from '../../composed-voice/src/network-client.js';
import { createGrokVoiceClient } from '../src/client.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const grant = { callId: 'call', providerSessionId: 'generation', expiresAt: Date.now() + 60000,
  opaque: { epoch: 2, spendDeadlineAt: Date.now() + 60000, browserLivenessDeadlineAt: Date.now() + 30000 } };
for (const mode of ['aborted', 'owner-lost', 'revoked', 'shutdown']) test(`AIT-346: late ${mode} relay opening disconnects`, async () => {
  const pending = Promise.withResolvers(), controller = new AbortController(); let disconnected = 0, allowed = true;
  const route = createComposedRelayRoute({ authenticate: () => 'owner', authorize: () => allowed,
    connect: () => pending.promise });
  const opening = route.handle(new Request('https://host.test/composed/relay', { method: 'POST',
    signal: controller.signal, headers: { 'x-composed-action': 'open' }, body: JSON.stringify(grant) }));
  await tick();
  if (mode === 'aborted') controller.abort();
  if (mode === 'owner-lost') allowed = false;
  if (mode === 'revoked') route.revoke(grant.providerSessionId);
  if (mode === 'shutdown') route.close();
  pending.resolve({ grant, disconnect() { disconnected++; } });
  const result = await opening; route.close();
  assert.equal(result.status, 403); assert.equal(disconnected, 1);
});
test('AIT-346: pending relay openings count against the queue limit', async () => {
  const pending = Promise.withResolvers();
  const route = createComposedRelayRoute({ authenticate: () => 'owner', authorize: () => true, maxConnections: 1, connect: () => pending.promise });
  const post = () => route.handle(new Request('https://host.test/composed/relay', { method: 'POST',
    headers: { 'x-composed-action': 'open' }, body: JSON.stringify(grant) }));
  const first = post(); await tick(); const second = post();
  // Resolve only after allowing the second handler to inspect occupied capacity.
  await tick(); pending.resolve({ grant, disconnect() {} });
  assert.equal((await first).status, 200); assert.equal((await second).status, 429); route.close();
});
test('AIT-346: cancelled browser start disconnects a relay which ignores cancellation', async () => {
  const pending = Promise.withResolvers(), controller = new AbortController(); let disconnected = 0, captured = 0;
  const media = createComposedBrowserMedia({ openRelay: () => pending.promise,
    capture() { captured++; }, player: { play() {}, stop() {} } });
  const starting = media.connect(grant, { signal: controller.signal, deadlineAt: Date.now() + 2000 });
  await tick(); controller.abort(); await assert.rejects(starting, { code: 'cancelled' });
  pending.resolve({ disconnect() { disconnected++; } }); await tick();
  assert.equal(disconnected, 1); assert.equal(captured, 0);
});

for (const name of ['pause', 'interrupt']) test(`AIT-346: Grok heartbeat uses control during pending ${name}`, async t => {
  const entered = Promise.withResolvers(), saved = Promise.withResolvers();
  const until = Date.now() + 60_000;
  const relay = createComposedRelay({ callId: 'grok-call', providerSessionId: 'grok-segment', epoch: 2, expiresAt: until });
  let relayHeartbeats = 0, controlHeartbeats = 0, recoveries = 0;
  relay.attach({
    async interrupt() { entered.resolve(); await saved.promise; return { acknowledged: true }; },
    heartbeat() { relayHeartbeats++; throw new Error('Heartbeat belongs on control'); },
    close() { relay.close(); },
  });
  const route = createComposedRelayRoute({ authenticate: () => 'owner', authorize: () => true,
    connect: candidate => relay.connect(candidate) });
  const control = {
    start: async () => ({ callId: relay.grant.callId, providerSessionId: relay.grant.providerSessionId, epoch: 2, mediaGrant: relay.grant }),
    async pause() { entered.resolve(); await saved.promise; return { acknowledged: true, paused: true }; },
    resume: async () => ({ acknowledged: true, paused: false }), close: async () => { relay.close(); },
    async heartbeat(identity) {
      assert.deepEqual(identity, { callId: 'grok-call', providerSessionId: 'grok-segment', epoch: 2 });
      controlHeartbeats++; return { acknowledged: true, browserLivenessDeadlineAt: until };
    },
    recover() { recoveries++; throw new Error('Unexpected recovery'); },
  };
  const client = createGrokVoiceClient({ control,
    openRelay: createNetworkRelayClient({ url: 'http://localhost/composed/relay', fetch: (url, init) => route.handle(new Request(url, init)) }),
    capture: async () => ({ stop() {} }), player: { play() {}, stop() {} } });
  const session = await client.start({ callId: 'grok-call' });
  t.after(async () => { saved.resolve(); await session.close(); route.close(); });
  const pending = session[name](); await entered.promise;
  assert.equal((await session.heartbeat()).browserLivenessDeadlineAt, until);
  assert.equal(controlHeartbeats, 1); assert.equal(relayHeartbeats, 0); assert.equal(recoveries, 0);
  saved.resolve(); await pending;
});
