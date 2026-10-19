import { test as nodeTest, after } from 'node:test';
const test = (name, run) => nodeTest(name, { timeout: 5000 }, run);
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { AudioRail } from '../src/audio-rail.js';
import { voiceEvents } from '../../core/src/live-voice.js';
import { de } from '../src/i18n/de.js';
import { en } from '../src/i18n/en.js';
import { currentVoiceClient } from './fixtures/current-voice-clients.js';

const micCopy = {
  voiceMicBusy: ['Das Mikrofon ist belegt oder vom System gesperrt. Schließen Sie andere Apps, die es nutzen, oder prüfen Sie die Systemeinstellungen. Versuchen Sie es dann erneut.', 'The microphone is busy or blocked by the system. Close other apps using it or check your system settings, then try again.'],
  voiceMicUnavailable: ['Dieser Browser erlaubt hier kein Mikrofon. Tippen Sie weiter oder öffnen Sie die Seite in einem anderen Browser.', "This browser doesn't allow a microphone here. Keep typing or open the page in another browser."],
  voiceMicFailed: ['Das Mikrofon konnte nicht starten. Versuchen Sie es erneut oder tippen Sie weiter.', "The microphone couldn't start. Try again or keep typing."],
};
const checks = [];
const flush = async () => { for (let n = 0; n < 8; n++) await new Promise(resolve => setImmediate(resolve)); };
// Advance the real clients in regular turns so their sleep/wake guard sees
// elapsed connected time, not a suspended browser resuming after a clock jump.
const advance = async (t, ms) => { while (ms > 0) { const step = Math.min(ms, 1000); t.mock.timers.tick(step); await flush(); ms -= step; } };
const full = rail => rail.root.querySelector('.voice-state').getAttribute('aria-label');
const record = (provider, name, detail = {}) => checks.push({ provider, assert: name, clock: 'controlled', stateOnly: true, pass: true, ...detail });
after(async () => {
  if (!process.env.AITHEMA_EVIDENCE_DIR) return;
  await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true });
  await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, 'ait377-state-checks.json'), JSON.stringify({ checks }, null, 2));
});
function fixture(t, provider, { ready, opening, microphone = false, replyStarted = false, error } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100_000 });
  const window = new Window(), root = window.document.createElement('div'); window.document.body.append(root);
  const events = voiceEvents(), calls = [], closes = [];
  const session = { callId: 'offline-call', providerSessionId: 'offline-provider', events,
    async setInput() {}, async setOutput() {}, async updateContext() {},
    async close() { closes.push(Date.now()); return { closureConfirmed: true, usage: { costEstimated: false } }; } };
  const client = { manifest: { id: provider, liveVoice: { capabilities: { onMicrophoneState: 'native', ...(replyStarted ? { replyStarted: 'native' } : {}) } } }, async start(request, options) {
    calls.push({ at: Date.now(), options });
    options.onMicrophoneState?.(microphone ? 'requesting' : 'granted');
    if (error) throw error;
    return opening ? opening.promise : session;
  } };
  const rail = new AudioRail({ root, copy: de, client, ready, context: () => ({}), feature: () => ({ available: true }) });
  t.after(async () => { rail.destroy(); events.end(); opening?.resolve(session); await window.happyDOM.abort(); });
  return { rail, calls, session, events, closes, send: async event => { events.push({ callId: session.callId, ...event }); await flush(); } };
}
for (const provider of ['elevenlabs', 'grok-voice']) {
  test(`AIT-377 ${provider}: cleanup ends at 5 s, then provider-only 30 s deadline`, async t => {
    const cleanup = Promise.withResolvers(), opening = Promise.withResolvers();
    const { rail, calls, session, closes } = fixture(t, provider, { ready: () => cleanup.promise, opening });
    const start = rail.start(); await flush();
    assert.equal(full(rail), 'Vorheriger Anruf wird beendet …');
    assert.equal(rail.button('close').disabled, false);
    assert.equal(rail.root.getRootNode().activeElement, rail.button('close'));
    t.mock.timers.tick(4999); await flush(); assert.equal(calls.length, 0);
    t.mock.timers.tick(1); await flush(); assert.equal(calls.length, 1);
    assert.equal(full(rail), de.voiceStates.connecting);
    t.mock.timers.tick(29_999); await flush(); assert.equal(rail.state, 'connecting');
    t.mock.timers.tick(1); await start;
    assert.equal(rail.errorKey, 'voiceDeadline'); assert.equal(calls[0].options.signal.aborted, true);
    assert.equal(rail.root.getRootNode().activeElement, rail.button('retry'));
    opening.resolve(session); cleanup.resolve(); await flush(); assert.equal(closes.length, 1, 'late session closed');
    record(provider, 'cleanup 5 s; connect deadline 30 s; late session closed', { cleanupMs: 5000, connectMs: 30000, focusTargets: ['voice-close', 'voice-retry'] });
  });
  test(`AIT-377 ${provider}: microphone phase contract holds S1 for 60 s and grant at 20 s fails at 50 s`, async t => {
    const opening = Promise.withResolvers();
    const { rail, calls } = fixture(t, provider, { opening, microphone: true });
    const start = rail.start(); await flush();
    assert.equal(full(rail), 'Mikrofon freigeben …');
    t.mock.timers.tick(60_000); await flush(); assert.equal(rail.state, 'connecting');
    await rail.close(); await start; assert.equal(rail.root.getRootNode().activeElement, rail.button('start'));
    record(provider, 'S1 60 s has no deadline; End aborts and focuses Start', { phaseContractFixture: true, heldMs: 60000, focusTargets: ['voice-close', 'voice-start'] });
    const next = rail.start(); await flush(); t.mock.timers.tick(20_000); await flush();
    calls.at(-1).options.onMicrophoneState('granted');
    assert.equal(full(rail), de.voiceStates.connecting);
    t.mock.timers.tick(29_999); await flush(); assert.equal(rail.state, 'connecting');
    t.mock.timers.tick(1); await next; assert.equal(rail.errorKey, 'voiceDeadline');
    record(provider, 'grant at 20 s fails at 50 s', { phaseContractFixture: true, grantMs: 20000, failedMs: 50000 });
  });
  test(`AIT-377 ${provider}: cooldown counts 12 to 0 every second before connect`, async t => {
    const opening = Promise.withResolvers(), { rail, calls } = fixture(t, provider, { opening });
    rail.retryAt = Date.now() + 12_000;
    const start = rail.start(); await flush(); const countdown = [];
    for (let s = 12; s >= 0; s--) {
      assert.equal(full(rail), `Neuer Versuch in ${s} s`); countdown.push(s);
      assert.equal(rail.root.querySelector('.consent-narrow').dataset.copy, `In ${s} s`);
      assert.equal(calls.length, 0);
      if (s) { t.mock.timers.tick(1000); await flush(); }
    }
    await flush();
    // Zero is painted for a frame before the provider begins.
    t.mock.timers.tick(1); await flush(); assert.equal(calls.length, 1);
    await rail.close(); await start;
    record(provider, '12 → 0 countdown in 1 s steps, no early client.start', { countdown });
  });
  for (const phase of ['cleanup', 'cooldown', 'connect', 'prompt']) test(`AIT-377 ${provider}: End immediately cancels ${phase}`, async t => {
    const pending = Promise.withResolvers();
    const { rail, calls } = fixture(t, provider, { ready: phase === 'cleanup' ? () => pending.promise : undefined,
      opening: pending, microphone: phase === 'prompt' });
    if (phase === 'cooldown') rail.retryAt = Date.now() + 60_000;
    const start = rail.start(); await flush(); await rail.close(); await start;
    assert.equal(rail.state, 'idle'); assert.equal(rail.root.getRootNode().activeElement, rail.button('start'));
    if (['cleanup', 'cooldown'].includes(phase)) assert.equal(calls.length, 0);
    else assert.equal(calls[0].options.signal.aborted, true);
    t.mock.timers.tick(60_001); await flush(); assert.equal(rail.state, 'idle');
    record(provider, `End cancels ${phase} immediately`, { focusTarget: 'voice-start' });
  });
  for (const [name, key] of [['NotReadableError', 'voiceMicBusy'], ['NoMediaAPIError', 'voiceMicUnavailable'], ['OverconstrainedError', 'voiceMicFailed'], ['AbortError', 'voiceMicFailed'], ['Error', 'voiceMicFailed']]) {
    test(`AIT-377 ${provider}: ${name} has device guidance and failure focus`, async t => {
      const { rail } = fixture(t, provider, { microphone: name === 'Error', error: Object.assign(new Error('offline acquisition'), { name }) });
      await rail.start(); assert.equal(rail.errorKey, key);
      for (const copy of [de, en]) {
        rail.copy = copy; rail.render(); assert.equal(full(rail), micCopy[key][copy === de ? 0 : 1]);
        assert.equal(rail.root.querySelector('.consent-narrow').dataset.copy, copy.voiceMessagesNarrow[key]);
      }
      const retry = name !== 'NoMediaAPIError';
      assert.equal(rail.button('retry').disabled, !retry);
      assert.equal(rail.root.hasAttribute('data-no-mic-api'), !retry);
      assert.equal(rail.root.getRootNode().activeElement, rail.button(retry ? 'retry' : 'start'));
      record(provider, `${name} maps to ${key}; full/narrow DE+EN; failure focus`, { focusTarget: retry ? 'voice-retry' : 'voice-start', retry });
    });
  }
  test(`AIT-377 ${provider}: programmatic idle cleanup preserves focus outside the rail`, async t => {
    const { rail } = fixture(t, provider), document = rail.root.ownerDocument;
    const control = document.createElement('button'); document.body.append(control); control.focus();
    await rail.close(); assert.equal(document.activeElement, control);
    record(provider, 'programmatic idle cleanup preserves unrelated focus');
  });
  test(`AIT-377 ${provider}: absent getUserMedia refuses before any client.start`, async t => {
    const { rail, calls } = fixture(t, provider);
    Object.defineProperty(rail.root.ownerDocument.defaultView, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(rail.root.ownerDocument.defaultView.navigator, 'mediaDevices', { configurable: true, value: {} });
    await rail.start();
    assert.equal(calls.length, 0); assert.equal(rail.errorKey, 'voiceMicUnavailable');
    assert.equal(rail.button('retry').disabled, true);
    record(provider, 'no getUserMedia: no call, no Retry, mic guidance');
  });
  test(`AIT-377 ${provider}: opener and user-turn watchdog, filler ignored, late transcript clears, visitor silence ignored`, async t => {
    const { rail, send, session } = fixture(t, provider, { replyStarted: true }); await rail.start();
    t.mock.timers.tick(14_999); await flush(); assert.equal(rail.errorKey, null);
    t.mock.timers.tick(1); await flush(); assert.equal(rail.errorKey, 'voiceNoReply'); assert.equal(rail.session, session);
    await send({ type: 'final', role: 'assistant', text: 'Eine Antwort.', turnId: 'answer' });
    assert.equal(rail.errorKey, null); assert.equal(rail.state, 'speaking');
    await send({ type: 'listening' }); t.mock.timers.tick(60_000); await flush(); assert.equal(rail.errorKey, null);
    await send({ type: 'final', role: 'user', text: 'Eine Frage.', turnId: 'question' });
    t.mock.timers.tick(5000); await send({ type: 'final', role: 'assistant', text: 'Einen Moment, bitte.', turnId: 'filler', filler: true });
    t.mock.timers.tick(9999); await flush(); assert.equal(rail.errorKey, null);
    t.mock.timers.tick(1); await flush(); assert.equal(rail.errorKey, 'voiceNoReply');
    await send({ type: 'final', role: 'assistant', text: 'Die Antwort.', turnId: 'reply' }); assert.equal(rail.errorKey, null);
    await send({ type: 'final', role: 'user', text: 'Noch eine Frage.', turnId: 'next' });
    await rail.close(); t.mock.timers.tick(15_000); await flush(); assert.notEqual(rail.errorKey, 'voiceNoReply');
    record(provider, '15 s opener and user-turn watchdog; filler ignored; late transcript clears; visitor silence never arms; End clears', { openerMs: 15000, replyMs: 15000, capability: 'replyStarted' });
  });
  test(`AIT-377 ${provider}: visitor speech holds the opener watch until the turn ends`, async t => {
    const { rail, send } = fixture(t, provider, { replyStarted: true }); await rail.start();
    t.mock.timers.tick(10_000); await send({ type: 'partial', role: 'user', text: 'Eine längere Frage', turnId: 'speaking-user' });
    t.mock.timers.tick(20_000); await flush(); assert.equal(rail.errorKey, null);
    await send({ type: 'final', role: 'user', text: 'Eine längere Frage.', turnId: 'user-turn' });
    t.mock.timers.tick(14_999); await flush(); assert.equal(rail.errorKey, null);
    t.mock.timers.tick(1); await flush(); assert.equal(rail.errorKey, 'voiceNoReply');
    record(provider, 'watchdog waits for end of visitor speech', { replyMs: 15000 });
  });
  test(`AIT-377 ${provider}: declared reply-started audio clears and blocks S5 during long speech`, async t => {
    const { rail, send } = fixture(t, provider, { replyStarted: true }); await rail.start();
    t.mock.timers.tick(14_999); await send({ type: 'speaking', audio: true });
    t.mock.timers.tick(30_000); await flush(); assert.equal(rail.errorKey, null);
    assert.equal(rail.state, 'speaking'); assert.equal(rail.replyTimer, null);
    await send({ type: 'listening' });
    await send({ type: 'final', role: 'user', text: 'Frage', turnId: 'question' });
    t.mock.timers.tick(5000); await send({ type: 'speaking', audio: true, filler: true });
    t.mock.timers.tick(10_000); await flush(); assert.equal(rail.errorKey, 'voiceNoReply');
    await send({ type: 'speaking', audio: true }); assert.equal(rail.errorKey, null);
    assert.equal(rail.state, 'speaking');
    t.mock.timers.tick(30_000); await flush(); assert.equal(rail.errorKey, null);
    record(provider, 'declared non-filler audio clears/blocks S5; filler does not; late audio clears', { capability: 'replyStarted' });
  });
  test(`AIT-377 ${provider}: current client preserves main permission copy and its own deadline`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100_000 });
    const permission = Promise.withResolvers(), current = currentVoiceClient(provider, { permission: permission.promise });
    const window = new Window(), root = window.document.createElement('div'); window.document.body.append(root);
    const rail = new AudioRail({ root, client: current.client, copy: de, context: () => ({}), feature: () => ({ available: true }) });
    t.after(async () => { permission.resolve(); await flush(); await rail.close(); rail.destroy(); current.end(); await window.happyDOM.abort(); });
    assert.equal(current.client.manifest.liveVoice.capabilities.onMicrophoneState, undefined);
    assert.equal(current.client.manifest.liveVoice.capabilities.replyStarted, undefined);
    const start = rail.start(); await flush(); assert.ok(current.acquired > 0);
    for (const copy of [de, en]) { rail.copy = copy; rail.render(); assert.equal(full(rail), copy.voiceStates.connecting); }
    assert.equal(current.options[0].deadlineAt, 130_000, 'same client option as main');
    await advance(t, 30_000);
    if (provider === 'grok-voice') {
      assert.equal(rail.state, 'connecting'); assert.equal(rail.errorKey, null);
      assert.equal(rail.controller.signal.aborted, false);
      await advance(t, 30_000); assert.equal(rail.state, 'connecting');
      permission.resolve(); await start; assert.equal(rail.state, 'listening');
    } else {
      await start; assert.equal(rail.state, 'failed'); assert.equal(rail.errorKey, 'voiceDeadline');
    }
    record(provider, 'capability-gated (today\'s behaviour): main connecting copy and client-owned permission deadline', { heldMs: provider === 'grok-voice' ? 60000 : 30000 });
  });
  test(`AIT-377 ${provider}: current client has no S5 on silence, audio or silent repair`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100_000 });
    const current = currentVoiceClient(provider), window = new Window(), root = window.document.createElement('div'); window.document.body.append(root);
    const rail = new AudioRail({ root, client: current.client, copy: de, context: () => ({}), feature: () => ({ available: true }) });
    t.after(async () => { await rail.close(); rail.destroy(); current.end(); await window.happyDOM.abort(); });
    await rail.start(); assert.equal(rail.state, 'listening'); assert.equal(rail.replyTimer, null);
    await advance(t, 15_000); assert.equal(rail.errorKey, null);
    current.speaking(rail.session.callId); await flush(); assert.equal(rail.state, 'speaking');
    await advance(t, 16_000); assert.equal(rail.errorKey, null);
    current.recover(); await flush(); assert.equal(rail.state, 'listening');
    assert.equal(current.requests.filter(r => r === 'recover').length, 1); assert.equal(rail.replyTimer, null);
    await advance(t, 15_000); assert.equal(rail.errorKey, null);
    await rail.sendText('Eine Frage.'); assert.equal(rail.replyTimer, null);
    await advance(t, 15_000); assert.equal(rail.errorKey, null);
    record(provider, 'capability-gated (today\'s behaviour): no S5 on visitor silence, long audio, recovered or typed turn');
  });
  for (const terminal of [undefined, { closureConfirmed: true, usage: { costEstimated: true } }, { closureConfirmed: true, usage: { costEstimated: false } }]) test(`AIT-377 ${provider}: agent end charge state ${JSON.stringify(terminal)}`, async t => {
    const { rail, send, session } = fixture(t, provider); await rail.start();
    await send({ type: 'ended', reason: 'provider-end', terminal });
    assert.equal(rail.errorKey, terminal?.usage?.costEstimated === false ? 'voiceEnded' : 'voiceClosureUncertain');
    assert.equal(rail.endedCall.callId, session.callId);
    rail.settlement({ callId: session.callId, providerSessionId: session.providerSessionId, terminal: { closureConfirmed: true, usage: { costEstimated: false } } });
    assert.equal(rail.errorKey, 'voiceEnded');
    record(provider, 'agent end retains pending charge until confirmed usage', { initialTerminal: terminal ?? null });
  });
}
