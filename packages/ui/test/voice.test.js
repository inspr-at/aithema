import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession, inputRevision } from '@inspr/aithema-core';
import { voiceEvents } from '../../core/src/live-voice.js';
import { AudioRail } from '../src/audio-rail.js';
import { en } from '../src/i18n/en.js';
import { manifest } from '../../../plugins/elevenlabs/src/manifest.js';
import { styles } from '../src/styles.js';
import { voiceJournal } from '../src/voice-orphan.js';
import { createVoiceControl } from '../src/voice-control.js';
import { createElevenLabsClient } from '../../../plugins/elevenlabs/src/client.js';
import { eventProbe } from '../../../test/voice-test-events.js';
const window = new Window();
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, { pause, unavailable = false, journal, ready, start } = {}) {
  const root = document.createElement('div'); document.body.append(root);
  const commands = [], events = voiceEvents(), context = { understanding: 'fixture' };
  const session = { callId: 'local-call', providerSessionId: 'local-provider', events,
    async setInput(value) { commands.push(['input', value]); }, async setOutput(value) { commands.push(['output', value]); },
    async sendText(value) { commands.push(['text', value]); }, async updateContext(value) { commands.push(['context', value]); },
    async pause() { return pause ? pause() : { acknowledged: true, paused: true }; },
    async resume() { return { acknowledged: true, paused: false }; },
    async close() { commands.push(['close']); events.end(); return { closureConfirmed: true }; },
  };
  const client = { manifest, async start() { if (start) await start(); return session; } };
  const rail = new AudioRail({ root, copy: en, client, feature: () => ({ available: !unavailable, reason: 'preset denies voice' }), context: () => context, journal, ready });
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
test('window blur keeps the call; a hidden page pauses it as START does; unacknowledged pause has distinct failure copy', async t => {
  const records = new Map(), storage = { getItem: k => records.get(k) ?? null, setItem: (k, v) => records.set(k, v), removeItem: k => records.delete(k) };
  const journal = voiceJournal(storage, 's1');
  const { rail, root } = fixture(t, { journal }); await rail.start(); window.dispatchEvent(new window.Event('blur')); await tick();
  assert.equal(root.dataset.state, 'listening', 'switching windows never pauses (AIT-116 D7)');
  assert.deepEqual(journal.read(), { callId: 'local-call', providerSessionId: 'local-provider' }, 'the journal holds call identity only');
  t.mock.method(document, 'hidden', () => true, { getter: true });
  document.dispatchEvent(new window.Event('visibilitychange')); await tick();
  assert.equal(root.dataset.state, 'paused');
  t.mock.restoreAll();
  await rail.pause(false); assert.equal(root.dataset.state, 'listening');
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
  let activeCall;
  c.configure({ copy: en, session, voiceClient: { manifest, async start({ callId }) {
    activeCall = callId;
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
  assert.equal(root.querySelector('.status').textContent, en.voiceTextSent);
  events.push({ callId: activeCall, type: 'speaking' }); await tick();
  assert.notEqual(root.querySelector('.status').textContent, en.voiceTextSent, 'the status line follows the call state (D11)');
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
test('Start waits for the orphan cleanup and a 409 conflict gets a precise message', async t => {
  let release; const ready = new Promise(resolve => { release = resolve; }); let started = 0;
  const { rail, root } = fixture(t, { ready: () => ready, start: () => { started++; } });
  const starting = rail.start(); await tick();
  assert.equal(started, 0, 'no start request while the previous page call is being ended');
  assert.equal(root.dataset.state, 'connecting'); release(); await starting;
  assert.equal(started, 1); assert.equal(root.dataset.state, 'listening'); await rail.close();
  rail.client.start = async () => { throw Object.assign(new Error('Voice control failed'), { code: 'voice-conflict' }); };
  await rail.start();
  assert.equal(root.querySelector('.voice-state').textContent, en.voiceConflict);
  assert.notEqual(en.voiceConflict, en.voiceConnectionFailed); assert.equal(rail.button('retry').disabled, false);
});
const memoryStorage = () => { const records = new Map();
  return { getItem: k => records.get(k) ?? null, setItem: (k, v) => records.set(k, v), removeItem: k => records.delete(k) }; };
const until = async (predicate, message) => {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(message);
};
const sse = events => new Response(new ReadableStream({ start(controller) {
  for (const event of events) controller.enqueue(new TextEncoder().encode(`${event.seq ? `id: ${event.seq}\n` : ''}data: ${JSON.stringify(event)}\n\n`));
} }), { headers: { 'content-type': 'text/event-stream' } });
// Reload a page that had a call. `history` is what the server streams after the page's
// cursor; `record` is the journal the previous page left (older builds also stored pause
// ownership in it).
async function reloadOrphan(t, { record, seq = 5, history = [], channel = true }) {
  const storage = memoryStorage(), nativeFetch = globalThis.fetch, nativeChannel = globalThis.BroadcastChannel, calls = [];
  const session = createSession({ demo: true }); session.paused = true; session.seq = seq;
  session.featureMatrix = { best: { voice: { available: true }, text: { available: true }, analysis: { available: true } } };
  voiceJournal(storage, session.id).save(record);
  const nativeStorage = globalThis.sessionStorage; globalThis.sessionStorage = storage;
  if (!channel) delete globalThis.BroadcastChannel;
  globalThis.fetch = async (url, options = {}) => {
    const after = new Headers(options.headers).get('last-event-id');
    calls.push({ url, body: options.body && JSON.parse(options.body), keepalive: options.keepalive, after });
    if (url.endsWith('/events')) return sse(history.filter(event => !event.seq || event.seq > Number(after)));
    if (url.endsWith('/pause')) return Response.json({ event: { sessionId: session.id, seq: c.session.seq + 1, type: 'session.paused', data: { paused: false } } });
    if (url.endsWith('/close')) return Response.json({ closureConfirmed: true });
    return Response.json(session);
  };
  const c = document.createElement('aithema-session');
  t.after(() => {
    c.remove(); globalThis.fetch = nativeFetch; globalThis.sessionStorage = nativeStorage;
    if (!channel) globalThis.BroadcastChannel = nativeChannel;
  });
  document.body.append(c); c.configure({ copy: en, session });
  await until(() => voiceJournal(storage, session.id).read() === null, 'the journal was not settled');
  for (let i = 0; i < 20; i++) await tick();
  return { c, calls, session, storage };
}
const pauseEvent = (seq, paused) => ({ seq, type: 'session.paused', data: { paused } });
const resumes = calls => calls.filter(call => call.url.endsWith('/pause'));
test('a reload never sends paused:false by itself: it stays paused behind one focused Resume (AIT-116 D4)', async t => {
  const legacy = { callId: 'old-call', providerSessionId: 'old-provider', autoPaused: true, pausedAfter: 4 };
  const probes = {
    'own automatic pause, complete history': { record: legacy, history: [pauseEvent(5, true)] },
    'truncated replay': { record: legacy, seq: 4, history: [pauseEvent(5, true)] },
    'a gap in the event numbers': { record: legacy, seq: 4, history: [pauseEvent(5, true), pauseEvent(7, true)] },
    'missing event numbers': { record: legacy, history: [{ type: 'session.paused', data: { paused: false } }, { type: 'lane.status', data: {} }] },
    // Another tab resumes and pauses by hand meanwhile: its pause is the person's, not a reload prompt.
    'concurrent foreign pause': { record: legacy, seq: 4, history: [pauseEvent(5, true), pauseEvent(6, false), pauseEvent(7, true)], status: en.paused },
    'failed automatic pause, then a foreign manual pause': { record: { ...legacy, pausedAfter: 3 }, history: [pauseEvent(5, true)] },
    'no pause ownership recorded': { record: { callId: 'old-call', providerSessionId: 'old-provider' }, history: [] },
  };
  for (const [name, probe] of Object.entries(probes)) {
    const { c, calls, session } = await reloadOrphan(t, probe);
    const closes = calls.filter(call => call.url.endsWith('/close'));
    assert.deepEqual(closes, [{ url: `/api/sessions/${session.id}/voice/old-call/close`,
      body: { providerSessionId: 'old-provider', reason: 'page-reloaded' }, keepalive: true, after: null }], `${name}: the abandoned call is ended`);
    assert.deepEqual(resumes(calls), [], `${name}: no pause change without the person`);
    assert.equal(c.session.paused, true, `${name}: still paused`);
    const root = c.shadowRoot, resume = root.querySelector('.pause');
    assert.equal(root.querySelector('.status').textContent, probe.status ?? en.pausedResume, `${name}: a clear Resume prompt`);
    assert.equal(resume.textContent, en.resume); assert.equal(root.activeElement, resume, `${name}: Resume has focus`);
    c.remove();
  }
  const { c, calls } = await reloadOrphan(t, probes['own automatic pause, complete history']);
  c.shadowRoot.querySelector('.pause').click(); await until(() => !c.session.paused, 'one click resumes');
  assert.deepEqual(resumes(calls).map(call => call.body), [{ paused: false }]);
  c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true } });
  assert.equal(c.shadowRoot.querySelector('.status').textContent, en.paused, 'the prompt ends with that pause');
});
test('without BroadcastChannel a reload never closes the journaled call; the lease ends it (AIT-116 D4)', async t => {
  const { c, calls, storage, session } = await reloadOrphan(t, { record: { callId: 'old-call', providerSessionId: 'old-provider' }, channel: false });
  assert.deepEqual(calls.filter(call => call.url.endsWith('/close')), [], 'no /close without proof of abandonment');
  assert.equal(voiceJournal(storage, session.id).read(), null);
  assert.equal(c.session.paused, true); assert.deepEqual(resumes(calls), []);
});
test('a sessionStorage that throws on access still mounts device and server conversations; the journal keeps nothing (AIT-116 D4)', async t => {
  // A sandboxed or opaque-origin frame raises SecurityError on the mere property read.
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), nativeFetch = globalThis.fetch, calls = [];
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new window.DOMException('denied', 'SecurityError'); } });
  t.after(() => { Object.defineProperty(globalThis, 'sessionStorage', descriptor); globalThis.fetch = nativeFetch; });
  assert.throws(() => globalThis.sessionStorage, { name: 'SecurityError' });
  const client = { manifest, async start() { return { callId: 'call', providerSessionId: 'provider', events: voiceEvents(),
    async setInput() {}, async setOutput() {}, async sendText() {}, async updateContext() {}, async close() { return { closureConfirmed: true }; } }; } };
  for (const preset of ['device', 'best']) {
    // A confirmed choice: the ready card leaves the call rail usable.
    const session = createSession({ demo: true }); session.processingPreset = preset; session.settings = { ...session.settings, origin: 'chosen' };
    session.featureMatrix = { best: { voice: { available: true }, text: { available: true }, analysis: { available: true } } };
    globalThis.fetch = async (url, options = {}) => {
      calls.push(url);
      if (url.endsWith('/events')) return new Response(new ReadableStream({ start(controller) { options.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
      return Response.json(session);
    };
    const c = document.createElement('aithema-session'); document.body.append(c);
    c.configure({ copy: en, session, voiceClient: client });
    const root = c.shadowRoot;
    assert.ok(root.querySelector('.composer textarea') && root.querySelector('.intro').dataset.mode === 'ready', `${preset}: the conversation mounts`);
    if (preset === 'best') {
      // A call starts and ends without storage; a page hide then has no record to close.
      await c.shadowRoot.querySelector('.voice-start').click(); await until(() => root.querySelector('.audio-rail').dataset.state === 'listening', 'the call starts');
      window.dispatchEvent(new window.Event('pagehide')); await tick();
      await root.querySelector('.voice-close').click(); await until(() => root.querySelector('.audio-rail').dataset.state === 'idle', 'the call ends');
    }
    c.remove(); await tick();
  }
  assert.deepEqual(calls.filter(url => url.endsWith('/close')), [], 'without storage the orphan close is skipped');
});
test('Retry after a 409 waits out the remaining lease the server reports, otherwise retries at once', async t => {
  let attempts = 0; const { rail, root } = fixture(t, { start: () => { attempts++; } });
  const conflict = retryAfterMs => Object.assign(new Error('Voice control failed'), { code: 'voice-conflict', retryAfterMs });
  const start = rail.client.start; rail.client.start = async () => { throw conflict(120); };
  await rail.start(); assert.equal(root.querySelector('.voice-state').textContent, en.voiceConflict);
  rail.client.start = start; const clicked = Date.now();
  rail.button('retry').click(); await tick(); assert.equal(root.dataset.state, 'connecting'); assert.equal(attempts, 0, 'Retry waits for the lease');
  await until(() => root.dataset.state === 'listening', 'Retry starts after the lease');
  assert.ok(Date.now() - clicked >= 100); assert.equal(attempts, 1); await rail.close();
  rail.client.start = async () => { throw conflict(undefined); };
  await rail.start(); rail.client.start = start;
  rail.button('retry').click(); await tick(); await tick(); assert.equal(attempts, 2, 'a plain Retry without a reported lease');
});
test('a 409 carries the remaining lease only when the server reports Retry-After', async t => {
  const nativeFetch = globalThis.fetch; t.after(() => { globalThis.fetch = nativeFetch; });
  const { control } = createVoiceControl({ sessionId: 's1' });
  for (const [headers, expected] of [[{ 'retry-after': '7' }, 7000], [{}, undefined]]) {
    globalThis.fetch = async () => Response.json({ error: 'voice-conflict' }, { status: 409, headers });
    await assert.rejects(control.start({ callId: 'c1' }), error => error.code === 'voice-conflict' && error.retryAfterMs === expected);
  }
});
test('a copied journal never ends a call another live tab still drives (AIT-116 D4 cross-tab)', async t => {
  const storage = memoryStorage(), original = globalThis.sessionStorage, nativeFetch = globalThis.fetch, closes = [];
  const session = createSession({ demo: true });
  session.featureMatrix = { best: { voice: { available: true }, text: { available: true }, analysis: { available: true } } };
  globalThis.sessionStorage = storage;
  globalThis.fetch = async url => { closes.push(url); return Response.json({ closureConfirmed: true }); };
  const events = voiceEvents(), driver = document.createElement('aithema-session');
  // configure() tears the rail down, heartbeat included, even when an assertion fails first.
  t.after(() => { events.end(); driver.configure({ copy: en, session: createSession({ demo: true }) }); globalThis.sessionStorage = original; globalThis.fetch = nativeFetch; });
  driver.configure({ copy: en, session, voiceClient: { manifest, async start({ callId }) {
    return { callId, providerSessionId: 'driver-provider', events, async close() { events.end(); return { closureConfirmed: true }; },
      async setInput() {}, async setOutput() {}, async updateContext() {} };
  } } });
  driver.shadowRoot.querySelector('.voice-start').click();
  await until(() => voiceJournal(storage, session.id).read(), 'the driving tab journals its call');
  const copied = memoryStorage(); voiceJournal(copied, session.id).save(voiceJournal(storage, session.id).read());
  // An auxiliary window inherits the opener's sessionStorage, journal included.
  globalThis.sessionStorage = copied;
  const auxiliary = document.createElement('aithema-session'); auxiliary.configure({ copy: en, session });
  t.after(() => auxiliary.remove());
  await until(() => voiceJournal(copied, session.id).read() === null, 'the copy is dropped once the owner answers');
  assert.deepEqual(closes, [], 'no close request for a call another tab drives');
  assert.equal(driver.shadowRoot.querySelector('.audio-rail').dataset.state, 'listening');
  // Once nothing answers for the call, a reload ends it as before.
  globalThis.sessionStorage = storage; await driver.shadowRoot.querySelector('.voice-close').click();
  voiceJournal(storage, session.id).save({ callId: 'gone-call', providerSessionId: 'gone-provider' });
  const reloaded = document.createElement('aithema-session'); reloaded.configure({ copy: en, session });
  await until(() => closes.length === 1, 'an unanswered journal is closed');
  assert.match(closes[0], /voice\/gone-call\/close$/u);
});
test('a hidden page during a pending microphone toggle pauses once the toggle settles (AIT-116 D7)', async t => {
  let release; const journal = voiceJournal(memoryStorage(), 's1');
  const { rail, root } = fixture(t, { journal }); await rail.start();
  rail.session.setInput = () => new Promise(resolve => { release = resolve; });
  rail.button('input').click(); await tick(); assert.equal(rail.busy, true);
  t.mock.method(document, 'hidden', () => true, { getter: true });
  document.dispatchEvent(new window.Event('visibilitychange')); await tick();
  assert.equal(root.dataset.state, 'listening', 'nothing interrupts the pending command');
  release(); for (let i = 0; i < 5; i++) await tick();
  assert.equal(root.dataset.state, 'paused', 'the queued visibility pause applies afterwards');
  assert.equal(rail.input, false); assert.ok(journal.read());
  t.mock.restoreAll();
});
test('a hidden page during a pending resume pauses again once the resume is acknowledged (AIT-116 D7)', async t => {
  const { rail, root } = fixture(t); await rail.start(); await rail.pause(true);
  let acknowledge; rail.session.resume = () => new Promise(resolve => { acknowledge = resolve; });
  const resuming = rail.pause(false); await tick(); assert.equal(rail.busy, true); assert.equal(rail.paused, true);
  t.mock.method(document, 'hidden', () => true, { getter: true });
  document.dispatchEvent(new window.Event('visibilitychange')); await tick();
  acknowledge({ acknowledged: true, paused: false }); await resuming; for (let i = 0; i < 5; i++) await tick();
  assert.equal(rail.paused, true, 'a hidden rail never stays listening after the acknowledgement');
  assert.equal(root.dataset.state, 'paused');
  t.mock.restoreAll();
});
