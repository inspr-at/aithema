import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import * as server from '../src/server.js';
import * as client from '../src/client.js';
import { createComposedRelay } from '@inspr/aithema-server/composed-voice/relay';
import { fixture, origin, urls } from './fixtures.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const collect = async source => { const out = []; for await (const value of source) out.push(value); return out; };
function mounted(overrides = {}) {
  assert.equal(typeof server.createVoxtralVoiceProvider, 'function');
  const f = fixture(); f.setClock(Date.now());
  for (const b of [...Object.values(f.componentBindings), f.hostProcessing[0].binding]) {
    b.legal.evidence.verifiedAt = Date.now() - 1000; b.legal.evidence.expiresAt = Date.now() + 60000;
  }
  let dispatches = 0, admissions = 0;
  const parent = structuredClone(f.componentBindings.stt);
  Object.assign(parent, { plugin: 'voxtral-voice', model: 'voxtral-voice', maxDurationSeconds: 120, upstreamMicroPerMinute: 0, visitorMicroPerMinute: 0 });
  parent.legal.evidence.model = parent.model;
  const p = server.createVoxtralVoiceProvider({ ...f.args, binding: parent, enabled: true,
    storage: { saveVoiceCall() {}, authorize(id, owner) { if (id !== f.request.session.id || owner !== 'owner') throw new Error('not owner'); return f.request.session; }, voiceLifecycle() { return { epoch: 1 }; } },
    resolveSecret() { dispatches++; assert.fail('No secrets in admission tests'); },
    connect() { dispatches++; assert.fail('No STT dispatch'); }, fetchImpl() { dispatches++; assert.fail('No TTS dispatch'); },
    authenticateRelay: request => request.headers.get('x-owner'), relayOrigin: 'https://host.test', ...overrides });
  const routes = p.ports.serverAdapter.bindCallbacks({
    authorizeComposition() { admissions++; return true; }, commitCoordinator() {},
    turnOperations: { run() { assert.fail('No reasoning'); } }, admitReasoning() { assert.fail('No reasoning'); }, admitComponent() { assert.fail('No claims'); },
  }).callbackRoutes;
  return { f, p, routes, counts: () => ({ dispatches, admissions }) };
}

for (const [name, headers, body, status] of [
  ['bad origin', { 'x-owner': 'owner', origin: 'https://bad.test' }, {}, 403],
  ['missing auth', {}, {}, 401],
  ['missing grant', { 'x-owner': 'owner' }, {}, 403],
  ['expired grant', { 'x-owner': 'owner' }, { callId: 'call', providerSessionId: 'wrong', expiresAt: 1, opaque: { epoch: 1 } }, 403],
  ['wrong session', { 'x-owner': 'other-owner' }, { callId: 'call', providerSessionId: 'other-session', expiresAt: Date.now() + 60000, opaque: { epoch: 1 } }, 403],
]) test(`AIT-330: mounted relay rejects ${name}`, async t => {
  const h = mounted(); t.after(() => h.p.networkRelay.close());
  assert.equal(h.routes.length, 1); assert.equal(h.routes[0].path, '/composed/relay');
  const response = await h.routes[0].handle(new Request('https://host.test/composed/relay', {
    method: 'POST', headers: { 'x-composed-action': 'open', ...headers }, body: JSON.stringify(body) }));
  assert.equal(response.status, status); assert.equal(h.counts().dispatches, 0);
});

test('AIT-330: invalid account blocks provider admission before mount authority or secrets', async t => {
  const h = mounted({ config: { endpoint: origin, secretRef: 'private:synthetic/key', voiceId: 'voice' } });
  t.after(() => h.p.networkRelay.close());
  assert.equal((await h.p.health()).available, false);
  assert.notEqual(await h.p.ports.serverAdapter.admissionReason(h.f.request), null);
  await assert.rejects(h.p.start({ sessionId: 'session', callId: 'call' }, { deadlineAt: Date.now() + 1000 }), { code: 'unavailable' });
  assert.deepEqual(h.counts(), { admissions: 0, dispatches: 0 });
});

