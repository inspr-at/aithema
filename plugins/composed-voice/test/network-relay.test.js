import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComposedRelay } from '../src/relay.js';
import { createComposedRelayRoute } from '../src/network-relay.js';
import { createNetworkRelayClient } from '../src/network-client.js';
import { createComposedBrowserMedia } from '../src/client.js';

function fixture(options = {}, durationMs = 60_000, coordinator = {}) {
  let at = Date.now(), authorized = true, received = 0, disconnects = 0;
  const relay = createComposedRelay({ callId: 'call', providerSessionId: 'segment', epoch: 2,
    expiresAt: at + 30_000, spendDeadlineAt: at + durationMs, now: () => at });
  relay.attach({ receiveAudio(bytes) { received += bytes.length; }, pause: async () => ({ acknowledged: true, paused: true }),
    close() { disconnects++; relay.close(); }, heartbeat: async () => ({ acknowledged: true }), ...coordinator });
  const route = createComposedRelayRoute({ now: () => at, authenticate: request => request.headers.get('x-owner'),
    authorize: async (_grant, owner) => owner === 'alice' && authorized,
    connect: async (grant, owner) => {
      if (owner !== 'alice' || !authorized) throw Object.assign(new Error(), { code: 'not-admitted' });
      return relay.connect(grant);
    }, ...options });
  const post = (action, body, id, owner = 'alice', headers = {}) => route.handle(new Request('http://localhost/composed/relay', {
    method: 'POST', headers: { ...(owner ? { 'x-owner': owner } : {}), 'x-composed-action': action,
      ...(id ? { 'x-composed-connection': id } : {}), ...headers }, body: body instanceof Uint8Array ? body : JSON.stringify(body ?? {}) }));
  return { relay, route, post, advance: ms => { at += ms; }, revoke: () => { authorized = false; },
    get received() { return received; }, get disconnects() { return disconnects; } };
}

test('network relay denies unauthenticated, wrong-owner, expired, altered and replayed grants', async t => {
  const h = fixture(); t.after(() => h.route.close());
  assert.equal((await h.post('open', h.relay.grant, null, null)).status, 401);
  assert.equal((await h.post('open', h.relay.grant, null, 'bob')).status, 403);
  assert.equal((await h.post('open', { ...h.relay.grant, callId: 'other' })).status, 403);
  const opened = await h.post('open', h.relay.grant); assert.equal(opened.status, 200);
  const { connectionId } = await opened.json();
  assert.equal((await h.post('audio', new Uint8Array(1280), connectionId, 'bob')).status, 403);
  assert.equal((await h.post('open', h.relay.grant)).status, 403);
  h.advance(31_000);
  assert.equal((await h.post('audio', new Uint8Array(1280), connectionId)).status, 200);
  const expired = fixture(); t.after(() => expired.route.close()); expired.advance(31_000);
  assert.equal((await expired.post('open', expired.relay.grant)).status, 403);
});

for (const name of ['pause', 'interrupt']) test(`AIT-346: composed network heartbeat overlapping ${name} preserves the session`, async t => {
  const entered = Promise.withResolvers(), saved = Promise.withResolvers(), frameDelivery = Promise.withResolvers();
  let recoveries = 0, captureStops = 0;
  const h = fixture({}, 60_000, { async [name]() {
    entered.resolve(); await saved.promise;
    return { acknowledged: true, ...(name === 'pause' ? { paused: true } : {}) };
  }, heartbeat: async () => ({ acknowledged: true, browserLivenessDeadlineAt: h.relay.grant.expiresAt }) });
  const requests = [];
  const openRelay = createNetworkRelayClient({ url: 'http://localhost/composed/relay', headers: { 'x-owner': 'alice' },
    async fetch(url, init) {
      const action = init.headers['x-composed-action'];
      const response = await h.route.handle(new Request(url, init));
      if (action === 'frame') await frameDelivery.promise;
      requests.push({ action, status: response.status }); return response;
    } });
  const media = createComposedBrowserMedia({ openRelay,
    control: { recover() { recoveries++; throw new Error('Unexpected recovery'); } },
    capture: async () => ({ stop() { captureStops++; } }), player: { play() {}, stop() {} } });
  const session = await media.connect(h.relay.grant);
  t.after(async () => { saved.resolve(); frameDelivery.resolve(); await session.close().catch(() => {}); h.route.close(); });
  const pending = session[name](); await entered.promise;
  // Pause's durable save is still in flight; the end-of-frames response may be delayed by the network.
  const ack = await session.heartbeat();
  assert.equal(ack.acknowledged, true);
  assert.equal(recoveries, 0, 'a concurrent heartbeat must not replace the healthy transport');
  assert.equal(captureStops, name === 'pause' ? 1 : 0, 'only the explicit pause stops capture');
  assert.ok(requests.every(request => request.status === 200), 'heartbeats must not encounter relay limit or authority errors');
  saved.resolve(); await pending;
  if (name === 'interrupt') {
    const renewed = await session.heartbeat();
    assert.equal(renewed.browserLivenessDeadlineAt, h.relay.grant.expiresAt);
    assert.equal(recoveries, 0);
  }
});

