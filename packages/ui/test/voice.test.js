import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession, inputRevision } from '@inspr/aithema-core';
import { voiceEvents } from '../../core/src/live-voice.js';
import { AudioRail } from '../src/audio-rail.js';
import { en } from '../src/i18n/en.js';
import { manifest } from '../../../plugins/elevenlabs/src/manifest.js';
import { styles } from '../src/styles.js';
import { createElevenLabsClient } from '../../../plugins/elevenlabs/src/client.js';
import { eventProbe } from '../../../test/voice-test-events.js';
const window = new Window();
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, { pause, unavailable = false } = {}) {
  const root = document.createElement('div'); document.body.append(root);
  const commands = [], events = voiceEvents(), context = { understanding: 'fixture' };
  const session = { callId: 'local-call', providerSessionId: 'local-provider', events,
    async setInput(value) { commands.push(['input', value]); }, async setOutput(value) { commands.push(['output', value]); },
    async sendText(value) { commands.push(['text', value]); }, async updateContext(value) { commands.push(['context', value]); },
    async pause() { return pause ? pause() : { acknowledged: true, paused: true }; },
    async resume() { return { acknowledged: true, paused: false }; },
    async close() { commands.push(['close']); events.end(); return { closureConfirmed: true }; },
  };
  const client = { manifest, async start() { return session; } };
  const rail = new AudioRail({ root, copy: en, client, feature: () => ({ available: !unavailable, reason: 'preset denies voice' }), context: () => context });
  t.after(async () => { await rail.close(); rail.destroy(); root.remove(); });
  return { root, rail, commands, events, context };
}
test('audio rail shows listening, speaking, paused, recovering and ended states with fixed controls and independent toggles', async t => {
  const { root, rail, events, commands } = fixture(t);
  const buttons = [...root.querySelectorAll('button')]; await rail.start();
  assert.equal(root.dataset.state, 'listening');
  events.push({ callId: 'local-call', type: 'speaking' }); await tick(); assert.equal(root.dataset.state, 'speaking');
  rail.button('input').click(); await tick(); assert.equal(rail.input, false); assert.equal(rail.output, true);
  rail.button('output').click(); await tick(); assert.equal(rail.output, false);
  await rail.pause(true); assert.equal(root.dataset.state, 'paused');
  await rail.pause(false); assert.equal(rail.input, false); assert.equal(rail.output, false);
  events.push({ callId: 'local-call', type: 'recovering' }); await tick(); assert.equal(root.dataset.state, 'recovering');
  events.push({ callId: 'local-call', type: 'recovered' }); await tick(); assert.equal(root.dataset.state, 'listening');
  assert.deepEqual([...root.querySelectorAll('button')], buttons);
  assert.ok(commands.some(c => c[0] === 'input' && c[1] === false));
  assert.ok(!root.querySelector('[class*=interrupt]'), 'native voice barge-in has no force button');
});
test('pause state changes only after server acknowledgement and focus never resumes it', async t => {
  let acknowledge; const { rail, root } = fixture(t, { pause: () => new Promise(resolve => { acknowledge = resolve; }) });
  await rail.start(); const pending = rail.pause(true);
  assert.equal(root.dataset.state, 'listening'); assert.equal(rail.button('pause').disabled, true);
  acknowledge({ acknowledged: true, paused: true }); await pending; assert.equal(root.dataset.state, 'paused');
  window.dispatchEvent(new window.Event('focus')); await tick(); assert.equal(root.dataset.state, 'paused');
});
test('tab blur pauses an active call; unacknowledged pause has distinct failure copy', async t => {
  const { rail, root } = fixture(t); await rail.start(); window.dispatchEvent(new window.Event('blur')); await tick();
  assert.equal(root.dataset.state, 'paused'); await rail.pause(false);
  rail.session.pause = async () => ({ acknowledged: false, paused: true }); await rail.pause(true);
  assert.equal(root.querySelector('.voice-state').textContent, en.voicePauseFailed); assert.equal(rail.paused, false);
});
test('voice unavailable in preset disables Start with a reason and retains layout', async t => {
  const { rail, root } = fixture(t, { unavailable: true });
  assert.equal(rail.button('start').disabled, true); assert.equal(rail.button('start').title, 'preset denies voice');
  await rail.start(); assert.equal(root.dataset.state, 'idle'); assert.equal(root.querySelectorAll('button').length, 7);
});
test('three failed reconnects expose recovery and typing controls, with distinct terminal and permission messages', async t => {
  const { rail, root, events } = fixture(t); await rail.start();
  events.push({ type: 'ended', callId: 'local-call', reason: 'recovery-failed' }); events.end(); await tick();
  assert.equal(rail.button('retry').disabled, false); assert.equal(root.querySelector('.voice-state').textContent, en.voiceRecoveryFailed);
  rail.failure({ name: 'NotAllowedError' }); assert.equal(rail.error, en.voiceMicDenied);
  rail.failure({ name: 'NotFoundError' }); assert.equal(rail.error, en.voiceMicMissing);
  rail.failure({ code: 'deadline' }); assert.equal(rail.error, en.voiceDeadline);
});
test('blocked SDK playback retries on a real user gesture and clears the message only after success', { timeout: 60_000 }, async t => {
  const { rail, root } = fixture(t); await rail.start(); let tries = 0;
  const blocked = Promise.withResolvers(), retried = Promise.withResolvers();
  const report = rail.reportPlaybackBlocked, retry = rail.retryPlayback;
  t.mock.method(rail, 'reportPlaybackBlocked', function () { report.call(this); blocked.resolve(); });
  t.mock.method(rail, 'retryPlayback', function () { const pending = retry.call(this); retried.resolve(pending); return pending; });
  const audio = document.createElement('audio'); audio.autoplay = true;
  audio.play = async () => { if (++tries === 1) throw new window.DOMException('policy', 'NotAllowedError'); };
  document.body.append(audio); await blocked.promise;
  assert.equal(rail.playbackBlocked, true); assert.equal(root.querySelector('.voice-state').textContent, en.voicePlaybackBlocked);
  rail.button('playback').click(); await retried.promise; assert.equal(tries, 2); assert.equal(rail.playbackBlocked, false); audio.remove();
});
test('component sends typed text through active voice, updates context and accepts a durable plain fallback', async t => {
  const session = createSession({ demo: true });
  session.featureMatrix = { best: { voice: { available: true }, text: { available: true }, analysis: { available: true } } };
  const commands = [], events = voiceEvents(), originalFetch = globalThis.fetch;
  let settle, plainReply = false; const terminal = new Promise(resolve => { settle = resolve; });
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).endsWith('/turns'));
    const body = JSON.parse(options.body); commands.push(['persist', body]);
    return Response.json({ seq: c.session.seq + 1, type: 'turn.final', data: { id: body.clientEventId, role: 'user', content: body.content,
      ...(plainReply ? {} : { voiceCallId: body.voiceCallId }) } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const c = document.createElement('aithema-session');
  c.configure({ copy: en, session, voiceClient: { manifest, async start({ callId }) {
    return { callId, providerSessionId: 'slow-provider', events, async close() { events.end(); return terminal; },
      async setInput() {}, async setOutput() {}, async sendText(value) { commands.push(['text', value]); },
      async updateContext(value) { commands.push(['context', value]); } };
  } } });
  t.after(() => { settle({ closureConfirmed: true }); c.configure({ copy: en, session }); c.remove(); }); const root = c.shadowRoot;
  root.querySelector('.voice-start').click(); await tick();
  root.querySelector('textarea').value = 'typed during voice'; root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true })); await tick();
  assert.ok(commands.some(([name, value]) => name === 'text' && value === 'typed during voice'));
  assert.equal(c.session.transcript.length, 1, 'typed text persists even when the provider never echoes');
  assert.ok(commands.findIndex(([name]) => name === 'persist') < commands.findIndex(([name]) => name === 'text'));
  c.receive({ seq: c.session.seq + 1, type: 'question.focused', data: { question: 'Which systems?' } }); await tick();
  assert.equal(commands.at(-1)[1].focusedQuestion, 'Which systems?');
  c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: { ...c.session.understanding, summary: 'New context', inputRevision: inputRevision(c.session) } }); await tick();
  assert.equal(commands.at(-1)[1].understanding.summary, 'New context');
  plainReply = true;
  root.querySelector('textarea').value = 'plain while closing';
  root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true })); await tick();
  assert.equal(c.session.transcript.at(-1).content, 'plain while closing');
  assert.equal(commands.filter(([name]) => name === 'text').length, 1, 'a plain acknowledgement is not forwarded to the closing SDK');
  assert.equal(root.querySelector('textarea').value, ''); assert.equal(root.querySelector('.status').textContent, en.saved);
  root.querySelector('.voice-close').click(); await tick();
  settle({ closureConfirmed: true }); await tick();
});

