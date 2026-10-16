import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PluginError } from '../../../packages/core/src/invocation.js';
import { createComposedVoiceCoordinator } from '../../../packages/server/src/composed-voice.js';
import { createElevenLabsTTS } from '../../elevenlabs/src/components.js';
import { fixtureBinding, fixtureConsent, fixtureConfig } from '../../elevenlabs/test/component-fixtures.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const speech = () => { const bytes = Buffer.alloc(3200); for (let i = 0; i < bytes.length; i += 2) bytes.writeInt16LE(8000, i); return bytes; };

// Mirror qualification-live-transport: messages are independently arriving,
// maxPayload and unread backlog are both 256,000 B; overflow is provider.
function boundedSocket(signal) {
  let bytes = 0, peak = 0, consumed = 0, failure, ended = false, wake, aborted = false;
  const messages = [];
  const notify = () => { wake?.(); wake = undefined; };
  const close = () => { ended = true; messages.length = 0; bytes = 0; notify(); signal.removeEventListener('abort', abort); };
  const abort = () => { aborted = true; close(); };
  signal.addEventListener('abort', abort, { once: true });
  return {
    send() {}, close,
    get backlog() { return bytes; }, get peak() { return peak; }, get consumed() { return consumed; },
    get failure() { return failure; }, get aborted() { return aborted; }, get closed() { return ended; },
    deliver(wire) {
      if (ended || failure) return;
      const size = Buffer.byteLength(wire);
      if (size > 256_000 || bytes + size > 256_000) { failure = new PluginError('provider'); notify(); return; }
      messages.push(wire); bytes += size; peak = Math.max(peak, bytes); notify();
    },
    events: {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        while (!ended && !failure && !messages.length) await new Promise(resolve => { wake = resolve; });
        if (failure) throw failure;
        if (!messages.length) return { done: true };
        const value = messages.shift(); bytes -= Buffer.byteLength(value); consumed++;
        return { value, done: false };
      },
      async return() { close(); return { done: true }; },
    },
  };
}

async function setup(t, { tts, blockRelay = false, text = 'a'.repeat(240), leaseMs = 600_000, spendMs = 600_000,
  fragmentCharacters = 240, format = 'pcm_s16le', onAudio, retainAudio = true } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 });
  const published = [], events = [], silences = [], reports = [], sockets = [];
  const release = Promise.withResolvers();
  tts ??= createElevenLabsTTS({ enabled: true, config: fixtureConfig,
    consent: fixtureConsent(fixtureBinding('tts')), resolveSecret: () => 'synthetic-auth',
    connect: ({ signal }) => { const socket = boundedSocket(signal); socket.openedAt = Date.now(); sockets.push(socket); return socket; } });
  let turns = 0;
  const coordinator = createComposedVoiceCoordinator({ sessionId: 'provider-pacing', callId: 'provider-pacing', tts,
    spendDeadlineAt: Date.now() + spendMs, browserLivenessDeadlineAt: Date.now() + leaseMs, maxDurationSeconds: 3600, fragmentCharacters,
    outputFormat: format, outputAudioFormat: { encoding: format, sampleRateHz: 24_000, channels: 1 },
    stt: { async *stream({ audio }) { for await (const _ of audio) { /* drain ingress */ } yield { text: ++turns === 1 ? 'Ja' : '', final: true }; } },
    replyExecutor: { async *execute() {
      yield { type: 'operation', replyId: 'reply' }; yield { type: 'delta', text };
      yield { type: 'completion', replyId: 'reply', text };
    } }, authorize: async () => true, commitUtterance: async () => {},
    admitComponent: async ({ role }) => ({ attempt: { attemptId: role, claimId: 'claim', maxMicro: 100_000, consume() {} }, report: value => reports.push(value) }),
    relay: { event: value => events.push(value), silence: value => silences.push(value),
      audio: value => { const result = onAudio?.(value); if (retainAudio) published.push({ ...value, at: Date.now() }); return blockRelay ? release.promise : result; } } });
  t.after(async () => { await coordinator.close(); release.resolve(); await coordinator.idle(); });
  await coordinator.receiveAudio(speech()); await coordinator.receiveAudio(Buffer.alloc(16_000)); await tick();
  return { coordinator, published, events, silences, reports, sockets,
    async advance(ms) { for (let elapsed = 0; elapsed < ms; elapsed += 25) { t.mock.timers.tick(25); await tick(); } } };
}

