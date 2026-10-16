import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createLocalVoiceProvider, localVoiceBinding } from '../src/server.js';
import { createFakeVoice } from '../src/client.js';
import { manifest } from '../src/manifest.js';
import { validateManifest } from '../../../packages/core/src/plugins.js';
import { assertVoicePorts, assertVoiceSession } from '../../../packages/core/src/live-voice.js';

test('AIT-102 grep: fake pipeline has no provider imports, factory, SDK, manifest or token protocol', async () => {
  for (const path of ['plugins/fake-voice/src/client.js', 'plugins/fake-voice/src/server.js', 'plugins/fake-voice/src/manifest.js',
    'packages/server/src/dev/local-voice.js', 'packages/server/src/dev/local-voice-manifest.js', 'demo/fake-voice.js']) {
    const source = await readFile(new URL('../../../' + path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /elevenlabs|conversationToken|signedUrl|mintConversation|createVoiceProvider|startSession/iu, path);
  }
});

test('AIT-102 grep: UI production package has no voice provider names, imports or SDK DOM audio discovery', async () => {
  const root = new URL('../../../packages/ui/src/', import.meta.url);
  for (const entry of await readdir(root, { recursive: true })) {
    if (!entry.endsWith('.js')) continue;
    const source = await readFile(new URL(entry, root), 'utf8');
    assert.doesNotMatch(source, /elevenlabs|plugins\/fake-voice|querySelectorAll\(['"]audio['"]\)|watchVoicePlayback/iu, entry);
  }
});

test('independent fake server and browser ports consume admission, connect no token, preserve holds and settle once', async t => {
  let at = Date.now(), consumed = 0; const saved = [], reports = [];
  const storage = { saveVoiceCall(sessionId, record, options) {
    saved.push(record); assert.equal(sessionId, 'session');
    return { acknowledged: true, ...(options.paused === undefined ? {} : { paused: options.paused }) };
  } };
  const plugin = createLocalVoiceProvider({ storage, now: () => at });
  assert.equal(plugin.manifest, manifest); assert.equal(validateManifest(manifest).ok, true);
  const port = assertVoicePorts(plugin.ports).serverAdapter;
  assert.deepEqual(port.validateConfig(localVoiceBinding.adapterConfig), {});
  assert.throws(() => port.validateConfig({ agentId: 'provider-config' }), TypeError);
  const options = { deadlineAt: at + 5000, spendDeadlineAt: at + 60_000, browserLivenessDeadlineAt: at + 30_000,
    attempt: { attemptId: 'attempt', claimId: 'claim', maxMicro: 0, consume: () => { consumed++; } }, report: value => reports.push(value) };
  const segment = await port.startSegment({ callId: 'call', sessionId: 'session', epoch: 1 }, options);
  t.after(() => segment.close());
  assert.equal(consumed, 1); assert.equal(Object.hasOwn(segment, 'credential'), false);
  assert.equal(segment.grant.opaque.simulated, true); assert.equal(port.callbackRoutes, undefined);
  const control = { tabId: 'tab', start: () => { throw new Error('grant connect cannot readmit'); },
    close: () => segment.close(), pause: () => segment.pause(), resume: () => segment.resume(), heartbeat: () => segment.heartbeat() };
  const f = createFakeVoice({ control, persistEvent: () => {}, document: undefined,
    copy: { fakeVoiceGreeting: 'Hello', fakeVoiceReply: 'A reply', fakeVoiceStatement: 'A statement', fakeVoiceHeard: 'A' } });
  const media = assertVoicePorts(f.client.ports).browserMedia;
  const session = assertVoiceSession(await media.connect(segment.grant, { deadlineAt: at + 5000 }));
  t.after(() => session.close());
  await media.capture(session, false); await media.playback(session, false);
  const held = session.pause(); assert.equal(f.snapshot().muted, true); assert.equal(f.snapshot().volume, 0); await held;
  at += 1000; await session.resume();
  assert.equal(f.snapshot().muted, true); assert.equal(f.snapshot().volume, 0, 'independent channel choices survive resume');
  await assert.rejects(media.connect({ ...segment.grant, expiresAt: Date.now() - 1 }, {}), { code: 'deadline' });
  at += 1000; await media.teardown(session, {});
  assert.equal(f.snapshot().open, false); assert.equal(reports.length, 1);
  assert.equal(reports[0].usage.providerSeconds, 2); assert.equal(reports[0].usage.pausedSeconds, 1);
  assert.equal(reports[0].chargedMicro, 0); assert.equal(saved.at(-1).terminal.closureConfirmed, true);
});

test('fake restart hold is idempotent while an explicit Resume awaits its replacement', async t => {
  const now = Date.now(), replacement = Promise.withResolvers(), requested = Promise.withResolvers();
  const receipt = { callId: 'call', providerSessionId: 'old', epoch: 1, controllingTabId: 'tab',
    spendDeadlineAt: now + 60_000, browserLivenessDeadlineAt: now + 30_000, presentation: 'continuation' };
  const control = { tabId: 'tab', start: () => receipt, close: () => ({ closureConfirmed: true }),
    pause: () => ({ acknowledged: true, paused: true }), resume: () => ({ acknowledged: true, paused: false }),
    heartbeat: () => ({ acknowledged: true, browserLivenessDeadlineAt: now + 30_000 }),
    recover: () => { requested.resolve(); return replacement.promise; } };
  const f = createFakeVoice({ control, persistEvent: () => {}, document: undefined, copy: {} });
  const session = await f.client.start({ callId: 'call' }, {});
  t.after(() => session.close());
  const restart = { ...receipt, state: 'waiting', needsRecovery: true, reason: 'server-restart' };
  session.receiveState(restart);
  const resuming = session.resume(); await requested.promise;
  session.receiveState(restart);
  replacement.resolve({ ...receipt, providerSessionId: 'new' });
  await resuming;
  assert.equal(session.providerSessionId, 'new'); assert.equal(f.snapshot().muted, false);
  assert.equal(session.lifecycle.state.state, 'active');
});

test('fake acknowledged heartbeat extends command liveness without extending the spend deadline', async t => {
  let at = Date.now(); t.mock.method(Date, 'now', () => at);
  const receipt = { callId: 'call', providerSessionId: 'segment', spendDeadlineAt: at + 60_000,
    browserLivenessDeadlineAt: at + 30_000, presentation: 'continuation' };
  const control = { start: () => receipt, close: () => ({ closureConfirmed: true }),
    pause: () => ({ acknowledged: true, paused: true }), resume: () => ({ acknowledged: true, paused: false }),
    heartbeat: () => ({ acknowledged: true, browserLivenessDeadlineAt: at + 40_000 }) };
  const f = createFakeVoice({ control, persistEvent: () => {}, document: undefined, copy: {} });
  const session = await f.client.start({ callId: 'call' }, {}); t.after(() => session.close());
  await session.heartbeat(); at += 31_000;
  await session.setInput(false); assert.equal(f.snapshot().muted, true);
  assert.equal(session.lifecycle.state.spendDeadlineAt, receipt.spendDeadlineAt);
});

test('fake barge-in silences output synchronously before a stalled receipt and only a fresh reply unlocks it', async t => {
  const now = Date.now(), persisted = Promise.withResolvers();
  const receipt = { callId: 'call', providerSessionId: 'segment', spendDeadlineAt: now + 60_000, browserLivenessDeadlineAt: now + 30_000 };
  const control = { start: () => receipt, close: () => ({ closureConfirmed: true }),
    pause: () => ({ acknowledged: true, paused: true }), resume: () => ({ acknowledged: true, paused: false }),
    heartbeat: () => ({ acknowledged: true, browserLivenessDeadlineAt: now + 30_000 }) };
  const f = createFakeVoice({ control, persistEvent: () => persisted.promise, document: undefined,
    copy: { fakeVoiceGreeting: 'A reply', fakeVoiceReply: 'Another reply', fakeVoiceHeard: 'A' } });
  const session = await f.client.start({ callId: 'call' }, {});
  t.after(async () => { persisted.resolve(); await session.close(); });
  assert.equal(f.snapshot().volume, 1);
  f.bargeIn();
  assert.equal(f.snapshot().volume, 0); assert.equal(session.audioLevels().output, 0);
  assert.ok(session.audioLevels().input > 0, 'barge-in retains microphone input');
  await session.setOutput(false); await session.setOutput(true);
  await session.pause(); await session.resume();
  assert.equal(f.snapshot().volume, 0, 'channel and pause commands cannot unlock the interrupted reply');
  f.speak('A new utterance'); assert.equal(f.snapshot().volume, 1);
});

test('fake restored startup failure closes its replacement as exhausted recovery and retains logical waiting', async () => {
  const now = Date.now(), closed = [];
  const control = { start: () => { throw new Error('Restoration must recover'); },
    recover: () => ({ callId: 'call', providerSessionId: 'replacement', epoch: 1,
      spendDeadlineAt: now + 60_000, browserLivenessDeadlineAt: now + 30_000, presentation: 'continuation' }),
    close: identity => { closed.push(identity); return { closureConfirmed: true }; },
    pause: () => ({ acknowledged: true, paused: true }), resume: () => { throw new Error('Resume refused'); }, heartbeat() {} };
  const f = createFakeVoice({ control, persistEvent: () => {}, document: undefined, copy: {} });
  await assert.rejects(f.client.start({ callId: 'call', providerSessionId: 'retired', epoch: 1 }), /Resume refused/u);
  assert.deepEqual(closed, [{ callId: 'call', providerSessionId: 'replacement', epoch: 1,
    reason: 'recovery-failed', recoveryAttempts: 3 }]);
});

test('fake commands are unavailable during recovery; a synchronous Pause waits and targets the replacement', async t => {
  const now = Date.now(), requested = Promise.withResolvers(), replacement = Promise.withResolvers(), pauses = [];
  const receipt = { callId: 'call', providerSessionId: 'old', epoch: 1, presentation: 'continuation',
    spendDeadlineAt: now + 60_000, browserLivenessDeadlineAt: now + 30_000 };
  const control = { start: () => receipt, close: () => ({ closureConfirmed: true }),
    recover: () => { requested.resolve(); return replacement.promise; },
    pause: identity => { pauses.push(identity.providerSessionId); return { acknowledged: true, paused: true }; },
    resume: () => ({ acknowledged: true, paused: false }), heartbeat() {} };
  const f = createFakeVoice({ control, persistEvent: () => {}, document: undefined, copy: {} });
  const session = await f.client.start({ callId: 'call' }, {}); t.after(() => session.close());
  f.disconnect(); await requested.promise;
  await assert.rejects(session.setInput(false), { code: 'unavailable' });
  await assert.rejects(session.sendText('During recovery'), { code: 'unavailable' });
  const held = session.pause(); assert.equal(f.snapshot().volume, 0); assert.equal(f.snapshot().muted, true);
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(pauses, []);
  replacement.resolve({ ...receipt, providerSessionId: 'new' }); await held;
  assert.deepEqual(pauses, ['new']); assert.equal(f.snapshot().muted, true);
  await session.resume(); assert.equal(f.snapshot().muted, false);
});

for (const completed of [false, true]) test(`AIT-190 r2: fake replay completed=${completed} reports completion and retires only played-through actions`, async t => {
  const { Window } = await import('happy-dom');
  const { RecoveryNotices } = await import('../../../packages/ui/src/recovery-notices.js');
  const { en } = await import('../../../packages/ui/src/i18n/en.js');
  const window = new Window(), root = window.document.createElement('div'); window.document.body.append(root);
  t.after(() => window.happyDOM.close());
  const finished = Promise.withResolvers(), final = Promise.withResolvers(), stopped = Promise.withResolvers(), events = [];
  const now = Date.now(), control = {
    start: () => ({ callId: 'call', providerSessionId: 'segment', spendDeadlineAt: now + 60_000, browserLivenessDeadlineAt: now + 30_000 }),
    close: () => ({ closureConfirmed: true }), pause: () => ({ acknowledged: true, paused: true }),
    resume: () => ({ acknowledged: true, paused: false }), heartbeat: () => ({ acknowledged: true, browserLivenessDeadlineAt: now + 30_000 }),
    speakText: async () => ({ kind: 'audio', audio: {} }),
  };
  const f = createFakeVoice({ control, persistEvent: () => {}, document: undefined, copy: { fakeVoiceGreeting: 'Exact reply' },
    playAudio: async () => ({ stop() {}, finished: finished.promise }) });
  const session = await f.client.start({ callId: 'call' });
  const notices = new RecoveryNotices({ root, copy: en, available: () => true, replay: () => session.replayLastReply() });
  const reading = (async () => { for await (const event of session.events) {
    events.push(event);
    if (event.type === 'final' && event.role === 'assistant') { notices.pageReply = { text: event.text, turnId: event.turnId }; notices.render(); final.resolve(); }
    if (event.replay && event.type === 'listening') { notices.playbackEnded(event.completed); stopped.resolve(); }
  } })();
  t.after(async () => { await session.close(); await reading; });
  await final.promise; await notices.repeat();
  assert.equal(notices.button.hidden, false, 'active audio retains the row');
  finished.resolve(completed); await stopped.promise;
  assert.equal(events.find(event => event.replay && event.type === 'listening').completed, completed);
  assert.equal(notices.button.hidden, completed);
  assert.equal(notices.readText.hidden, completed);
});

test('AIT-263: local voice speaks a persisted focus reply without creating a person turn', async t => {
  const now = Date.now(), requests = [], persisted = [], greeting = Promise.withResolvers();
  const control = {
    start: () => ({ callId: 'focus-call', providerSessionId: 'segment', spendDeadlineAt: now + 60_000, browserLivenessDeadlineAt: now + 30_000 }),
    close: () => ({ closureConfirmed: true }), pause: () => ({ acknowledged: true, paused: true }),
    resume: () => ({ acknowledged: true, paused: false }), heartbeat: () => ({ acknowledged: true, browserLivenessDeadlineAt: now + 30_000 }),
    speakText: async request => { requests.push(request); return { kind: 'audio', audio: {} }; },
  };
  const f = createFakeVoice({ control, persistEvent: event => { persisted.push(event); if (event.type === 'final') greeting.resolve(); },
    document: undefined, copy: { fakeVoiceGreeting: 'Greeting.' },
    playAudio: async () => ({ stop() {}, finished: new Promise(() => {}) }) });
  const session = await f.client.start({ callId: 'focus-call' });
  const reading = (async () => { for await (const event of session.events) { /* drain simulator events */ } })();
  t.after(async () => { await session.close(); await reading; });
  await greeting.promise;
  const before = persisted.length;
  const { deliverFocusedReply } = await import('../../../packages/ui/src/focused-reply.js');
  const result = await deliverFocusedReply({ session, paused: false, output: true },
    { id: 'focused-final', role: 'assistant', content: 'Launch date?', focusRequestId: 'focus' });
  assert.equal(result.kind, 'audio'); assert.equal(requests[0].turnId, 'focused-final');
  assert.equal(persisted.length, before); assert.equal(persisted.some(event => event.role === 'user'), false);
});
