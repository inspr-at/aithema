import { componentInvocation } from '../src/voice-components.js';
import { PluginError } from '../src/invocation.js';
import { voiceOperation } from '../src/live-voice.js';

export const format = { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 };
export const transcript = [{ text: 'wrong', final: false }, { text: 'A😀 B', final: false }, { text: 'A😀 B', final: true }];
export const request = role => role === 'stt' ? { audio: new Uint8Array(4), language: 'en' } : { text: 'A😀 B', voice: 'fixture', language: 'en' };

export function speechFixture(role, fault, { consumeSource = 'manual' } = {}) {
  let mode, requests = 0, active = 0, observed = 0, cachedOptions, heard = '', delivered = [], playbackRequest;
  const playback = {
    reset(input) { heard = ''; delivered = []; playbackRequest = input; },
    deliver(chunk) { delivered.push(chunk); },
    confirm(count) { let bytes = 0; for (const chunk of delivered) { bytes += chunk.audio.byteLength; if (bytes <= count) heard = playbackRequest.text.slice(0, chunk.textEnd); } },
    heardPrefix() { return heard; },
  };
  const fixtures = { formats: [format], incompatibleFormats: [
    [{ ...format, encoding: 'unsupported-fixture' }], [{ ...format, sampleRateHz: 16001 }], [{ ...format, channels: 99 }]], timeoutMs: 300, expectedText: 'A😀 B', expectedTranscripts: transcript, playback,
    maxInputChunkBytes: 8, maxInputBytes: 16, maxTranscriptCharacters: 32, maxChunkBytes: 16, maxAudioBytes: 32,
    prepare(value) { mode = value.mode; observed = 0; }, requestCount: () => requests, activeCount: () => active, observedMicro: () => observed };
  async function* run(operation, input, rawOptions) {
    if (fault === 'timeout' && mode === 'completed') await new Promise(() => {});
    let options = rawOptions;
    if (fault === 'cancel' && mode === 'active-cancelled') options = { ...options, signal: new AbortController().signal };
    if (fault === 'deadline' && mode === 'active-deadline') options = { ...options, deadlineAt: Date.now() + 1000 };
    if (fault === 'fresh') { cachedOptions ??= rawOptions; options = cachedOptions; }
    if (fault === 'dispatch') requests++;
    const report = options.report;
    options = { ...options, report: async terminal => {
      if (fault === 'identity') terminal = { ...terminal, attemptId: 'wrong' };
      if (fault === 'uncertain' && terminal.outcome === 'uncertain') terminal = { ...terminal, chargedMicro: 0 };
      if (fault === 'observed' && terminal.outcome === 'uncertain') terminal = { ...terminal, chargedMicro: options.attempt.maxMicro };
      if (fault === 'usage' && terminal.usage) terminal = { ...terminal, usage: { ...terminal.usage, quantity: -1 } };
      if (fault !== 'settlement') await report(terminal);
      if (fault === 'duplicate') await report(terminal);
    } };
    const invocation = await componentInvocation(options, { role, unit: role === 'stt' ? 'seconds' : 'characters', model: 'fake' });
    let completed = false, audioIterator;
    try {
      invocation.dispatch(); if (fault !== 'dispatch') requests++; active++;
      if (operation === 'stream') {
        if (consumeSource === 'for-await') {
          let inputBytes = 0;
          for await (const audio of input.audio) {
            inputBytes += audio.byteLength;
            if (audio.byteLength > 8 || inputBytes > 16) throw new PluginError('limit');
          }
        } else {
          audioIterator = input.audio[Symbol.asyncIterator]();
          let inputBytes = 0;
          for (;;) { const item = await audioIterator.next(); if (item.done) break;
            inputBytes += item.value.byteLength;
            if (fault !== 'input-bounds' && (item.value.byteLength > 8 || inputBytes > 16)) throw new PluginError('limit');
            if (fault === 'source-return') break;
          }
        }
      }
      if (operation === 'transcribe' && fault !== 'input-bounds' && input.audio.byteLength > 8) throw new PluginError('limit');
      if (mode.startsWith('active-') && !(fault === 'cancel' && mode === 'active-cancelled') && !(fault === 'deadline' && mode === 'active-deadline')) await voiceOperation({ ...options, signal: invocation.signal }, () => new Promise(() => {}));
      if (mode === 'provider-error') throw new PluginError('provider');
      if (mode === 'missing-final' && fault !== 'finality') throw new PluginError('invalid-output');
      if ((mode === 'overflow' && fault !== 'bounds') || (mode === 'overflow-total' && fault !== 'total-bounds')) throw new PluginError('limit');
      if (mode === 'over-ceiling') { observed = 5; invocation.usage(1, observed, 'fixture'); }
      if (role === 'stt') {
        const events = mode === 'overflow' ? [{ text: 'x'.repeat(33), final: true }]
          : fault === 'finality' ? transcript.slice(0, 2) : fault === 'replacement' ? [{ text: 'A', final: false }, transcript[2]]
          : fault === 'after-final' ? [...transcript, transcript[2]] : transcript;
        if (operation === 'stream') { for (const event of events) yield event; }
        else yield { text: mode === 'overflow' ? 'x'.repeat(33) : 'A😀 B' };
      } else {
        for (const end of mode === 'overflow-total' ? Array(9).fill(input.text.length) : [1, input.text.length]) {
          const audio = new Uint8Array(mode === 'overflow' ? 34 : 4);
          if (fault === 'heard' && operation === 'speakAligned') heard = input.text.slice(0, end);
          yield operation === 'speakAligned' ? { audio, textEnd: fault === 'alignment' ? 2 : fault === 'alignment-backwards' ? input.text.length + 1 - end : fault === 'alignment-range' ? input.text.length + 1 : fault === 'alignment-fraction' ? 1.5 : end } : audio;
        }
      }
      invocation.usage(1, 1, 'fixture', false); completed = true;
    } finally {
      if (fault !== 'source-return') await audioIterator?.return();
      if (fault !== 'cleanup') active = 0;
      await invocation.finish(completed);
    }
  }
  const component = { capabilities: role === 'stt' ? { streaming: true, partialTranscripts: true, languages: ['en'] }
    : { streaming: true, heardPrefix: 'aligned', languages: ['en'] },
    async negotiateAudioFormat(offered, options) {
      return voiceOperation(options, () => {
        if (fault === 'format') return format;
        if (!offered.some(value => ['encoding', 'sampleRateHz', 'channels'].every(key => value[key] === format[key]))) throw new PluginError('unavailable');
        return format;
      });
    },
    async transcribe(input, options) { let result; for await (const value of run('transcribe', input, options)) result = value; return result; },
    stream: (input, options) => run('stream', input, options),
    speak: (input, options) => run('speak', input, options),
    speakAligned: (input, options) => run('speakAligned', input, options),
  };
  return { component, fixtures };
}