test('AIT-330: deadline while component preflight is pending prevents admission and consumption', async t => {
  // Preflight negotiates asynchronously; expiring the request in the same turn
  // must win before either the mounted authority or a claim is touched.
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const h = mounted(); t.after(() => h.p.networkRelay.close());
  let consumed = 0;
  const pending = h.p.start({ sessionId: 'session', callId: 'call' }, { deadlineAt: Date.now() + 10,
    attempt: { maxMicro: 0, consume() { consumed++; } } });
  const rejected = assert.rejects(pending, { code: 'deadline' });
  assert.equal(h.counts().admissions, 0);
  t.mock.timers.tick(20); await rejected;
  assert.equal(consumed, 0); assert.deepEqual(h.counts(), { admissions: 0, dispatches: 0 });
});

class Socket extends EventEmitter {
  static instances = [];
  constructor(url, options) { super(); this.url = url; this.options = options; this.bufferedAmount = 0; Socket.instances.push(this); }
  send(wire, done) { this.sent = wire; done?.(); }
  close() { this.closed = true; }
  terminate() { this.closed = true; }
}
function ports() {
  assert.equal(typeof server.createVoxtralTransports, 'function');
  return server.createVoxtralTransports({ endpoint: origin, WebSocket: Socket, fetchImpl() { assert.fail('Unexpected fetch'); } });
}
test('AIT-330: injected server WebSocket binds exact regional URL and limits queued frames', async () => {
  const transports = ports(), controller = new AbortController();
  const opening = transports.connect({ url: urls.stt, headers: { Authorization: 'Bearer synthetic-only' }, signal: controller.signal });
  const socket = Socket.instances.at(-1); socket.emit('open'); const port = await opening;
  assert.equal(socket.url, urls.stt); assert.equal(socket.options.maxPayload, 256000);
  const iterator = port.events[Symbol.asyncIterator]();
  socket.emit('message', Buffer.from('{"type":"session.created"}'), false);
  assert.equal((await iterator.next()).value, '{"type":"session.created"}');
  for (let i = 0; i < 32; i++) socket.emit('message', Buffer.from('{"type":"delta"}'), false);
  await assert.rejects(iterator.next(), { code: 'limit' }); assert.equal(socket.closed, true);
  await assert.rejects(transports.connect({ url: urls.stt.replace('api.eu.', 'api.'), headers: {} }), { code: 'not-admitted' });
});
for (const kind of ['abort', 'frame', 'send-buffer', 'binary']) test(`AIT-330: WebSocket ${kind} closes its injected socket`, async () => {
  const controller = new AbortController(), transports = ports();
  const opening = transports.connect({ url: urls.stt, headers: {}, signal: controller.signal });
  const socket = Socket.instances.at(-1); socket.emit('open'); const port = await opening;
  if (kind === 'abort') controller.abort();
  if (kind === 'frame') socket.emit('message', Buffer.alloc(256001), false);
  if (kind === 'binary') socket.emit('message', Buffer.alloc(4), true);
  if (kind === 'send-buffer') { socket.bufferedAmount = 512000; await assert.rejects(port.send('{}'), { code: 'limit' }); }
  else await assert.rejects(port.events[Symbol.asyncIterator]().next(), { code: kind === 'abort' ? 'cancelled' : kind === 'frame' ? 'limit' : 'invalid-output' });
  assert.equal(socket.closed, true);
});

