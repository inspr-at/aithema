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
  assert.equal(rail.errorKey, 'voiceConnectFailed'); assert.equal(requests[0].signal.reason.source, 'connect-timer');
  assert.equal(requests.length, 1); assert.equal(rail.button('retry').disabled, false);
  await rail.start(); assert.equal(requests.length, 2); assert.equal(rail.errorKey, 'voiceConflict');
});
test('AIT-502: slow provider Start 504 request deadline is a connect failure with explicit Retry', async t => {
  const { rail, requests } = fixture(t, { start() { throw { code: 'deadline', status: 504 }; } });
  await rail.start(); assert.equal(rail.errorKey, 'voiceConnectFailed'); assert.equal(requests.length, 1); assert.equal(rail.button('retry').disabled, false);
  assert.equal(label(rail), en.voiceConnectFailed);
});
test('AIT-502: media grant expiry during microphone permission is a connection failure', async t => {
  const permission = Promise.withResolvers();
  const { rail } = fixture(t, { async start(options) {
    options.onMicrophoneState('requesting'); await permission.promise;
    assertVoiceMediaGrant({ callId: 'call', providerSessionId: 'segment', expiresAt: 110_000, opaque: {} });
  } });
  const pending = rail.start(); await flush(); t.mock.timers.tick(20_000); permission.resolve(); await pending;
  assert.equal(rail.errorKey, 'voiceConnectFailed'); assert.equal(rail.button('retry').disabled, false);
});
for (const [reason, timeLimit, expected] of [
  ['spend-deadline', 'call', 'voiceTimeLimit'], ['spend-deadline', 'conversation', null],
  ['one-hour', undefined, null], ['browser-liveness-deadline', undefined, 'voiceConnectionFailed'],
  ['transport-lost', undefined, 'voiceConnectionFailed'], ['recovery-failed', undefined, 'voiceRecoveryFailed'],
  ['budget-limit', undefined, 'voiceAdmissionDenied'], ['spend-deadline', undefined, null],
]) for (const via of ['ended', 'close']) test(`AIT-502: ${via} ${reason}/${timeLimit ?? 'unknown'} is honest with correct buttons`, async t => {
  const { rail, events } = fixture(t); await rail.start();
  if (via === 'close') await rail.close(reason, { timeLimit });
  else { events.push({ type: 'ended', callId: 'call', reason, timeLimit }); await flush(); }
  if (timeLimit === 'conversation' || reason === 'one-hour') {
    assert.equal(label(rail), en.voiceStates.timeExpired);
    assert.equal(rail.button('start').disabled, true); assert.equal(rail.button('retry').disabled, true);
  } else {
    assert.equal(rail.errorKey, expected); assert.equal(rail.button('retry').disabled, reason === 'budget-limit' || reason === 'spend-deadline' && !timeLimit);
    if (reason === 'spend-deadline' && !timeLimit) {
      assert.equal(label(rail), en.voiceStates.failed); assert.equal(rail.root.hasAttribute('data-message'), false);
      assert.equal(rail.button('start').disabled, false);
    }
    if (reason === 'budget-limit') assert.equal(label(rail), en.voiceCreditStatus.session);
    if (expected === 'voiceTimeLimit') assert.equal(label(rail), en.voiceTimeLimit);
  }
});
for (const copy of [en, de]) test(`AIT-502: ${copy === en ? 'EN' : 'DE'} approved copy and narrow labels`, t => {
  const { rail } = fixture(t, { copy });
  assert.equal(copy.voiceConnectFailed, copy === en ? "The call couldn't connect. Select Retry call, or continue typing." : 'Der Anruf konnte nicht aufgebaut werden. Wählen Sie „Erneut anrufen“ oder schreiben Sie weiter.');
  assert.equal(copy.voiceTimeLimit, copy === en ? 'The call reached its maximum length. Start a new call or continue typing.' : 'Der Anruf hat seine maximale Dauer erreicht. Starten Sie einen neuen Anruf oder schreiben Sie weiter.');
  for (const [key, narrow] of [['voiceConnectFailed', copy === en ? "Couldn't connect" : 'Keine Verbindung'], ['voiceTimeLimit', copy === en ? 'Time limit reached' : 'Zeitlimit erreicht']]) {
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
  else { rail.button('retry').focus(); root.dispatchEvent(new root.ownerDocument.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }
  assert.equal(rail.errorKey, null); assert.equal(root.hasAttribute('data-message'), false); assert.equal(dismiss.hidden, true);
});
test('AIT-502: 429 cooldown still defers the explicit retry', async t => {
  let attempt = 0; const { rail, requests } = fixture(t, { start() { if (++attempt === 1) throw { status: 429, code: 'limit', retryAfterMs: 5000 }; return new Promise(() => {}); } });
  await rail.start(); const pending = rail.start(); await flush(); assert.equal(rail.errorKey, null);
  t.mock.timers.tick(4999); await flush(); assert.equal(requests.length, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(requests.length, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(requests.length, 2); await rail.close(); await pending;
});

test('AIT-502: missing new narrow label uses shipped text', async t => {
  const copy = structuredClone(en); delete copy.voiceMessagesNarrow.voiceTimeLimit;
  copy.voiceMessagesNarrow.voiceDeadline = 'Host short limit';
  const { rail } = fixture(t, { copy }); await rail.start(); await rail.close('spend-deadline', { timeLimit: 'call' });
  assert.equal(label(rail), en.voiceTimeLimit);
  assert.equal(rail.root.querySelector('.consent-narrow').dataset.copy, en.voiceMessagesNarrow.voiceTimeLimit);
});
test('AIT-502: active operation 504 is a connection failure, not a start limit', async t => {
  const { rail } = fixture(t); await rail.start(); rail.failure({ code: 'deadline', status: 504 });
  assert.equal(rail.errorKey, 'voiceConnectionFailed');
});
for (const sameCall of [true, false]) test(`AIT-502: ended uses bound metadata only for ${sameCall ? 'the same' : 'a different'} call`, async t => {
  const { rail, events } = fixture(t); await rail.start();
  rail.receiveState({ callId: sameCall ? 'call' : 'previous-call', providerSessionId: 'segment', epoch: 1, state: 'active', timeLimit: 'call' });
  events.push({ type: 'ended', callId: 'call', reason: 'spend-deadline' }); await flush();
  assert.equal(rail.errorKey, sameCall ? 'voiceTimeLimit' : null);
});

for (const timeLimit of ['call', 'conversation', undefined]) test(`AIT-502 v2.2: resumed bound refusal ${timeLimit ?? 'unknown'}`, async t => {
  const { rail } = fixture(t, { start() { throw { code: 'deadline', status: 504, reason: 'time-limit', timeLimit }; } });
  rail.waitingCall = { callId: 'call', providerSessionId: 'old' };
  await rail.start();
  assert.equal(rail.waitingCall, null);
  assert.equal(label(rail), timeLimit === 'call' ? en.voiceTimeLimit : timeLimit === 'conversation' ? en.voiceStates.timeExpired : en.voiceStates.failed);
  assert.equal(rail.root.hasAttribute('data-message'), timeLimit === 'call');
  assert.equal(rail.button('start').disabled, timeLimit === 'conversation');
});
test('AIT-502 v2.2: fresh Start cannot use a resumed time-limit refusal', async t => {
  const { rail } = fixture(t, { start() { throw { code: 'deadline', status: 504, reason: 'time-limit', timeLimit: 'call' }; } });
  await rail.start(); assert.equal(label(rail), en.voiceConnectFailed);
});
test('AIT-502 v2.2: Escape ignores focus outside the rail', async t => {
  const { rail, root } = fixture(t); rail.state = 'failed'; rail.failure({ code: 'deadline' });
  const outside = root.ownerDocument.createElement('button'); root.ownerDocument.body.append(outside); outside.focus();
  root.dispatchEvent(new root.ownerDocument.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(root.hasAttribute('data-message'), true);
  rail.button('retry').focus(); root.dispatchEvent(new root.ownerDocument.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(root.hasAttribute('data-message'), false);
});
for (const copy of [en, de]) for (const [key, legacy] of [['voiceConnectFailed', 'voiceConnectionFailed'], ['voiceTimeLimit', 'voiceDeadline']]) {
  test(`AIT-502 v2.2: legacy ${legacy} override wins over new shipped default (${copy.display.locale})`, async t => {
    const host = structuredClone(copy); host[legacy] = 'Host legacy override';
    const { rail } = fixture(t, { copy: host }); rail.state = 'failed'; rail.errorKey = key; rail.render();
    assert.equal(label(rail), 'Host legacy override');
    host[key] = 'Host new override'; rail.render(); assert.equal(label(rail), 'Host new override');
  });
  test(`AIT-502 v2.2: absent ${key} uses shipped locale (${copy.display.locale})`, t => {
    const host = structuredClone(copy); delete host[key]; delete host.voiceMessageClose; delete host.voiceMessagesNarrow[key];
    const { rail } = fixture(t, { copy: host }); rail.state = 'failed'; rail.errorKey = key; rail.render();
    assert.equal(label(rail), copy === en ? key === 'voiceConnectFailed' ? "The call couldn't connect. Select Retry call, or continue typing." : en.voiceTimeLimit : key === 'voiceConnectFailed' ? 'Der Anruf konnte nicht aufgebaut werden. Wählen Sie „Erneut anrufen“ oder schreiben Sie weiter.' : de.voiceTimeLimit);
    assert.equal(rail.root.querySelector('.consent-narrow').dataset.copy, key === 'voiceConnectFailed' ? copy === en ? "Couldn't connect" : 'Keine Verbindung' : copy.voiceMessagesNarrow.voiceTimeLimit);
    assert.equal(rail.root.querySelector('.voice-message-close').getAttribute('aria-label'), copy.voiceMessageClose);
  });
}
for (const [copy, text] of [[en, 'Voice connection failed. Retry or continue typing.'], [de, 'Die Sprachverbindung ist fehlgeschlagen. Versuchen Sie es erneut oder tippen Sie weiter.']]) test(`AIT-502 v2.2: mid-call legacy copy unchanged (${copy.display.locale})`, async t => {
  const { rail } = fixture(t, { copy }); await rail.start(); rail.failure({ code: 'deadline', status: 504 });
  assert.equal(label(rail), text); assert.equal(copy.voiceConnectionFailed, text);
});

test('AIT-502 v2.2: voice control preserves resumed bound refusal metadata', async t => {
  const { createVoiceControl } = await import('../src/voice-control.js');
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'deadline', reason: 'time-limit', timeLimit: 'call' }, { status: 504 }));
  const { control } = createVoiceControl({ sessionId: 'fixture', sessionToken: 'fixture' });
  await assert.rejects(control.recover({ callId: 'call' }), error => error.code === 'deadline' && error.reason === 'time-limit' && error.timeLimit === 'call');
});

for (const reason of ['purpose', 'session-revoked']) test(`AIT-502 gate M1: ${reason} closes quietly with Call ended`, async t => {
  const { rail } = fixture(t); await rail.start(); await rail.close(reason);
  assert.equal(rail.state, 'idle'); assert.equal(label(rail), en.voiceEnded);
  assert.equal(rail.root.hasAttribute('data-message'), false);
  assert.equal(rail.root.querySelector('.voice-message-close').hidden, true);
  assert.equal(rail.button('retry').disabled, true);
});
for (const reason of ['host-limit', 'session', 'voiceVisitor']) test(`AIT-502 gate M1: ${reason} uses credits and clears after recovery`, async t => {
  const { rail } = fixture(t); let exhausted = false;
  rail.usedUp = () => exhausted; rail.endReason = () => reason;
  await rail.start(); exhausted = true; await rail.close(reason);
  assert.equal(rail.errorKey, 'voiceAdmissionDenied'); assert.equal(rail.errorReason, reason);
  assert.equal(rail.allowanceDenied, true); assert.equal(rail.root.hasAttribute('data-used-up'), true);
  assert.equal(label(rail), reason === 'host-limit' ? en.voiceCreditStatus.hostLimit : en.voiceCreditStatus.session);
  assert.equal(rail.button('start').disabled, true); assert.equal(rail.button('retry').disabled, true);
  exhausted = false; rail.reconcileAdmission(); rail.render();
  assert.equal(rail.errorKey, null); assert.equal(rail.errorReason, null);
  assert.equal(rail.root.hasAttribute('data-used-up'), false); assert.equal(rail.root.hasAttribute('data-message'), false);
  assert.equal(rail.button('start').disabled, false);
  assert.notEqual(label(rail), en.voiceConnectionFailed);
});
test('AIT-502 gate M1: an unlisted transport close remains a connection failure', async t => {
  const { rail } = fixture(t); await rail.start(); await rail.close('unlisted-transport-end');
  assert.equal(rail.state, 'failed'); assert.equal(rail.errorKey, 'voiceConnectionFailed');
  assert.equal(label(rail), en.voiceConnectionFailed); assert.equal(rail.button('retry').disabled, false);
});

for (const [reason, key, state] of [
  ['turn-expired', null, 'idle'], ['upload-expired', null, 'idle'], ['start-cancelled', null, 'idle'],
  ['call-authorization-lost', 'voiceAdmissionDenied', 'failed'], ['voice-host-unavailable', 'voiceAdmissionDenied', 'failed'],
  ['transcript-persistence-failed', 'voiceAdmissionDenied', 'failed'], ['transcript-limit', 'voiceAdmissionDenied', 'failed'],
  ['pause-failed', 'voicePauseFailed', 'failed'], ['tab-takeover', 'voiceMoved', 'idle'],
]) test(`AIT-502 gate M1 audit: ${reason} retains its actual cause`, async t => {
  const { rail } = fixture(t); await rail.start(); await rail.close(reason);
  assert.equal(rail.state, state);
  assert.equal(rail.errorKey, key ?? 'voiceEnded');
  assert.notEqual(label(rail), en.voiceConnectionFailed);
  if (key === 'voiceAdmissionDenied') { assert.equal(rail.errorReason, reason); assert.equal(label(rail), en.reasons[reason]); }
});