const wire = bytes => JSON.stringify({ audio: bytes.toString('base64'), isFinal: false });
const final = JSON.stringify({ audio: null, isFinal: true });

test('AIT-258: next speak opens after provider final and before the previous fragment drains', async t => {
  const h = await setup(t, { text: 'First. Second. ' }), first = h.sockets[0];
  for (let i = 0; i < 4; i++) { first.deliver(wire(Buffer.alloc(64_000, 1))); await tick(); }
  assert.equal(h.sockets.length, 1, 'only one provider stream can open before its terminal');
  const terminalAt = Date.now(); first.deliver(final); await tick();
  assert.equal(first.closed, true, 'the previous provider closes before the next opens');
  assert.equal(h.sockets.length, 2, 'next speak dispatch must not wait for playback');
  const second = h.sockets[1];
  assert.equal(second.openedAt, terminalAt, 'no playback-clock advance between provider final and next dispatch');
  for (let i = 0; i < 4; i++) { second.deliver(wire(Buffer.alloc(64_000, 2))); await tick(); }
  second.deliver(final); await tick();
  await h.advance(12_000); await h.coordinator.idle();
  const lastFirstFrame = h.published.filter(frame => frame.bytes[0] === 1).at(-1);
  assert.ok(second.openedAt < lastFirstFrame.at, 'next speak dispatch precedes the pacer last-frame time');
  assert.deepEqual(Buffer.concat(h.published.map(frame => frame.bytes)),
    Buffer.concat([Buffer.alloc(256_000, 1), Buffer.alloc(256_000, 2)]));
  assert.equal(h.reports.filter(report => report.attemptId === 'tts' && report.outcome === 'completed').length, 2);
});

test('AIT-258: third speak waits for acknowledgement of the first fragment last relay', async t => {
  const acknowledged = Promise.withResolvers(); let speaks = 0, frames = 0;
  const h = await setup(t, { text: 'First. Second. Third. ',
    onAudio({ bytes }) { if (bytes[0] === 1 && ++frames === 3) return acknowledged.promise; },
    tts: { async *speak() { const index = ++speaks; for (let i = 0; i < 3; i++) yield Buffer.alloc(48_000, index); } } });
  assert.equal(speaks, 2);
  await h.advance(2000);
  assert.equal(frames, 3, 'the last first-fragment frame reached the relay');
  assert.equal(speaks, 2, 'pending last-frame acknowledgement still holds the first slot');
  acknowledged.resolve(); await tick();
  assert.equal(speaks, 3, 'acknowledgement releases the next speak without another clock tick');
  await h.advance(8000); await h.coordinator.idle();
  assert.equal(h.published.length, 9);
  assert.ok(!h.events.some(event => event.type === 'waiting'));
});

test('AIT-258: empty lookahead retains FIFO order and interrupt releases a waiting dispatch', async t => {
  let speaks = 0;
  const h = await setup(t, { text: 'First. Second. Third. ', blockRelay: true,
    tts: { async *speak() { if (++speaks === 1) yield Buffer.alloc(48_000); } } });
  assert.equal(speaks, 2, 'empty N+1 cannot let N+2 bypass the blocked N');
  assert.equal(h.reports.filter(report => report.attemptId === 'tts').length, 2);
  const silent = h.silences.length, pending = h.coordinator.interrupt();
  assert.equal(h.silences.length, silent + 1);
  await pending; await h.coordinator.idle();
  assert.equal(speaks, 2, 'waiting dispatch was never admitted or opened');
  assert.equal(h.reports.filter(report => report.attemptId === 'tts').length, 2);
  assert.ok(h.events.some(event => event.type === 'final' && event.role === 'assistant'));
  await h.advance(10_000); assert.equal(h.published.length, 1, 'no stale audio after interruption');
});

