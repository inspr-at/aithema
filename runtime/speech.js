/**
 * Independent completed-file audio transcription adapter.
 *
 * OpenAI-compatible POST to an operator-configured exact endpoint
 * (multipart file + model + response_format=json). Chat Completions
 * compatibility does not imply audio support; this adapter never
 * defaults to a live vendor URL or imports a vendor SDK.
 */

import {
  composeAbortSignals,
  IncompleteProviderStreamError,
  readBoundedResponse,
} from './provider.js';
import { boundProviderId, providerPolicyFields } from './policy.js';
import { MAX_MESSAGE_CHARS } from './transcript.js';

export const MOCK_SPEECH_ID = 'mock';
export const MOCK_SPEECH_MARK = '[Demo / test speech — no live model was contacted.]';

export const SPEECH_ACCEPTED_MEDIA_TYPES = Object.freeze(['audio/webm', 'audio/mp4']);

export const SPEECH_LIMIT_DEFAULTS = Object.freeze({
  maxAudioBytes: 2 * 1024 * 1024,
  maxRequestBytes: 2 * 1024 * 1024 + 65_536,
  maxRecordingMs: 60_000,
  maxDurationMs: 60_000,
  maxResponseBytes: 65_536,
  maxTranscriptChars: MAX_MESSAGE_CHARS,
});

export const SPEECH_LIMIT_CEILINGS = Object.freeze({
  maxAudioBytes: 4 * 1024 * 1024,
  maxRequestBytes: 4 * 1024 * 1024 + 65_536,
  maxRecordingMs: 180_000,
  maxDurationMs: 180_000,
  maxResponseBytes: 262_144,
  maxTranscriptChars: MAX_MESSAGE_CHARS,
});

const SPEECH_KINDS = Object.freeze(['mock', 'openai-compatible-transcription']);

const SPEECH_CONFIG_KEYS = Object.freeze([
  'enabled',
  'kind',
  'providerId',
  'model',
  'allowedModels',
  'endpoint',
  'apiKey',
  'acceptedMediaTypes',
  'limits',
]);

const SPEECH_CREDENTIAL_OVERRIDE_KEYS = Object.freeze([
  'username',
  'password',
  'user',
  'pass',
  'authorization',
  'token',
  'secret',
  'credentials',
  'api_key',
  'access_token',
]);

/**
 * @param {unknown} mimeType
 */
export function canonicalSpeechMediaType(mimeType) {
  return String(mimeType ?? '').split(';')[0]?.trim().toLowerCase() || '';
}

/**
 * @param {unknown} mimeType
 * @param {readonly string[]} [accepted]
 */
export function isAcceptedSpeechMediaType(mimeType, accepted = SPEECH_ACCEPTED_MEDIA_TYPES) {
  const type = canonicalSpeechMediaType(mimeType);
  return accepted.includes(type);
}

/**
 * Extension-bearing filename derived from MIME. Client path names are not used.
 * @param {unknown} mimeType
 */
export function filenameForSpeechMediaType(mimeType) {
  const type = canonicalSpeechMediaType(mimeType);
  if (type === 'audio/webm') return 'recording.webm';
  if (type === 'audio/mp4') return 'recording.mp4';
  throw Object.assign(new Error('audio media type is not accepted'), { code: 'unsupported_media' });
}

/**
 * @param {unknown} value
 */
export function normalizeSpeechLimits(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  /** @type {typeof SPEECH_LIMIT_DEFAULTS} */
  const limits = { ...SPEECH_LIMIT_DEFAULTS };
  for (const key of Object.keys(SPEECH_LIMIT_DEFAULTS)) {
    if (source[key] == null || source[key] === '') continue;
    const numeric = Number(source[key]);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      throw new Error(`speech limit ${key} must be a positive number`);
    }
    limits[key] = Math.min(Math.floor(numeric), SPEECH_LIMIT_CEILINGS[key]);
  }
  if (limits.maxTranscriptChars > MAX_MESSAGE_CHARS) {
    limits.maxTranscriptChars = MAX_MESSAGE_CHARS;
  }
  if (limits.maxRequestBytes < limits.maxAudioBytes) {
    throw new Error('speech maxRequestBytes must be at least maxAudioBytes');
  }
  return Object.freeze(limits);
}

