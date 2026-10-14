import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComposedBrowserMedia } from '../src/client.js';
import { createComposedRelay } from '../src/relay.js';
import { createComposedVoice } from '../src/server.js';
import { manifest as composedManifest } from '../src/manifest.js';
import { manifest as voxtralManifest } from '../../voxtral/src/index.js';
import { validateManifest } from '../../../packages/core/src/plugins.js';
import { assertVoiceSession, assertVoicePorts } from '../../../packages/core/src/live-voice.js';
import { SQLiteStorage } from '../../../packages/server/src/storage.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function relayFixture(id = 'generation-1') {
  const commands = [], until = Date.now() + 60_000;
  const relay = createComposedRelay({ callId: 'offline-call', providerSessionId: id, epoch: 1,
    expiresAt: until, spendDeadlineAt: until, browserLivenessDeadlineAt: until });
  let paused = false;
  relay.attach({ receiveAudio() {}, pause: async () => { paused = true; commands.push('pause'); return { acknowledged: true, paused }; },
    resume: async () => { paused = false; commands.push('resume'); return { acknowledged: true, paused }; },
    interrupt: async () => { commands.push('interrupt'); }, setInput: async () => {}, setOutput: async () => {},
    heartbeat: async () => ({ acknowledged: true, browserLivenessDeadlineAt: until }), close: async () => { relay.close(); } });
  return { relay, commands };
}

test('AIT-160: plugin manifests and independent media ports satisfy neutral contracts', () => {
  assert.deepEqual(validateManifest(composedManifest), { ok: true, errors: [] });
  assert.deepEqual(validateManifest(voxtralManifest), { ok: true, errors: [] });
  assertVoicePorts({ browserMedia: createComposedBrowserMedia({ openRelay() {}, capture() {}, player: { play() {}, stop() {} } }) });
});

test('AIT-160: browser pause/close stop physical media synchronously; old audio stays silent', async t => {
  const h = relayFixture(); let captures = 0, captureStops = 0, stops = 0;
  const played = [];
  const media = createComposedBrowserMedia({ openRelay: grant => h.relay.connect(grant),
    capture: async () => { captures++; return { stop() { captureStops++; } }; },
    player: { stop() { stops++; }, play(bytes) { played.push([...bytes]); } } });
  const session = assertVoiceSession(await media.connect(h.relay.grant));
  t.after(() => session.close());
  h.relay.audio({ playbackRevision: 0, format: 'pcm_f32le', bytes: new Uint8Array(4) }); await tick();
  assert.equal(played.length, 1);
  const paused = session.pause(); assert.equal(captureStops, 1); assert.ok(stops > 0); await paused;
  h.relay.audio({ playbackRevision: 0, format: 'pcm_f32le', bytes: new Uint8Array(4) }); await tick();
  assert.equal(played.length, 1);
  await session.resume(); assert.equal(captures, 2);
  const interrupt = session.interrupt();
  h.relay.audio({ playbackRevision: 0, format: 'pcm_f32le', bytes: new Uint8Array(4) }); await interrupt; await tick();
  assert.equal(played.length, 1);
  h.relay.audio({ playbackRevision: 3, format: 'pcm_f32le', bytes: new Uint8Array([1, 2, 3, 4]) }); await tick();
  assert.equal(played.length, 2);
  const closing = session.close(); assert.equal(captureStops, 2); await closing;
});

test('AIT-160: playback acknowledgement cannot block a server barge-in stop frame', async t => {
  const h = relayFixture(), release = Promise.withResolvers(); let stops = 0;
  const media = createComposedBrowserMedia({ openRelay: grant => h.relay.connect(grant),
    capture: async () => ({ stop() {} }), player: { play: () => release.promise, stop: () => { stops++; } } });
  const session = await media.connect(h.relay.grant);
  t.after(async () => { release.resolve(); await session.close(); });
  h.relay.audio({ playbackRevision: 0, format: 'pcm_f32le', bytes: new Uint8Array(4) }); await tick();
  const before = stops; h.relay.silence({ playbackRevision: 1, reason: 'barge-in' }); await tick();
  assert.equal(stops, before + 1);
});

test('AIT-160: recovery makes a fresh generation, keeps channel choices and emits no greeting', async t => {
  const a = relayFixture(), b = relayFixture('generation-2'); let captures = 0, recoveries = 0;
  const media = createComposedBrowserMedia({
    openRelay: grant => (grant.providerSessionId === 'generation-1' ? a : b).relay.connect(grant),
    control: { recover: async () => { recoveries++; return b.relay.grant; } },
    capture: async () => { captures++; return { stop() {} }; }, player: { play() {}, stop() {} } });
  const session = await media.connect(a.relay.grant); t.after(() => session.close());
  await session.setInput(false); a.relay.close();
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(recoveries, 1); assert.equal(session.providerSessionId, 'generation-2');
  assert.equal(captures, 1); assert.deepEqual(b.commands, []);
});

test('AIT-160: relay grants are expiring, scoped, single-consumer and byte-bounded', async () => {
  const h = relayFixture();
  await assert.rejects(h.relay.connect({ ...h.relay.grant, opaque: { ...h.relay.grant.opaque, epoch: 9 } }), { code: 'not-admitted' });
  await h.relay.connect(h.relay.grant);
  await assert.rejects(h.relay.connect(h.relay.grant), { code: 'not-admitted' });
  assert.throws(() => h.relay.audio({ bytes: new Uint8Array(256_001) }), { code: 'limit' });
  h.relay.close();
});

