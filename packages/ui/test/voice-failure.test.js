import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { createVoiceControl } from '../src/voice-control.js';
import { AudioRail } from '../src/audio-rail.js';
import { createElevenLabsClient } from '../../../plugins/elevenlabs/src/client.js';
import { fakeSdk } from '../../../plugins/elevenlabs/test/fixtures.js';
import { createGrokVoiceClient } from '../../../plugins/grok-voice/src/client.js';
import { voiceEvents } from '../../core/src/live-voice.js';
import { de } from '../src/i18n/de.js';
import { en } from '../src/i18n/en.js';
import { failureCopy } from './fixtures/voice-failure-copy.js';

const checks = [];
const record = (provider, state, assertions, extra = {}) => checks.push(...assertions.map(assert => ({ provider, state, theme: 'light', locale: 'de', width: 1440, assert, stateOnly: true, clock: 'mock', ...extra, pass: true })));
after(async () => {
  if (!process.env.AITHEMA_EVIDENCE_DIR) return;
  await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true });
  await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, 'ait361-state-checks.json'), JSON.stringify({ checks }, null, 2));
});

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const rateLimit = retryAfterMs => Object.assign(new Error('Offline 429'), { status: 429, code: 'limit', retryAfterMs });
function fixture(t, provider, { startError, recoveryError } = {}) {
  const window = new Window(), root = window.document.createElement('div'); window.document.body.append(root);
  const requests = [], streams = [], sdk = fakeSdk(); let capture, failStart = Boolean(startError), failRecovery = Boolean(recoveryError), generation = 0;
  const receipt = request => {
    const providerSessionId = `fixture-${++generation}`, until = Date.now() + 180_000;
    return { callId: request.callId, providerSessionId, epoch: 1,
      spendDeadlineAt: until, browserLivenessDeadlineAt: until,
      credential: { providerSessionId, ttlMs: 60_000, connectionType: 'webrtc', conversationToken: `fixture-token-${providerSessionId}` },
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
  for (const [locale, copy] of [['de', de], ['en', en]]) { rail.copy = copy; rail.render(); const status = rail.root.querySelector('.voice-state');
    assert.ok(!status.textContent.includes(copy.voiceReasonsNarrow.providerLimit)); assert.ok(!status.getAttribute('aria-label').includes(copy.voiceReasonsNarrow.providerLimit));
    assert.ok(!status.querySelector('.consent-narrow')?.dataset.copy.includes(copy.voiceReasonsNarrow.providerLimit));
    checks.push({ provider: rail.client.manifest.id, state: rail.errorKey ?? rail.state, theme: 'light', locale, width: 1440, stateOnly: true, assert: 'no providerLimit in full text, accessible name or narrow copy', pass: true }); }
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
      assert.equal(rail.root.querySelector('.voice-state').getAttribute('aria-label'), rail.copy.voiceCooldown.replace('{s}', Math.min(retryAfterMs, 60_000) / 1000));
      await rail.start(); t.mock.timers.tick(wait - 200); await flush();
      assert.equal(requests.length, 1, 'client.start must not dispatch before 4.8 s / 59.8 s');
      t.mock.timers.tick(199); await flush(); assert.equal(requests.length, 1);
      t.mock.timers.tick(1); await flush();
      assert.equal(rail.root.querySelector('.voice-state').getAttribute('aria-label'), rail.copy.voiceCooldown.replace('{s}', 0));
      t.mock.timers.tick(1);
    }
    await retry; await flush(); assert.equal(requests.length, 2); assert.equal(requests[1][1] - began, wait ? wait + 1 : 0);
    assert.equal(rail.state, 'listening'); noLimit(rail);
    record(provider, 'start429', ['429 leads to F2, no live call, Retry enabled', 'visible cooldown countdown throughout retry-after', 'no request before 4.8 s / 59.8 s; exactly once at deadline', '120 s capped at 60 s; absent retry-after starts immediately', 'no providerLimit in full, accessible or narrow copy (DE/EN)'], { retryAfterMs: retryAfterMs ?? null, waitedMs: wait });
  });
  for (const retryAfterMs of [5000, 120_000, undefined]) test(`AIT-361 ${provider}: recovery 429 retry-after ${retryAfterMs ?? 'absent'}`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100_000 });
    const { rail, requests, recover, allowRecovery } = fixture(t, provider, { recoveryError: rateLimit(retryAfterMs) });
    await rail.start(); recover(); await flush();
    assert.equal(rail.state, 'waiting'); assert.equal(rail.paused, true); noLimit(rail);
    const previous = requests.length, began = Date.now(), wait = Math.min(retryAfterMs ?? 0, 60_000);
    allowRecovery(); const continuing = rail.pause(false); await flush();
    if (wait) {
      assert.equal(rail.root.dataset.state, 'connecting'); assert.equal(rail.root.querySelector('.voice-state').getAttribute('aria-label'), rail.copy.voiceCooldown.replace('{s}', Math.min(retryAfterMs, 60_000) / 1000));
      t.mock.timers.tick(wait - 200); await flush(); assert.equal(requests.length, previous);
      t.mock.timers.tick(200); await flush();
      assert.equal(rail.root.querySelector('.voice-state').getAttribute('aria-label'), rail.copy.voiceCooldown.replace('{s}', 0));
      t.mock.timers.tick(1);
    }
    await continuing; await flush();
    assert.equal(requests.length, previous + 1, 'one explicit recovery request after the wait');
    assert.equal(requests.at(-1)[1] - began, wait ? wait + 1 : 0); assert.equal(rail.state, 'listening'); noLimit(rail);
    record(provider, 'recovery429', ['recovery 429 leads to F4 waiting', 'Continue shows visible cooldown countdown while waiting', 'Continue waits retry-after, capped at 60 s, then one recovery request', 'absent retry-after continues immediately', 'no providerLimit in full, accessible or narrow copy (DE/EN)'], { retryAfterMs: retryAfterMs ?? null, waitedMs: wait });
  });
  test(`AIT-361 ${provider}: recovery 429 cannot become an admission refusal without retry-after`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100_000 });
    const error = Object.assign(rateLimit(), { code: 'not-admitted', reason: 'host-limit' });
    const { rail, recover, allowRecovery } = fixture(t, provider, { recoveryError: error });
    await rail.start(); recover(); await flush();
    assert.equal(rail.state, 'waiting'); assert.equal(rail.paused, true); noLimit(rail);
    allowRecovery(); await rail.pause(false); assert.equal(rail.state, 'listening');
    record(provider, 'recovery429-admission-code', ['any recovery 429 reaches F4, even with a misleading admission code and no retry-after']);
  });
  test(`AIT-361 ${provider}: ownership loss fences Continue during retry-after`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100_000 });
    const { rail, recover, allowRecovery, requests } = fixture(t, provider, { recoveryError: rateLimit(5000) });
    await rail.start(); recover(); await flush(); allowRecovery();
    const before = requests.length, continuing = rail.pause(false); await flush();
    rail.receiveState({ callId: rail.session.callId, providerSessionId: rail.session.providerSessionId,
      epoch: 2, controllingTabId: 'other-tab', state: 'active' });
    assert.equal(rail.root.dataset.state, 'waiting');
    t.mock.timers.tick(5000); await continuing; await flush();
    assert.equal(requests.length, before); assert.equal(rail.root.dataset.state, 'waiting');
    record(provider, 'retry-after-ownership-loss', ['ownership loss during wait keeps Waiting and fences the delayed continuation']);
  });
  test(`AIT-361 ${provider}: a deadline ending the call clears the retry wait`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100_000 });
    const { rail, recover, allowRecovery, requests } = fixture(t, provider, { recoveryError: rateLimit(5000) });
    await rail.start(); recover(); await flush(); allowRecovery();
    const before = requests.length, session = rail.session, continuing = rail.pause(false); await flush();
    await session.close({ reason: 'browser-liveness-deadline' }); await flush();
    assert.equal(rail.session, null); assert.equal(rail.root.dataset.state, 'failed');
    assert.equal(rail.errorKey, 'voiceDeadline'); assert.equal(rail.button('retry').disabled, false);
    t.mock.timers.tick(5000); await continuing; await flush(); assert.equal(requests.length, before);
    record(provider, 'retry-after-deadline', ['a terminal deadline during wait restores F2 Retry and fences the delayed continuation']);
  });
  test(`AIT-361 ${provider}: retry-after is an absolute advertised deadline`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100_000 });
    const { rail, requests } = fixture(t, provider, { startError: rateLimit(5000) });
    await rail.start(); t.mock.timers.tick(2000);
    const retry = rail.start(); await flush(); t.mock.timers.tick(2999); await flush();
    assert.equal(requests.length, 1); t.mock.timers.tick(1); await flush();
    assert.equal(requests.length, 1, 'zero paints at the advertised deadline before dispatch');
    t.mock.timers.tick(1); await retry;
    assert.equal(requests.length, 2); assert.equal(requests[1][1], 105_001);
    record(provider, 'retry-after-elapsed', ['time before Retry counts towards retry-after; one request at advertised deadline']);
  });
  test(`AIT-361 ${provider}: ending a pending retry cancels its eventual start`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100_000 });
    const { rail, requests } = fixture(t, provider, { startError: rateLimit(5000) });
    await rail.start(); const retry = rail.start(); await flush();
    await rail.close(); t.mock.timers.tick(5000); await retry; await flush();
    assert.equal(requests.length, 1); assert.equal(rail.state, 'idle');
    record(provider, 'cancelled-retry', ['End during wait fences the delayed start']);
  });
  test(`AIT-361 ${provider}: F1/F2 remain failures, including misleading 429 admission codes`, async t => {
    const { rail } = fixture(t, provider);
    for (const [error, key] of [[{ name: 'NotAllowedError' }, 'voiceMicDenied'], [{ name: 'NotFoundError' }, 'voiceMicMissing'],
      [{}, 'voiceConnectionFailed'], [{ code: 'deadline' }, 'voiceDeadline'], [{ code: 'voice-conflict' }, 'voiceConflict'],
      [{ status: 429, code: 'not-admitted', reason: 'host-limit' }, 'voiceConnectionFailed']]) {
      rail.state = 'failed'; rail.failure(error); assert.equal(rail.errorKey, key); assert.equal(rail.button('pause').disabled, true);
      assert.equal(rail.button('pause').getAttribute('aria-pressed'), 'false'); noLimit(rail);
      record(provider, key, ['F1/F2 error mapping and disabled Pause; unchanged pause glyph', '429 overrides admission/provider-limit reason']);
    }
  });
}
// Expose only binding-base keys during rendering and check every string read
// against its original text. Enumeration uses that same scoped key set, so a
// different feature can add locale entries without extending this contract.
function existingFailureCopy(actual, expected, path) {
  return new Proxy(expected, {
    get(target, key) {
      assert.ok(Object.hasOwn(target, key), `${path}.${String(key)} must be an existing binding-base copy key`);
      const name = `${path}.${String(key)}`;
      if (typeof target[key] === 'object') return existingFailureCopy(actual?.[key], target[key], name);
      assert.equal(actual?.[key], target[key], `${name} must retain its exact pre-AIT-361 text`);
      return actual[key];
    },
  });
}

