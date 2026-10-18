import { PluginError, normalizedError } from '@inspr/aithema-core/invocation';
import { deepFreeze } from '@inspr/aithema-core/plugins';
import { voiceOperation } from '@inspr/aithema-core/live-voice';
import { componentInvocation, boundedEvents, audioQueue, TTS_MESSAGE_BYTES, TTS_WIRE_CHARACTERS, TTS_SPEAK_BYTES } from '@inspr/aithema-core/voice-components';
import { validateGrokConfiguration, TTS_FORMAT, EVIDENCE_DATE } from './configuration.js';
import { manifest } from './manifest.js';
export { TTS_FORMAT, manifest };
export const TTS_MODEL = 'grok-voice-tts'; // local component descriptor; the documented wire has no model parameter
const failure = status => new PluginError(status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate-limit' : 'provider');
function decode(wire, maximum) {
  if (typeof wire !== 'string') throw new PluginError('invalid-output');
  if (wire.length > maximum) throw new PluginError('limit');
  try { const event = JSON.parse(wire);
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error(); return event;
  } catch { throw new PluginError('invalid-output'); }
}
function pcm(delta) {
  if (typeof delta !== 'string' || !delta.length || delta.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(delta)) throw new PluginError('invalid-output');
  if (delta.length > 4 * Math.ceil(TTS_MESSAGE_BYTES / 3)) throw new PluginError('limit');
  const bytes = Buffer.from(delta, 'base64');
  if (!bytes.byteLength || bytes.byteLength % 2 || bytes.toString('base64') !== delta) throw new PluginError('invalid-output');
  if (bytes.byteLength > TTS_MESSAGE_BYTES) throw new PluginError('limit');
  return bytes;
}
/** One bounded utterance per socket and separately admitted child claim.
 * No implicit retries, provider transport, credential lookup or environment defaults.
 * https://docs.x.ai/developers/model-capabilities/audio/text-to-speech#streaming-tts-websocket
 */
export function createGrokTTS({ enabled = false, config: raw, resolveSecret, connect } = {}) {
  const config = validateGrokConfiguration(raw);
  const validateVoice = voice => voice === config.voice;
  return Object.freeze({ manifest: deepFreeze({ ...manifest, kinds: ['tts'], models: manifest.models.filter(model => model.id === TTS_MODEL) }), model: TTS_MODEL, format: TTS_FORMAT, formats: Object.freeze([TTS_FORMAT]),
    capabilities: deepFreeze({ streaming: true, languages: [...config.languages], voices: [config.voice], heardPrefix: 'unavailable' }),
    validateVoice,
    negotiateAudioFormat: async (offered, options) => voiceOperation(options, () => {
      if (!offered?.some(format => ['encoding', 'sampleRateHz', 'channels'].every(key => format[key] === TTS_FORMAT[key]))) throw new PluginError('unavailable');
      return TTS_FORMAT;
    }),
    health: async () => ({ available: enabled && typeof resolveSecret === 'function' && typeof connect === 'function', reason: 'not yet qualified in live use' }),
    async *speak(request, options) {
      if (!enabled || typeof connect !== 'function') throw new PluginError('unavailable');
      const text = request.text, voice = request.voice ?? config.voice, language = request.language ?? config.languages[0];
      if (typeof text !== 'string' || !text.trim() || !text.isWellFormed()) throw new PluginError('invalid-output');
      if (text.length > config.maxTranscriptCharacters) throw new PluginError('limit');
      if (request.format !== TTS_FORMAT.encoding || !validateVoice(voice) || !config.languages.includes(language)) throw new PluginError('unavailable');
      const characters = [...text].length, amount = Math.ceil(characters * config.ttsMicroPerMillionCharacters / 1_000_000);
      const invocation = await componentInvocation(options, { role: 'tts', unit: 'characters', model: TTS_MODEL });
      const cleanup = new AbortController(), opts = { ...options, signal: AbortSignal.any([invocation.signal, cleanup.signal]) };
      // The reader eagerly drains the provider independently of playback. The sum
      // of queued/generated audio remains bounded even if the consumer pauses.
      const queue = audioQueue(TTS_SPEAK_BYTES);
      let socket, closing, completed = false, error, total = 0;
      const stop = () => {
        if (socket && !closing) closing = voiceOperation({ deadlineAt: Date.now() + 1000 }, () => socket.close()).catch(() => {});
        return closing;
      };
      const pump = (async () => {
        try {
          if (amount > options.attempt.maxMicro) throw new PluginError('not-admitted');
          validateGrokConfiguration(config);
          if (typeof resolveSecret !== 'function') throw new PluginError('auth');
          const secret = await voiceOperation(opts, () => resolveSecret(config.secretRef));
          if (typeof secret !== 'string' || !secret || /[\r\n]/u.test(secret)) throw new PluginError('auth');
          const url = new URL('/v1/tts', config.endpoint); url.protocol = 'wss:';
          url.search = new URLSearchParams({ language, voice, codec: 'pcm', sample_rate: String(TTS_FORMAT.sampleRateHz), speed: String(config.speed) }).toString();
          validateGrokConfiguration(config); invocation.dispatch();
          let accepted = false;
          const pending = Promise.resolve().then(() => connect({ url: url.href, headers: { Authorization: `Bearer ${secret}` }, signal: opts.signal }));
          try { socket = await voiceOperation(opts, () => pending); accepted = true; }
          catch (caught) { if (caught?.usage == null) invocation.rejectWithoutUsage(caught?.status); if (caught?.status) throw failure(caught.status); throw caught; }
          finally { if (!accepted) void pending.then(value => value?.close?.()).catch(() => {}); }
          if (typeof socket?.close === 'function') opts.signal.addEventListener('abort', stop, { once: true });
          if (typeof socket?.send !== 'function' || typeof socket.close !== 'function' || !socket.events?.[Symbol.asyncIterator]) throw new PluginError('invalid-output');
          opts.signal.throwIfAborted();
          for (const message of [{ type: 'text.delta', delta: text }, { type: 'text.done' }]) {
            await voiceOperation(opts, () => socket.send(JSON.stringify(message)));
            if (message.type === 'text.delta') invocation.usage(characters, amount,
              `xai-sent-code-points:usd-micro-per-million:${config.ttsMicroPerMillionCharacters}:ceil-per-attempt:${EVIDENCE_DATE}`, true);
          }
          let count = 0;
          for await (const wire of boundedEvents(socket.events, opts)) {
            if (++count > config.maxEvents) throw new PluginError('limit');
            const event = decode(wire, TTS_WIRE_CHARACTERS);
            if (event.type === 'error') throw failure();
            if (event.type === 'audio.done') {
              if (!total || typeof event.trace_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(event.trace_id)) throw new PluginError('invalid-output');
              // Trace is a completion/debug identifier, never a cost receipt or
              // playback cursor. Count the exact text sent, without normalization.
              await invocation.finish(true); completed = true; break;
            }
            if (event.type !== 'audio.delta') throw new PluginError('invalid-output');
            const bytes = pcm(event.delta); total += bytes.byteLength;
            if (total > TTS_SPEAK_BYTES) throw new PluginError('limit');
            for (let offset = 0; offset < bytes.byteLength; offset += 64000) queue.push(Uint8Array.from(bytes.subarray(offset, offset + 64000)));
          }
          if (!completed) throw new PluginError('invalid-output', 'Missing synthesis terminal');
        } catch (caught) { error = normalizedError(caught, invocation.signal); queue.clear(); }
        finally {
          opts.signal.removeEventListener('abort', stop); await stop();
          try { await invocation.finish(completed); } catch (caught) { error = caught; queue.clear(); }
          queue.end();
        }
      })();
      try {
        for await (const bytes of boundedEvents(queue, opts)) { if (error) throw error; yield bytes; }
        await pump; if (error) throw error;
      } catch (caught) { throw normalizedError(error ?? caught, invocation.signal); }
      finally {
        cleanup.abort(); queue.clear(); await stop(); await pump;
        // Settlement errors must propagate even on iterator abandonment.
        await invocation.finish(completed);
      }
    } });
}
