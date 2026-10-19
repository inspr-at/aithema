import { PluginError, normalizedError } from '@inspr/aithema-core/invocation';
import { deepFreeze } from '@inspr/aithema-core/plugins';
import { voiceOperation } from '@inspr/aithema-core/live-voice';
import { componentInvocation, boundedEvents, TTS_SPEAK_BYTES, TTS_MESSAGE_BYTES, TTS_WIRE_CHARACTERS } from '@inspr/aithema-core/voice-components';

import { STT_FORMAT, TTS_FORMAT, STT_MODEL, TTS_MODEL, voxtralEndpoints } from './configuration.js';
import { componentManifest as manifest } from './manifest.js';
export { STT_FORMAT, TTS_FORMAT } from './configuration.js';
export { componentManifest as manifest } from './manifest.js';

function configuration(raw = {}) {
  const endpoint = raw.endpoint ?? 'https://api.mistral.ai', url = new URL(endpoint);
  voxtralEndpoints(endpoint);
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
function providerError(value, tts = false) {
  const marker = value?.error?.code ?? value?.code;
  if (tts && ['moderation_blocked', 'content_policy_violation', 'moderation_refused'].includes(marker)) return new PluginError('provider', 'tts-moderation-refused');
  const status = value?.status ?? value?.error?.code;
  return new PluginError(status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate-limit' : 'provider',
    tts && status === 403 ? 'tts-forbidden-or-moderation' : status === 401 ? 'provider-authentication-failed' : status === 429 ? 'provider-rate-limited' : 'provider-request-failed');
}

/** No default transport: PR 4a can only use an explicitly injected fixture port. */
export function createVoxtralSTT({ enabled = false, config: raw, resolveSecret, connect } = {}) {
  const config = configuration(raw);
  const stream = async function* ({ audio, format }, options) {
    if (!enabled || typeof connect !== 'function') throw new PluginError('unavailable');
    if (format !== STT_FORMAT.encoding || !audio?.[Symbol.asyncIterator]) throw new TypeError('PCM16 stream required');
    const invocation = await componentInvocation(options, { role: 'stt', unit: 'seconds', model: STT_MODEL });
    const cleanup = new AbortController();
    const opts = { ...options, signal: AbortSignal.any([invocation.signal, cleanup.signal]) };
    let socket, pump, pumpError, closed = false, completed = false, bytes = 0, text = '', created = false, count = 0;
    const stop = () => { if (!closed && socket) { closed = true; return socket.close(); } };
    const audioIterator = audio[Symbol.asyncIterator]();
    try {
      const headers = await authorization(config, resolveSecret, opts);
      const url = new URL('/v1/audio/transcriptions/realtime', config.endpoint); url.protocol = 'wss:'; url.searchParams.set('model', STT_MODEL);
      invocation.dispatch();
      const pending = Promise.resolve().then(() => connect({ url: url.href, headers, signal: opts.signal }));
      let accepted = false;
      try { socket = await voiceOperation(opts, () => pending); accepted = true; }
      finally { if (!accepted) void pending.then(value => value?.close?.()).catch(() => {}); }
      if (!socket?.send || !socket.close || !socket.events?.[Symbol.asyncIterator]) throw new PluginError('invalid-output');
      const onAbort = () => { void Promise.resolve().then(stop).catch(() => {}); };
      opts.signal.addEventListener('abort', onAbort, { once: true });
      opts.signal.throwIfAborted();
      try {
        for await (const wire of boundedEvents(socket.events, opts)) {
          if (++count > 4096) throw new PluginError('limit');
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
            pump.catch(error => { pumpError = error; cleanup.abort(); });
          } else if (event.type === 'transcription.text.delta') {
            if (!created || typeof event.text !== 'string') throw new PluginError('invalid-output');
            text += event.text; if (text.length > 32_768) throw new PluginError('limit');
            yield { text, final: false };
          } else if (event.type === 'transcription.done') {
            if (!created || typeof event.text !== 'string' || event.text.length > 32_768) throw new PluginError('invalid-output');
            await voiceOperation(opts, () => pump);
            invocation.usage(bytes / 32_000, Math.ceil(bytes / 32_000 * config.sttMicroPerSecond), 'configured-audio-tariff');
            completed = true;
            yield { text: event.text, final: true }; break;
          }
          // Language/segment diagnostics and future events cannot establish finality.
        }
        if (!completed) throw new PluginError('invalid-output', 'Transcription ended without done');
      } finally { opts.signal.removeEventListener('abort', onAbort); }
    } catch (error) { throw pumpError ?? normalizedError(error, opts.signal); }
    finally {
      cleanup.abort();
      if (audioIterator.return) void Promise.resolve(audioIterator.return()).catch(() => {});
      if (socket) await voiceOperation({ deadlineAt: Date.now() + 1000 }, stop).catch(() => {});
      await invocation.finish(completed);
    }
  };
  return Object.freeze({ manifest, model: STT_MODEL,
    capabilities: deepFreeze({ streaming: true, languages: manifest.models[0].languages, partialTranscripts: true }),
    negotiateAudioFormat: negotiate(STT_FORMAT), stream,
    health: async () => ({ available: enabled && typeof connect === 'function', reason: 'offline-unqualified' }),
    async transcribe({ audio, format }, options) {
      let text;
      for await (const event of stream({ audio: (async function* () { yield audio; })(), format }, options)) if (event.final) text = event.text;
      return { text };
    } });
}

