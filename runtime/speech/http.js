import { canonicalJson } from '../../contracts/validate.js';
import { cancelReader, readWithCancellation, withCancellation } from '../ports/cancellation.js';
import { SpeechAttempt } from './attempt.js';
import { abortError, approved, checkAbort, speechError, textInput, wavInput, wavSeconds } from './common.js';

function endpointFor(value, local) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('Invalid speech endpoint'); }
  const literalLoopback = url.hostname === '[::1]' || /^127\.(?:[0-9]{1,3}\.){2}[0-9]{1,3}$/.test(url.hostname);
  if (url.username || url.password || url.search || url.hash || value.includes('\\') || value !== value.trim()
      || (local && !literalLoopback) || (!local && url.protocol !== 'https:' && !literalLoopback)
      || !['https:', 'http:'].includes(url.protocol)) throw new TypeError('Speech endpoint must be HTTPS or literal loopback without credentials, query or fragment');
  return url.href;
}

function selections(config, tts = false) {
  if (!Array.isArray(config.allowedModels) || !config.allowedModels.length
      || !config.allowedModels.every((id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id))) {
    throw new TypeError('Speech requires operator-approved models');
  }
  approved(config.modelId, undefined, config.allowedModels, 'model');
  if (tts && (!Array.isArray(config.allowedVoices) || !config.allowedVoices.length
      || !config.allowedVoices.every((id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)))) {
    throw new TypeError('Speech requires operator-approved voices');
  }
  if (tts) approved(config.voiceId, undefined, config.allowedVoices, 'voice');
  return { modelId: config.modelId, allowedModels: Object.freeze([...config.allowedModels]),
    ...(tts ? { voiceId: config.voiceId, allowedVoices: Object.freeze([...config.allowedVoices]) } : {}) };
}

async function* responseChunks(response, signal, maximum) {
  if (!response.body) throw speechError('incomplete_stream', 'Speech response has no body');
  const reader = response.body.getReader();
  let count = 0;
  try {
    while (true) {
      const { value, done } = await readWithCancellation(reader, signal, abortError);
      if (done) break;
      checkAbort(signal);
      count += value.byteLength;
      if (count > maximum) throw speechError('response_too_large', 'Speech response exceeds its bound');
      yield Buffer.from(value);
    }
  } finally { await cancelReader(reader, signal, abortError); }
  checkAbort(signal);
  if (!count) throw speechError('incomplete_stream', 'Speech response is empty');
}

async function post(adapter, prepared, bytes, signal) {
  checkAbort(signal);
  let response;
  try {
    const pending = Promise.resolve().then(() => adapter.fetchImpl(prepared.endpoint, {
      method: 'POST', headers: prepared.headers, body: bytes, signal, redirect: 'error',
    }));
    // Injected transports can ignore AbortSignal. Dispose a late response too,
    // even after the local cancellation waiter has already rejected.
    pending.then((late) => { if (signal.aborted) void late.body?.cancel().catch(() => {}); }, () => {});
    response = await withCancellation(() => pending, signal, abortError);
  } catch (error) { checkAbort(signal); throw error; }
  if (signal.aborted || !response.ok) {
    void response.body?.cancel().catch(() => {});
    checkAbort(signal);
    throw speechError('provider_http', `Speech provider HTTP ${response.status}`);
  }
  return response;
}

/** Completed-utterance STT. Multipart bytes are materialized BEFORE the claim:
 * FormData at fetch time would choose a different boundary/digest. No speaker
 * identification is requested. Residency is never inferred from a URL.
 */
export class OpenAISpeechToText extends SpeechAttempt {
  constructor(config) {
    super(config, 'stt');
    Object.assign(this, selections(config));
    this.endpoint = endpointFor(config.endpoint, false);
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.apiKey = config.apiKey ?? '';
    this.protocol = 'openai';
    this.executionLocation = 'cloud';
  }

  async *streamTranscribe(request) {
    yield* this.run(request, async () => {
      const audio = wavInput(request, this.limits);
      const model = approved(request.model, this.modelId, this.allowedModels, 'model');
      if (request.language !== undefined && !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(request.language)) throw new TypeError('Invalid speech language');
      const form = new FormData();
      form.append('file', new Blob([audio], { type: 'audio/wav' }), 'utterance.wav');
      form.append(this.protocol === 'elevenlabs' ? 'model_id' : 'model', model);
      if (request.language) form.append(this.protocol === 'elevenlabs' ? 'language_code' : 'language', request.language);
      if (this.protocol === 'elevenlabs') { form.append('diarize', 'false'); form.append('tag_audio_events', 'false'); }
      else form.append('response_format', 'json');
      const encoded = new Request(this.endpoint, { method: 'POST', body: form });
      const bytes = Buffer.from(await encoded.arrayBuffer());
      const headers = { 'content-type': encoded.headers.get('content-type') };
      if (this.apiKey) headers[this.protocol === 'elevenlabs' ? 'xi-api-key' : 'authorization'] = this.protocol === 'elevenlabs' ? this.apiKey : `Bearer ${this.apiKey}`;
      return { bytes, endpoint: this.endpoint, headers, input_seconds: wavSeconds(audio) };
    }, async (prepared, bytes, signal, emit) => {
      const response = await post(this, prepared, bytes, signal);
      const chunks = [];
      for await (const chunk of responseChunks(response, signal, this.limits.maxResponseBytes)) chunks.push(chunk);
      let payload;
      try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw speechError('invalid_output', 'Speech transcription is not UTF-8 JSON'); }
      const text = textInput(payload?.text, this.limits.maxTextChars);
      checkAbort(signal);
      await emit(text);
      return { input_seconds: prepared.input_seconds, provider_usage: payload.usage ?? null };
    });
  }

  async transcribe(request) {
    let text = '';
    for await (const chunk of this.streamTranscribe(request)) text += chunk;
    checkAbort(request.signal);
    return { text };
  }
}

