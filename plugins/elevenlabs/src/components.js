import { PluginError, normalizedError } from '../../../packages/core/src/invocation.js';
import { deepFreeze } from '../../../packages/core/src/plugins.js';
import { voiceOperation } from '../../../packages/core/src/live-voice.js';
import { processingScope } from '../../../packages/core/src/presets.js';
import { consentCoverage } from '../../../packages/core/src/consent.js';
import { componentInvocation, boundedEvents } from '../../composed-voice/src/component.js';

export const STT_FORMAT = Object.freeze({ encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 });
export const TTS_FORMAT = Object.freeze({ encoding: 'pcm_s16le', sampleRateHz: 24000, channels: 1 });
const STT_MODEL = 'scribe_v2_realtime', TTS_MODEL = 'eleven_flash_v2_5';
export const componentManifest = deepFreeze({ id: 'elevenlabs', version: '0.0.0', apiVersion: '^1.0.0',
  kinds: ['stt', 'tts'], placement: 'server', entrypoints: { server: './src/components.js' },
  vendor: { name: 'ElevenLabs', url: 'https://elevenlabs.io' },
  configSchema: { type: 'object', properties: {}, additionalProperties: true },
  models: [STT_MODEL, TTS_MODEL].map((id, i) => ({ id, operations: i ? ['speak'] : ['transcribe', 'stream'],
    streaming: true, structured: false, efforts: ['none'], languages: ['de', 'en'], germanQuality: 'unverified',
    formats: ['pcm_s16le'], processingLocations: ['unverified'], qualification: 'unverified', evidence: [], expiresAt: null,
    cost: { unit: i ? 'character' : 'second', inputMicro: null, outputMicro: null, reviewedAt: null } })) });

