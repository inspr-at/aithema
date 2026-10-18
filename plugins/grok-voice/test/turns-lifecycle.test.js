import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComposedVoiceCoordinator } from '@inspr/aithema-server/composed-voice';
import { createComposedRelay } from '@inspr/aithema-server/composed-voice/relay';
import { createComposedRelayRoute } from '@inspr/aithema-server/composed-voice/network-relay';
import { createNetworkRelayClient } from '@inspr/aithema-server/composed-voice/network-client';
import { createComposedBrowserMedia } from '@inspr/aithema-server/composed-voice/client';
import { manifest } from '../src/manifest.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, overrides = {}) {
  const until = Date.now() + 60_000, commits = [], executions = [], roles = [], events = [];
  let allowed = true;
  const relay = createComposedRelay({ callId: 'call', providerSessionId: 'generation', epoch: 2, expiresAt: until });
  const coordinator = createComposedVoiceCoordinator({ sessionId: 'session', callId: 'call', providerSessionId: 'generation', epoch: 2,
    spendDeadlineAt: until, browserLivenessDeadlineAt: until,
    authorize: () => allowed, commitUtterance: envelope => { commits.push(envelope); },
    replyExecutor: { async *execute(envelope) {
      executions.push(envelope); const replyId = `reply-${executions.length}`;
      yield { type: 'operation', replyId }; yield { type: 'delta', text: 'Antwort.' };
      yield { type: 'completion', replyId, text: 'Antwort.' };
    } },
    stt: { async *stream({ audio }) { for await (const _ of audio) {} yield { text: 'Gesprochen', final: true }; } },
    tts: { async *speak() { yield new Uint8Array(4); } },
    admitComponent: ({ role }) => { roles.push(role); return { attempt: { attemptId: `${role}-${roles.length}`, consume() {} }, report() {} }; },
    relay: { audio: frame => relay.audio(frame), silence: frame => relay.silence(frame), event: value => { events.push(value); relay.event(value); } },
    ...overrides });
  relay.attach(coordinator);
  const route = createComposedRelayRoute({ authenticate: () => 'owner', authorize: () => allowed, connect: grant => relay.connect(grant) });
  const open = createNetworkRelayClient({ url: 'http://fixture/composed/relay', fetch: (url, init) => route.handle(new Request(url, init)) });
  t.after(async () => { route.close(); await coordinator.close(); await coordinator.idle(); });
  return { relay, coordinator, open, commits, executions, roles, events, withdraw: () => { allowed = false; }, reconsent: () => { allowed = true; } };
}
const receipt = deliveryId => ({ deliveryId, providerSessionId: 'generation', epoch: 2 });

test('AIT-348: typed network deliveries dedupe by delivery identity, never by text, and bypass STT', async t => {
  const h = fixture(t), transport = await h.open(h.relay.grant);
  assert.equal(manifest.liveVoice.capabilities.sendText, 'native');
  const first = await transport.command('sendText', 'Ja', receipt('first'));
  const duplicate = await transport.command('sendText', 'Ja', receipt('first'));
  const second = await transport.command('sendText', 'Ja', receipt('second'));
  await h.coordinator.idle();
  assert.deepEqual(duplicate, first); assert.notEqual(second.turnId, first.turnId);
  assert.equal(h.commits.length, 2); assert.equal(h.executions.length, 2);
  assert.deepEqual(h.roles, ['tts', 'tts']);
  assert.deepEqual(h.commits.map(x => x.payload.callbackBody.metadata.sequence), [1, 2]);
  assert.ok(Object.isFrozen(h.commits[0].payload.callbackBody));
  await assert.rejects(transport.command('sendText', 'changed', receipt('first')), { code: 'not-admitted' });
});

test('AIT-348: an unfinished spoken turn and concurrent typing share capture order', async t => {
  const h = fixture(t), bytes = Buffer.alloc(3200);
  for (let i = 0; i < bytes.length; i += 2) bytes.writeInt16LE(8000, i);
  const speech = h.coordinator.receiveAudio(bytes);
  const typed = h.coordinator.sendText('Getippt', receipt('typed'));
  await speech;
  await h.coordinator.receiveAudio(Buffer.alloc(16000));
  await typed; await h.coordinator.idle();
  assert.deepEqual(h.commits.map(x => x.payload.callbackBody.messages.filter(m => m.role === 'user').at(-1).content), ['Gesprochen', 'Getippt']);
  assert.deepEqual(h.commits.map(x => x.payload.callbackBody.metadata.sequence), [1, 2]);
  assert.equal(h.roles.filter(x => x === 'stt').length, 1);
});

