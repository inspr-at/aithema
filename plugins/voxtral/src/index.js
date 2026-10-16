import { PluginError, normalizedError } from '../../../packages/core/src/invocation.js';
import { deepFreeze } from '../../../packages/core/src/plugins.js';
import { voiceOperation } from '../../../packages/core/src/live-voice.js';
import { componentInvocation, boundedEvents } from '../../../packages/core/src/voice-components.js';

export const STT_FORMAT = Object.freeze({ encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 });
// Speech API PCM is float32 LE. It must never be sent to a PCM16 player.
export const TTS_FORMAT = Object.freeze({ encoding: 'pcm_f32le', sampleRateHz: 24000, channels: 1 });
const STT_MODEL = 'voxtral-mini-transcribe-realtime-2602', TTS_MODEL = 'voxtral-mini-tts-2603';
// Voxtral TTS uses injected fetch/SSE, not the qualification WebSocket connect.
// Keep a 1 MiB decoded event ceiling and bounded SSE assembly independently
// of HTTP read coalescing; the synthesis total remains 16,000,000 B.
// See composed-voice/README.md for all transport and backlog bounds.
const TTS_MESSAGE_BYTES = 1_048_576;
const TTS_WIRE_CHARACTERS = 4 * Math.ceil(TTS_MESSAGE_BYTES / 3) + 16_384; // base64 + SSE/JSON metadata
export const manifest = deepFreeze({ id: 'voxtral', version: '0.0.0', apiVersion: '^1.0.0',
  kinds: ['stt', 'tts'], placement: 'server', entrypoints: { server: './src/index.js' },
  configSchema: { type: 'object', properties: {}, additionalProperties: true },
  vendor: { name: 'Mistral', url: 'https://mistral.ai' },
  models: [
    { id: STT_MODEL, operations: ['transcribe', 'stream'], streaming: true, structured: false, efforts: ['none'],
      languages: ['de', 'en'], germanQuality: 'unverified', formats: ['pcm_s16le'], processingLocations: ['unverified'],
      qualification: 'unverified', evidence: [], expiresAt: null, cost: { unit: 'minute', inputMicro: 6000, outputMicro: 0, reviewedAt: '2026-10-14' } },
    { id: TTS_MODEL, operations: ['speak'], streaming: true, structured: false, efforts: ['none'],
      languages: ['de', 'en'], germanQuality: 'unverified', formats: ['pcm_f32le'], processingLocations: ['unverified'],
      qualification: 'unverified', evidence: [], expiresAt: null, cost: { unit: 'character', inputMicro: 16, outputMicro: 0, reviewedAt: '2026-10-14' } },
  ] });

