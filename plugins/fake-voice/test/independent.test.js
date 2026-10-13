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
    'packages/server/src/local-voice.js', 'demo/fake-voice.js']) {
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
