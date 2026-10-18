import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComposedRelayRoute } from '../../composed-voice/src/network-relay.js';
import { createComposedBrowserMedia } from '../../composed-voice/src/client.js';
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
