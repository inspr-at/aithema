import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComposedVoiceCoordinator, callDurationSeconds } from '@inspr/aithema-server/composed-voice';
import { elevenLabsCompletion, runElevenLabsReply } from '../../elevenlabs/src/reply.js';
import { SQLiteStorage } from '../../../packages/server/src/storage.js';
import { createVoiceTurnOperations, createVoiceReplyExecutor } from '../../../packages/server/src/voice-turns.js';
import { createComposedRelay } from '@inspr/aithema-server/composed-voice/relay';
import { createComposedBrowserMedia } from '@inspr/aithema-server/composed-voice/client';
import { createGrokVoiceClient } from '../../grok-voice/src/client.js';
import { Window } from 'happy-dom';
import { AudioRail } from '../../../packages/ui/src/audio-rail.js';
import { de } from '../../../packages/ui/src/i18n/de.js';

const pcm = (ms, amplitude = 8000) => {
  const bytes = Buffer.alloc(ms * 32);
  for (let i = 0; i < bytes.length; i += 2) bytes.writeInt16LE(amplitude, i);
  return bytes;
};
const collect = async source => { const values = []; for await (const item of source) values.push(item); return values; };

function fixture(t, overrides = {}) {
  const storage = new SQLiteStorage(), session = storage.create({ ownerToken: 'offline-owner' });
  const turns = createVoiceTurnOperations({ storage });
  let admissions = 0;
  const envelopes = [], audio = [], reports = [], commits = [], silences = [];
  const executor = createVoiceReplyExecutor({ execute(envelope, options) {
    envelopes.push(envelope);
    return turns.run(envelope.payload, worker => {
      worker.beforeAdmission(); worker.admitted(`reasoning-${++admissions}`);
      return { replyId: `reply-${admissions}`, created: 1, events: (async function* () {
        yield { type: 'delta', text: 'Welche Firma? ' };
        yield { type: 'completion', text: 'Welche Firma? ' };
      })() };
    }, options);
  } });
  const coordinator = createComposedVoiceCoordinator({ sessionId: session.id, callId: 'call-offline',
    providerSessionId: 'composed-generation-1', spendDeadlineAt: Date.now() + 60_000,
    browserLivenessDeadlineAt: Date.now() + 30_000,
    authorize: async () => true,
    commitUtterance: async envelope => { commits.push(envelope); },
    replyExecutor: executor,
    stt: { async *stream({ audio }, options) {
      await options.attempt.consume(); await collect(audio);
      await options.report({ attemptId: options.attempt.attemptId, outcome: 'completed',
        usage: { attemptId: options.attempt.attemptId, role: 'stt', unit: 'seconds', quantity: 1,
          upstreamMicro: 0, source: 'fixture', estimated: false } });
      yield { text: 'Ja', final: true };
    } },
    tts: { async *speak({ text }, options) {
      await options.attempt.consume(); yield new Uint8Array([1, 2, 3, 4]);
      await options.report({ attemptId: options.attempt.attemptId, outcome: 'completed',
        usage: { attemptId: options.attempt.attemptId, role: 'tts', unit: 'characters', quantity: text.length,
          upstreamMicro: 0, source: 'fixture', estimated: false } });
    } },
    admitComponent: async ({ role, signal, deadlineAt }) => ({ signal, deadlineAt,
      attempt: { attemptId: `${role}-${reports.length}-${crypto.randomUUID()}`, claimId: 'offline-claim', maxMicro: 0, consume() {} },
      report: terminal => { reports.push(terminal); } }),
    relay: { audio: frame => { audio.push(frame); }, silence: frame => { silences.push(frame); }, event() {} },
    ...overrides });
  t.after(async () => { await coordinator.close(); await turns.idle(); storage.close(); });
  return { coordinator, storage, session, turns, envelopes, audio, reports, commits, silences, get admissions() { return admissions; } };
}