function configuration(raw = {}) {
  const endpoint = raw.endpoint ?? 'https://api.mistral.ai', url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    raw.secretRef !== undefined && (typeof raw.secretRef !== 'string' || !raw.secretRef) ||
    !Number.isSafeInteger(raw.targetDelayMs ?? 480) || (raw.targetDelayMs ?? 480) < 0 || (raw.targetDelayMs ?? 480) > 2400 ||
    ![raw.sttMicroPerSecond ?? 100, raw.ttsMicroPerCharacter ?? 16].every(n => Number.isSafeInteger(n) && n >= 0)) throw new TypeError('Invalid Voxtral configuration');
  return Object.freeze({ endpoint: url.origin, secretRef: raw.secretRef, voiceId: raw.voiceId,
    targetDelayMs: raw.targetDelayMs ?? 480, sttMicroPerSecond: raw.sttMicroPerSecond ?? 100, ttsMicroPerCharacter: raw.ttsMicroPerCharacter ?? 16 });
}
const negotiate = format => async (offered, options) => voiceOperation(options, async () => {
  if (!offered?.some(x => x.encoding === format.encoding && x.sampleRateHz === format.sampleRateHz && x.channels === 1)) throw new PluginError('unavailable', 'Incompatible audio format');
  return format;
});
async function authorization(config, resolveSecret, options) {
  if (!config.secretRef || typeof resolveSecret !== 'function') throw new PluginError('auth');
  const value = await voiceOperation(options, () => resolveSecret(config.secretRef));
  if (typeof value !== 'string' || !value || /[\r\n]/u.test(value)) throw new PluginError('auth');
  return { Authorization: `Bearer ${value}` };
}
function decodeJSON(wire, maxCharacters = 256_000) {
  if (typeof wire !== 'string' || wire.length > maxCharacters) throw new PluginError('invalid-output');
  try { const value = JSON.parse(wire); if (!value || typeof value.type !== 'string') throw new Error(); return value; }
  catch { throw new PluginError('invalid-output'); }
}
function providerError(value) {
  const status = value?.status ?? value?.error?.code;
  return new PluginError(status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate-limit' : 'provider');
}

/** No default transport: PR 4a can only use an explicitly injected fixture port. */
export function createVoxtralSTT({ enabled = false, config: raw, resolveSecret, connect } = {}) {
  const config = configuration(raw);
  const stream = async function* ({ audio, format }, options) {
    if (!enabled || typeof connect !== 'function') throw new PluginError('unavailable');
    if (format !== STT_FORMAT.encoding || !audio?.[Symbol.asyncIterator]) throw new TypeError('PCM16 stream required');
    const invocation = await componentInvocation(options, { role: 'stt', unit: 'seconds', model: STT_MODEL });
    const opts = { ...options, signal: invocation.signal }; let socket, pump, completed = false, bytes = 0, text = '', created = false;
    const audioIterator = audio[Symbol.asyncIterator]();
    try {
      const headers = await authorization(config, resolveSecret, opts);
      const url = new URL('/v1/audio/transcriptions/realtime', config.endpoint); url.protocol = 'wss:'; url.searchParams.set('model', STT_MODEL);
      invocation.dispatch();
      socket = await voiceOperation(opts, () => connect({ url: url.href, headers, signal: opts.signal }));
      if (!socket?.send || !socket.close || !socket.events?.[Symbol.asyncIterator]) throw new PluginError('invalid-output');
      const stop = () => { void Promise.resolve(socket.close()).catch(() => {}); };
      opts.signal.addEventListener('abort', stop, { once: true });
      try {
        for await (const wire of boundedEvents(socket.events, opts)) {
          const event = decodeJSON(wire);
          if (event.type === 'error') throw providerError(event);
          if (event.type === 'session.created') {
            if (created) throw new PluginError('invalid-output'); created = true;
            await voiceOperation(opts, () => socket.send(JSON.stringify({ type: 'session.update', session: {
              audio_format: { encoding: STT_FORMAT.encoding, sample_rate: STT_FORMAT.sampleRateHz }, target_streaming_delay_ms: config.targetDelayMs } })));
            pump = (async () => {
              for (;;) {
                const item = await voiceOperation(opts, () => audioIterator.next());
                if (item.done) break;
                if (!(item.value instanceof Uint8Array) || item.value.byteLength % 2 || item.value.byteLength > 64_000) throw new PluginError('limit');
                bytes += item.value.byteLength;
                if (bytes > 1_920_000 || Math.ceil(bytes / 32_000 * config.sttMicroPerSecond) > options.attempt.maxMicro) throw new PluginError('limit');
                await voiceOperation(opts, () => socket.send(JSON.stringify({ type: 'input_audio.append', audio: Buffer.from(item.value).toString('base64') })));
              }
              await voiceOperation(opts, () => socket.send(JSON.stringify({ type: 'input_audio.end' })));
            })();
            pump.catch(stop);
          } else if (event.type === 'transcription.text.delta') {
            if (!created || typeof event.text !== 'string') throw new PluginError('invalid-output');
            text += event.text; if (text.length > 32_768) throw new PluginError('limit');
            yield { text, final: false };
          } else if (event.type === 'transcription.done') {
            if (!created || typeof event.text !== 'string' || event.text.length > 32_768) throw new PluginError('invalid-output');
            await pump;
            invocation.usage(bytes / 32_000, Math.ceil(bytes / 32_000 * config.sttMicroPerSecond), 'configured-audio-tariff');
            completed = true;
            yield { text: event.text, final: true }; break;
          }
          // Language/segment diagnostics and future events cannot establish finality.
        }
        if (!completed) throw new PluginError('invalid-output', 'Transcription ended without done');
      } finally { opts.signal.removeEventListener('abort', stop); }
    } catch (error) { throw normalizedError(error, opts.signal); }
    finally {
      if (audioIterator.return) void Promise.resolve(audioIterator.return()).catch(() => {});
      if (socket) await voiceOperation({ deadlineAt: Date.now() + 1000 }, () => socket.close()).catch(() => {});
      await invocation.finish(completed);
    }
  };
  return Object.freeze({ manifest, model: STT_MODEL, negotiateAudioFormat: negotiate(STT_FORMAT), stream,
    health: async () => ({ available: enabled && typeof connect === 'function', reason: 'offline-unqualified' }),
    async transcribe({ audio, format }, options) {
      let text;
      for await (const event of stream({ audio: (async function* () { yield audio; })(), format }, options)) if (event.final) text = event.text;
      return { text };
    } });
}

async function* speechEvents(body, options) {
  const reader = body?.getReader(); if (!reader) throw new PluginError('invalid-output');
  const decoder = new TextDecoder('utf-8', { fatal: true }); let pending = '';
  try {
    for (;;) {
      const item = await voiceOperation(options, () => reader.read());
      const input = item.done ? decoder.decode() : decoder.decode(item.value, { stream: true });
      // HTTP reads may coalesce many valid events. Bound the pending SSE
      // message, not the aggregate read, and drain before accepting more.
      for (let offset = 0; offset < input.length;) {
        const length = Math.min(input.length - offset, TTS_WIRE_CHARACTERS - pending.length);
        if (!length) throw new PluginError('limit');
        pending += input.slice(offset, offset + length); offset += length;
        let match;
        while ((match = /\r?\n\r?\n/u.exec(pending))) {
          const frame = pending.slice(0, match.index); pending = pending.slice(match.index + match[0].length);
          const data = frame.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (data) yield decodeJSON(data, TTS_WIRE_CHARACTERS);
        }
      }
      if (item.done) { if (pending.trim()) throw new PluginError('invalid-output'); return; }
    }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function createVoxtralTTS({ enabled = false, config: raw, resolveSecret, fetchImpl } = {}) {
  const config = configuration(raw);
  return Object.freeze({ manifest, model: TTS_MODEL, negotiateAudioFormat: negotiate(TTS_FORMAT),
    health: async () => ({ available: enabled && typeof fetchImpl === 'function', reason: 'offline-unqualified' }),
    async *speak({ text, voice = config.voiceId, format }, options) {
      if (!enabled || typeof fetchImpl !== 'function') throw new PluginError('unavailable');
      if (typeof text !== 'string' || !text.trim() || text.length > 1000 || typeof voice !== 'string' || !voice || format !== TTS_FORMAT.encoding) throw new TypeError('Bounded text, saved voice and float32 PCM required');
      const characters = [...text].length, cost = characters * config.ttsMicroPerCharacter;
      if (!Number.isSafeInteger(cost) || cost > options?.attempt?.maxMicro) throw new PluginError('not-admitted');
      const invocation = await componentInvocation(options, { role: 'tts', unit: 'characters', model: TTS_MODEL });
      const opts = { ...options, signal: invocation.signal }; let completed = false, totalBytes = 0;
      try {
        const headers = await authorization(config, resolveSecret, opts);
        invocation.dispatch();
        const response = await voiceOperation(opts, () => fetchImpl(`${config.endpoint}/v1/audio/speech`, {
          method: 'POST', redirect: 'error', headers: { ...headers, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          signal: opts.signal, body: JSON.stringify({ model: TTS_MODEL, input: text, voice_id: voice, response_format: 'pcm', stream: true }) }));
        if (!response.ok) throw providerError({ status: response.status });
        if (!response.headers.get('content-type')?.startsWith('text/event-stream')) throw new PluginError('invalid-output');
        for await (const event of speechEvents(response.body, opts)) {
          if (event.type === 'speech.audio.delta') {
            if (typeof event.audio_data !== 'string' || event.audio_data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(event.audio_data)) throw new PluginError('invalid-output');
            if (event.audio_data.length > 4 * Math.ceil(TTS_MESSAGE_BYTES / 3)) throw new PluginError('limit');
            const bytes = Buffer.from(event.audio_data, 'base64'); totalBytes += bytes.byteLength;
            if (!bytes.byteLength || bytes.byteLength % 4 || bytes.byteLength > TTS_MESSAGE_BYTES || totalBytes > 16_000_000) throw new PluginError('limit');
            for (let offset = 0; offset < bytes.byteLength; offset += 64_000) {
              opts.signal.throwIfAborted();
              yield Uint8Array.from(bytes.subarray(offset, offset + 64_000));
            }
          } else if (event.type === 'speech.audio.done') {
            if (!totalBytes || !event.usage || typeof event.usage !== 'object') throw new PluginError('invalid-output');
            invocation.usage(characters, cost, 'configured-character-tariff'); completed = true; break;
          } else if (event.type === 'error') throw providerError(event);
          else throw new PluginError('invalid-output');
        }
        if (!completed) throw new PluginError('invalid-output', 'Speech ended without done');
      } catch (error) { throw normalizedError(error, opts.signal); }
      finally { await invocation.finish(completed); }
    },
  });
}
