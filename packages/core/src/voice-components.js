import { PluginError } from './invocation.js';
import { operationScope } from './reasoning.js';
import { voiceOperation, assertComponentUsage } from './live-voice.js';
export { assertComponentUsage } from './live-voice.js';

/** Generated PCM ceiling per TTS speak, shared by providers and playback. */
export const TTS_SPEAK_BYTES = 16_000_000;
// Keep wire limits available to public transports without exposing source-only helpers.
export { TTS_MESSAGE_BYTES, TTS_WIRE_CHARACTERS } from './live-voice.js';

/** Validate a supported STT port and its explicit capability declaration. */
export function assertSTTComponent(component) {
  const caps = component?.capabilities;
  if (!component || typeof component.transcribe !== 'function' || typeof component.negotiateAudioFormat !== 'function' ||
    !validCapabilities(caps) || typeof caps.partialTranscripts !== 'boolean' ||
    (component.stream !== undefined && typeof component.stream !== 'function') ||
    (caps.streaming && typeof component.stream !== 'function') || (caps.partialTranscripts && !caps.streaming)) {
    throw new TypeError('Invalid STT component');
  }
  return component;
}

/** Validate a supported TTS port; aligned prefixes require an aligned synthesis port. */
export function assertTTSComponent(component) {
  const caps = component?.capabilities;
  if (!component || typeof component.speak !== 'function' || typeof component.negotiateAudioFormat !== 'function' ||
    !validCapabilities(caps) || !['unavailable', 'aligned'].includes(caps.heardPrefix) ||
    (component.speakAligned !== undefined && typeof component.speakAligned !== 'function') ||
    (caps.heardPrefix === 'aligned' && typeof component.speakAligned !== 'function')) {
    throw new TypeError('Invalid TTS component');
  }
  return component;
}

function validCapabilities(caps) {
  return caps && typeof caps.streaming === 'boolean' && Array.isArray(caps.languages) &&
    caps.languages.every(language => typeof language === 'string' && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(language)) &&
    new Set(caps.languages.map(language => language.toLowerCase())).size === caps.languages.length;
}

/** Capability ceiling for a composition. Playback confirmation is still host authority. */
export function voiceCompositionCapabilities(stt, tts) {
  assertSTTComponent(stt); assertTTSComponent(tts);
  return { languages: stt.capabilities.languages.filter(language =>
    tts.capabilities.languages.some(other => other.toLowerCase() === language.toLowerCase())),
  streaming: { stt: stt.capabilities.streaming, tts: tts.capabilities.streaming },
  partialTranscripts: stt.capabilities.partialTranscripts, heardPrefix: tts.capabilities.heardPrefix };
}

/** Configuration failures are separate from provider invocation errors. */
export class VoiceCompositionError extends TypeError {
  constructor(code, message, options) { super(message, options); this.name = 'VoiceCompositionError'; this.code = code; }
}

/** Offline preflight only: negotiation and optional voice validation must never
 * consume claims, resolve credentials or access transports. No synthesis probes.
 * Requested languages are a preference set; at least one must be shared. */