test('AIT-160: server endpointing commits repeated Ja once each with Rule C identity and replay', async t => {
  const h = fixture(t);
  for (let i = 0; i < 2; i++) {
    await h.coordinator.receiveAudio(pcm(100)); await h.coordinator.receiveAudio(pcm(500, 0));
    await h.coordinator.idle();
  }
  assert.equal(h.commits.length, 2); assert.equal(h.admissions, 2);
  assert.equal(h.envelopes[0].source, 'server-coordinator');
  assert.ok(Object.isFrozen(h.envelopes[0].payload.callbackBody));
  const operations = h.storage.voiceOperations(h.session.id);
  assert.deepEqual(operations.map(x => x.ordinal), [1, 2]);
  assert.notEqual(operations[0].key, operations[1].key);
  await collect(h.coordinator.replyExecutor.execute(h.envelopes[0], {}));
  assert.equal(h.admissions, 2); assert.equal(h.audio.length, 2);
  assert.deepEqual(h.reports.map(x => x.usage.role).sort(), ['stt', 'stt', 'tts', 'tts']);
});

test('AIT-160: interruption stops playback synchronously and retains admitted reasoning', async t => {
  const release = Promise.withResolvers();
  let finished = false;
  const h = fixture(t, { replyExecutor: { async *execute(envelope) {
    yield { type: 'operation', operation: { key: 'fixture', ordinal: 1 }, replyId: 'reply-1' };
    await release.promise; finished = true;
    yield { type: 'delta', text: 'Late reply.' }; yield { type: 'completion', replyId: 'reply-1', text: 'Late reply.' };
  } } });
  t.after(() => release.resolve());
  await h.coordinator.receiveAudio(pcm(100)); await h.coordinator.receiveAudio(pcm(500, 0));
  await new Promise(resolve => setImmediate(resolve));
  const before = h.silences.length;
  const interrupt = h.coordinator.interrupt();
  assert.equal(h.silences.length, before + 1);
  release.resolve(); await interrupt; await h.coordinator.idle();
  assert.equal(finished, true); assert.equal(h.audio.length, 0);
});

test('AIT-383 round 3: a browser typed turn stops server TTS and records the previous reply interrupted', async t => {
  const at = Date.now(), heard = Promise.withResolvers(), release = Promise.withResolvers(), saved = [];
  const relay = createComposedRelay({ callId: 'call-offline', providerSessionId: 'composed-generation-1', epoch: 0,
    expiresAt: at + 60_000, spendDeadlineAt: at + 60_000, browserLivenessDeadlineAt: at + 30_000 });
  let synthesisSignal, lateChunks = 0;
  const audio = [];
  const h = fixture(t, { interruptionAwareness: true,
    commitUtterance: async (envelope, opts) => { saved.push({ envelope, ...opts }); },
    relay: { event: value => relay.event(value), silence: value => relay.silence(value),
      audio: frame => { audio.push(frame); relay.audio(frame); } },
    replyExecutor: { async *execute(envelope) {
      const first = envelope.payload.callbackBody.messages.at(-1).content === 'First';
      const replyId = first ? 'reply-A' : 'reply-B', text = first ? 'First answer. ' : 'Second answer.';
      yield { type: 'operation', replyId };
      yield { type: 'delta', text };
      yield { type: 'completion', replyId, text };
    } },
    tts: { capabilities: { heardPrefix: 'unavailable' }, async *speak({ text }, opts) {
      await opts.attempt.consume();
      if (text === 'First answer. ') {
        synthesisSignal = opts.signal;
        yield new Uint8Array(4);
        await release.promise; lateChunks++;
        yield new Uint8Array(4);
      } else yield new Uint8Array(4);
    } } });
  relay.attach(h.coordinator);
  const media = createComposedBrowserMedia({ openRelay: grant => relay.connect(grant),
    capture: async () => ({ stop() {} }), player: { stop() {}, play() { heard.resolve(); } } });
  const session = await media.connect(relay.grant);
  t.after(async () => { release.resolve(); await session.close(); });
  await session.sendText('First', { deliveryId: 'first' }); await heard.promise;
  const before = audio.filter(frame => frame.replyId === 'reply-A').length;
  assert.equal(before, 1);
  await session.sendText('Second', { deliveryId: 'second' });
  assert.equal(synthesisSignal.aborted, true, 'the typed turn must stop synthesis on the server');
  assert.deepEqual(saved.filter(value => value.role === 'interrupted').map(value => [value.replyId, value.heardLength]),
    [['reply-A', 'unknown']], 'Grok has no confirmed played offset; never claim the full reply was heard');
  release.resolve(); await h.coordinator.idle();
  assert.equal(audio.filter(frame => frame.replyId === 'reply-A').length, before, 'no reply-A TTS frames after the typed turn');
  assert.equal(audio.filter(frame => frame.replyId === 'reply-B').length, 1);
  assert.equal(lateChunks, 1, 'even an uncooperative late provider chunk is fenced');
  await session.sendText('Second', { deliveryId: 'second' });
  assert.equal(saved.filter(value => value.role === 'interrupted').length, 1, 'a delivery retry is not a new interruption');
});

