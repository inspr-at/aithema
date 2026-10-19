import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Window } from 'happy-dom';
import { AudioRail } from '../src/audio-rail.js';
import { createElevenLabsClient } from '../../../plugins/elevenlabs/src/client.js';
import { fakeSdk } from '../../../plugins/elevenlabs/test/fixtures.js';
import { createGrokVoiceClient } from '../../../plugins/grok-voice/src/client.js';
import { voiceEvents } from '../../core/src/live-voice.js';
import { de } from '../src/i18n/de.js';
import { en } from '../src/i18n/en.js';

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const rateLimit = retryAfterMs => Object.assign(new Error('Offline 429'), { status: 429, code: 'limit', retryAfterMs });
function fixture(t, provider, { startError, recoveryError } = {}) {
  const window = new Window(), root = window.document.createElement('div'); window.document.body.append(root);
  const requests = [], streams = [], sdk = fakeSdk(); let capture, failStart = Boolean(startError), failRecovery = Boolean(recoveryError), generation = 0;
  const receipt = request => {
    const providerSessionId = `fixture-${++generation}`, until = Date.now() + 180_000;
    return { callId: request.callId, providerSessionId, epoch: 1,
      spendDeadlineAt: until, browserLivenessDeadlineAt: until,
      credential: { providerSessionId, ttlMs: 180_000, connectionType: 'webrtc', conversationToken: `fixture-token-${providerSessionId}` },
      mediaGrant: { callId: request.callId, providerSessionId, expiresAt: until,
        opaque: { epoch: 1, spendDeadlineAt: until, browserLivenessDeadlineAt: until } } };
  };
  const control = {
    async start(request) { requests.push(['start', Date.now()]); if (failStart) { failStart = false; throw startError; } return receipt(request); },
    async recover(request) { requests.push(['recover', Date.now()]); if (failRecovery) throw recoveryError; return receipt(request); },
    async close() { return { closureConfirmed: true }; },
    async pause() { return { acknowledged: true, paused: true }; }, async resume() { return { acknowledged: true, paused: false }; },
    async heartbeat() { return { acknowledged: true, browserLivenessDeadlineAt: Date.now() + 180_000 }; },
  };
  const client = provider === 'elevenlabs' ? createElevenLabsClient({ control, sdk, mediaDevices: sdk.mediaDevices,
    AudioContext: sdk.AudioContext, persistEvent: async () => {} }) : createGrokVoiceClient({ control,
    async openRelay() { const frames = voiceEvents(); streams.push(frames); return { frames, async disconnect() { frames.end(); }, async sendAudio() {}, async command() { return { acknowledged: true }; } }; },
    capture: async options => { capture = options; return { stop() {} }; }, player: { play() {}, stop() {} } });
  const rail = new AudioRail({ root, client, copy: de, feature: () => ({ available: true }), context: () => ({}) });
  t.after(async () => { await rail.close(); rail.destroy(); for (const stream of streams) stream.end(); root.remove(); await window.happyDOM.close(); });
  return { rail, root, requests, recover: () => provider === 'elevenlabs' ? sdk.starts.at(-1).onDisconnect({ reason: 'error' }) : capture.onError(),
    allowRecovery: () => { failRecovery = false; } };
}
function noLimit(rail) {
  for (const copy of [de, en]) { rail.copy = copy; rail.render(); const status = rail.root.querySelector('.voice-state');
    assert.ok(!status.textContent.includes(copy.voiceReasonsNarrow.providerLimit)); assert.ok(!status.getAttribute('aria-label').includes(copy.voiceReasonsNarrow.providerLimit));
    assert.ok(!status.querySelector('.consent-narrow')?.dataset.copy.includes(copy.voiceReasonsNarrow.providerLimit)); }
}
for (const provider of ['elevenlabs', 'grok-voice']) {
  for (const retryAfterMs of [5000, 120_000, undefined]) test(`AIT-361 ${provider}: start 429 retry-after ${retryAfterMs ?? 'absent'}`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100_000 });
    const { rail, requests } = fixture(t, provider, { startError: rateLimit(retryAfterMs) });
    await rail.start(); assert.equal(rail.state, 'failed'); assert.equal(rail.session, null);
    assert.equal(rail.errorKey, 'voiceConnectionFailed'); assert.equal(rail.button('retry').disabled, false); noLimit(rail);
    const began = Date.now(), wait = Math.min(retryAfterMs ?? 0, 60_000), retry = rail.start(); await flush();
    if (wait) {
      assert.equal(rail.root.dataset.state, 'connecting'); assert.equal(rail.errorKey, null);
      assert.equal(rail.root.querySelector('.voice-state').getAttribute('aria-label'), rail.copy.voiceStates.connecting);
      await rail.start(); t.mock.timers.tick(wait - 200); await flush();
      assert.equal(requests.length, 1, 'client.start must not dispatch before 4.8 s / 59.8 s');
      t.mock.timers.tick(199); await flush(); assert.equal(requests.length, 1);
      t.mock.timers.tick(1);
    }
    await retry; await flush(); assert.equal(requests.length, 2); assert.equal(requests[1][1] - began, wait);
    assert.equal(rail.state, 'listening'); noLimit(rail);
  });
  for (const retryAfterMs of [5000, 120_000, undefined]) test(`AIT-361 ${provider}: recovery 429 retry-after ${retryAfterMs ?? 'absent'}`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100_000 });
    const { rail, requests, recover, allowRecovery } = fixture(t, provider, { recoveryError: rateLimit(retryAfterMs) });
    await rail.start(); recover(); await flush();
    assert.equal(rail.state, 'waiting'); assert.equal(rail.paused, true); noLimit(rail);
    const previous = requests.length, began = Date.now(), wait = Math.min(retryAfterMs ?? 0, 60_000);
    allowRecovery(); const continuing = rail.pause(false); await flush();
    if (wait) {
      assert.equal(rail.root.dataset.state, 'connecting'); assert.equal(rail.root.querySelector('.voice-state').getAttribute('aria-label'), rail.copy.voiceStates.connecting);
      t.mock.timers.tick(wait - 200); await flush(); assert.equal(requests.length, previous);
      t.mock.timers.tick(200);
    }
    await continuing; await flush();
    assert.equal(requests.length, previous + 1, 'one explicit recovery request after the wait');
    assert.equal(requests.at(-1)[1] - began, wait); assert.equal(rail.state, 'listening'); noLimit(rail);
  });
  test(`AIT-361 ${provider}: F1/F2 remain failures, including misleading 429 admission codes`, async t => {
    const { rail } = fixture(t, provider);
    for (const [error, key] of [[{ name: 'NotAllowedError' }, 'voiceMicDenied'], [{ name: 'NotFoundError' }, 'voiceMicMissing'],
      [{}, 'voiceConnectionFailed'], [{ code: 'deadline' }, 'voiceDeadline'], [{ code: 'voice-conflict' }, 'voiceConflict'],
      [{ status: 429, code: 'not-admitted', reason: 'host-limit' }, 'voiceConnectionFailed']]) {
      rail.state = 'failed'; rail.failure(error); assert.equal(rail.errorKey, key); assert.equal(rail.button('pause').disabled, true);
      assert.equal(rail.button('pause').getAttribute('aria-pressed'), 'false'); noLimit(rail);
    }
  });
}
test('AIT-361: DE and EN copy files remain byte-identical to the binding base', async () => {
  for (const [locale, digest] of [['de', 'de1b89bba7bed88d2f13e7cd2500190f85e756772276c37cb5c42c2559fb95a3'], ['en', '3b4378f1f70073a79dfc6e2694e0e29af6e061a8da75dbc87d1a4ac46d82b195']]) {
    const path = `packages/ui/src/i18n/${locale}.js`;
    assert.equal(createHash('sha256').update(await readFile(new URL(`../../../${path}`, import.meta.url))).digest('hex'), digest);
  }
});