test('closing notification ends the browser SDK before slow provider settlement', async t => {
  const session = createSession({ demo: true });
  session.featureMatrix = { best: { voice: { available: true }, text: { available: true }, analysis: { available: true } } };
  let ended = false, settle, callId, providerClosed = false;
  const terminal = new Promise(resolve => { settle = resolve; });
  const control = {
    async start(request) { callId = request.callId; return { callId, providerSessionId: 'slow-provider',
      credential: { providerSessionId: 'slow-provider', connectionType: 'webrtc', conversationToken: 'fixture-token', ttlMs: 60_000 },
      spendDeadlineAt: Date.now() + 60_000, browserLivenessDeadlineAt: Date.now() + 30_000 }; },
    async close() { assert.equal(ended, true); providerClosed = true; return terminal; },
    async pause() {}, async resume() {}, async heartbeat() {},
  };
  const client = createElevenLabsClient({ control, persistEvent: async () => {}, sdk: {
    async startSession() { return { getId: () => 'slow-provider', setMicMuted() {}, setVolume() {}, sendContextualUpdate() {},
      async endSession() { ended = true; } }; },
  } });
  const c = document.createElement('aithema-session'); c.configure({ copy: en, session, voiceClient: client });
  t.after(async () => { settle({ closureConfirmed: true }); c.configure({ copy: en, session }); c.remove(); await tick(); });
  c.shadowRoot.querySelector('.voice-start').click(); await tick();
  assert.equal(c.shadowRoot.querySelector('.audio-rail').dataset.state, 'listening');
  c.receive({ type: 'voice.state', data: { callId, providerSessionId: 'previous-provider', state: 'closing', reason: 'consent-revised' } }); await tick();
  assert.equal(ended, false, 'an old provider cannot close the current SDK');
  c.receive({ type: 'voice.state', data: { callId, providerSessionId: 'slow-provider', state: 'closing', reason: 'consent-revised' } }); await tick();
  assert.equal(ended, true, 'closing stops capture without waiting for a terminal'); assert.equal(providerClosed, true);
  assert.equal(c.shadowRoot.querySelector('.audio-rail').dataset.state, 'closing');
  settle({ closureConfirmed: true }); await tick();
});