test('AIT-348: invalid, paused, withdrawn, cancelled and stale-generation typing dispatches nothing', async t => {
  const h = fixture(t);
  for (const text of ['', '   ', 'x'.repeat(16385), null]) await assert.rejects(h.coordinator.sendText(text, receipt('bad')), { code: 'limit' });
  await assert.rejects(h.coordinator.sendText('Ja', { ...receipt('stale'), epoch: 1 }), { code: 'not-admitted' });
  await h.coordinator.pause();
  await assert.rejects(h.coordinator.sendText('Ja', receipt('paused')), { code: 'not-admitted' });
  await h.coordinator.resume();
  await assert.rejects(h.coordinator.sendText('Ja', { ...receipt('cancelled'), signal: AbortSignal.abort() }), { code: 'cancelled' });
  h.withdraw(); await assert.rejects(h.coordinator.sendText('Ja', receipt('withdrawn')), { code: 'not-admitted' });
  assert.equal(h.commits.length, 0); assert.deepEqual(h.roles, []);
});

for (const refusal of ['pause', 'withdrawal', 'cancel', 'deadline']) test(`AIT-348 round 2: ${refusal} leaves the same typed delivery retryable`, async t => {
  const h = fixture(t), id = receipt('retryable'), controller = new AbortController();
  if (refusal === 'pause') await h.coordinator.pause();
  if (refusal === 'withdrawal') h.withdraw();
  if (refusal === 'cancel') controller.abort();
  const failed = { ...id, ...(refusal === 'cancel' ? { signal: controller.signal } : {}),
    ...(refusal === 'deadline' ? { deadlineAt: Date.now() - 1 } : {}) };
  await assert.rejects(h.coordinator.sendText('Noch einmal', failed),
    { code: { pause: 'not-admitted', withdrawal: 'not-admitted', cancel: 'cancelled', deadline: 'deadline' }[refusal] });
  assert.equal(h.executions.length, 0); assert.equal(h.commits.length, 0);
  if (refusal === 'pause') await h.coordinator.resume();
  if (refusal === 'withdrawal') h.reconsent();
  const retried = await Promise.all(Array.from({ length: 4 }, () => h.coordinator.sendText('Noch einmal', id)));
  assert.ok(retried.every(value => value.acknowledged && value.turnId === retried[0].turnId));
  await h.coordinator.idle();
  assert.deepEqual(await h.coordinator.sendText('Noch einmal', id), retried[0]);
  assert.equal(h.executions.length, 1); assert.equal(h.commits.length, 1);
  assert.deepEqual(h.roles, ['tts']);
});

for (const refusal of ['pause', 'withdrawal', 'cancel', 'deadline']) test(`AIT-348 round 2: ${refusal} before executor hand-off rejects the receipt and permits retry`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), controller = new AbortController();
  let first = true, settled = false;
  const h = fixture(t, { commitUtterance: async () => {
    if (first) { first = false; entered.resolve(); await release.promise; }
  } });
  t.after(() => release.resolve());
  const id = receipt('handoff-retry'), pending = h.coordinator.sendText('Noch einmal', { ...id, signal: controller.signal,
    ...(refusal === 'deadline' ? { deadlineAt: Date.now() + 100 } : {}) });
  const rejected = assert.rejects(pending, { code: refusal === 'withdrawal' ? 'not-admitted' : refusal === 'deadline' ? 'deadline' : 'cancelled' });
  void rejected.catch(() => {});
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await entered.promise; await tick();
  assert.equal(settled, false, 'receipt waits for executor hand-off');
  assert.equal(h.executions.length, 0);
  if (refusal === 'pause') await h.coordinator.pause();
  if (refusal === 'withdrawal') h.withdraw();
  if (refusal === 'cancel') controller.abort();
  if (refusal === 'deadline') t.mock.timers.tick(100);
  release.resolve(); await rejected; await h.coordinator.idle();
  assert.equal(h.executions.length, 0, 'refused attempt never reaches the executor');
  if (refusal === 'pause') await h.coordinator.resume();
  if (refusal === 'withdrawal') h.reconsent();
  const retried = await Promise.all(Array.from({ length: 4 }, () => h.coordinator.sendText('Noch einmal', id)));
  await h.coordinator.idle();
  assert.ok(retried.every(value => value.acknowledged && value.turnId === retried[0].turnId));
  assert.deepEqual(await h.coordinator.sendText('Noch einmal', id), retried[0]);
  assert.equal(h.executions.length, 1);
  assert.deepEqual(h.executions[0].payload.callbackBody.messages, [{ role: 'user', content: 'Noch einmal' }]);
  assert.deepEqual(h.roles, ['tts']);
});

