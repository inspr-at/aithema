import { it } from 'node:test';
import assert from 'node:assert/strict';
import { PcmEnergyVad, createVadPort, createSpeechToTextPort, createTextToSpeechPort } from '../runtime/speech/index.js';

it('(c) VAD detects bounded 16 kHz PCM16 activity and distinguishes synthetic silence', async () => {
  const port = createVadPort(new PcmEnergyVad());
  assert.equal(Object.isFrozen(port), true);
  assert.deepEqual(await port.detect({ bytes: Buffer.alloc(640) }), { speech: false, rms: 0 });
  const frame = Buffer.alloc(640); for (let n = 0; n < frame.length; n += 2) frame.writeInt16LE(n % 4 ? 5000 : -5000, n);
  const result = await port.detect({ bytes: frame });
  assert.equal(result.speech, true); assert.equal(result.rms, 5000 / 32768);
});

it('(c) VAD refuses pre-cancelled, empty, odd, oversized and invalid frames', async () => {
  const port = createVadPort(new PcmEnergyVad());
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(3), Buffer.alloc(3202), 'audio', null]) await assert.rejects(port.detect({ bytes }));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(port.detect({ bytes: Buffer.alloc(640), signal: abort.signal }), { name: 'AbortError' });
  await assert.rejects(port.detect({ bytes: Buffer.alloc(640), signal: {} }), TypeError);
  for (const options of [{ threshold: 0 }, { threshold: NaN }, { threshold: 2 }, { maxFrameMs: 101 }, { maxFrameMs: 0 }]) {
    assert.throws(() => new PcmEnergyVad(options));
  }
});

it('speech port factories forward the same request, AbortSignal and adapter receiver as text ports', async () => {
  const signal = new AbortController().signal;
  const request = { signal };
  const adapter = {
    label: 'receiver',
    async *streamTranscribe(input) { assert.equal(input, request); yield this.label; },
    async transcribe(input) { assert.equal(input.signal, signal); return this.label; },
    async *streamSynthesize(input) { assert.equal(input, request); yield this.label; },
    async synthesize(input) { assert.equal(input.signal, signal); return this.label; },
  };
  const stt = createSpeechToTextPort(adapter), tts = createTextToSpeechPort(adapter);
  assert.equal(Object.isFrozen(stt), true); assert.equal(Object.isFrozen(tts), true);
  assert.equal(await stt.transcribe(request), 'receiver'); assert.equal(await tts.synthesize(request), 'receiver');
  assert.equal((await stt.streamTranscribe(request).next()).value, 'receiver');
  assert.equal((await tts.streamSynthesize(request).next()).value, 'receiver');
  for (const factory of [createSpeechToTextPort, createTextToSpeechPort, createVadPort]) assert.throws(() => factory({}), TypeError);
});