test('failed recovered SDK connections complete all three attempts and expose Retry despite closing broadcasts', { timeout: 60_000 }, async t => {
  const session = createSession({ demo: true });
  session.featureMatrix = { best: { voice: { available: true }, text: { available: true } } };
  const c = document.createElement('aithema-session'), notices = eventProbe();
  let callbacks, attempts = 0, connections = 0, callId;
  const receipt = providerSessionId => ({ callId, providerSessionId,
    credential: { providerSessionId, connectionType: 'webrtc', conversationToken: 'fixture-token', ttlMs: 60_000 },
    spendDeadlineAt: Date.now() + 60_000, browserLivenessDeadlineAt: Date.now() + 30_000 });
  const control = {
    async start(request) { callId = request.callId; return receipt('initial-provider'); },
    async recover() { return receipt(`recovered-provider-${++attempts}`); },
    async close(identity) {
      c.receive({ type: 'voice.state', data: { ...identity, state: identity.reason === 'transport-lost' ? 'recovering' : 'closing' } });
      c.receive({ type: 'voice.state', data: { ...identity, state: identity.reason === 'transport-lost' ? 'recovering' : 'ended' } });
      return { closureConfirmed: true };
    },
    async pause() {}, async resume() {}, async heartbeat() {},
  };
  const client = createElevenLabsClient({ control, persistEvent: async () => {}, sdk: {
    async startSession(options) {
      if (++connections > 1) throw new Error('fixture SDK connect failed');
      callbacks = options;
      return { getId: () => 'initial-provider', setMicMuted() {}, setVolume() {}, sendContextualUpdate() {}, async endSession() {} };
    },
  } });
  const render = AudioRail.prototype.render;
  t.mock.method(AudioRail.prototype, 'render', function () {
    render.call(this); notices.record(this.state);
  });
  c.configure({ copy: en, session, voiceClient: client });
  t.after(async () => { c.configure({ copy: en, session }); c.remove(); await tick(); });
  const root = c.shadowRoot;
  const started = notices.waitFor(state => state === 'listening'); root.querySelector('.voice-start').click(); await started;
  const after = notices.events.length;
  const finished = notices.waitFor(state => ['failed', 'idle'].includes(state), after);
  callbacks.onDisconnect(); await finished;
  assert.equal(attempts, 3); assert.equal(connections, 4, 'recovery admission succeeds but each SDK connect fails');
  assert.equal(root.querySelector('.audio-rail').dataset.state, 'failed');
  assert.equal(root.querySelector('.voice-state').textContent, en.voiceRecoveryFailed);
  assert.equal(root.querySelector('.voice-retry').disabled, false);
  assert.equal(root.querySelector('.send').disabled, false);
});