for (const turn of ['typed', 'spoken']) for (const late of [false, true]) {
  test(`AIT-383 round 4: ${turn} turn fences an interrupted final ${late ? 'after' : 'before'} S5 appears`, { timeout: 10_000 }, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100_000 });
    const flush = async () => { for (let n = 0; n < 8; n++) await new Promise(resolve => setImmediate(resolve)); };
    const advance = async ms => {
      while (ms > 0) { const step = Math.min(ms, 1000); t.mock.timers.tick(step); await flush(); ms -= step; }
    };
    const releaseA = Promise.withResolvers(), releaseB = Promise.withResolvers(), heard = Promise.withResolvers();
    const saved = [], serverFinals = [], clientFinals = [];
    const at = Date.now(), relay = createComposedRelay({ callId: 'call-offline', providerSessionId: 'composed-generation-1', epoch: 0,
      expiresAt: at + 60_000, spendDeadlineAt: at + 60_000, browserLivenessDeadlineAt: at + 30_000 });
    const h = fixture(t, { interruptionAwareness: true,
      commitUtterance: async (envelope, opts) => { saved.push({ envelope, ...opts }); },
      relay: { audio: frame => relay.audio(frame), silence: frame => relay.silence(frame), event: value => {
        if (value.type === 'final' && value.role === 'assistant') serverFinals.push(value);
        relay.event(value);
      } },
      replyExecutor: { async *execute(envelope) {
        const first = envelope.payload.callbackBody.messages.at(-1).content === 'First';
        const replyId = first ? 'reply-A' : 'reply-B', text = first ? 'First answer. ' : 'Second answer.';
        yield { type: 'operation', replyId };
        // A is audible but reasoning has not completed when B interrupts it.
        if (first) { yield { type: 'delta', text }; await releaseA.promise; }
        else { await releaseB.promise; yield { type: 'delta', text }; }
        yield { type: 'completion', replyId, text };
      } },
      tts: { capabilities: { heardPrefix: 'unavailable' }, async *speak() { yield new Uint8Array(4); } } });
    relay.attach(h.coordinator);
    let capture;
    const client = createGrokVoiceClient({
      control: { async start() { return { ...relay.grant, epoch: 0, mediaGrant: relay.grant }; },
        close: () => h.coordinator.close(), heartbeat: () => h.coordinator.heartbeat(),
        async pause() {}, async resume() {}, async recover() { assert.fail('No recovery expected'); } },
      openRelay: grant => relay.connect(grant), capture: async opts => { capture = opts; return { stop() {} }; },
      // No device-start callback for B: its final alone must clear S5.
      player: { stop() {}, play() { heard.resolve(); } } });
    const window = new Window(), root = window.document.createElement('div'); window.document.body.append(root);
    const rail = new AudioRail({ root, copy: de, client, context: () => ({}), feature: () => ({ available: true }),
      onFinal: event => clientFinals.push(event) });
    t.after(async () => {
      releaseA.resolve(); releaseB.resolve(); await rail.close(); rail.destroy(); await window.happyDOM.abort();
    });
    await rail.start();
    await rail.sendText('First'); await heard.promise;
    if (turn === 'typed') await rail.sendText('Second');
    else { await capture.onAudio(pcm(100)); await capture.onAudio(pcm(500, 0)); }
    await flush();
    assert.equal(clientFinals.filter(event => event.role === 'user').length, 2, 'both visitor turns reached the real rail');
    const watch = rail.replyTimer;
    assert.ok(watch, 'B arms a new S5 watch');
    await advance(late ? 15_000 : 14_999);
    assert.equal(rail.errorKey, late ? 'voiceNoReply' : null);
    const state = rail.state;
    releaseA.resolve(); await flush();
    assert.equal(serverFinals.find(event => event.turnId === 'reply-A')?.text, 'First answer. ', 'interrupted reasoning still completes');
    assert.deepEqual(saved.filter(value => value.role === 'interrupted').map(value => [value.replyId, value.heardLength]),
      [['reply-A', 'unknown']], 'retain the AIT-349 interruption record');
    assert.equal(rail.replyTimer, watch, 'A\'s late final must not clear B\'s watch');
    assert.equal(rail.errorKey, late ? 'voiceNoReply' : null, 'A\'s late final must not dismiss visible S5');
    assert.equal(rail.state, state, 'A\'s late final must not flip S5 to speaking');
    assert.equal(clientFinals.some(event => event.turnId === 'reply-A'), false, 'the interrupted final stays out of the live rail');
    if (!late) { await advance(1); assert.equal(rail.errorKey, 'voiceNoReply', 'B still times out at 15 s'); }
    releaseB.resolve(); await h.coordinator.idle(); await flush();
    assert.equal(clientFinals.filter(event => event.turnId === 'reply-B').length, 1);
    assert.equal(rail.replyTimer, null, 'B\'s own final clears its watch');
    assert.equal(rail.errorKey, null, 'B\'s own final clears S5');
    assert.equal(rail.state, 'speaking');
  });
}

