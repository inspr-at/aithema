import { PluginError, normalizedError } from '../../../packages/core/src/invocation.js';
import { deepFreeze } from '../../../packages/core/src/plugins.js';
import { voiceOperation } from '../../../packages/core/src/live-voice.js';
import { componentInvocation, boundedEvents } from '../../../packages/core/src/voice-components.js';
import { validateGrokConfiguration, STT_MODEL, STT_FORMAT, EVIDENCE_DATE } from './configuration.js';
import { manifest } from './manifest.js';
export { STT_FORMAT, manifest };

function failure(status) { return new PluginError(status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate-limit' : 'provider'); }
function cost(seconds, rate) {
  const amount = Math.ceil(seconds * rate / 3600);
  if (!Number.isFinite(seconds) || seconds < 0 || !Number.isSafeInteger(amount)) throw new PluginError('invalid-output');
  return amount;
}
function decode(wire, config) {
  if (typeof wire !== 'string') throw new PluginError('invalid-output');
  if (wire.length > config.maxWireCharacters) throw new PluginError('limit');
  try { const value = JSON.parse(wire);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value;
  } catch { throw new PluginError('invalid-output'); }
}
function transcript(event, config) {
  if (typeof event.text !== 'string') throw new PluginError('invalid-output');
  if (event.text.length > config.maxTranscriptCharacters) throw new PluginError('limit');
  return event.text;
}
function usage(event, invocation, config, batch) {
  if (!Number.isFinite(event.duration) || event.duration < 0) throw new PluginError('invalid-output', 'Provider duration required');
  invocation.usage(event.duration, cost(event.duration, batch ? config.restMicroPerHour : config.streamingMicroPerHour),
    `xai-provider-duration:configured-${batch ? 'rest' : 'streaming'}-usd-per-hour:${EVIDENCE_DATE}`, true);
}
function audioChunk(chunk, config) {
  if (!(chunk instanceof Uint8Array) || !chunk.byteLength || chunk.byteLength % 2) throw new PluginError('invalid-output');
  if (chunk.byteLength > config.maxInputChunkBytes) throw new PluginError('limit');
}
function languageFor(request, config) {
  const language = request.language ?? config.languages[0];
  if (request.format !== STT_FORMAT.encoding || !config.languages.includes(language)) throw new PluginError('unavailable');
  return language;
}
const negotiate = async (offered, options) => voiceOperation(options, () => {
  if (!offered?.some(format => ['encoding', 'sampleRateHz', 'channels'].every(key => format[key] === STT_FORMAT[key]))) throw new PluginError('unavailable');
  return STT_FORMAT;
});
function closer(socket) {
  let terminal;
  return () => terminal ??= voiceOperation({ deadlineAt: Date.now() + 1000 }, () => socket.close()).catch(() => {});
}
async function openSocket(connect, args, options) {
  let accepted = false;
  // A port may ignore abort and resolve after the bounded wait has already failed.
  const pending = Promise.resolve().then(() => connect(args));
  try { const socket = await voiceOperation(options, () => pending); accepted = true; return socket; }
  finally { if (!accepted) void pending.then(socket => socket?.close?.()).catch(() => {}); }
}
async function headers(config, resolveSecret, options) {
  validateGrokConfiguration(config); // evidence can expire after construction
  if (typeof resolveSecret !== 'function') throw new PluginError('auth');
  const value = await voiceOperation(options, () => resolveSecret(config.secretRef));
  if (typeof value !== 'string' || !value || /[\r\n]/u.test(value)) throw new PluginError('auth');
  return { Authorization: `Bearer ${value}` };
}
function metadata(config, streaming) {
  return { manifest: streaming ? manifest : deepFreeze({ ...manifest, models: manifest.models.map(model => ({ ...model, streaming: false, operations: ['transcribe'] })) }), model: STT_MODEL,
    capabilities: deepFreeze({ streaming, languages: [...config.languages], partialTranscripts: streaming }),
    formats: Object.freeze([STT_FORMAT]), negotiateAudioFormat: negotiate };
}

/** Server-only fixture ports: no default fetch, WebSocket, secret resolver or environment lookup.
 * Each utterance is one separately admitted child invocation. Retries require fresh authority.
 * https://docs.x.ai/developers/model-capabilities/audio/speech-to-text#streaming
 */
export function createGrokSTT({ enabled = false, config: raw, resolveSecret, connect } = {}) {
  const config = validateGrokConfiguration(raw);
  const stream = async function* (request, options) {
    if (!enabled || typeof connect !== 'function') throw new PluginError('unavailable');
    const language = languageFor(request, config);
    if (!request.audio?.[Symbol.asyncIterator]) throw new PluginError('invalid-output');
    const invocation = await componentInvocation(options, { role: 'stt', unit: 'seconds', model: STT_MODEL });
    const cleanup = new AbortController(), opts = { ...options, signal: AbortSignal.any([invocation.signal, cleanup.signal]) };
    let socket, stop, iterator, pump, pumpError, completed = false, ready = false, ended = false, total = 0, count = 0;
    let utteranceStart = 0, locked = new Map(), prefix = '';
    try {
      iterator = request.audio[Symbol.asyncIterator]();
      const auth = await headers(config, resolveSecret, opts);
      const url = new URL('/v1/stt', config.endpoint); url.protocol = 'wss:';
      url.search = new URLSearchParams({ model: config.model, sample_rate: String(STT_FORMAT.sampleRateHz), encoding: 'pcm',
        channels: '1', interim_results: 'true', endpointing: String(config.endpointingMs), language }).toString();
      invocation.dispatch();
      try { socket = await openSocket(connect, { url: url.href, headers: auth, signal: opts.signal }, opts); }
      catch (error) { if (error?.usage == null) invocation.rejectWithoutUsage(error?.status); if (error?.status) throw failure(error.status); throw error; }
      if (typeof socket?.send !== 'function' || typeof socket.close !== 'function' || !socket.events?.[Symbol.asyncIterator]) throw new PluginError('invalid-output');
      stop = closer(socket); opts.signal.addEventListener('abort', stop, { once: true }); opts.signal.throwIfAborted();
      for await (const wire of boundedEvents(socket.events, opts)) {
        if (++count > config.maxEvents) throw new PluginError('limit');
        const event = decode(wire, config);
        if (event.type === 'error') throw failure();
        if (event.type === 'transcript.created') {
          if (ready) throw new PluginError('invalid-output'); ready = true;
          pump = (async () => {
            for (;;) {
              const item = await voiceOperation(opts, () => iterator.next());
              if (item.done) break;
              audioChunk(item.value, config); total += item.value.byteLength;
              if (total > config.maxInputBytes || cost(total / 32000, config.streamingMicroPerHour) > options.attempt.maxMicro) throw new PluginError('limit');
              // Copy the bounded chunk: producers may reuse their input buffers.
              await voiceOperation(opts, () => socket.send(Uint8Array.from(item.value)));
            }
            if (!total) throw new PluginError('invalid-output', 'Missing audio');
            // Set the boundary before send: a transport can deliver the reply synchronously.
            ended = true;
            await voiceOperation(opts, () => socket.send(JSON.stringify({ type: 'audio.done' })));
          })();
          pump.catch(error => { pumpError = error; cleanup.abort(); });
        } else if (event.type === 'transcript.partial') {
          const text = transcript(event, config);
          if (!ready || typeof event.is_final !== 'boolean' || typeof event.speech_final !== 'boolean' ||
            event.speech_final && !event.is_final || !Number.isFinite(event.start) || event.start < utteranceStart ||
            !Number.isFinite(event.duration) || event.duration < 0 || event.channel_index !== undefined) throw new PluginError('invalid-output');
          let hypothesis;
          if (event.speech_final) {
            // Utterance-final text already stitches the locked chunks. It is still
            // only a hypothesis for Aithema until its own queue has endpointed.
            hypothesis = prefix + text; prefix = hypothesis; locked = new Map();
            utteranceStart = event.start + event.duration;
          } else {
            const preceding = [...locked].filter(([start]) => start < event.start).sort(([a], [b]) => a - b).map(([, value]) => value).join('');
            hypothesis = prefix + preceding + text;
            if (event.is_final) locked.set(event.start, text);
          }
          if (hypothesis.length > config.maxTranscriptCharacters || locked.size > config.maxEvents) throw new PluginError('limit');
          yield { text: hypothesis, final: false };
        } else if (event.type === 'transcript.done') {
          if (!ready || !ended || event.channel_index !== undefined) throw new PluginError('invalid-output', 'Terminal before audio endpoint');
          const text = transcript(event, config);
          await pump; usage(event, invocation, config, false);
          // Settle before exposing finality; report failures must reach the caller.
          await invocation.finish(true); completed = true;
          yield { text, final: true }; break;
        } else throw new PluginError('invalid-output');
      }
      if (pumpError) throw pumpError;
      if (!completed) throw new PluginError('invalid-output', 'Missing terminal transcript');
    } catch (error) { throw normalizedError(pumpError ?? error, invocation.signal); }
    finally {
      opts.signal.removeEventListener('abort', stop); cleanup.abort(); await stop?.();
      if (iterator?.return) await voiceOperation({ deadlineAt: Date.now() + 1000 }, () => iterator.return()).catch(() => {});
      await invocation.finish(completed);
    }
  };
  return Object.freeze({ ...metadata(config, true), stream,
    health: async () => ({ available: enabled && typeof connect === 'function', reason: 'not yet qualified in live use' }),
    async transcribe(request, options) {
      let text;
      for await (const event of stream({ ...request, audio: (async function* () { yield request.audio; })() }, options)) if (event.final) text = event.text;
      return { text };
    } });
}
export const createGrokStreamingSTT = createGrokSTT;

/** REST file transcription. Accepts the same conservative raw PCM input as streaming.
 * https://docs.x.ai/developers/model-capabilities/audio/speech-to-text#response
 */
export function createGrokBatchSTT({ enabled = false, config: raw, resolveSecret, fetchImpl } = {}) {
  const config = validateGrokConfiguration(raw);
  return Object.freeze({ ...metadata(config, false),
    health: async () => ({ available: enabled && typeof fetchImpl === 'function', reason: 'not yet qualified in live use' }),
    async transcribe(request, options) {
      if (!enabled || typeof fetchImpl !== 'function') throw new PluginError('unavailable');
      const language = languageFor(request, config);
      const invocation = await componentInvocation(options, { role: 'stt', unit: 'seconds', model: STT_MODEL });
      const opts = { ...options, signal: invocation.signal }; let response, reader, completed = false;
      try {
        audioChunk(request.audio, { ...config, maxInputChunkBytes: config.maxInputBytes });
        if (request.audio.byteLength > config.maxInputBytes || cost(request.audio.byteLength / 32000, config.restMicroPerHour) > options.attempt.maxMicro) throw new PluginError('limit');
        const auth = await headers(config, resolveSecret, opts);
        const body = new FormData();
        body.append('model', config.model); body.append('audio_format', 'pcm'); body.append('sample_rate', '16000'); body.append('language', language);
        body.append('file', new Blob([request.audio], { type: 'application/octet-stream' }), 'speech.pcm'); // file last
        invocation.dispatch();
        let accepted = false;
        const pending = Promise.resolve().then(() => fetchImpl(`${config.endpoint}/v1/stt`, {
          method: 'POST', redirect: 'error', headers: auth, signal: opts.signal, body }));
        try { response = await voiceOperation(opts, () => pending); accepted = true; }
        finally { if (!accepted) void pending.then(value => value.body?.cancel()).catch(() => {}); }
        if (!response.ok) { invocation.rejectWithoutUsage(response.status); throw failure(response.status); }
        if (!response.headers.get('content-type')?.startsWith('application/json') || !response.body?.getReader) throw new PluginError('invalid-output');
        reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: true }); let wire = '', bytes = 0;
        for (;;) {
          const item = await voiceOperation(opts, () => reader.read()); if (item.done) break;
          bytes += item.value.byteLength; if (bytes > config.maxWireCharacters) throw new PluginError('limit');
          wire += decoder.decode(item.value, { stream: true });
        }
        wire += decoder.decode();
        const event = decode(wire, config), text = transcript(event, config);
        usage(event, invocation, config, true); await invocation.finish(true); completed = true;
        return { text };
      } catch (error) { throw normalizedError(error, invocation.signal); }
      finally {
        if (reader) { await voiceOperation({ deadlineAt: Date.now() + 1000 }, () => reader.cancel()).catch(() => {}); reader.releaseLock(); }
        else if (response?.body) await voiceOperation({ deadlineAt: Date.now() + 1000 }, () => response.body.cancel()).catch(() => {});
        await invocation.finish(completed);
      }
    } });
}