/**
 * Transcript text becomes an editable draft. Oversize is refused, never sliced.
 * @param {unknown} value
 * @param {number} [maxChars]
 */
export function boundSpeechTranscript(value, maxChars = MAX_MESSAGE_CHARS) {
  if (typeof value !== 'string' || !value.trim()) {
    throw Object.assign(new Error('transcription was empty'), { code: 'empty_transcript' });
  }
  const text = value.trim();
  if (text.length > maxChars) {
    throw Object.assign(
      new Error(`transcription exceeds the ${maxChars}-character message limit`),
      { code: 'transcript_too_long' },
    );
  }
  return text;
}

/**
 * Optional speech. Absent, null, false, or { enabled: false } stays disabled.
 * Any other presence is fail-closed: partial or unsafe config is rejected.
 *
 * @param {unknown} value
 * @param {{
 *   providers?: unknown,
 *   mode?: string,
 *   policy?: unknown,
 * }} [context]
 */
export function normalizeSpeechConfig(value, context = {}) {
  if (value == null || value === false) {
    return Object.freeze({ enabled: false });
  }
  if (value === true || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('speech config must be an object');
  }
  rejectUnsafeSpeechFields(value);
  if (value.enabled === false) {
    return Object.freeze({ enabled: false });
  }
  const mode = context.mode ?? 'production';
  const providers = context.providers;
  if (providers == null || typeof providers !== 'object' || Array.isArray(providers)) {
    throw new Error('speech config requires the operator provider registry');
  }
  const providerId = boundProviderId(value.providerId);
  if (!Object.hasOwn(providers, providerId)) {
    throw new Error(`speech provider ${providerId} is not in the operator registry`);
  }
  const entry = providers[providerId];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`speech provider ${providerId} is not in the operator registry`);
  }
  if (typeof value.model !== 'string' || !value.model.trim()) {
    throw new Error('speech model is required');
  }
  const model = value.model.trim();
  const allowedModels = uniqueModels(value.allowedModels, model);
  if (!allowedModels.includes(model)) {
    throw new Error('speech model must be listed in speech allowedModels');
  }
  const kind = value.kind ?? (value.endpoint ? 'openai-compatible-transcription' : null);
  if (!SPEECH_KINDS.includes(kind)) {
    throw new Error('speech kind must be mock or openai-compatible-transcription');
  }
  if (kind === 'mock') {
    if (mode === 'production') {
      throw new Error('mock speech is not allowed in production');
    }
    if (value.endpoint != null && value.endpoint !== '') {
      throw new Error('mock speech must not set a live transcription endpoint');
    }
  }
  let endpoint = null;
  if (kind === 'openai-compatible-transcription') {
    endpoint = normalizeSpeechEndpoint(value.endpoint);
  }
  const acceptedMediaTypes = normalizeAcceptedMedia(value.acceptedMediaTypes);
  let executionLocation;
  let allowedDataClasses;
  if (context.policy != null && context.policy !== false) {
    const fields = providerPolicyFields(entry, providerId);
    executionLocation = fields.executionLocation;
    allowedDataClasses = fields.allowedDataClasses;
  } else if (entry.executionLocation != null && entry.executionLocation !== '') {
    const fields = providerPolicyFields({
      executionLocation: entry.executionLocation,
      allowedDataClasses: Array.isArray(entry.allowedDataClasses)
        ? entry.allowedDataClasses
        : ['unclassified'],
    }, providerId);
    executionLocation = fields.executionLocation;
    allowedDataClasses = fields.allowedDataClasses;
  }
  const apiKey = typeof value.apiKey === 'string'
    ? value.apiKey
    : (typeof entry.apiKey === 'string' ? entry.apiKey : '');
  return Object.freeze({
    enabled: true,
    kind,
    providerId,
    model,
    allowedModels: Object.freeze(allowedModels),
    endpoint,
    apiKey,
    acceptedMediaTypes: Object.freeze(acceptedMediaTypes),
    executionLocation,
    allowedDataClasses: allowedDataClasses ? Object.freeze([...allowedDataClasses]) : undefined,
    labelledDemo: kind === 'mock',
    limits: normalizeSpeechLimits(value.limits),
  });
}

