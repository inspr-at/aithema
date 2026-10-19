import { test as nodeTest, after } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const checks = [];
const test = (name, run) => nodeTest(name, { timeout: 5000 }, async t => { await run(t); checks.push({ provider: name.includes('elevenlabs') ? 'elevenlabs' : name.includes('grok-voice') ? 'grok-voice' : 'shared', assert: name, clock: 'controlled', pass: true }); });
after(async () => {
  if (!process.env.AITHEMA_EVIDENCE_DIR) return;
  await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true });
  await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, 'ait383-state-checks.json'), JSON.stringify({ checks }, null, 2));
});
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { AudioRail } from '../src/audio-rail.js';
import { de } from '../src/i18n/de.js';
import { currentVoiceClient } from './fixtures/current-voice-clients.js';
import { validateManifest } from '../../core/src/plugins.js';
import { createPCMCapture } from '../../server/src/composed/browser-audio.js';
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
const advance = async (t, ms) => { while (ms > 0) { const n = Math.min(ms, 1000); t.mock.timers.tick(n); await flush(); ms -= n; } };
function setup(t, provider, options = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100_000 });
  const current = currentVoiceClient(provider, { ...options, enabled: true }), window = new Window(), root = window.document.createElement('div');
  window.document.body.append(root);
  const rail = new AudioRail({ root, client: current.client, copy: de, context: () => ({}), feature: () => ({ available: true }) });
  t.after(async () => { options.permission?.then?.(() => {}, () => {}); await rail.close(); rail.destroy(); current.end(); await window.happyDOM.abort(); });
  return { rail, current };
}
for (const provider of ['elevenlabs', 'grok-voice']) {
  test(`AIT-383 ${provider}: declarations pass strict schema; invalid optional values fail`, () => {
    const { client } = currentVoiceClient(provider, { enabled: true });
    assert.equal(client.manifest.liveVoice.capabilities.onMicrophoneState, 'native');
    assert.equal(client.manifest.liveVoice.capabilities.replyStarted, 'native');
    assert.equal(client.manifest.liveVoice.capabilities.opener, provider === 'elevenlabs');
    assert.equal(validateManifest(client.manifest).ok, true);
    for (const [key, value] of [['onMicrophoneState', true], ['replyStarted', true], ['opener', 'true']]) {
      const invalid = structuredClone(client.manifest); invalid.liveVoice.capabilities[key] = value;
      assert.equal(validateManifest(invalid).ok, false);
    }
  });
  test(`AIT-383 ${provider}: real client prompt survives 60 s; grant starts a fresh 30 s`, async t => {
    const permission = Promise.withResolvers(), connection = Promise.withResolvers();
    const { rail, current } = setup(t, provider, { permission: permission.promise, connection: connection.promise });
    t.after(() => { permission.resolve(); connection.resolve(); });
    const start = rail.start(); await flush();
    assert.equal(current.options[0].deadlineAt, undefined);
    assert.equal(rail.startupPhase, 'microphone');
    await advance(t, 60_000); assert.equal(rail.errorKey, null); assert.equal(rail.controller.signal.aborted, false);
    permission.resolve(); await flush(); assert.equal(rail.startupPhase, null);
    await advance(t, 29_999); assert.equal(rail.state, 'connecting');
    await advance(t, 1); await start; assert.equal(rail.errorKey, 'voiceDeadline');
    assert.equal(rail.controller.signal.aborted, true);
  });
  test(`AIT-383 ${provider}: grant at 20 s fails at 50 s`, async t => {
    const permission = Promise.withResolvers(), connection = Promise.withResolvers();
    const { rail } = setup(t, provider, { permission: permission.promise, connection: connection.promise });
    t.after(() => { permission.resolve(); connection.resolve(); });
    const start = rail.start(); await flush(); await advance(t, 20_000); permission.resolve(); await flush();
    await advance(t, 29_999); assert.equal(rail.state, 'connecting');
    await advance(t, 1); await start; assert.equal(Date.now(), 150_000); assert.equal(rail.errorKey, 'voiceDeadline');
  });
  test(`AIT-383 ${provider}: S5 excludes mode and holding audio, late reply clears it; recovery stays silent`, async t => {
    const { rail, current } = setup(t, provider);
    await rail.start();
    if (provider === 'grok-voice') { assert.equal(rail.replyTimer, null); await advance(t, 16_000); assert.equal(rail.errorKey, null); }
    await rail.sendText('Eine Frage.'); assert.ok(rail.replyTimer);
    current.speaking(rail.session.callId); await flush();
    if (provider === 'elevenlabs') current.audio('Einen Moment, bitte.');
    else current.event({ type: 'speaking', audio: true, filler: true });
    await flush(); await advance(t, 15_000); assert.equal(rail.errorKey, 'voiceNoReply');
    current.audio(); await flush(); assert.equal(rail.errorKey, null); assert.equal(rail.state, 'speaking');
    await rail.sendText('Noch eine Frage.'); current.recover(); await flush();
    assert.equal(rail.replyTimer, null); await advance(t, 16_000); assert.equal(rail.errorKey, null);
  });
}
for (const name of ['AbortError', 'OverconstrainedError', 'NotReadableError', 'Error']) test(`AIT-383 physical PCM acquisition attributes ${name}`, async () => {
  const phases = [], error = Object.assign(new Error('device failed'), { name });
  await assert.rejects(createPCMCapture({ mediaDevices: { async getUserMedia() { throw error; } } })({ onAudio() {}, onMicrophoneState: p => phases.push(p) }), e => e === error && e.phase === 'microphone');
  assert.deepEqual(phases, ['requesting']);
});
test('AIT-383 non-microphone AbortError retains admission/deadline/connection copy', async t => {
  const { rail } = setup(t, 'grok-voice');
  for (const [code, key] of [['not-admitted', 'voiceAdmissionDenied'], ['deadline', 'voiceDeadline'], [undefined, 'voiceConnectionFailed']]) {
    rail.failure(Object.assign(new Error('request aborted'), { name: 'AbortError', code })); assert.equal(rail.errorKey, key);
  }
});
for (const provider of ['elevenlabs', 'grok-voice']) {
  test(`AIT-383 ${provider}: real credential preparation has its own 30 s guard`, async t => {
    const credential = Promise.withResolvers(), { rail, current } = setup(t, provider, { credential: credential.promise });
    t.after(() => credential.resolve());
    const start = rail.start(); await flush(); assert.equal(rail.startupPhase, null); assert.equal(current.acquired, 0);
    await advance(t, 30_000); await start; assert.equal(rail.errorKey, 'voiceDeadline'); assert.equal(current.acquired, 0);
  });
  for (const name of ['NotReadableError', 'OverconstrainedError', 'AbortError', 'Error']) test(`AIT-383 ${provider}: real ${name} remains attributed to microphone acquisition`, async t => {
    const { rail } = setup(t, provider, { microphoneError: Object.assign(new Error('device failed'), { name }) });
    await rail.start(); assert.equal(rail.errorKey, name === 'NotReadableError' ? 'voiceMicBusy' : 'voiceMicFailed');
  });
  test(`AIT-383 ${provider}: user-final arms S5; long reply and visitor silence never re-arm it`, async t => {
    const { rail, current } = setup(t, provider); await rail.start();
    current.event({ type: 'final', turnId: 'user-1', role: 'user', text: 'Frage' }); await flush(); assert.ok(rail.replyTimer);
    await advance(t, 15_000); assert.equal(rail.errorKey, 'voiceNoReply');
    current.audio(); await flush(); assert.equal(rail.errorKey, null); assert.equal(rail.replyTimer, null);
    await advance(t, 16_000); assert.equal(rail.errorKey, null);
    current.event({ type: 'listening' }); await flush(); await advance(t, 16_000); assert.equal(rail.errorKey, null);
  });
}
test('AIT-383 physical PCM no API and already-granted acquisition preserve provenance', async () => {
  const phases = [];
  await assert.rejects(createPCMCapture({ mediaDevices: {} })({ onAudio() {}, onMicrophoneState: p => phases.push(p) }), { name: 'NoMediaAPIError', phase: 'microphone' });
  assert.deepEqual(phases, []);
  const failure = new DOMException('busy', 'NotReadableError');
  await assert.rejects(createPCMCapture({ permissions: { async query() { return { state: 'granted' }; } }, mediaDevices: { async getUserMedia() { throw failure; } } })({ onAudio() {}, onMicrophoneState: p => phases.push(p) }), { name: 'NotReadableError', phase: 'microphone' });
  assert.deepEqual(phases, [], 'already-granted permission never reports an open prompt');
});