/** OpenAI Europe is only a candidate: the exact operator account's evidence
 * must prove inference/storage/log countries (including CH where applicable),
 * retention, opt-out, entitlement and expiry through runtime/settings.
 */
export class ElevenLabsSpeechToText extends OpenAISpeechToText {
  constructor(config) { super(config); this.protocol = 'elevenlabs'; }
}

/** Raw signed PCM16 stream. The sample rate is operator-owned and returned by
 * the promise port; consumers of the stream read adapter.sampleRate. No timing
 * offsets are fabricated when the provider does not supply alignment.
 */
export class OpenAITextToSpeech extends SpeechAttempt {
  constructor(config, local = false) {
    super(config, 'tts', local);
    Object.assign(this, selections(config, true));
    this.endpoint = endpointFor(config.endpoint, local);
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.apiKey = config.apiKey ?? '';
    this.protocol = 'openai';
    this.sampleRate = 24000;
    this.executionLocation = local ? 'local' : 'cloud';
  }

  async *streamSynthesize(request) {
    yield* this.run(request, () => {
      const model = approved(request.model, this.modelId, this.allowedModels, 'model');
      const voice = approved(request.voice, this.voiceId, this.allowedVoices, 'voice');
      const text = textInput(request.text, this.limits.maxTextChars);
      const eleven = this.protocol === 'elevenlabs';
      const body = eleven ? { text, model_id: model } : { model, input: text, voice, response_format: 'pcm' };
      const headers = { 'content-type': 'application/json' };
      if (this.apiKey) headers[eleven ? 'xi-api-key' : 'authorization'] = eleven ? this.apiKey : `Bearer ${this.apiKey}`;
      return { bytes: Buffer.from(canonicalJson(body)), headers, input_characters: [...text].length,
        endpoint: eleven ? `${this.endpoint.replace(/\/$/, '')}/${encodeURIComponent(voice)}/stream?output_format=pcm_16000` : this.endpoint };
    }, async (prepared, bytes, signal, emit) => {
      const response = await post(this, prepared, bytes, signal);
      const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (!['audio/pcm', 'audio/raw', 'audio/l16', 'application/octet-stream'].includes(type)) {
        void response.body?.cancel().catch(() => {});
        throw speechError('invalid_output', 'Speech synthesis requires raw PCM audio');
      }
      let trailing = Buffer.alloc(0);
      let audioBytes = 0;
      for await (const chunk of responseChunks(response, signal, Math.min(this.limits.maxResponseBytes, this.sampleRate * 2 * 30))) {
        audioBytes += chunk.length;
        const joined = trailing.length ? Buffer.concat([trailing, chunk]) : chunk;
        const size = joined.length - joined.length % 2;
        trailing = Buffer.from(joined.subarray(size));
        // Network chunk boundaries can split a sample; preserve every byte.
        for (let offset = 0; offset < size; offset += this.limits.maxBufferedBytes - this.limits.maxBufferedBytes % 2) {
          if (this.limits.maxBufferedBytes < 2) throw speechError('invalid_output', 'PCM buffer must hold one sample');
          await emit(Buffer.from(joined.subarray(offset, Math.min(size, offset + this.limits.maxBufferedBytes - this.limits.maxBufferedBytes % 2))));
        }
      }
      if (trailing.length) throw speechError('incomplete_stream', 'Speech stream ends within a PCM sample');
      return { input_characters: prepared.input_characters, output_seconds: audioBytes / (this.sampleRate * 2), provider_usage: null };
    });
  }

  async synthesize(request) {
    const chunks = [];
    for await (const chunk of this.streamSynthesize(request)) chunks.push(chunk);
    checkAbort(request.signal);
    return { bytes: Buffer.concat(chunks), mimeType: 'audio/pcm', sampleRate: this.sampleRate };
  }
}

/** Separately installed Chatterbox with an OpenAI-compatible PCM API bridge;
 * neither code, weights nor voices are bundled. Literal loopback only (L1).
 */
export class LocalChatterboxTextToSpeech extends OpenAITextToSpeech {
  constructor(config) { super(config, true); }
}

/** C1 by default. Only Enterprise account-bound evidence can admit EU-E1;
 * a regional hostname alone is never an Enterprise/residency attestation.
 */
export class ElevenLabsTextToSpeech extends OpenAITextToSpeech {
  constructor(config) { super(config); this.protocol = 'elevenlabs'; this.sampleRate = 16000; }
}