test('AIT-330: browser factory connects float32 playback, meters, blocked retry and control', async t => {
  assert.equal(typeof client.createVoxtralVoiceClient, 'function');
  const relay = createComposedRelay({ callId: 'call', providerSessionId: 'segment', epoch: 2, expiresAt: Date.now() + 60000 });
  relay.attach({ close() {}, interrupt() {}, heartbeat() {} });
  let gesture, attempts = 0, paused = 0, resumed = 0; const played = [];
  const control = { tabId: 'tab', start: async () => ({ callId: 'call', providerSessionId: 'segment', epoch: 2, mediaGrant: relay.grant }),
    close() {}, pause() { paused++; return { acknowledged: true, paused: true }; }, resume() { resumed++; },
    heartbeat() {}, recover() { throw new Error('No recovery expected'); } };
  const browser = client.createVoxtralVoiceClient({ control, openRelay: grant => relay.connect(grant),
    capture: async () => ({ stop() {}, audioLevel: () => 0.25 }),
    player: { play(bytes, format) { if (++attempts === 1) throw new DOMException('gesture', 'NotAllowedError'); played.push(format); },
      stop() {}, retry() {}, audioLevel: () => 0.5 } });
  const session = await browser.start({ callId: 'call' }, { onPlaybackBlocked: retry => { gesture = retry; } });
  t.after(async () => { await session.close(); relay.close(); });
  assert.deepEqual(session.audioLevels(), { input: 0.25, output: 0.5 });
  relay.audio({ bytes: Uint8Array.from([0, 0, 0, 0]), format: 'pcm_f32le', sampleRateHz: 24000, channels: 1, playbackRevision: 0, replyId: 'reply' });
  await tick(); assert.equal(typeof gesture, 'function'); assert.equal(session.audioLevels().output, 0);
  await gesture(); await tick(); assert.equal(played[0].format, 'pcm_f32le');
  await session.pause(); assert.equal(paused, 1); assert.equal(resumed, 0);
  assert.equal(typeof session.lifecycle.recover, 'function');
});

test('AIT-330: browser imports contain no credential or server transport graph and worklet resolves', async () => {
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /secretRef|resolveSecret|Authorization|\.\/server\.js|\.\/provider\.js|\.\/transports\.js/u);
  assert.match(source, /packages\/server\/src\/composed/u);
  const worklet = await readFile(new URL('../../../packages/server/src/composed/pcm-capture-worklet.js', import.meta.url), 'utf8');
  assert.match(worklet, /registerProcessor\('composed-pcm-capture'/u);
  assert.equal(import.meta.resolve('@inspr/aithema-server/composed-voice/pcm-capture-worklet.js'), new URL('../../../packages/server/src/composed/pcm-capture-worklet.js', import.meta.url).href);
});

test('AIT-330: a real assembled segment mounts a single-use owner-bound grant', async t => {
  const h = mounted(), reports = []; t.after(() => h.p.networkRelay.close());
  let consumed = 0;
  const segment = await h.p.start({ sessionId: 'session', callId: 'call', ownerToken: 'owner' }, {
    deadlineAt: Date.now() + 5000, spendDeadlineAt: Date.now() + 60000, browserLivenessDeadlineAt: Date.now() + 60000,
    attempt: { attemptId: 'parent', claimId: 'parent', maxMicro: 0, consume() { consumed++; } }, report: terminal => reports.push(terminal) });
  t.after(() => segment.close());
  const open = (grant, owner = 'owner') => h.routes[0].handle(new Request('https://host.test/composed/relay', {
    method: 'POST', headers: { 'x-owner': owner, origin: 'https://host.test', 'x-composed-action': 'open' }, body: JSON.stringify(grant) }));
  assert.equal((await open(segment.grant, 'other-owner')).status, 403);
  assert.equal((await open({ ...segment.grant, callId: 'other-call' })).status, 403);
  assert.equal((await open({ ...segment.grant, expiresAt: 1 })).status, 403);
  assert.equal((await open(segment.grant)).status, 200);
  assert.equal((await open(segment.grant)).status, 403);
  assert.equal(consumed, 1); assert.equal(h.counts().dispatches, 0);
  await segment.close(); assert.equal(reports.length, 1);
});

test('AIT-330: injected TTS fetch cannot redirect or change regional endpoint', async () => {
  let requests = 0;
  const transports = server.createVoxtralTransports({ endpoint: origin, fetchImpl(url, options) {
    requests++; assert.equal(url, urls.tts); assert.equal(options.redirect, 'error'); return new Response('fixture');
  } });
  await transports.fetchImpl(urls.tts, { method: 'POST', redirect: 'error' });
  await assert.rejects(transports.fetchImpl(urls.tts.replace('api.eu.', 'api.'), { method: 'POST', redirect: 'error' }), { code: 'not-admitted' });
  await assert.rejects(transports.fetchImpl(urls.tts, { method: 'POST', redirect: 'follow' }), { code: 'not-admitted' });
  assert.equal(requests, 1);
});
