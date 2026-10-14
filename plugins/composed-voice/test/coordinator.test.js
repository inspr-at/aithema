import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComposedVoiceCoordinator, callDurationSeconds } from '../../../packages/server/src/composed-voice.js';
import { SQLiteStorage } from '../../../packages/server/src/storage.js';
import { createVoiceTurnOperations, createVoiceReplyExecutor } from '../../../packages/server/src/voice-turns.js';

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

test('AIT-160: pause holds capture until an authorized acknowledgement; defaults preserve start2', async t => {
  let allowed = true;
  const h = fixture(t, { authorize: async () => allowed });
  await h.coordinator.pause();
  await assert.rejects(h.coordinator.receiveAudio(pcm(100)), { code: 'not-admitted' });
  allowed = false; await assert.rejects(h.coordinator.resume(), { code: 'not-admitted' });
  assert.equal(h.coordinator.state.state, 'paused');
  allowed = true; await h.coordinator.resume();
  assert.equal(h.coordinator.state.state, 'active');
  assert.equal(callDurationSeconds(), 900); assert.equal(callDurationSeconds({ host: 'start2' }), 3600);
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