test('AIT-346: relay defers heartbeats without consuming command capacity or weakening overload bounds', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let heartbeats = 0;
  const h = fixture({}, 60_000, {
    async interrupt() { entered.resolve(); await release.promise; return { acknowledged: true }; },
    async heartbeat() { heartbeats++; return { acknowledged: true }; },
  });
  t.after(() => { release.resolve(); h.route.close(); });
  const id = (await (await h.post('open', h.relay.grant)).json()).connectionId;
  const pending = h.post('command', { name: 'interrupt' }, id); await entered.promise;
  const heartbeat = await h.post('command', { name: 'heartbeat' }, id);
  assert.equal(heartbeat.status, 200);
  assert.equal((await heartbeat.json()).result.acknowledged, true);
  assert.equal(heartbeats, 0, 'deferred heartbeats do not claim a renewed lease');
  const overloaded = await h.post('command', { name: 'interrupt' }, id);
  assert.equal(overloaded.status, 429); assert.deepEqual(await overloaded.json(), { error: 'limit' });
  release.resolve(); assert.equal((await pending).status, 200);
  assert.equal((await h.post('command', { name: 'heartbeat' }, id)).status, 200);
  assert.equal(heartbeats, 1);
});

test('AIT-346: a heartbeat in flight does not take the regular command slot', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let heartbeats = 0, interrupts = 0;
  const h = fixture({}, 60_000, {
    async heartbeat() { heartbeats++; entered.resolve(); await release.promise; return { acknowledged: true }; },
    async interrupt() { interrupts++; return { acknowledged: true }; },
  });
  t.after(() => { release.resolve(); h.route.close(); });
  const id = (await (await h.post('open', h.relay.grant)).json()).connectionId;
  const pending = h.post('command', { name: 'heartbeat' }, id); await entered.promise;
  assert.equal((await h.post('command', { name: 'interrupt' }, id)).status, 200);
  assert.equal((await h.post('command', { name: 'heartbeat' }, id)).status, 200);
  assert.equal(interrupts, 1); assert.equal(heartbeats, 1, 'only one heartbeat may reach the coordinator at a time');
  release.resolve(); assert.equal((await pending).status, 200);
});

test('network relay carries explicit formats and PCM, closes on pause and revoke, bounds body/rate', async t => {
  const h = fixture(); t.after(() => h.route.close());
  const id = (await (await h.post('open', h.relay.grant)).json()).connectionId;
  h.relay.audio({ format: 'pcm_s16le', sampleRateHz: 24000, channels: 1, playbackRevision: 2, bytes: new Uint8Array([1, 2]) });
  const { frame } = await (await h.post('frame', {}, id)).json();
  assert.equal(frame.sampleRateHz, 24000); assert.equal(frame.channels, 1); assert.equal(frame.bytes, 'AQI=');
  assert.equal((await h.post('audio', new Uint8Array(1280), id)).status, 200); assert.equal(h.received, 1280);
  assert.equal((await h.post('audio', new Uint8Array(16001), id)).status, 429);
  assert.equal((await h.post('command', { name: 'pause' }, id)).status, 200);
  assert.equal((await h.post('audio', new Uint8Array(2), id)).status, 403);
  const revoked = fixture(); t.after(() => revoked.route.close());
  const revokedId = (await (await revoked.post('open', revoked.relay.grant)).json()).connectionId;
  const waiting = revoked.post('frame', {}, revokedId); await new Promise(resolve => setImmediate(resolve));
  revoked.revoke(); revoked.relay.audio({ bytes: new Uint8Array(2) });
  assert.deepEqual(await (await waiting).json(), { done: true }); assert.equal(revoked.disconnects, 1);
  const rate = fixture({ requestsPerSecond: 2 }); t.after(() => rate.route.close());
  const rateId = (await (await rate.post('open', rate.relay.grant)).json()).connectionId;
  assert.equal((await rate.post('audio', new Uint8Array(2), rateId)).status, 200);
  assert.equal((await rate.post('audio', new Uint8Array(2), rateId)).status, 429);
});