function configuration(raw = {}) {
  const url = new URL(raw.endpoint ?? 'https://api.elevenlabs.io');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    raw.secretRef !== undefined && (typeof raw.secretRef !== 'string' || !raw.secretRef) ||
    ![raw.sttMicroPerSecond, raw.ttsMicroPerCharacter].every(n => n === undefined || Number.isSafeInteger(n) && n >= 0)) throw new TypeError('Invalid ElevenLabs component configuration');
  return Object.freeze({ ...raw, endpoint: url.origin });
}
function cost(quantity, rate) {
  if (!Number.isFinite(quantity) || quantity < 0 || !Number.isSafeInteger(rate) || rate < 0) throw new PluginError('not-admitted', 'Configured component tariff required');
  const value = Math.ceil(quantity * rate);
  if (!Number.isSafeInteger(value)) throw new PluginError('limit'); return value;
}
function negotiate(format) {
  return async (offered, options) => voiceOperation(options, () => {
    if (!offered?.some(x => x.encoding === format.encoding && x.sampleRateHz === format.sampleRateHz && x.channels === 1)) throw new PluginError('unavailable');
    return format;
  });
}
function decode(wire) {
  if (typeof wire !== 'string' || wire.length > 256_000) throw new PluginError('invalid-output');
  try { const value = JSON.parse(wire); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new PluginError('invalid-output'); }
}
function failure(status) { return new PluginError(status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate-limit' : 'provider'); }
async function coverage(consent, model, config, operation, options) {
  const binding = consent?.binding;
  if (!binding || binding.plugin !== 'elevenlabs' || binding.model !== model || binding.endpoint !== config.endpoint ||
    binding.legal?.purpose !== 'voice-elevenlabs' || binding.legal.consentVersion !== 1 ||
    !consent.session || !await voiceOperation(options, opts => consentCoverage(consent.port, consent.session,
      processingScope(binding, operation), opts))) throw new PluginError('not-admitted', 'Current voice-elevenlabs consent required');
}
async function headers(config, resolveSecret, options) {
  if (!config.secretRef || typeof resolveSecret !== 'function') throw new PluginError('auth');
  const value = await voiceOperation(options, () => resolveSecret(config.secretRef));
  if (typeof value !== 'string' || !value || /[\r\n]/u.test(value)) throw new PluginError('auth');
  return { 'xi-api-key': value };
}
function transportSocket(value) {
  if (!value?.send || !value.close || !value.events?.[Symbol.asyncIterator]) throw new PluginError('invalid-output');
  return value;
}
function closer(socket) {
  let closed = false;
  return () => { if (!closed) { closed = true; try { void Promise.resolve(socket.close()).catch(() => {}); } catch { /* Cleanup must not mask settlement. */ } } };
}
async function openSocket(connect, request, options) {
  // A transport may ignore abort and resolve after the caller has already settled.
  // Close that late socket before it can escape into an abandoned invocation.
  const opening = Promise.resolve().then(() => connect(request)).then(socket => {
    if (options.signal.aborted) { if (typeof socket?.close === 'function') closer(socket)(); options.signal.throwIfAborted(); }
    return transportSocket(socket);
  });
  return voiceOperation(options, () => opening);
}
function hooks(role, model, config, reconcileReceipt) {
  const rate = role === 'stt' ? config.sttMicroPerSecond : config.ttsMicroPerCharacter;
  return { manifest: componentManifest, model, format: role === 'stt' ? STT_FORMAT : TTS_FORMAT,
    estimateCost: request => cost(role === 'stt' ? request.maxDurationMs / 1000 : [...speechText(request.text)].length + 1, rate),
    usageCost: usage => cost(usage.quantity, rate),
    // No receipt endpoint or tariff can establish actual billing offline. OPS supplies
    // authenticated, attempt-bound evidence later; absent evidence retains reservation.
    async reconcileCost(record, options) {
      if (!reconcileReceipt) return null;
      const receipt = await voiceOperation(options, opts => reconcileReceipt(record, opts));
      if (!receipt || receipt.attemptId !== record.attemptId || receipt.estimated !== false ||
        !Number.isSafeInteger(receipt.chargedMicro) || receipt.chargedMicro < 0) return null;
      return { chargedMicro: receipt.chargedMicro, estimated: false, source: 'host-component-receipt' };
    } };
}
function speechText(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 240) throw new TypeError('A 1–240 character fragment is required');
  // ElevenLabs requires a trailing space; hooks also include the initialization space.
  return text.endsWith(' ') ? text : `${text} `;
}

/** Fixture transport only: no WebSocket implementation or secret default is installed. */
export function createElevenLabsSTT({ enabled = false, config: raw, consent, resolveSecret, connect, reconcileReceipt } = {}) {
  const config = configuration(raw);
  const stream = async function* ({ audio, format }, options) {
    if (!enabled || typeof connect !== 'function') throw new PluginError('unavailable');
    if (format !== STT_FORMAT.encoding || !audio?.[Symbol.asyncIterator]) throw new TypeError('PCM16 mono 16 kHz stream required');
    cost(0, config.sttMicroPerSecond);
    const invocation = await componentInvocation(options, { role: 'stt', unit: 'seconds', model: STT_MODEL });
    const cleanup = new AbortController();
    const opts = { ...options, signal: AbortSignal.any([invocation.signal, cleanup.signal]) }, iterator = audio[Symbol.asyncIterator]();
    let socket, stop, pump, pumpError, completed = false, started = false, committed = false, bytes = 0;
    try {
      await coverage(consent, STT_MODEL, config, 'stream', opts);
      const auth = await headers(config, resolveSecret, opts);
      const url = new URL('/v1/speech-to-text/realtime', config.endpoint); url.protocol = 'wss:';
      url.search = new URLSearchParams({ model_id: STT_MODEL, audio_format: 'pcm_16000', commit_strategy: 'manual' }).toString();
      // Recheck coverage after asynchronous secret resolution, immediately before dispatch.
      await coverage(consent, STT_MODEL, config, 'stream', opts); invocation.dispatch();
      try { socket = await openSocket(connect, { url: url.href, headers: auth, signal: opts.signal }, opts); }
      catch (error) { invocation.rejectWithoutUsage(error?.status); if (error?.status) throw failure(error.status); throw error; }
      stop = closer(socket); opts.signal.addEventListener('abort', stop, { once: true }); opts.signal.throwIfAborted();
      for await (const wire of boundedEvents(socket.events, opts)) {
        const event = decode(wire);
        if (event.message_type === 'session_started') {
          if (started || typeof event.session_id !== 'string' || event.config?.audio_format !== 'pcm_16000' || event.config?.sample_rate !== 16000) throw new PluginError('invalid-output');
          started = true;
          pump = (async () => {
            for (;;) {
              const item = await voiceOperation(opts, () => iterator.next()); if (item.done) break;
              if (!(item.value instanceof Uint8Array) || !item.value.byteLength || item.value.byteLength % 2 || item.value.byteLength > 64_000) throw new PluginError('limit');
              bytes += item.value.byteLength;
              if (bytes > 1_920_000 || cost(bytes / 32_000, config.sttMicroPerSecond) > options.attempt.maxMicro) throw new PluginError('limit');
              await voiceOperation(opts, () => socket.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: Buffer.from(item.value).toString('base64'), commit: false, sample_rate: 16000 })));
            }
            // Queue exhaustion is the server endpoint, never a browser final.
            committed = true;
            await voiceOperation(opts, () => socket.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: '', commit: true, sample_rate: 16000 })));
          })();
          pump.catch(error => { pumpError = error; cleanup.abort(); stop(); });
        } else if (['partial_transcript', 'committed_transcript'].includes(event.message_type)) {
          if (!started || typeof event.text !== 'string' || event.text.length > 32_768) throw new PluginError('invalid-output');
          if (event.message_type === 'committed_transcript') {
            if (!committed) throw new PluginError('invalid-output', 'Final before server endpoint');
            await pump;
            invocation.usage(bytes / 32_000, cost(bytes / 32_000, config.sttMicroPerSecond), 'configured-audio-tariff');
            completed = true; yield { text: event.text, final: true }; break;
          }
          yield { text: event.text, final: false };
        } else if (event.message_type === 'rate_limited') throw failure(429);
        else if (event.message_type === 'auth_error') throw failure(401);
        else if (typeof event.error === 'string') throw failure();
        else throw new PluginError('invalid-output');
      }
      if (pumpError) throw pumpError;
      if (!completed) throw new PluginError('invalid-output', 'Missing committed transcript');
    } catch (error) { throw normalizedError(pumpError ?? error, invocation.signal); }
    finally {
      opts.signal.removeEventListener('abort', stop);
      stop?.(); cleanup.abort();
      if (iterator.return) void Promise.resolve(iterator.return()).catch(() => {});
      await invocation.finish(completed);
    }
  };
  return Object.freeze({ ...hooks('stt', STT_MODEL, config, reconcileReceipt), negotiateAudioFormat: negotiate(STT_FORMAT), stream,
    health: async () => ({ available: enabled && typeof connect === 'function', reason: 'offline-unqualified' }),
    async transcribe({ audio, format }, options) {
      let text; for await (const event of stream({ audio: (async function* () { yield audio; })(), format }, options)) if (event.final) text = event.text;
      return { text };
    } });
}