/**
 * Reject credential override fields and unknown keys. URL userinfo is a
 * separate check on the exact endpoint.
 * @param {object} value
 */
function rejectUnsafeSpeechFields(value) {
  for (const key of Object.keys(value)) {
    if (SPEECH_CREDENTIAL_OVERRIDE_KEYS.includes(key)) {
      throw new Error('speech config must not include credentials');
    }
    if (!SPEECH_CONFIG_KEYS.includes(key)) {
      throw new Error(`speech config field ${key} is not supported`);
    }
  }
}

/**
 * @param {unknown} value
 */
function normalizeSpeechEndpoint(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('speech endpoint is required and must be the exact transcription URL');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('speech endpoint must be an absolute http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('speech endpoint must be an absolute http(s) URL');
  }
  if (parsed.username || parsed.password) {
    throw new Error('speech endpoint must not include credentials');
  }
  if (parsed.hash) {
    throw new Error('speech endpoint must not include a fragment');
  }
  return parsed.href;
}

/**
 * @param {unknown} value
 * @param {string} fallback
 */
function uniqueModels(value, fallback) {
  const source = value == null || value === '' ? [fallback] : value;
  if (!Array.isArray(source) || source.length === 0) {
    throw new Error('speech allowedModels must be a non-empty array');
  }
  const seen = new Set();
  const out = [];
  for (const item of source) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error('speech allowedModels entries must be non-empty strings');
    }
    const id = item.trim();
    if (seen.has(id)) throw new Error('speech allowedModels must not contain duplicates');
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * @param {unknown} value
 */
function normalizeAcceptedMedia(value) {
  if (value == null || value === '') {
    return [...SPEECH_ACCEPTED_MEDIA_TYPES];
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('speech acceptedMediaTypes must be a non-empty array');
  }
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const type = canonicalSpeechMediaType(item);
    if (!SPEECH_ACCEPTED_MEDIA_TYPES.includes(type)) {
      throw new Error('speech acceptedMediaTypes may only include audio/webm and audio/mp4');
    }
    if (seen.has(type)) throw new Error('speech acceptedMediaTypes must not contain duplicates');
    seen.add(type);
    out.push(type);
  }
  return out;
}

/**
 * Browser-visible speech capability. No endpoint, credentials, or limits the
 * browser may raise.
 * @param {ReturnType<typeof normalizeSpeechConfig>} speech
 * @param {{ projectRef: string, publicBasePath?: string }} context
 * @param {(base: string, path: string) => string} joinPath
 */
export function publicSpeechCapability(speech, context, joinPath) {
  if (!speech?.enabled) {
    return Object.freeze({ enabled: false });
  }
  const location = speech.executionLocation;
  return Object.freeze({
    enabled: true,
    providerId: speech.providerId,
    model: speech.model,
    models: speech.allowedModels,
    executionLocation: location ?? null,
    destinationLabel: location ? `configured ${location}` : 'configured',
    destinationNote: 'Operator-declared location label; not measured network placement.',
    acceptedMediaTypes: speech.acceptedMediaTypes,
    maxAudioBytes: speech.limits.maxAudioBytes,
    maxRecordingMs: speech.limits.maxRecordingMs,
    maxTranscriptChars: speech.limits.maxTranscriptChars,
    transcribePath: joinPath(context.publicBasePath ?? '', `/projects/${encodeURIComponent(context.projectRef)}/transcribe`),
  });
}

