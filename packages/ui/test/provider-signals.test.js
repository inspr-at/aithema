import { test as nodeTest } from 'node:test';
const test = (name, run) => nodeTest(name, { timeout: 5000 }, run);
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
    assert.equal(rail.controller, null);
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