export async function preflightVoiceComposition(configuration = {}, options = {}) {
  const { stt, tts, capture, playback, languages, voice, capabilities } = configuration ?? {};
  const fail = (code, message, cause) => { throw new VoiceCompositionError(code, message, cause ? { cause } : undefined); };
  for (const [role, component, check] of [['stt', stt, assertSTTComponent], ['tts', tts, assertTTSComponent]]) {
    try { check(component); }
    catch (error) { fail(`composition-${role}-invalid`, `Invalid ${role.toUpperCase()} component`, error); }
  }
  const ceiling = voiceCompositionCapabilities(stt, tts);
  const validLanguages = values => Array.isArray(values) && values.every(value => typeof value === 'string' &&
    /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(value)) && new Set(values.map(value => value.toLowerCase())).size === values.length;
  if (!validLanguages(languages)) fail('composition-languages-invalid', 'Explicit requested language tags required');
  const shared = ceiling.languages.filter(language => languages.some(requested => requested.toLowerCase() === language.toLowerCase()));
  if (!shared.length) fail('composition-languages-empty', 'No requested language is supported by both components');
  const voices = tts.capabilities.voices;
  if (typeof voice !== 'string' || !voice.trim() || voice !== voice.trim() || /\p{Cc}/u.test(voice) ||
    voices !== undefined && (!Array.isArray(voices) || !voices.length || voices.some(value => typeof value !== 'string' || !value.trim()) || !voices.includes(voice)) ||
    tts.validateVoice !== undefined && typeof tts.validateVoice !== 'function') fail('composition-voice-invalid', 'A valid configured TTS voice is required');
  if (tts.validateVoice) {
    try { if (tts.validateVoice(voice) !== true) fail('composition-voice-invalid', 'TTS voice policy rejected the configured voice'); }
    catch (error) { fail('composition-voice-invalid', 'TTS voice policy rejected the configured voice', error); }
  }
  const selected = capabilities === undefined ? { ...ceiling, languages: shared } : capabilities;
  if (!selected || typeof selected !== 'object' || Object.keys(selected).some(key => !['languages', 'streaming', 'partialTranscripts', 'heardPrefix'].includes(key)) ||
    !validLanguages(selected.languages) || !selected.languages.length || selected.languages.some(language => !shared.some(other => language.toLowerCase() === other.toLowerCase())) ||
    !selected.streaming || Object.keys(selected.streaming).some(key => !['stt', 'tts'].includes(key)) ||
    ['stt', 'tts'].some(role => typeof selected.streaming[role] !== 'boolean' || selected.streaming[role] && !ceiling.streaming[role]) ||
    typeof selected.partialTranscripts !== 'boolean' || selected.partialTranscripts && (!ceiling.partialTranscripts || !selected.streaming.stt) ||
    !['unavailable', 'aligned'].includes(selected.heardPrefix) || selected.heardPrefix === 'aligned' && ceiling.heardPrefix !== 'aligned') {
    fail('composition-capabilities-exceeded', 'Composition capabilities exceed the declared component ceiling');
  }
  const validFormat = format => format && typeof format.encoding === 'string' && format.encoding.trim() &&
    Number.isSafeInteger(format.sampleRateHz) && format.sampleRateHz > 0 && Number.isSafeInteger(format.channels) && format.channels > 0;
  // Copy caller-owned configuration before negotiation can yield.
  const result = { capture: { ...capture }, playback: { ...playback }, voice,
    capabilities: { ...selected, languages: [...selected.languages], streaming: { ...selected.streaming } } };
  const bounded = { ...options, deadlineAt: options.deadlineAt ?? Date.now() + 1000 };
  for (const [role, component] of [['capture', stt], ['playback', tts]]) {
    const format = result[role], code = `composition-${role}-format`;
    if (!validFormat(format)) fail(code, `Valid ${role} audio format required`);
    try {
      const negotiated = await voiceOperation(bounded, opts => component.negotiateAudioFormat([{ ...format }], opts));
      if (!validFormat(negotiated) || ['encoding', 'sampleRateHz', 'channels'].some(key => format[key] !== negotiated[key])) {
        fail(code, `Negotiated audio does not match ${role}`);
      }
    } catch (error) {
      if (['cancelled', 'deadline'].includes(error?.code)) throw error;
      fail(code, `Audio negotiation failed for ${role}`, error);
    }
  }
  return result;
}

/** Separately admitted accounting. Consume fresh host authority before dispatch; the first
 * terminal wins. Missing completion evidence after dispatch retains at least claim max.
 * @param {import('./voice-components.js').ComponentOperationOptions} options
 * @param {{role: 'stt'|'reasoning'|'tts', unit: 'seconds'|'tokens'|'characters'|'bytes'|'credits', model: string}} descriptor
 */