test('AIT-160: pause holds capture until an authorized acknowledgement; explicit duration preserves the ceiling', async t => {
  let allowed = true;
  const h = fixture(t, { authorize: async () => allowed });
  await h.coordinator.pause();
  await assert.rejects(h.coordinator.receiveAudio(pcm(100)), { code: 'not-admitted' });
  allowed = false; await assert.rejects(h.coordinator.resume(), { code: 'not-admitted' });
  assert.equal(h.coordinator.state.state, 'paused');
  allowed = true; await h.coordinator.resume();
  assert.equal(h.coordinator.state.state, 'active');
  assert.equal(callDurationSeconds(), 900); assert.equal(callDurationSeconds({ maxDurationSeconds: 3600 }), 3600);
  assert.throws(() => callDurationSeconds({ maxDurationSeconds: Infinity }));
});

test('AIT-160: relay rejects text receipts, stale generations and oversized audio', async t => {
  const h = fixture(t);
  await assert.rejects(h.coordinator.receiveAudio({ text: 'forged final' }), TypeError);
  await assert.rejects(h.coordinator.receiveAudio(pcm(100), { providerSessionId: 'old-generation' }), { code: 'not-admitted' });
  await assert.rejects(h.coordinator.receiveAudio(Buffer.alloc(64_002)), { code: 'limit' });
  assert.equal(h.admissions, 0);
});