test('AIT-160: composed server persists acknowledged holds and settles only its zero-cost parent', async t => {
  const storage = new SQLiteStorage(), session = storage.create({ ownerToken: 'offline-owner' }), reports = [];
  const plugin = createComposedVoice({ enabled: true, storage, stt: { stream() {} }, tts: { speak() {} },
    replyExecutor: { execute() {} }, authorize: async () => true, commitUtterance: async () => {}, admitComponent: async () => {} });
  t.after(() => storage.close());
  const call = await plugin.start({ callId: 'offline-call', sessionId: session.id, ownerToken: 'offline-owner' }, {
    deadlineAt: Date.now() + 5000, spendDeadlineAt: Date.now() + 60_000, browserLivenessDeadlineAt: Date.now() + 30_000,
    attempt: { attemptId: 'offline-parent', claimId: 'offline-parent-claim', maxMicro: 0, consume() {} }, report: value => reports.push(value) });
  await call.pause(); await call.resume();
  const result = await call.close(); await call.close();
  await assert.rejects(call.pause(), { code: 'unavailable' });
  assert.equal(result.chargedMicro, 0); assert.equal(reports.length, 1);
  assert.equal(storage.voiceCalls(session.id)[0].terminal.chargedMicro, 0);
});

test('AIT-160: delayed predecessor closure cannot silence a successor using the same player', async t => {
  const a = relayFixture(), b = relayFixture('generation-2'); let stops = 0;
  const media = createComposedBrowserMedia({ openRelay: grant => (grant.providerSessionId === 'generation-1' ? a : b).relay.connect(grant),
    capture: async () => ({ stop() {} }), player: { play() {}, stop() { stops++; } } });
  const old = await media.connect(a.relay.grant), successor = await media.connect(b.relay.grant);
  t.after(() => successor.close());
  const before = stops; await old.close(); assert.equal(stops, before);
});

test('AIT-160: a startup hold preserves the logical call and Resume uses a fresh capture signal', async t => {
  const h = relayFixture(), hold = new AbortController(); hold.abort('hide'); let captures = 0;
  const media = createComposedBrowserMedia({ openRelay: grant => h.relay.connect(grant),
    capture: async ({ signal }) => { assert.equal(signal.aborted, false); captures++; return { stop() {} }; },
    player: { play() {}, stop() {} } });
  const session = await media.connect(h.relay.grant, { holdSignal: hold.signal }); t.after(() => session.close());
  assert.equal(captures, 0); assert.deepEqual(h.commands, ['pause']);
  await session.resume(); assert.equal(captures, 1);
});

test('AIT-160: active hold stops capture without ending; lifetime cancellation stops immediately', async t => {
  const h = relayFixture(), hold = new AbortController(), lifetime = new AbortController(); let captures = 0, stops = 0;
  const media = createComposedBrowserMedia({ openRelay: grant => h.relay.connect(grant),
    capture: async () => { captures++; return { stop() { stops++; } }; }, player: { play() {}, stop() {} } });
  const session = await media.connect(h.relay.grant, { holdSignal: hold.signal, signal: lifetime.signal });
  t.after(() => session.close());
  hold.abort('hide'); assert.equal(stops, 1); await tick();
  await session.resume(); assert.equal(captures, 2);
  lifetime.abort(); assert.equal(stops, 2);
});

test('AIT-160: a hold during pending Resume acknowledgement keeps capture stopped', async t => {
  const h = relayFixture(), hold = new AbortController(), ready = Promise.withResolvers(), resume = Promise.withResolvers(); let captures = 0;
  const media = createComposedBrowserMedia({ openRelay: async grant => {
    const transport = await h.relay.connect(grant);
    return { ...transport, command(name, ...args) {
      if (name === 'resume') { ready.resolve(); return resume.promise; }
      return transport.command(name, ...args);
    } };
  }, capture: async () => { captures++; return { stop() {} }; }, player: { play() {}, stop() {} } });
  const session = await media.connect(h.relay.grant, { holdSignal: hold.signal }); t.after(() => session.close());
  await session.pause(); const pending = session.resume(); await ready.promise;
  hold.abort('hide'); resume.resolve({ acknowledged: true, paused: false });
  await assert.rejects(pending, { code: 'cancelled' }); assert.equal(captures, 1);
});

test('AIT-160: a hide during explicit generation recovery supersedes the pending Resume', async t => {
  const a = relayFixture(), b = relayFixture('generation-2'), hold = new AbortController();
  const ready = Promise.withResolvers(), release = Promise.withResolvers(); let captures = 0;
  const media = createComposedBrowserMedia({ openRelay: grant => (grant.providerSessionId === 'generation-1' ? a : b).relay.connect(grant),
    control: { recover: async () => { ready.resolve(); await release.promise; return b.relay.grant; } },
    capture: async () => { captures++; return { stop() {} }; }, player: { play() {}, stop() {} } });
  const session = await media.connect(a.relay.grant, { holdSignal: hold.signal }); t.after(() => session.close());
  await session.pause(); a.relay.close(); await tick();
  const pending = session.resume(); await ready.promise;
  hold.abort('hide'); release.resolve(); await assert.rejects(pending, { code: 'cancelled' });
  assert.equal(captures, 1); assert.deepEqual(b.commands, []);
});