test('resending failed typed input after voice ends drops its stale call identity', async t => {
  const session = createSession({ demo: true });
  session.featureMatrix = { best: { voice: { available: true }, text: { available: true } } };
  const c = document.createElement('aithema-session'), events = voiceEvents(), requests = [], originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    if (requests.length === 1) return Response.json({ error: 'fixture-failure' }, { status: 503 });
    return Response.json({ seq: 1, type: 'turn.final', data: { id: body.clientEventId, role: 'user', content: body.content } });
  };
  c.configure({ copy: en, session, voiceClient: { manifest, async start({ callId }) {
    return { callId, providerSessionId: 'provider', events, async setInput() {}, async setOutput() {}, async updateContext() {},
      async close() { events.end(); return { closureConfirmed: true }; } };
  } } });
  t.after(() => { globalThis.fetch = originalFetch; c.configure({ copy: en, session }); c.remove(); });
  const root = c.shadowRoot;
  root.querySelector('.voice-start').click(); await tick();
  root.querySelector('textarea').value = 'yes';
  root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true })); await tick();
  assert.ok(requests[0].voiceCallId); assert.equal(root.querySelector('.status').textContent, en.failed);
  events.push({ type: 'ended', callId: requests[0].voiceCallId, reason: 'closed' }); events.end(); await tick();
  root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true })); await tick();
  assert.equal(requests[1].voiceCallId, undefined); assert.equal(requests[1].providerSessionId, undefined);
  assert.equal(requests[1].clientEventId, requests[0].clientEventId, 'resend preserves the pending turn identity');
  assert.equal(c.session.transcript.length, 1); assert.equal(root.querySelector('textarea').value, '');
});
test('heard correction truncates the bubble immediately under hover while preserving its occupied height', () => {
  const c = document.createElement('aithema-session'), session = createSession({ demo: true });
  c.configure({ copy: en, session });
  c.receive({ seq: 1, type: 'turn.final', data: { id: 'a', role: 'assistant', content: 'Heard. Unspoken remainder.' } });
  const shell = c.shadowRoot.querySelector('.transcript-shell'), row = shell.querySelector('.turn');
  row.getBoundingClientRect = () => ({ height: 80 }); shell.dispatchEvent(new window.Event('pointerenter'));
  c.receive({ seq: 2, type: 'turn.corrected', data: { id: 'a', role: 'assistant', content: 'Heard.' } });
  assert.equal(row.querySelector('span').textContent, 'Heard.'); assert.equal(row.style.minHeight, '80px');
  assert.equal(shell.querySelector('.turn'), row);
  shell.dispatchEvent(new window.Event('pointerleave')); assert.equal(c.session.transcript[0].content, 'Heard.');
  assert.match(styles, /height:8rem/); assert.match(styles, /grid-template-columns:repeat\(7,minmax\(0,1fr\)\)/);
  assert.ok(!/\.voice-controls[^}]*:hover[^}]*\b(?:width|height|padding|margin|transform):/u.test(styles));
});