test('AIT-258: bounded fake socket rejects two unread 137 KB messages', () => {
  const socket = boundedSocket(new AbortController().signal), message = wire(Buffer.alloc(102_540));
  assert.ok(Buffer.byteLength(message) > 136_000 && Buffer.byteLength(message) < 138_000);
  socket.deliver(message); socket.deliver(message);
  assert.equal(socket.failure?.code, 'provider'); socket.close();
});

test('AIT-258: eager reader drains bounded provider messages while one-second pacer runs', async t => {
  const h = await setup(t), expected = [], started = Date.now();
  assert.equal(h.sockets.length, 1);
  const socket = h.sockets[0];
  for (let i = 0; i < 8; i++) {
    const bytes = Buffer.alloc(102_540, i + 1); expected.push(bytes); socket.deliver(wire(bytes));
    await tick(); // Let arrival microtasks settle before advancing simulated time.
    await h.advance(25);
    assert.equal(socket.failure, undefined, 'pacing must never stall the bounded reader');
    assert.equal(socket.backlog, 0, 'each message is consumed before the next arrives');
  }
  socket.deliver(final); await tick();
  assert.equal(socket.consumed, 9, 'terminal is read before queued audio finishes playing');
  assert.equal(h.reports.filter(report => report.attemptId === 'tts').length, 1);
  assert.equal(h.reports.find(report => report.attemptId === 'tts').outcome, 'completed');
  assert.equal(h.published[0].at, started, 'immediate first audio');
  await h.advance(18_000); await h.coordinator.idle();
  assert.equal(h.coordinator.state.state, 'active'); assert.ok(socket.peak < 138_000);
  assert.deepEqual(Buffer.concat(h.published.map(frame => frame.bytes)), Buffer.concat(expected));
  let total = 0;
  for (const frame of h.published) { total += frame.bytes.length; assert.ok(total / 48_000 <= (frame.at - started) / 1000 + 1.001); }
  assert.ok(!h.events.some(event => event.type === 'waiting'));
});

test('AIT-258: bounded provider cancellation closes the socket and finishes one uncertain invocation', async t => {
  const h = await setup(t), socket = h.sockets[0];
  for (let i = 0; i < 8; i++) { socket.deliver(wire(Buffer.alloc(102_540, i))); await tick(); }
  assert.equal(socket.consumed, 8); assert.equal(socket.backlog, 0);
  const count = h.published.length, silent = h.silences.length;
  const pending = h.coordinator.interrupt();
  assert.equal(h.silences.length, silent + 1); assert.equal(socket.aborted, true);
  await pending; await h.coordinator.idle();
  const reports = h.reports.filter(report => report.attemptId === 'tts');
  assert.equal(reports.length, 1); assert.equal(reports[0].outcome, 'uncertain');
  assert.equal(socket.backlog, 0); assert.equal(h.published.length, count);
  socket.deliver(wire(Buffer.alloc(102_540))); socket.deliver(final);
  await h.advance(20_000);
  assert.equal(h.reports.filter(report => report.attemptId === 'tts').length, 1);
  assert.equal(h.published.length, count, 'late provider audio cannot refill a dropped queue');
});