test('AIT-361: failure rendering reads only existing, unchanged DE and EN copy', async t => {
  for (const [locale, copy] of [['de', de], ['en', en]]) {
    const expected = failureCopy[locale];
    for (const provider of ['elevenlabs', 'grok-voice']) {
      const { rail } = fixture(t, provider);
      rail.copy = existingFailureCopy(copy, expected, locale);
      for (const errorKey of ['voiceMicDenied', 'voiceMicMissing', 'voiceConnectionFailed', 'voiceDeadline', 'voiceConflict', 'voiceRecoveryFailed', 'voicePlaybackBlocked']) {
        rail.state = errorKey === 'voicePlaybackBlocked' ? 'listening' : 'failed';
        rail.session = errorKey === 'voicePlaybackBlocked' ? { callId: 'offline-copy-fixture' } : null;
        rail.errorKey = errorKey; rail.render();
        const status = rail.root.querySelector('.voice-state');
        assert.equal(status.getAttribute('aria-label'), expected[errorKey]);
        assert.equal(status.querySelector('.consent-wide').textContent, expected[errorKey]);
        assert.equal(status.querySelector('.consent-narrow').dataset.copy, expected.voiceMessagesNarrow[errorKey]);
      }
      rail.errorKey = null;
      for (const state of ['recovering', 'waiting', 'connecting']) {
        rail.state = state; rail.paused = state === 'waiting'; rail.render();
        const status = rail.root.querySelector('.voice-state');
        assert.equal(status.getAttribute('aria-label'), expected.voiceStates[state]);
        assert.equal(status.querySelector('.consent-wide').textContent, expected.voiceStates[state]);
        assert.equal(status.querySelector('.consent-narrow').dataset.copy, expected.voiceStatesNarrow[state]);
      }
      // This fixture has no live provider call to close during cleanup.
      rail.session = null;
      checks.push({ provider, state: 'copy', theme: 'light', locale, width: 1440,
        assert: 'failure rendering reads only existing keys with exact text from 5d015ba6', diff: 0, pass: true });
    }
  }
});

for (const seconds of [5, 120, null]) test(`AIT-361: control preserves HTTP 429 retry-after ${seconds}`, async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'limit' }, {
    status: 429, headers: seconds === null ? {} : { 'retry-after': String(seconds) },
  }));
  const { control } = createVoiceControl({ sessionId: 'offline-fixture' });
  for (const action of ['start', 'recover']) await assert.rejects(control[action]({ callId: 'offline-call' }), error => {
    assert.equal(error.status, 429); assert.equal(error.retryAfterMs, seconds === null ? undefined : seconds * 1000); return true;
  });
  for (const provider of ['elevenlabs', 'grok-voice']) record(provider, 'http429', ['HTTP start/recovery 429 preserves retry-after without providerLimit mapping'], { retryAfterMs: seconds === null ? null : seconds * 1000 });
});