export class MockSpeechTranscriber {
  /**
   * @param {{
   *   id?: string,
   *   modelId?: string,
   *   allowedModels?: readonly string[],
   *   acceptedMediaTypes?: readonly string[],
   *   limits?: unknown,
   *   executionLocation?: 'local' | 'cloud',
   *   allowedDataClasses?: readonly string[],
   *   reply?: string,
   * }} [options]
   */
  constructor(options = {}) {
    this.id = options.id || MOCK_SPEECH_ID;
    this.modelId = options.modelId || MOCK_SPEECH_ID;
    this.allowedModels = Object.freeze(options.allowedModels ? [...options.allowedModels] : [this.modelId]);
    this.live = false;
    this.labelledDemo = true;
    this.kind = 'mock';
    this.acceptedMediaTypes = Object.freeze(
      options.acceptedMediaTypes ? [...options.acceptedMediaTypes] : [...SPEECH_ACCEPTED_MEDIA_TYPES],
    );
    this.limits = normalizeSpeechLimits(options.limits);
    this.executionLocation = options.executionLocation;
    this.allowedDataClasses = options.allowedDataClasses
      ? Object.freeze([...options.allowedDataClasses])
      : undefined;
    this.reply = typeof options.reply === 'string' && options.reply.trim()
      ? options.reply.trim()
      : `Need a concrete sign-in check. ${MOCK_SPEECH_MARK}`;
  }

  /**
   * @param {string} [requested]
   */
  resolveModel(requested) {
    if (!requested) return this.modelId;
    if (!this.allowedModels.includes(requested)) {
      throw new Error('requested speech model is not in the operator-approved registry');
    }
    return requested;
  }

  /**
   * @param {{
   *   bytes: Uint8Array,
   *   mimeType: string,
   *   filename?: string,
   *   model?: string,
   *   signal?: AbortSignal,
   * }} request
   */
  async transcribe(request) {
    if (request.signal?.aborted) throw abortError(request.signal);
    assertSpeechAudio(request, this.acceptedMediaTypes, this.limits.maxAudioBytes);
    this.resolveModel(request.model);
    return {
      text: boundSpeechTranscript(this.reply, this.limits.maxTranscriptChars),
      labelledDemo: true,
      live: false,
    };
  }
}

/**
 * OpenAI-compatible completed-file transcription. Posts to the configured
 * exact endpoint only. Redirects are not followed, so credentials never move.
 */
export class OpenAICompatibleTranscription {
  /**
   * @param {{
   *   id: string,
   *   endpoint: string,
   *   apiKey?: string,
   *   modelId: string,
   *   allowedModels: readonly string[],
   *   acceptedMediaTypes?: readonly string[],
   *   fetchImpl?: typeof fetch,
   *   limits?: unknown,
   *   executionLocation?: 'local' | 'cloud',
   *   allowedDataClasses?: readonly string[],
   * }} config
   */
  constructor(config) {
    if (!config?.id?.trim()) throw new Error('speech provider id is required');
    if (!Array.isArray(config.allowedModels) || config.allowedModels.length === 0) {
      throw new Error('speech allowedModels must contain at least one operator-approved model');
    }
    if (!config.allowedModels.includes(config.modelId)) {
      throw new Error(`speech model ${config.modelId} is not in the operator-approved registry`);
    }
    this.id = config.id;
    this.modelId = config.modelId;
    this.allowedModels = Object.freeze([...config.allowedModels]);
    this.endpoint = normalizeSpeechEndpoint(config.endpoint);
    this.apiKey = typeof config.apiKey === 'string' ? config.apiKey : '';
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.live = true;
    this.labelledDemo = false;
    this.kind = 'openai-compatible-transcription';
    this.acceptedMediaTypes = Object.freeze(
      config.acceptedMediaTypes ? [...config.acceptedMediaTypes] : [...SPEECH_ACCEPTED_MEDIA_TYPES],
    );
    this.limits = normalizeSpeechLimits(config.limits);
    this.executionLocation = config.executionLocation;
    this.allowedDataClasses = config.allowedDataClasses
      ? Object.freeze([...config.allowedDataClasses])
      : undefined;
  }

  /**
   * @param {string} [requested]
   */
  resolveModel(requested) {
    if (!requested) return this.modelId;
    if (!this.allowedModels.includes(requested)) {
      throw new Error('requested speech model is not in the operator-approved registry');
    }
    return requested;
  }