export function createElevenLabsTTS({ enabled = false, config: raw, consent, resolveSecret, connect, reconcileReceipt } = {}) {
  const config = configuration(raw);
  return Object.freeze({ ...hooks('tts', TTS_MODEL, config, reconcileReceipt), negotiateAudioFormat: negotiate(TTS_FORMAT),
    health: async () => ({ available: enabled && typeof connect === 'function', reason: 'offline-unqualified' }),
    async *speak({ text, voice = config.voiceId, format }, options) {
      if (!enabled || typeof connect !== 'function') throw new PluginError('unavailable');
      const wireText = speechText(text), characters = [...wireText].length + 1, amount = cost(characters, config.ttsMicroPerCharacter);
      if (typeof voice !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(voice) || format !== TTS_FORMAT.encoding) throw new TypeError('Saved voice and PCM16 24 kHz required');
      if (amount > options?.attempt?.maxMicro) throw new PluginError('not-admitted');
      const invocation = await componentInvocation(options, { role: 'tts', unit: 'characters', model: TTS_MODEL });
      const opts = { ...options, signal: invocation.signal }; let socket, stop, completed = false, total = 0;
      try {
        await coverage(consent, TTS_MODEL, config, 'speak', opts);
        const auth = await headers(config, resolveSecret, opts);
        const url = new URL(`/v1/text-to-speech/${voice}/stream-input`, config.endpoint); url.protocol = 'wss:';
        url.search = new URLSearchParams({ model_id: TTS_MODEL, output_format: 'pcm_24000' }).toString();
        await coverage(consent, TTS_MODEL, config, 'speak', opts); invocation.dispatch();
        try { socket = await openSocket(connect, { url: url.href, headers: auth, signal: opts.signal }, opts); }
        catch (error) { invocation.rejectWithoutUsage(error?.status); if (error?.status) throw failure(error.status); throw error; }
        stop = closer(socket); opts.signal.addEventListener('abort', stop, { once: true }); opts.signal.throwIfAborted();
        for (const message of [{ text: ' ' }, { text: wireText, flush: true }, { text: '' }]) {
          await voiceOperation(opts, () => socket.send(JSON.stringify(message)));
        }
        for await (const wire of boundedEvents(socket.events, opts)) {
          const event = decode(wire);
          // API page examples use is_final; AsyncAPI uses isFinal. See fixture unverified list.
          if (event.is_final === true) {
            if (!total || event.audio != null) throw new PluginError('invalid-output');
            invocation.usage(characters, amount, 'configured-character-tariff'); completed = true; break;
          }
          if (typeof event.audio !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(event.audio)) throw new PluginError('invalid-output');
          const bytes = Buffer.from(event.audio, 'base64'); total += bytes.byteLength;
          if (!bytes.byteLength || bytes.byteLength % 2 || bytes.byteLength > 64_000 || total > 16_000_000) throw new PluginError('limit');
          yield Uint8Array.from(bytes);
        }
        if (!completed) throw new PluginError('invalid-output', 'Missing synthesis final');
      } catch (error) { throw normalizedError(error, opts.signal); }
      finally { opts.signal.removeEventListener('abort', stop); stop?.(); await invocation.finish(completed); }
    } });
}