export async function componentInvocation(options, { role, unit, model }) {
  if (!['stt', 'reasoning', 'tts'].includes(role) || !['seconds', 'tokens', 'characters', 'bytes', 'credits'].includes(unit) ||
    typeof model !== 'string' || !model) throw new TypeError('Invalid component accounting descriptor');
  if (typeof options?.attempt?.attemptId !== 'string' || !options.attempt.attemptId ||
    typeof options.attempt.claimId !== 'string' || !options.attempt.claimId || typeof options.attempt.consume !== 'function' ||
    !Number.isSafeInteger(options.attempt.maxMicro) || options.attempt.maxMicro < 0 || typeof options.report !== 'function') {
    throw new PluginError('not-admitted', 'A separately admitted component claim is required');
  }
  const { attemptId, maxMicro } = options.attempt;
  const scope = operationScope(options);
  let dispatched = false, terminal, usage, observedMicro = 0, rejected = false, invalidUsage = false;
  const finish = completed => {
    if (terminal) return terminal;
    const zero = { attemptId, role, unit, quantity: 0, upstreamMicro: 0, source: 'undispatched', estimated: false };
    const report = !dispatched ? { outcome: 'cancelled', usage: zero, chargedMicro: 0 }
      : rejected ? { outcome: 'cancelled', usage: { ...zero, source: 'provider-4xx-no-usage' }, chargedMicro: 0 }
      : completed === true && usage && !invalidUsage ? { outcome: 'completed', usage, chargedMicro: usage.upstreamMicro }
      : { outcome: 'uncertain', chargedMicro: Math.max(maxMicro, observedMicro), ...(usage ? { usage } : {}) };
    scope.signal.removeEventListener('abort', abort);
    scope.dispose();
    // Install the once-only fence before invoking a host which may synchronously abort.
    terminal = Promise.resolve().then(() => options.report({ attemptId, servedModel: model, ...report }));
    return terminal;
  };
  const abort = () => { void finish(false).catch(() => {}); };
  scope.signal.addEventListener('abort', abort, { once: true });
  try {
    await voiceOperation({ ...options, signal: scope.signal }, () => options.attempt.consume());
    scope.signal.throwIfAborted();
  } catch (error) { await finish(false); throw error; }
  return {
    signal: scope.signal,
    dispatch() {
      scope.signal.throwIfAborted();
      if (terminal || dispatched) throw new PluginError('already-claimed');
      dispatched = true;
    },
    usage(quantity, upstreamMicro, source, estimated = true) {
      if (terminal) throw new PluginError('already-claimed');
      if (!dispatched) throw new PluginError('not-admitted', 'Component has not dispatched');
      rejected = false;
      try {
        const next = assertComponentUsage({ attemptId, role, unit, quantity, upstreamMicro, source, estimated });
        usage = next; observedMicro = Math.max(observedMicro, next.upstreamMicro);
        options.observe?.(next);
        if (usage.upstreamMicro > maxMicro) throw new PluginError('limit', 'Component exceeded its admitted ceiling');
      } catch (error) { invalidUsage = true; throw error; }
    },
    // Only a transport-observed 4xx rejection without usage may release dispatch.
    // Timeouts (408/499) leave provider state unknown and retain the reservation.
    rejectWithoutUsage(status) {
      if (!terminal && dispatched && !usage && !invalidUsage && Number.isInteger(status) && status >= 400 && status < 500 && ![408, 499].includes(status)) rejected = true;
    },
    finish,
  };
}

/** Bound each iterator read by cancellation/deadline, and cleanup by a separate 1 s lease. */
export async function* boundedEvents(source, options) {
  const iterator = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      const item = await voiceOperation(options, () => iterator.next());
      if (item.done) return;
      yield item.value;
    }
  } finally {
    if (iterator.return) await voiceOperation({ deadlineAt: Date.now() + 1000 }, () => iterator.return()).catch(() => {});
  }
}

/** Byte-bounded producer queue; ingress cannot hide unbounded audio in promises. */
export function audioQueue(limit = 960_000) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Positive audio queue byte limit required');
  let bytes = 0, ended = false, waiter;
  const queue = [];
  return {
    push(value) {
      if (ended) throw new PluginError('unavailable');
      if (!value || !Number.isSafeInteger(value.byteLength) || value.byteLength < 1) throw new TypeError('Positive audio entry byte length required');
      if (bytes + value.byteLength > limit) throw new PluginError('limit', 'Audio relay buffer full');
      if (waiter) { const resolve = waiter; waiter = undefined; resolve({ value, done: false }); }
      else { bytes += value.byteLength; queue.push(value); }
    },
    end() { ended = true; waiter?.({ done: true }); waiter = undefined; },
    clear() { queue.length = 0; bytes = 0; this.end(); },
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (queue.length) { const value = queue.shift(); bytes -= value.byteLength; return Promise.resolve({ value, done: false }); }
      if (ended) return Promise.resolve({ done: true });
      if (waiter) throw new TypeError('One audio consumer required');
      return new Promise(resolve => { waiter = resolve; });
    },
    return() { this.clear(); return Promise.resolve({ done: true }); },
  };
}