// 30,000 characters also exceeds the former 32 MB backlog at 10x synthesis.
for (const [format, fragmentCharacters] of [['pcm_s16le', 240], ['pcm_f32le', 240], ['pcm_f32le', 1000]]) {
  test(`AIT-258: ${format} ${fragmentCharacters}-character fragments keep 30,000 characters at 10x TTS within two buffers`, async t => {
    const bytesPerSecond = format === 'pcm_s16le' ? 48_000 : 96_000;
    const fragmentBytes = fragmentCharacters / 12 * bytesPerSecond;
    const dispatches = [], terminals = [], relayed = [], spoken = [];
    let buffered = 0, peak = 0, open = 0, produced = 0, delivered = 0, firstAt, lastAt, lastFragment = 0;
    const h = await setup(t, { format, fragmentCharacters, text: 'a'.repeat(30_000), retainAudio: false,
      leaseMs: 3_600_000, spendMs: 3_600_000,
      onAudio({ bytes }) {
        const index = bytes[0] - 1;
        assert.ok(index === lastFragment || index === lastFragment + 1, 'fragment audio stays ordered');
        lastFragment = index;
        relayed[index] = (relayed[index] ?? 0) + bytes.length;
        buffered -= bytes.length; delivered += bytes.length;
        firstAt ??= Date.now(); lastAt = Date.now();
        assert.ok(delivered / bytesPerSecond <= (lastAt - firstAt) / 1000 + 1.001, 'L = one second throughout the reply');
      },
      tts: { async *speak({ text }, opts) {
        const index = dispatches.length;
        assert.equal(++open, 1, 'only one open TTS provider');
        if (index >= 2) assert.equal(relayed[index - 2], spoken[index - 2], 'N+2 must wait for N last relayed frame');
        dispatches.push(Date.now());
        spoken[index] = text.length / 12 * bytesPerSecond;
        try {
          for (let offset = 0; offset < spoken[index];) {
            const size = Math.min(bytesPerSecond / 2, spoken[index] - offset);
            // Half a second of speech arrives in 50 ms: exactly 10x real time.
            if (offset) await new Promise(resolve => setTimeout(resolve, 50));
            opts.signal.throwIfAborted();
            buffered += size; produced += size; peak = Math.max(peak, buffered);
            assert.ok(buffered <= 2 * fragmentBytes, 'retained PCM never exceeds two fragments');
            offset += size; yield Buffer.alloc(size, index + 1);
          }
          terminals.push(Date.now());
        } finally { open--; }
      } } });
    const started = Date.now();
    await h.advance(2_550_000); await h.coordinator.idle();
    assert.equal(dispatches.length, Math.ceil(30_000 / fragmentCharacters));
    assert.equal(terminals.length, dispatches.length);
    assert.equal(dispatches[1], terminals[0], 'N+1 opens at the previous provider terminal');
    assert.equal(firstAt, started, 'first frame is immediate');
    assert.equal(delivered, 30_000 / 12 * bytesPerSecond);
    assert.equal(delivered, produced); assert.equal(buffered, 0);
    assert.ok(peak <= 2 * fragmentBytes);
    assert.ok(peak < 2 * (fragmentCharacters / 4 * bytesPerSecond) + 64_000, 'never reaches the derived queue ceiling');
    assert.ok(lastAt - firstAt >= 2_499_000, 'one-second lead spans the whole reply');
    assert.equal(h.coordinator.state.state, 'active');
    assert.ok(!h.events.some(event => event.type === 'waiting'));
    assert.equal(h.reports.filter(report => report.attemptId === 'tts').length, dispatches.length, 'accounting once per speak');
  });
}

for (const format of ['pcm_s16le', 'pcm_f32le']) {
  test(`AIT-258: ${format} two worst-case fragments fit while the pacer holds a chunk`, async t => {
    const fragmentBytes = 240 / 4 * (format === 'pcm_s16le' ? 48_000 : 96_000);
    let speaks = 0, produced = 0;
    const h = await setup(t, { format, blockRelay: true, text: 'a'.repeat(720),
      tts: { async *speak() {
        speaks++;
        for (let offset = 0; offset < fragmentBytes; offset += 64_000) {
          const size = Math.min(64_000, fragmentBytes - offset); produced += size; yield Buffer.alloc(size);
        }
      } } });
    await tick();
    assert.equal(speaks, 2, 'third fragment waits before admission');
    assert.equal(produced, 2 * fragmentBytes, 'both maximum duration allowances fit');
    assert.equal(h.published.length, 1, 'the pacer-held chunk is included');
    assert.ok(!h.events.some(event => event.type === 'waiting'));
    await h.coordinator.interrupt(); await h.coordinator.idle();
    assert.equal(h.reports.filter(report => report.attemptId === 'tts').length, 2);
  });
}

