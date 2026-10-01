import { composeAbortSignals } from '../provider.js';

export const SPEECH_BOUNDS = Object.freeze({ maxDurationMs: 60_000, maxAudioBytes: 960_044,
  maxResponseBytes: 1_440_000, maxTextChars: 16_000, maxBufferedBytes: 160_000 });

export function speechError(reason, message) {
  return Object.assign(new Error(message), { name: 'SpeechError', reason });
}

export function abortError(signal) {
  if (signal?.reason?.name === 'TimeoutError') return speechError('timeout', 'Speech attempt exceeded its duration');
  return Object.assign(new Error('Speech attempt cancelled'), { name: 'AbortError' });
}

export function checkAbort(signal) { if (signal?.aborted) throw abortError(signal); }

export function limitsFor(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => !Object.hasOwn(SPEECH_BOUNDS, key))) throw new TypeError('Invalid speech limits');
  const limits = { ...SPEECH_BOUNDS };
  for (const [key, value] of Object.entries(input)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > SPEECH_BOUNDS[key]) throw new TypeError(`Invalid speech limit ${key}`);
    limits[key] = value;
  }
  return Object.freeze(limits);
}

export function callSignal(signal, cancel, limits) {
  return composeAbortSignals([signal, cancel.signal, AbortSignal.timeout(limits.maxDurationMs)]);
}

export function approved(value, fallback, allowed, label) {
  const chosen = value === undefined ? fallback : value;
  if (typeof chosen !== 'string' || !allowed.includes(chosen)) throw speechError('unapproved_selection', `Unapproved speech ${label}`);
  return chosen;
}

export function textInput(text, limit) {
  if (typeof text !== 'string' || !text.trim() || text.length > limit) throw speechError('invalid_text', 'Speech text is empty or exceeds its bound');
  return text;
}

/** Inline v1 input: mono signed PCM16 WAV at 16 kHz, at most 30 seconds.
 * Parse chunk lengths, including padding; never trust a supplied duration.
 */
export function wavInput(request, limits) {
  if (request.mimeType !== 'audio/wav' || !(request.bytes instanceof Uint8Array)
      || request.bytes.byteLength > limits.maxAudioBytes) throw speechError('invalid_audio', 'Expected bounded PCM16 WAV audio');
  const bytes = Buffer.from(request.bytes);
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE'
      || bytes.readUInt32LE(4) !== bytes.length - 8) throw speechError('invalid_audio', 'Invalid WAV container');
  let format = false, audio = null;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw speechError('invalid_audio', 'Truncated WAV chunk');
    const kind = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + size;
    if (end + (size % 2) > bytes.length) throw speechError('invalid_audio', 'Truncated WAV chunk');
    if (kind === 'fmt ') {
      if (format || size !== 16 || bytes.readUInt16LE(start) !== 1 || bytes.readUInt16LE(start + 2) !== 1
          || bytes.readUInt32LE(start + 4) !== 16000 || bytes.readUInt32LE(start + 8) !== 32000
          || bytes.readUInt16LE(start + 12) !== 2 || bytes.readUInt16LE(start + 14) !== 16) {
        throw speechError('invalid_audio', 'WAV must be mono PCM16 at 16 kHz');
      }
      format = true;
    }
    if (kind === 'data') {
      if (audio || !format || size < 2 || size % 2 || size > 960_000) throw speechError('invalid_audio', 'Invalid or excessive WAV audio');
      audio = bytes.subarray(start, end);
    }
    offset = end + size % 2;
  }
  if (!audio) throw speechError('invalid_audio', 'WAV audio missing');
  return bytes;
}

/** Duration from the validated data chunk, never caller-supplied metadata. */
export function wavSeconds(bytes) {
  for (let offset = 12; offset < bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4);
    if (bytes.toString('ascii', offset, offset + 4) === 'data') return size / 32000;
    offset += 8 + size + size % 2;
  }
  throw speechError('invalid_audio', 'WAV audio missing');
}