// SSE assembly is bounded independently of HTTP read coalescing: core's
// decoded event ceiling applies per message and synthesis totals 16,000,000 B.
async function* speechEvents(body, options) {
  const reader = body?.getReader(); if (!reader) throw new PluginError('invalid-output');
  const decoder = new TextDecoder('utf-8', { fatal: true }); let pending = '';
  try {
    for (;;) {
      const item = await voiceOperation(options, () => reader.read());
      if (!item.done && (!(item.value instanceof Uint8Array) || item.value.byteLength > TTS_SPEAK_BYTES * 2)) throw new PluginError('limit');
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

async function errorDetail(body, options) {
  const reader = body?.getReader(); if (!reader) return {};
  let length = 0; const chunks = [];
  try {
    for (;;) {
      const { value, done } = await voiceOperation(options, () => reader.read());
      if (done) break;
      if (!(value instanceof Uint8Array) || (length += value.byteLength) > 8192) return {};
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function createVoxtralTTS({ enabled = false, config: raw, resolveSecret, fetchImpl } = {}) {
  const config = configuration(raw);
  return Object.freeze({ manifest, model: TTS_MODEL,
    capabilities: deepFreeze({ streaming: true, languages: manifest.models[1].languages, heardPrefix: 'unavailable' }),
    negotiateAudioFormat: negotiate(TTS_FORMAT),
    health: async () => ({ available: enabled && typeof fetchImpl === 'function', reason: 'offline-unqualified' }),
    async *speak({ text, voice = config.voiceId, format }, options) {
      if (!enabled || typeof fetchImpl !== 'function') throw new PluginError('unavailable');
      if (typeof text !== 'string' || !text.trim() || text.length > 1000 || typeof voice !== 'string' || !voice || format !== TTS_FORMAT.encoding) throw new TypeError('Bounded text, saved voice and float32 PCM required');
      const characters = [...text].length, cost = characters * config.ttsMicroPerCharacter;
      const invocation = await componentInvocation(options, { role: 'tts', unit: 'characters', model: TTS_MODEL });
      const opts = { ...options, signal: invocation.signal }; let completed = false, totalBytes = 0;
      try {
        // Settle an admitted claim even when the tariff refuses dispatch.
        if (!Number.isSafeInteger(cost) || cost > options.attempt.maxMicro) throw new PluginError('not-admitted');
        const headers = await authorization(config, resolveSecret, opts);
        invocation.dispatch();
        const pending = Promise.resolve().then(() => fetchImpl(`${config.endpoint}/v1/audio/speech`, {
          method: 'POST', redirect: 'error', headers: { ...headers, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          signal: opts.signal, body: JSON.stringify({ model: TTS_MODEL, input: text, voice_id: voice, response_format: 'pcm', stream: true }) }));
        let response, accepted = false;
        try { response = await voiceOperation(opts, () => pending); accepted = true; }
        finally { if (!accepted) void pending.then(value => value?.body?.cancel()).catch(() => {}); }
        if (!response.ok) {
          // A 403 can mean TTS moderation, not just authentication. Never publish
          // provider text; inspect only bounded machine-readable error markers.
          const detail = await errorDetail(response.body, opts);
          throw providerError({ ...detail, status: response.status }, true);
        }
        if (!response.headers.get('content-type')?.startsWith('text/event-stream')) throw new PluginError('invalid-output');
        for await (const event of speechEvents(response.body, opts)) {
          if (event.type === 'speech.audio.delta') {
            if (typeof event.audio_data !== 'string' || event.audio_data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(event.audio_data)) throw new PluginError('invalid-output');
            if (event.audio_data.length > 4 * Math.ceil(TTS_MESSAGE_BYTES / 3)) throw new PluginError('limit');
            const bytes = Buffer.from(event.audio_data, 'base64'); totalBytes += bytes.byteLength;
            if (!bytes.byteLength || bytes.byteLength % 4 || bytes.byteLength > TTS_MESSAGE_BYTES || totalBytes > TTS_SPEAK_BYTES) throw new PluginError('limit');
            for (let offset = 0; offset < bytes.byteLength; offset += 64_000) {
              opts.signal.throwIfAborted();
              yield Uint8Array.from(bytes.subarray(offset, offset + 64_000));
            }
          } else if (event.type === 'speech.audio.done') {
            if (!totalBytes || !event.usage || typeof event.usage !== 'object') throw new PluginError('invalid-output');
            invocation.usage(characters, cost, 'configured-character-tariff'); completed = true; break;
          } else if (['error', 'speech.audio.error'].includes(event.type)) throw providerError(event, true);
          else throw new PluginError('invalid-output');
        }
        if (!completed) throw new PluginError('invalid-output', 'Speech ended without done');
      } catch (error) { throw normalizedError(error, opts.signal); }
      finally { await invocation.finish(completed); }
    },
  });
}