for (const [format, fragmentCharacters] of [['pcm_s16le', 240], ['pcm_f32le', 240], ['pcm_f32le', 1000]]) {
  test(`AIT-258: ${format} ${fragmentCharacters}-character single fragment exceeding derived bound fails with limit`, async t => {
    const bytesPerSecond = format === 'pcm_s16le' ? 48_000 : 96_000;
    const bound = 2 * (fragmentCharacters / 4 * bytesPerSecond) + 64_000;
    let aborted = false, speaks = 0;
    const h = await setup(t, { format, fragmentCharacters, blockRelay: true, text: 'a'.repeat(fragmentCharacters),
      tts: { async *speak(_, { signal }) {
        speaks++; signal.addEventListener('abort', () => { aborted = true; }, { once: true });
        for (let bytes = 0; bytes <= bound; bytes += 64_000) yield Buffer.alloc(64_000);
      } } });
    await tick();
    assert.equal(speaks, 1);
    assert.ok(h.events.some(event => event.type === 'waiting' && event.reason === 'limit'));
    assert.equal(h.published.length, 1); assert.equal(aborted, true);
  });
}

test('AIT-258: server reply queue also bounds tiny-chunk metadata', async t => {
  const h = await setup(t, { blockRelay: true, tts: { async *speak() { for (let i = 0; i < 1025; i++) yield Buffer.alloc(2); } } });
  await tick();
  assert.ok(h.events.some(event => event.type === 'waiting' && event.reason === 'limit'));
});

for (const action of ['barge-in', 'interrupt', 'pause', 'output-off', 'close', 'lease-expired', 'spend-deadline']) {
  test(`AIT-258: ${action} drops two queued fragments, aborts TTS and settles without playback time`, async t => {
    const filled = Promise.withResolvers(); let aborted = false, finished = false, speaks = 0;
    const h = await setup(t, { blockRelay: true, text: 'First. Second. ', leaseMs: action === 'spend-deadline' ? 900_000 : 600_000,
      spendMs: action === 'lease-expired' ? 900_000 : 600_000, tts: { async *speak(_, { signal }) {
      const index = ++speaks;
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      try {
        for (let i = 0; i < 40; i++) yield Buffer.alloc(64_000);
        if (index === 1) return;
        filled.resolve(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      } finally { if (index === 2) finished = true; }
    } } });
    await filled.promise; const count = h.published.length, silent = h.silences.length;
    assert.equal(speaks, 2, 'both fragments are queued while the second provider remains open');
    let pending;
    if (action === 'barge-in') pending = h.coordinator.receiveAudio(speech());
    else if (action === 'output-off') pending = h.coordinator.setOutput(false);
    else if (action === 'lease-expired') { t.mock.timers.tick(600_000); pending = Promise.resolve(); }
    else if (action === 'spend-deadline') { t.mock.timers.tick(600_000); pending = Promise.resolve(); }
    else pending = h.coordinator[action]();
    assert.ok(h.silences.length > silent, 'silence is synchronous'); assert.equal(aborted, true, 'TTS is aborted synchronously');
    await pending;
    // End a new barge-in utterance without advancing playback timers.
    if (action === 'barge-in') await h.coordinator.receiveAudio(Buffer.alloc(16_000));
    await h.coordinator.idle(); assert.equal(finished, true);
    assert.equal(h.published.length, count, 'no frame after the revision fence');
    assert.equal(h.reports.filter(report => report.attemptId === 'tts').length, 2, 'each invocation finishes exactly once');
    if (['barge-in', 'interrupt', 'output-off'].includes(action)) {
      assert.ok(h.events.some(event => event.type === 'final' && event.role === 'assistant'), 'admitted reasoning still completes');
    }
    await h.coordinator.close(); t.mock.timers.tick(1_000_000); await tick();
    assert.equal(h.published.length, count, 'terminal cleanup leaves no playback timer');
  });
}