// Gate 1 regressions use the server's actual 30 s browser lease. The spend
// budget is independent and remains long enough for the visitor's decision.
for (const heldMs of [45_000, 60_000]) test(`AIT-383 elevenlabs: ${heldMs / 1000} s prompt renews a 30 s server lease and connects`, async t => {
  const permission = Promise.withResolvers();
  const { rail, current } = setup(t, 'elevenlabs', { permission: permission.promise });
  t.after(() => permission.resolve());
  const start = rail.start(); await flush();
  await advance(t, heldMs);
  assert.equal(current.leaseExpired, false, 'server must not close the call during S1');
  assert.ok(current.leases.length >= 4, 'startup renews the lease every 10 s');
  permission.resolve(); await start; await flush();
  assert.equal(rail.state, 'listening'); assert.equal(rail.paused, false);
  assert.equal(rail.session.lifecycle.state.browserLivenessDeadlineAt, current.leaseDeadlineAt, 'connected uses the latest renewal');
  await advance(t, 16_000); assert.equal(current.leaseExpired, false);
});
test('AIT-383 elevenlabs: credential guard pauses for the prompt but remains bounded after grant without a rail timer', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100_000 });
  const permission = Promise.withResolvers(), connection = Promise.withResolvers(), phases = [];
  const current = currentVoiceClient('elevenlabs', { enabled: true, permission: permission.promise, connection: connection.promise, credentialTtlMs: 20_000 });
  const started = current.client.start({ callId: 'bounded-credential' }, { onMicrophoneState: p => phases.push(p) }).then(session => ({ session }), error => ({ error }));
  let result; void started.then(value => { result = value; });
  t.after(async () => { permission.resolve(); connection.resolve(); await flush(); await result?.session?.close(); current.end(); });
  await flush(); assert.deepEqual(phases, ['requesting']);
  await advance(t, 60_000); assert.equal(result, undefined, 'permission wait does not consume credential budget');
  permission.resolve(); await flush(); assert.deepEqual(phases, ['requesting', 'granted']);
  await advance(t, 19_999); assert.equal(result, undefined);
  await advance(t, 1); assert.equal(result?.error?.code, 'deadline', 'SDK credential phase is still bounded without the rail');
});
test('AIT-383 elevenlabs: unqualified chunks do not queue activity round trips ahead of finals', async t => {
  const { rail, current } = setup(t, 'elevenlabs'); await rail.start();
  current.speaking(rail.session.callId); await flush();
  for (let i = 0; i < 50; i++) current.audio('', { mode: false });
  current.event({ type: 'final', role: 'user', text: 'Frage', event_id: 21 });
  await flush();
  assert.equal(current.activities.filter(e => e.type === 'speaking').length, 1, 'one activity report per transition, never per chunk');
  assert.ok(rail.replyTimer, 'user final reaches the rail without chunk round trips');
});
test('AIT-383 elevenlabs: late filler cannot restart playback after listening', async t => {
  const { rail, current } = setup(t, 'elevenlabs'); await rail.start();
  current.audio('Einen Moment, bitte.'); await flush();
  current.event({ type: 'listening' }); await flush();
  current.audio('', { mode: false }); await flush();
  assert.equal(rail.state, 'listening');
  assert.equal(rail.session.lifecycle.state.checkpoint.playbackPending, false);
  assert.deepEqual(current.activities.map(e => e.type), ['speaking', 'listening']);
});
for (const enabled of [false, true]) test(`AIT-383 ${enabled ? 'declared prompt' : 'undeclared client'}: bare DOMException AbortError keeps microphone copy`, async t => {
  const { rail } = setup(t, 'elevenlabs');
  const failure = new DOMException('microphone acquisition aborted', 'AbortError');
  rail.client = { manifest: { liveVoice: { capabilities: enabled ? { onMicrophoneState: 'native' } : {} } },
    async start(_request, opts) { if (enabled) opts.onMicrophoneState('requesting'); throw failure; } };
  await rail.start(); assert.equal(rail.errorKey, 'voiceMicFailed');
});
for (const turn of ['user-final', 'typed']) test(`AIT-383 grok-voice: queued previous reply cannot clear S5 after ${turn}`, async t => {
  const { rail, current } = setup(t, 'grok-voice', { deferPlayback: true }); await rail.start();
  current.audio('Old reply', { replyId: 'reply-A' }); await flush();
  const previous = current.playback.at(-1); assert.equal(previous.replyId, 'reply-A');
  if (turn === 'typed') await rail.sendText('New question');
  else { current.event({ type: 'final', role: 'user', turnId: 'user-B', text: 'New question' }); await flush(); }
  assert.ok(rail.replyTimer);
  previous.onStarted(); await flush(); assert.ok(rail.replyTimer, 'queued old device start cannot satisfy the new turn');
  current.audio('Late old frame', { replyId: 'reply-A' }); await flush();
  assert.equal(current.playback.length, 1, 'late frame from retired reply is ignored');
  await advance(t, 15_000); assert.equal(rail.errorKey, 'voiceNoReply');
  current.audio('New reply', { replyId: 'reply-B' }); await flush();
  current.playback.at(-1).onStarted(); await flush(); assert.equal(rail.errorKey, null);
  assert.equal(rail.state, 'speaking');
  current.playback.forEach(p => p.finish());
});
test('AIT-383 grok-voice: physical reply start carries the frame reply id', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100_000 });
  const current = currentVoiceClient('grok-voice', { enabled: true });
  const session = await current.client.start({ callId: 'reply-identity' });
  t.after(async () => { await session.close(); current.end(); });
  current.audio('Reply', { replyId: 'reply-identity-B' });
  const { value } = await session.events[Symbol.asyncIterator]().next();
  assert.equal(value.audio, true); assert.equal(value.replyId, 'reply-identity-B');
});