  /**
   * @param {{
   *   bytes: Uint8Array,
   *   mimeType: string,
   *   filename?: string,
   *   model?: string,
   *   signal?: AbortSignal,
   * }} request
   */
  async transcribe(request) {
    const signal = composeAbortSignals([request.signal, AbortSignal.timeout(this.limits.maxDurationMs)]);
    if (signal?.aborted) throw abortError(signal);
    const mimeType = canonicalSpeechMediaType(request.mimeType);
    assertSpeechAudio({ ...request, mimeType }, this.acceptedMediaTypes, this.limits.maxAudioBytes);
    const model = this.resolveModel(request.model);
    const filename = filenameForSpeechMediaType(mimeType);
    const form = new FormData();
    form.append('file', new Blob([request.bytes], { type: mimeType }), filename);
    form.append('model', model);
    form.append('response_format', 'json');
    const headers = {};
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    let response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        body: form,
        signal,
        redirect: 'manual',
      });
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      throw error;
    }
    if (response.status >= 300 && response.status < 400) {
      throw new Error('speech transcription redirect was refused so credentials are not forwarded');
    }
    if (!response.ok) {
      throw new Error(`speech transcription HTTP ${response.status}`);
    }
    const raw = await readBoundedResponse(response, this.limits.maxResponseBytes, signal);
    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new Error('speech transcription response was not JSON');
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('speech transcription response was not a JSON object');
    }
    return {
      text: boundSpeechTranscript(payload.text, this.limits.maxTranscriptChars),
      labelledDemo: false,
      live: true,
    };
  }
}

/**
 * @param {ReturnType<typeof normalizeSpeechConfig>} speech
 * @param {{ fetchImpl?: typeof fetch, mode?: string, allowMock?: boolean }} [options]
 */
export function createSpeechAdapter(speech, options = {}) {
  if (!speech?.enabled) {
    throw new Error('speech input is not configured');
  }
  const mode = options.mode ?? 'production';
  if (speech.kind === 'mock') {
    if (mode === 'production' || options.allowMock === false) {
      throw new Error('mock speech is not allowed in production');
    }
    return new MockSpeechTranscriber({
      id: speech.providerId,
      modelId: speech.model,
      allowedModels: speech.allowedModels,
      acceptedMediaTypes: speech.acceptedMediaTypes,
      limits: speech.limits,
      executionLocation: speech.executionLocation,
      allowedDataClasses: speech.allowedDataClasses,
    });
  }
  return new OpenAICompatibleTranscription({
    id: speech.providerId,
    endpoint: speech.endpoint,
    apiKey: speech.apiKey,
    modelId: speech.model,
    allowedModels: speech.allowedModels,
    acceptedMediaTypes: speech.acceptedMediaTypes,
    fetchImpl: options.fetchImpl,
    limits: speech.limits,
    executionLocation: speech.executionLocation,
    allowedDataClasses: speech.allowedDataClasses,
  });
}

/**
 * @param {{ bytes?: Uint8Array, mimeType?: string }} request
 * @param {readonly string[]} accepted
 * @param {number} maxAudioBytes
 */
export function assertSpeechAudio(request, accepted, maxAudioBytes) {
  const bytes = request.bytes;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw Object.assign(new Error('audio body is required'), { code: 'empty_audio' });
  }
  if (bytes.byteLength > maxAudioBytes) {
    throw Object.assign(new Error('audio body is too large'), { code: 'too_large' });
  }
  if (!isAcceptedSpeechMediaType(request.mimeType, accepted)) {
    throw Object.assign(new Error('audio media type is not accepted'), { code: 'unsupported_media' });
  }
}

/**
 * @param {AbortSignal} [signal]
 */
function abortError(signal) {
  if (signal?.reason?.name === 'TimeoutError') {
    return new IncompleteProviderStreamError('timeout', 'speech transcription exceeded the configured duration');
  }
  const error = new Error('speech transcription cancelled');
  error.name = 'AbortError';
  error.code = 'cancelled';
  return error;
}