test('AIT-160: delayed STT finalizers preserve capture order and suppress the interrupted older reply', async t => {
  const first = Promise.withResolvers(), second = Promise.withResolvers(); let streams = 0;
  const h = fixture(t, { stt: { async *stream({ audio }, options) {
    const index = ++streams; await options.attempt.consume(); await collect(audio);
    if (index === 1) await first.promise; else second.resolve();
    await options.report({ attemptId: options.attempt.attemptId, outcome: 'completed', chargedMicro: 0 });
    yield { text: index === 1 ? 'Erste Firma' : 'Zweite Firma', final: true };
  } } });
  t.after(() => first.resolve());
  for (let i = 0; i < 2; i++) {
    await h.coordinator.receiveAudio(pcm(100)); await h.coordinator.receiveAudio(pcm(500, 0));
  }
  await second.promise; first.resolve(); await h.coordinator.idle();
  assert.deepEqual(h.commits.map(e => e.payload.callbackBody.messages.at(-1).content), ['Erste Firma', 'Zweite Firma']);
  assert.deepEqual(h.storage.voiceOperations(h.session.id).map(x => x.ordinal), [1, 2]);
  assert.equal(h.audio.length, 1); assert.equal(h.admissions, 2);
});

test('AIT-160: a component failure holds capture and requires a fresh segment', async t => {
  const h = fixture(t, { stt: { async *stream(request, options) {
    await options.attempt.consume(); throw new Error('synthetic failure');
  } } });
  await h.coordinator.receiveAudio(pcm(100)); await h.coordinator.idle();
  assert.equal(h.coordinator.state.state, 'waiting');
  await assert.rejects(h.coordinator.receiveAudio(pcm(100)), { code: 'not-admitted' });
  await assert.rejects(h.coordinator.resume(), { code: 'unavailable' });
  assert.equal(h.reports.length, 1); assert.equal(h.reports[0].outcome, 'uncertain');
});

test('AIT-160: lease expiry waits; the independent absolute spend deadline still ends the call', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let at = Date.now();
  const h = fixture(t, { now: () => at, browserLivenessDeadlineAt: at + 10, spendDeadlineAt: at + 100 });
  at += 10; t.mock.timers.tick(10);
  assert.equal(h.coordinator.state.state, 'waiting');
  at += 90; t.mock.timers.tick(90);
  assert.equal(h.coordinator.state.state, 'ended');
});

test('AIT-160: pause during pending server authorization cannot be cleared by a stale Resume', async t => {
  const ready = Promise.withResolvers(), release = Promise.withResolvers();
  const h = fixture(t, { authorize: async () => { ready.resolve(); await release.promise; return true; } });
  await h.coordinator.pause(); const pending = h.coordinator.resume(); await ready.promise;
  await h.coordinator.pause(); release.resolve();
  await assert.rejects(pending, { code: 'cancelled' }); assert.equal(h.coordinator.state.state, 'paused');
});

test('AIT-160 round 2: published assistant finals join multi-turn history in order', async t => {
  const h = fixture(t);
  for (let i = 0; i < 3; i++) {
    await h.coordinator.receiveAudio(pcm(100)); await h.coordinator.receiveAudio(pcm(500, 0));
    await h.coordinator.idle();
  }
  const assistant = elevenLabsCompletion({ replyId: 'fixture', created: 1 }, 'Welche Firma? ').choices[0].message;
  assert.deepEqual(h.commits[2].payload.callbackBody.messages, [
    { role: 'user', content: 'Ja' }, assistant,
    { role: 'user', content: 'Ja' }, assistant,
    { role: 'user', content: 'Ja' },
  ]);
});