function mediaFixture(t, { command, capture, player, recover } = {}) {
  const until = Date.now() + 60_000;
  const relay = createComposedRelay({ callId: 'call', providerSessionId: 'generation', epoch: 2, expiresAt: until });
  relay.attach({ receiveAudio() {}, pause: async () => ({ acknowledged: true, paused: true }), resume: async () => ({ acknowledged: true, paused: false }),
    setInput() {}, setOutput() {}, close() { relay.close(); }, heartbeat: () => ({ acknowledged: true, browserLivenessDeadlineAt: until }), ...command });
  const media = createComposedBrowserMedia({ openRelay: grant => relay.connect(grant), capture: capture ?? (async () => ({ stop() {}, audioLevel: () => 0.4 })),
    player: player ?? { play() {}, stop() {}, audioLevel: () => 0.25 }, control: { recover: recover ?? (() => { throw new Error('offline'); }) } });
  t.after(() => relay.close()); return { relay, media };
}

test('AIT-348: measured levels respect independent channels and delayed pause/resume acknowledgements', async t => {
  const saved = Promise.withResolvers(), resumed = Promise.withResolvers(); let captures = 0;
  const h = mediaFixture(t, { capture: async () => { captures++; return { stop() {}, audioLevel: () => 0.4 }; },
    command: { pause: () => saved.promise, resume: () => resumed.promise } });
  const session = await h.media.connect(h.relay.grant); t.after(() => session.close());
  assert.deepEqual(session.audioLevels(), { input: 0.4, output: 0.25 });
  await session.setInput(false); assert.deepEqual(session.audioLevels(), { input: 0, output: 0.25 });
  await session.setInput(true); await session.setOutput(false); assert.deepEqual(session.audioLevels(), { input: 0.4, output: 0 });
  const pausing = session.pause(); assert.deepEqual(session.audioLevels(), { input: 0, output: 0 });
  saved.resolve({ acknowledged: true, paused: true }); await pausing;
  const resuming = session.resume(); await tick(); assert.equal(captures, 2);
  resumed.resolve({ acknowledged: true, paused: false }); await resuming;
  assert.equal(captures, 3); assert.deepEqual(session.audioLevels(), { input: 0.4, output: 0 });
});

test('AIT-348: blocked playback uses the existing gesture callback without pausing capture or recovering', async t => {
  let blocked = true, retries = 0, recoveries = 0, notify = 0;
  const h = mediaFixture(t, { player: { stop() {}, play() { if (blocked) return Promise.reject(new DOMException('blocked', 'NotAllowedError')); },
    retry() { retries++; blocked = false; } }, recover() { recoveries++; } });
  const session = await h.media.connect(h.relay.grant, { onPlaybackBlocked() { notify++; } }); t.after(() => session.close());
  h.relay.audio({ playbackRevision: 0, format: 'pcm_s16le', bytes: new Uint8Array(4) }); await tick(); await tick();
  assert.equal(notify, 1); assert.equal(retries, 0); assert.equal(recoveries, 0);
  assert.equal(session.audioLevels().input, 0.4);
  await session.retryPlayback(); assert.equal(retries, 1);
});

test('AIT-348: recovery is bounded to three attempts; a hidden-page hold never restarts capture', async t => {
  let attempts = 0, captures = 0; const observed = [], hidden = new AbortController();
  const h = mediaFixture(t, { capture: async () => { captures++; return { stop() {} }; }, recover() { attempts++; throw new Error('offline'); } });
  const session = await h.media.connect(h.relay.grant, { holdSignal: hidden.signal }); t.after(() => session.close().catch(() => {}));
  void (async () => { for await (const event of session.events) observed.push(event); })();
  h.relay.close(); for (let i = 0; i < 12; i++) await tick();
  assert.equal(attempts, 3); assert.ok(observed.some(x => x.type === 'waiting' && x.reason === 'recovery-failed'));
  hidden.abort(); for (let i = 0; i < 4; i++) await tick();
  assert.equal(captures, 1); assert.deepEqual(session.audioLevels(), { input: 0, output: 0 });
});

for (const name of ['NotAllowedError', 'NotFoundError']) test(`AIT-348: microphone ${name} keeps its existing rail failure identity`, async t => {
  const h = mediaFixture(t, { capture: async () => { throw new DOMException('fixture microphone failure', name); } });
  await assert.rejects(h.media.connect(h.relay.grant), { name });
});

test('AIT-348: failed durable pause acknowledgement retains silence', async t => {
  const h = mediaFixture(t, { command: { pause: async () => ({ acknowledged: false, paused: true }) } });
  const session = await h.media.connect(h.relay.grant); t.after(() => session.close());
  await assert.rejects(session.pause(), { code: 'invalid-output' });
  assert.deepEqual(session.audioLevels(), { input: 0, output: 0 });
});

