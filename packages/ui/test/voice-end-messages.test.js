import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { AudioRail } from '../src/audio-rail.js';
import { voiceEvents, assertVoiceMediaGrant } from '../../core/src/live-voice.js';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
function fixture(t, { copy = en, start } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100_000 });
  const window = new Window(), root = window.document.createElement('div'), events = voiceEvents(), requests = [];
  window.document.body.append(root);
  const session = { callId: 'call', providerSessionId: 'segment', events,
    async setInput() {}, async setOutput() {}, async updateContext() {},
    async close() { return { closureConfirmed: true, usage: { costEstimated: false } }; } };
  const rail = new AudioRail({ root, copy, feature: () => ({ available: true }), context: () => ({}),
    client: { manifest: { liveVoice: { capabilities: { onMicrophoneState: 'native' } } }, async start(request, options) {
      requests.push(options); return start ? start(options) : session;
    } } });
  t.after(async () => { await rail.close(); events.end(); rail.destroy(); await window.happyDOM.abort(); });
  return { rail, root, requests, session, events };
}
const label = rail => rail.root.querySelector('.voice-state').getAttribute('aria-label');

test('AIT-502: fresh full-credit call never claims a time limit', async t => {
  const { rail } = fixture(t); await rail.start();
  assert.equal(rail.state, 'listening'); assert.equal(rail.errorKey, null);
  assert.equal(label(rail), en.voiceStates.listening);
});
test('AIT-502: connect timer is tagged, never automatically retries, and a following 409 stays a conflict', async t => {
  let attempt = 0;
  const { rail, requests } = fixture(t, { start() { if (++attempt === 1) return new Promise(() => {}); throw { status: 409, code: 'voice-conflict' }; } });
  const pending = rail.start(); await flush(); t.mock.timers.tick(30_000); await pending;
  assert.equal(rail.errorKey, 'voiceConnectionFailed'); assert.equal(requests[0].signal.reason.source, 'connect-timer');
  assert.equal(requests.length, 1); assert.equal(rail.button('retry').disabled, false);
  await rail.start(); assert.equal(requests.length, 2); assert.equal(rail.errorKey, 'voiceConflict');
});
test('AIT-502: server start 504 deadline takes the legacy limit path without retry', async t => {
  const { rail, requests } = fixture(t, { start() { throw { code: 'deadline', status: 504 }; } });
  await rail.start(); assert.equal(rail.errorKey, 'voiceDeadline'); assert.equal(requests.length, 1);
  assert.equal(label(rail), en.voiceDeadline);
});
test('AIT-502: media grant expiry during microphone permission is a connection failure', async t => {
  const permission = Promise.withResolvers();
  const { rail } = fixture(t, { async start(options) {
    options.onMicrophoneState('requesting'); await permission.promise;
    assertVoiceMediaGrant({ callId: 'call', providerSessionId: 'segment', expiresAt: 110_000, opaque: {} });
  } });
  const pending = rail.start(); await flush(); t.mock.timers.tick(20_000); permission.resolve(); await pending;
  assert.equal(rail.errorKey, 'voiceConnectionFailed'); assert.equal(rail.button('retry').disabled, false);
});
for (const [reason, timeLimit, expected] of [
  ['spend-deadline', 'call', 'voiceTimeLimit'], ['spend-deadline', 'conversation', null],
  ['one-hour', undefined, null], ['browser-liveness-deadline', undefined, 'voiceConnectionFailed'],
  ['transport-lost', undefined, 'voiceConnectionFailed'], ['recovery-failed', undefined, 'voiceRecoveryFailed'],
  ['budget-limit', undefined, 'voiceAdmissionDenied'], ['spend-deadline', undefined, 'voiceDeadline'],
]) for (const via of ['ended', 'close']) test(`AIT-502: ${via} ${reason}/${timeLimit ?? 'unknown'} is honest with correct buttons`, async t => {
  const { rail, events } = fixture(t); await rail.start();
  if (via === 'close') await rail.close(reason, { timeLimit });
  else { events.push({ type: 'ended', callId: 'call', reason, timeLimit }); await flush(); }
  if (timeLimit === 'conversation' || reason === 'one-hour') {
    assert.equal(label(rail), en.voiceStates.timeExpired);
    assert.equal(rail.button('start').disabled, true); assert.equal(rail.button('retry').disabled, true);
  } else {
    assert.equal(rail.errorKey, expected); assert.equal(rail.button('retry').disabled, false);
    if (reason === 'budget-limit') assert.equal(label(rail), en.voiceCreditStatus.session);
    if (expected === 'voiceTimeLimit') assert.equal(label(rail), en.voiceTimeLimit);
  }
});
for (const copy of [en, de]) test(`AIT-502: ${copy === en ? 'EN' : 'DE'} approved copy and narrow labels`, t => {
  const { rail } = fixture(t, { copy });
  assert.equal(copy.voiceConnectionFailed, copy === en ? "The call couldn't connect. Select Retry call, or continue typing." : 'Der Anruf konnte nicht aufgebaut werden. Wählen Sie „Erneut anrufen“ oder schreiben Sie weiter.');
  assert.equal(copy.voiceTimeLimit, copy === en ? 'The call reached its maximum length. Start a new call or continue typing.' : 'Der Anruf hat seine maximale Dauer erreicht. Starten Sie einen neuen Anruf oder schreiben Sie weiter.');
  for (const [key, narrow] of [['voiceConnectionFailed', copy === en ? "Couldn't connect" : 'Keine Verbindung'], ['voiceTimeLimit', copy === en ? 'Time limit reached' : 'Zeitlimit erreicht']]) {
    rail.state = 'failed'; rail.errorKey = key; rail.render();
    assert.equal(label(rail), copy[key]); assert.equal(rail.root.querySelector('.consent-narrow').dataset.copy, narrow);
  }
});
test('AIT-502: custom bundle without new keys keeps a visible legacy message', async t => {
  const copy = structuredClone(en); delete copy.voiceTimeLimit; delete copy.voiceMessageClose; delete copy.voiceMessagesNarrow.voiceTimeLimit;
  copy.voiceDeadline = 'Host limit message';
  const { rail } = fixture(t, { copy }); await rail.start(); await rail.close('spend-deadline', { timeLimit: 'call' });
  assert.equal(label(rail), 'Host limit message'); assert.equal(rail.root.hasAttribute('data-message'), true);
});
for (const action of ['retry', 'close', 'dismiss', 'escape']) test(`AIT-502: ${action} clears a failed message`, async t => {
  const { rail, root } = fixture(t); rail.state = 'failed'; rail.failure({ source: 'connect-timer', code: 'deadline' });
  const dismiss = root.querySelector('.voice-message-close');
  assert.ok(dismiss); assert.equal(dismiss.parentElement, root.querySelector('.voice-state').parentElement);
  assert.equal(root.querySelector('.voice-state').contains(dismiss), false);
  assert.equal(dismiss.getAttribute('aria-label'), 'Close message'); assert.equal(dismiss.hidden, false);
  if (action === 'retry') await rail.start();
  else if (action === 'close') await rail.close();
  else if (action === 'dismiss') dismiss.click();
  else root.dispatchEvent(new root.ownerDocument.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(rail.errorKey, null); assert.equal(root.hasAttribute('data-message'), false); assert.equal(dismiss.hidden, true);
});
test('AIT-502: 429 cooldown still defers the explicit retry', async t => {
  let attempt = 0; const { rail, requests } = fixture(t, { start() { if (++attempt === 1) throw { status: 429, code: 'limit', retryAfterMs: 5000 }; return new Promise(() => {}); } });
  await rail.start(); const pending = rail.start(); await flush(); assert.equal(rail.errorKey, null);
  t.mock.timers.tick(4999); await flush(); assert.equal(requests.length, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(requests.length, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(requests.length, 2); await rail.close(); await pending;
});