test('AIT-160 round 2: Rule C digest matches ElevenLabs message shape for the same turns', async t => {
  const h = fixture(t);
  for (let i = 0; i < 2; i++) {
    await h.coordinator.receiveAudio(pcm(100)); await h.coordinator.receiveAudio(pcm(500, 0));
    await h.coordinator.idle();
  }
  const composed = h.storage.voiceOperations(h.session.id).find(operation => operation.ordinal === 2);
  const payload = h.commits[1].payload;
  const messages = [{ role: 'user', content: 'Ja' },
    elevenLabsCompletion({ replyId: 'fixture', created: 1 }, 'Welche Firma? ').choices[0].message,
    { role: 'user', content: 'Ja' }];
  const response = await runElevenLabsReply(h.turns, { ...payload, providerSessionId: 'elevenlabs-fixture',
    messages, callbackBody: { ...payload.callbackBody, messages }, stream: false }, async worker => {
    worker.beforeAdmission(); worker.admitted('elevenlabs-reasoning');
    return new Response('data: ' + JSON.stringify({ id: 'elevenlabs-reply', created: 1, choices: [{ delta: { content: 'Next reply.' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  assert.equal(response.status, 200);
  await response.text();
  const baseline = h.storage.voiceOperations(h.session.id).find(operation => operation.providerSessionId === 'elevenlabs-fixture');
  assert.equal(composed.historyDigest, baseline.historyDigest);
});

test('AIT-160 round 2: assistant history counts against the generation text limit', async t => {
  const h = fixture(t, { maxTextCharacters: 16 });
  for (let i = 0; i < 2; i++) {
    await h.coordinator.receiveAudio(pcm(100)); await h.coordinator.receiveAudio(pcm(500, 0));
    await h.coordinator.idle();
  }
  assert.equal(h.commits.length, 1);
  assert.equal(h.coordinator.state.state, 'waiting');
});

test('AIT-160 round 2: voiced barge-in silences before pending ingress authorization', async t => {
  const release = Promise.withResolvers(), entered = Promise.withResolvers(); let block = false;
  const h = fixture(t, { authorize: async () => {
    if (block) { entered.resolve(); await release.promise; }
    return true;
  } });
  t.after(() => release.resolve());
  await h.coordinator.receiveAudio(pcm(100)); await h.coordinator.receiveAudio(pcm(500, 0));
  await h.coordinator.idle(); assert.equal(h.audio.length, 1);
  block = true; const before = h.silences.length;
  const pending = h.coordinator.receiveAudio(pcm(100));
  try {
    await entered.promise;
    assert.equal(h.silences.length, before + 1, 'silence must not wait for authorization');
    assert.equal(h.silences.at(-1).reason, 'barge-in');
    assert.equal(h.commits.length, 1, 'new work still waits for authorization');
  } finally { release.resolve(); await pending; }
});


test('AIT-258: server preserves its aligned, nonempty 64,000 B output frame contract', async t => {
  for (const size of [0, 3, 64_004]) {
    const h = fixture(t, { tts: { async *speak() { yield new Uint8Array(size); } } });
    await h.coordinator.receiveAudio(pcm(100)); await h.coordinator.receiveAudio(pcm(500, 0));
    await h.coordinator.idle();
    assert.equal(h.coordinator.state.state, 'waiting'); assert.equal(h.audio.length, 0);
  }
});


test('AIT-345: supported coordinator reads explicit seconds and no host policy', async t => {
  const explicit = value => new Proxy(value, { get(target, key) {
    assert.notEqual(key, 'host', 'supported API must not read a host name');
    return Reflect.get(target, key);
  } });
  assert.equal(callDurationSeconds(explicit({})), 900);
  assert.equal(callDurationSeconds(explicit({ maxDurationSeconds: 3600 })), 3600);
  assert.throws(() => createComposedVoiceCoordinator(explicit({})), TypeError);
  const now = Date.now();
  for (const maxDurationSeconds of [undefined, 3600]) {
    const h = fixture(t, { now: () => now, spendDeadlineAt: now + 7200_000,
      browserLivenessDeadlineAt: now + 7200_000, maxDurationSeconds });
    assert.equal(h.coordinator.state.spendDeadlineAt, now + (maxDurationSeconds ?? 900) * 1000);
  }
});