for (const code of ['auth', 'deadline', 'rate-limit']) test(`AIT-348: relay ${code} retains existing lifecycle failure policy`, async t => {
  let recoveries = 0; const events = [], until = Date.now() + 60_000;
  const media = createComposedBrowserMedia({ capture: async () => ({ stop() {} }), player: { stop() {}, play() {} },
    control: { recover() { recoveries++; throw new Error('offline'); } },
    openRelay: async () => ({ command: async () => {}, disconnect() {}, frames: { async *[Symbol.asyncIterator]() {
      await tick(); throw Object.assign(new Error('fixture transport'), { code });
    } } }) });
  const session = await media.connect({ callId: 'call', providerSessionId: 'generation', expiresAt: until, opaque: { epoch: 1 } });
  t.after(() => session.close());
  void (async () => { for await (const event of session.events) events.push(event); })();
  for (let i = 0; i < 12; i++) await tick();
  if (code === 'rate-limit') {
    assert.equal(recoveries, 3); assert.ok(events.some(x => x.type === 'waiting' && x.reason === 'recovery-failed'));
  } else {
    assert.equal(recoveries, 0);
    assert.ok(events.some(x => x.type === 'ended' && x.reason === (code === 'auth' ? 'call-authorization-lost' : 'spend-deadline')));
  }
});

test('AIT-348: output meter samples the playback graph and stops at physical silence', async () => {
  const { createPCMPlayer } = await import('@inspr/aithema-server/composed-voice/browser-audio');
  let sampled = 0, value = 0.3, destination;
  const analyser = { connect() {}, disconnect() {}, getFloatTimeDomainData(data) { sampled++; data.fill(value); } };
  class Context {
    currentTime = 0; state = 'running'; destination = {};
    createAnalyser() { return analyser; }
    createBuffer(_channels, length) { return { getChannelData: () => new Float32Array(length) }; }
    createBufferSource() { return { connect(node) { destination = node; }, disconnect() {}, start() {}, stop() {} }; }
    resume() { return Promise.resolve(); } close() { return Promise.resolve(); }
  }
  const player = createPCMPlayer({ AudioContext: Context });
  const playing = player.play(new Uint8Array(48000), { format: 'pcm_s16le', sampleRateHz: 24000, channels: 1 });
  try {
    assert.equal(destination, analyser); assert.ok(Math.abs(player.audioLevel() - 0.3) < 0.00001);
    value = 0; assert.equal(player.audioLevel(), 0); assert.equal(sampled, 2);
    player.stop(); await playing; assert.equal(player.audioLevel(), 0);
  } finally { await player.close(); }
});

test('AIT-348: input meter derives RMS from captured PCM, expires, and stops with the track', async () => {
  const { createPCMCapture } = await import('@inspr/aithema-server/composed-voice/browser-audio');
  let node, at = 0, trackStopped = false;
  class Worklet { port = {}; constructor() { node = this; } connect() {} disconnect() {} }
  class Context {
    currentTime = 0; audioWorklet = { addModule: async () => {} };
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    resume() { return Promise.resolve(); } close() { return Promise.resolve(); }
  }
  const track = { addEventListener() {}, stop() { trackStopped = true; } };
  const capture = createPCMCapture({ AudioContext: Context, AudioWorkletNode: Worklet, clock: () => at,
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) } });
  const recording = await capture({ onAudio() {} });
  assert.equal(recording.audioLevel(), 0);
  const storage = new Uint8Array([0, 0, 0, 64, 0, 64]), bytes = storage.subarray(2);
  node.port.onmessage({ data: { bytes, captureFrame: 0, contextSampleRate: 16000 } });
  assert.equal(recording.audioLevel(), 0.5);
  at = 151; assert.equal(recording.audioLevel(), 0);
  recording.stop(); assert.equal(recording.audioLevel(), 0); assert.equal(trackStopped, true);
});

test('AIT-348: typed ingress reserves order before delayed authorization and concurrent speech', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let checks = 0;
  const h = fixture(t, { authorize: async () => { if (++checks === 1) { entered.resolve(); await release.promise; } return true; } });
  t.after(() => release.resolve());
  const typed = h.coordinator.sendText('Zuerst getippt', receipt('typed-first'));
  await entered.promise;
  const bytes = Buffer.alloc(3200); for (let i = 0; i < bytes.length; i += 2) bytes.writeInt16LE(8000, i);
  const spoken = h.coordinator.receiveAudio(bytes);
  await tick(); release.resolve(); await Promise.all([typed, spoken]);
  await h.coordinator.receiveAudio(Buffer.alloc(16000)); await h.coordinator.idle();
  assert.deepEqual(h.commits.map(x => x.payload.callbackBody.messages.filter(m => m.role === 'user').at(-1).content), ['Zuerst getippt', 'Gesprochen']);
});