test('network browser bridge sends owner auth and never puts grants in URL', async t => {
  const h = fixture(); t.after(() => h.route.close());
  const urls = [];
  const open = createNetworkRelayClient({ url: 'http://localhost/composed/relay', headers: { 'x-owner': 'alice' },
    fetch: (url, init) => { urls.push(url); return h.route.handle(new Request(url, init)); } });
  const connection = await open(h.relay.grant);
  h.relay.audio({ format: 'pcm_f32le', sampleRateHz: 24000, channels: 1, bytes: new Uint8Array([1, 2, 3, 4]) });
  assert.deepEqual([...(await connection.frames.next()).value.bytes], [1, 2, 3, 4]);
  await connection.sendAudio(new Uint8Array(4)); assert.equal(h.received, 4);
  assert.equal((await connection.command('pause')).paused, true);
  await connection.disconnect().catch(() => {});
  assert.ok(urls.every(url => url === 'http://localhost/composed/relay'));
});

test('network relay rejects cross-site and concurrent reads and enforces byte-rate bound', async t => {
  const h = fixture({ bytesPerSecond: 1500 }); t.after(() => h.route.close());
  assert.equal((await h.post('open', h.relay.grant, null, 'alice', { origin: 'http://other.test' })).status, 403);
  const id = (await (await h.post('open', h.relay.grant)).json()).connectionId;
  const pending = h.post('frame', {}, id); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.post('frame', {}, id)).status, 429);
  assert.equal((await h.post('audio', new Uint8Array(1000), id)).status, 200);
  assert.equal((await h.post('audio', new Uint8Array(1000), id)).status, 429);
  assert.deepEqual(await (await pending).json(), { done: true });
});

test('grant revocation fences an audio upload already waiting for its body', async t => {
  const h = fixture(); t.after(() => h.route.close());
  const id = (await (await h.post('open', h.relay.grant)).json()).connectionId;
  let upload;
  const body = new ReadableStream({ start(controller) { upload = controller; } });
  const pending = h.route.handle(new Request('http://localhost/composed/relay', { method: 'POST', duplex: 'half', body,
    headers: { 'x-owner': 'alice', 'x-composed-action': 'audio', 'x-composed-connection': id } }));
  await new Promise(resolve => setImmediate(resolve));
  h.route.revoke('segment'); upload.enqueue(new Uint8Array(1280)); upload.close();
  assert.equal((await pending).status, 403); assert.equal(h.received, 0);
});

for (const seconds of [900, 3600]) {
  test(`claimed connection survives claim expiry with heartbeats until ${seconds}s spend deadline`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = fixture({}, seconds * 1000); t.after(() => h.route.close());
    const id = (await (await h.post('open', h.relay.grant)).json()).connectionId;
    for (let elapsed = 30; elapsed < seconds; elapsed += 30) {
      h.advance(30_000); t.mock.timers.tick(30_000);
      assert.equal((await h.post('command', { name: 'heartbeat' }, id)).status, 200);
      assert.equal((await h.post('audio', new Uint8Array(2), id)).status, 200);
      assert.equal(h.disconnects, 0);
    }
    h.advance(30_000); t.mock.timers.tick(30_000);
    assert.equal(h.disconnects, 1);
    assert.equal((await h.post('command', { name: 'heartbeat' }, id)).status, 403);
  });
}

test('client-posted later spend deadline is ignored in favor of the stored relay grant', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = fixture(); t.after(() => h.route.close());
  const altered = { ...h.relay.grant, opaque: { ...h.relay.grant.opaque, spendDeadlineAt: h.relay.grant.opaque.spendDeadlineAt + 3_600_000 } };
  const opened = await h.post('open', altered); assert.equal(opened.status, 200);
  const { connectionId } = await opened.json();
  h.advance(60_000); t.mock.timers.tick(60_000);
  assert.equal(h.disconnects, 1);
  assert.equal((await h.post('audio', new Uint8Array(2), connectionId)).status, 403);
});
