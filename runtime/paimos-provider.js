/**
 * Paimos conversation-service adapter. Executable account, runtime, profile,
 * and model choices remain pinned by the operator-owned Paimos binding.
 */

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';

import {
  IncompleteProviderStreamError,
  composeAbortSignals,
  normalizeProviderLimits,
} from './provider.js';
import { validateVerifiedActor } from './identity.js';
import { boundDataClass, normalizeProviderEstimatedSpend } from './policy.js';
import { validateUnderstanding } from './understanding.js';

const INPUT_BYTES = 128 * 1024;
const MAX_MESSAGES = 128;
const OUTPUT_BYTES = 256 * 1024;
const DELTA_BYTES = 8 * 1024;
const MAX_EVENTS = 512;
const MAX_CREDENTIAL_BYTES = 8 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const DEFAULT_POLL_MS = 500;
const DEFAULT_CLEANUP_MS = 2_000;
const CALL_STATES = new Set([
  'queued', 'claimed', 'running', 'cancel_requested', 'completed', 'failed', 'cancelled',
]);
const EVENT_KINDS = new Set(['started', 'assistant_delta', 'completed', 'failed', 'cancelled']);
const PURPOSES = new Set(['chat', 'understand', 'interpret']);
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * @param {unknown} value
 * @param {string} label
 * @param {number} [max]
 */
function boundedString(value, label, max = 512) {
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function safeHeader(value, label) {
  const text = boundedString(value, label, 1024);
  if (!/^[\x20-\x7e]+$/u.test(text)) throw new Error(`${label} is invalid`);
  return text;
}

function wellFormed(value) {
  return typeof value === 'string' && (typeof value.isWellFormed !== 'function' || value.isWellFormed());
}

function loopbackHostname(hostname) {
  const lower = hostname.toLowerCase();
  return lower === 'localhost' || lower === '::1' || lower === '[::1]'
    || /^127(?:\.[0-9]{1,3}){3}$/u.test(lower);
}

function normalizeOrigin(value, allowLoopbackHttp) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('paimos origin must be a valid URL origin');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
    throw new Error('paimos origin must contain only scheme and authority');
  }
  if (parsed.protocol !== 'https:' && !(allowLoopbackHttp && parsed.protocol === 'http:' && loopbackHostname(parsed.hostname))) {
    throw new Error('paimos origin must use HTTPS');
  }
  return parsed.origin;
}

function exactKeys(value, required, optional, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid`);
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(`${label} is invalid`);
  if (required.some((key) => !Object.hasOwn(value, key))) throw new Error(`${label} is invalid`);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function timeoutError() {
  return new IncompleteProviderStreamError('timeout', 'Paimos call exceeded the configured duration');
}

function abortedError(signal) {
  if (signal?.reason?.name === 'TimeoutError') return timeoutError();
  const error = new Error('provider stream cancelled');
  error.name = 'AbortError';
  return error;
}

function incomplete(reason = 'provider_failed') {
  return new IncompleteProviderStreamError(reason, 'Paimos call did not complete');
}

async function delay(ms, signal) {
  if (ms <= 0) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError(signal));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

async function boundedJson(response, signal, maxBytes) {
  const type = response.headers.get('content-type') ?? '';
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(type.trim())) {
    throw new Error('Paimos response encoding is invalid');
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw incomplete('response_too_large');
  if (!response.body) throw new Error('Paimos response is invalid');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      if (signal?.aborted) throw abortedError(signal);
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw incomplete('response_too_large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new Error('Paimos response encoding is invalid');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Paimos response is invalid');
  }
}

/** Server-side provider for an already enrolled Paimos account binding. */
export class PaimosHarnessProvider {
  /**
   * @param {{
   *   id: string,
   *   origin: string,
   *   credentialFile: string,
   *   projectID: string,
   *   bindingID: string,
   *   bindingRevision: number,
   *   trustedIssuer: string,
   *   modelId: string,
   *   allowedModels: readonly string[],
   *   limits?: unknown,
   *   fetchImpl?: typeof fetch,
   *   mode?: string,
   *   pollIntervalMs?: number,
   *   retryDelayMs?: number,
   *   cleanupTimeoutMs?: number,
   *   allowedDataClasses?: readonly string[],
   *   estimatedSpend?: unknown,
   * }} config
   */
  constructor(config) {
    this.id = boundedString(config?.id, 'provider id', 100);
    this.origin = normalizeOrigin(config.origin, config.mode === 'test');
    this.credentialFile = boundedString(config.credentialFile, 'paimos credential file', 4096);
    this.projectID = boundedString(config.projectID, 'paimos project id', 200);
    this.bindingID = boundedString(config.bindingID, 'paimos binding id', 200);
    if (!Number.isSafeInteger(config.bindingRevision) || config.bindingRevision < 1) {
      throw new Error('paimos binding revision is invalid');
    }
    this.bindingRevision = config.bindingRevision;
    this.trustedIssuer = safeHeader(config.trustedIssuer, 'paimos trusted issuer');
    this.modelId = boundedString(config.modelId, 'paimos model id', 200);
    if (!Array.isArray(config.allowedModels)
      || config.allowedModels.length !== 1
      || config.allowedModels[0] !== this.modelId) {
      throw new Error('paimos allowedModels must contain exactly its binding-approved model');
    }
    this.allowedModels = Object.freeze([this.modelId]);
    this.live = true;
    this.labelledDemo = false;
    if (config.executionLocation != null && config.executionLocation !== 'cloud') {
      throw new Error('paimos harness executionLocation must be cloud');
    }
    this.executionLocation = 'cloud';
    if (!Array.isArray(config.allowedDataClasses) || config.allowedDataClasses.length === 0) {
      throw new Error('paimos allowedDataClasses must contain operator-approved data classes');
    }
    const allowedDataClasses = [...new Set(config.allowedDataClasses.map(boundDataClass))];
    if (allowedDataClasses.length !== config.allowedDataClasses.length) {
      throw new Error('paimos allowedDataClasses must not contain duplicates');
    }
    this.allowedDataClasses = Object.freeze(allowedDataClasses);
    this.estimatedSpend = normalizeProviderEstimatedSpend(config.estimatedSpend, this.id);
    this.limits = normalizeProviderLimits(config.limits);
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.pollIntervalMs = Math.min(DEFAULT_POLL_MS, Math.max(0, config.pollIntervalMs ?? DEFAULT_POLL_MS));
    this.retryDelayMs = Math.min(DEFAULT_POLL_MS, Math.max(0, config.retryDelayMs ?? 100));
    this.cleanupTimeoutMs = Math.min(5_000, Math.max(100, config.cleanupTimeoutMs ?? DEFAULT_CLEANUP_MS));
    this.basePath = `/api/projects/${encodeURIComponent(this.projectID)}/conversation/v1`;
    this.credentialPromise = null;
  }

  resolveModel(requested) {
    if (requested == null || requested === '' || requested === this.modelId) return this.modelId;
    throw new Error('requested model is not in the operator-approved registry');
  }

  async *streamChat(request) {
    this.resolveModel(request.model);
    yield* this.#execute(request, 'chat');
  }

  async understand(request) {
    this.resolveModel(request.model);
    const purpose = request.executionContext?.purpose;
    if (purpose !== 'understand' && purpose !== 'interpret') {
      throw new Error('trusted Paimos execution context is required');
    }
    let output = '';
    for await (const chunk of this.#execute(request, purpose)) output += chunk;
    let parsed;
    try {
      parsed = JSON.parse(output);
    } catch {
      throw new Error('provider understanding response was not JSON');
    }
    return validateUnderstanding(parsed);
  }

  async *#execute(request, purpose) {
    if (!PURPOSES.has(purpose)) throw new Error('Paimos purpose is invalid');
    const context = this.#executionContext(request.executionContext, purpose);
    const timeoutMs = Math.min(180_000, this.limits.maxDurationMs);
    let deadline = Date.now() + timeoutMs;
    const credential = await this.#credential();
    const headers = Object.freeze({
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
      'x-paimos-actor-issuer': context.actor.issuer,
      'x-paimos-actor-subject': context.actor.subject,
    });
    const body = this.#callBody(request, context, purpose, timeoutMs);
    const maxOutputBytes = Math.min(
      OUTPUT_BYTES,
      purpose === 'chat' ? this.limits.maxResponseBytes : this.limits.maxUnderstandingBytes,
    );
    let call;
    let admitted = false;
    let terminal = false;
    try {
      call = await this.#request('POST', `${this.basePath}/calls`, headers, body, deadline, request.signal);
      this.#validateCall(call, context.requestId);
      deadline = Math.min(deadline, Date.parse(call.deadline_at));
      admitted = true;
      const callID = boundedString(call.call_id, 'Paimos call id', 256);
      let after = 0;
      let started = false;
      let nativeThreadID = null;
      let nativeTurnID = null;
      let assembled = '';
      let assembledBytes = 0;
      const seen = new Map();
      const serverDeadline = call.deadline_at;

      while (true) {
        if (Date.now() >= deadline) throw timeoutError();
        const result = await this.#request(
          'GET',
          `${this.basePath}/calls/${encodeURIComponent(callID)}/events?after=${after}`,
          headers,
          undefined,
          deadline,
          request.signal,
        );
        exactKeys(result, ['schema_version', 'call_id', 'events', 'call'], [], 'Paimos events response');
        if (result.schema_version !== 1 || result.call_id !== callID || !Array.isArray(result.events)
          || result.events.length > MAX_EVENTS) {
          throw new Error('Paimos events response is invalid');
        }
        this.#validateCall(result.call, context.requestId, callID);
        if (result.call.deadline_at !== serverDeadline) throw new Error('Paimos call deadline changed');
        call = result.call;
        for (const event of result.events) {
          this.#validateEvent(event);
          const fingerprint = canonical(event);
          if (event.sequence <= after) {
            if (seen.get(event.sequence) !== fingerprint) throw new Error('Paimos event replay conflicts');
            continue;
          }
          if (event.sequence !== after + 1) throw new Error('Paimos event sequence is invalid');
          if (seen.size >= MAX_EVENTS) throw incomplete('response_too_large');
          seen.set(event.sequence, fingerprint);
          after = event.sequence;

          if (event.kind === 'started') {
            if (started || typeof event.thread_id !== 'string' || typeof event.turn_id !== 'string') {
              throw new Error('Paimos started event is invalid');
            }
            nativeThreadID = boundedString(event.thread_id, 'Paimos thread id', 512);
            nativeTurnID = boundedString(event.turn_id, 'Paimos native turn id', 512);
            started = true;
            continue;
          }
          if (event.kind === 'failed' || event.kind === 'cancelled') {
            terminal = true;
            throw incomplete(event.kind === 'cancelled' ? 'cancelled' : 'provider_failed');
          }
          if (!started || event.thread_id !== nativeThreadID || event.turn_id !== nativeTurnID) {
            throw new Error('Paimos event identity is invalid');
          }
          if (event.kind === 'assistant_delta') {
            if (typeof event.text !== 'string' || !event.text) throw new Error('Paimos delta is invalid');
            const bytes = Buffer.byteLength(event.text, 'utf8');
            if (!wellFormed(event.text) || bytes > DELTA_BYTES) throw incomplete('response_too_large');
            assembledBytes += bytes;
            assembled += event.text;
            if (assembledBytes > maxOutputBytes || assembled.length > this.limits.maxAssembledChars) {
              throw incomplete('response_too_large');
            }
            yield event.text;
            continue;
          }
          if (event.kind === 'completed') {
            if (terminal || call.state !== 'completed' || call.last_sequence !== after) {
              throw new Error('Paimos completion is invalid');
            }
            const digest = createHash('sha256').update(Buffer.from(assembled, 'utf8')).digest('hex');
            if (event.output_sha256 !== digest || call.output_sha256 !== digest
              || (call.output_text != null && call.output_text !== assembled)) {
              throw new Error('Paimos completion digest is invalid');
            }
            terminal = true;
            return;
          }
        }
        if (call.last_sequence !== after) throw new Error('Paimos event sequence is invalid');
        if (call.state === 'completed' || call.state === 'failed' || call.state === 'cancelled') {
          throw new Error('Paimos terminal call is missing its terminal event');
        }
        await delay(Math.min(this.pollIntervalMs, Math.max(0, deadline - Date.now())), this.#signal(request.signal, deadline));
      }
    } finally {
      if (admitted && !terminal && call?.call_id) {
        await this.#cancel(call.call_id, headers, context.requestId, call.deadline_at).catch(() => {});
      }
    }
  }

  #executionContext(value, purpose) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.purpose !== purpose) {
      throw new Error('trusted Paimos execution context is required');
    }
    const actor = validateVerifiedActor(value.actor);
    return Object.freeze({
      actor: Object.freeze({
        issuer: this.trustedIssuer,
        subject: safeHeader(actor.subject, 'verified actor subject'),
      }),
      projectRef: boundedString(value.projectRef, 'project ref', 512),
      conversationId: boundedString(value.conversationId, 'conversation id', 512),
      turnId: boundedString(value.turnId, 'turn id', 512),
      requestId: boundedString(value.requestId, 'request id', 512),
    });
  }

  #callBody(request, context, purpose, timeoutMs) {
    if (!wellFormed(request.system) || !Array.isArray(request.messages)
      || request.messages.length > MAX_MESSAGES) {
      throw new Error('Paimos inference input is invalid');
    }
    const messages = request.messages.map((message) => {
      if (!message || (message.role !== 'user' && message.role !== 'assistant') || !wellFormed(message.content)) {
        throw new Error('Paimos inference input is invalid');
      }
      return { role: message.role, content: message.content };
    });
    const inputBytes = Buffer.byteLength(request.system, 'utf8')
      + messages.reduce((total, message) => total + Buffer.byteLength(message.content, 'utf8'), 0);
    if (inputBytes > INPUT_BYTES) throw incomplete('request_too_large');
    return {
      schema_version: 1,
      request_id: context.requestId,
      binding_id: this.bindingID,
      binding_revision: this.bindingRevision,
      actor: context.actor,
      project_ref: context.projectRef,
      conversation_id: context.conversationId,
      turn_id: context.turnId,
      purpose,
      system: request.system,
      messages,
      timeout_ms: timeoutMs,
    };
  }

  #validateCall(value, requestID, callID = undefined) {
    exactKeys(
      value,
      ['schema_version', 'call_id', 'request_id', 'state', 'deadline_at', 'last_sequence'],
      ['output_text', 'output_sha256', 'error_code'],
      'Paimos call',
    );
    if (value.schema_version !== 1 || value.request_id !== requestID
      || (callID && value.call_id !== callID) || !CALL_STATES.has(value.state)
      || !Number.isSafeInteger(value.last_sequence) || value.last_sequence < 0
      || typeof value.deadline_at !== 'string' || !Number.isFinite(Date.parse(value.deadline_at))) {
      throw new Error('Paimos call is invalid');
    }
    boundedString(value.call_id, 'Paimos call id', 256);
    if (value.output_text != null && (!wellFormed(value.output_text)
      || Buffer.byteLength(value.output_text, 'utf8') > OUTPUT_BYTES)) {
      throw new Error('Paimos call is invalid');
    }
    if (value.output_sha256 != null && !/^[a-f0-9]{64}$/u.test(value.output_sha256)) throw new Error('Paimos call is invalid');
    if (value.error_code != null) boundedString(value.error_code, 'Paimos error code', 100);
  }

  #validateEvent(value) {
    exactKeys(
      value,
      ['sequence', 'kind'],
      ['text', 'thread_id', 'turn_id', 'output_sha256', 'error_code'],
      'Paimos event',
    );
    if (!Number.isSafeInteger(value.sequence) || value.sequence < 1 || !EVENT_KINDS.has(value.kind)) {
      throw new Error('Paimos event is invalid');
    }
    if (value.text != null && !wellFormed(value.text)) throw new Error('Paimos event is invalid');
    if (value.output_sha256 != null && !/^[a-f0-9]{64}$/u.test(value.output_sha256)) throw new Error('Paimos event is invalid');
  }

  async #credential() {
    if (!this.credentialPromise) this.credentialPromise = this.#readCredential();
    return this.credentialPromise;
  }

  async #readCredential() {
    let handle;
    try {
      handle = await open(this.credentialFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_CREDENTIAL_BYTES
        || (stat.mode & 0o077) !== 0
        || (typeof process.geteuid === 'function' && stat.uid !== process.geteuid())) {
        throw new Error('Paimos credential file is not protected');
      }
      const text = (await handle.readFile('utf8')).replace(/\r?\n$/u, '');
      if (!/^[\x21-\x7e]+$/u.test(text) || text.length > MAX_CREDENTIAL_BYTES) {
        throw new Error('Paimos credential file is invalid');
      }
      return text;
    } catch {
      throw new Error('Paimos credential is unavailable');
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  #signal(parent, deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timeoutError();
    return composeAbortSignals([parent, AbortSignal.timeout(remaining)]);
  }

  async #request(method, path, headers, body, deadline, parentSignal) {
    const target = new URL(path, this.origin);
    if (target.origin !== this.origin) throw new Error('Paimos request origin is invalid');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const signal = this.#signal(parentSignal, deadline);
      let response;
      try {
        response = await this.fetchImpl(target, {
          method,
          headers,
          redirect: 'error',
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal,
        });
      } catch {
        if (parentSignal?.aborted) throw abortedError(parentSignal);
        if (Date.now() >= deadline || signal.aborted) throw timeoutError();
        if (attempt === 0) {
          await delay(Math.min(this.retryDelayMs, Math.max(0, deadline - Date.now())), this.#signal(parentSignal, deadline));
          continue;
        }
        throw incomplete('transport');
      }
      if (response.url && new URL(response.url).origin !== this.origin) {
        await response.body?.cancel().catch(() => {});
        throw new Error('Paimos response origin is invalid');
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (attempt === 0 && RETRYABLE_STATUS.has(response.status)) {
          await delay(Math.min(this.retryDelayMs, Math.max(0, deadline - Date.now())), this.#signal(parentSignal, deadline));
          continue;
        }
        throw incomplete(response.status === 408 ? 'timeout' : 'provider_failed');
      }
      try {
        return await boundedJson(response, signal, Math.min(MAX_JSON_BYTES, this.limits.maxResponseBytes));
      } catch (error) {
        if (parentSignal?.aborted) throw abortedError(parentSignal);
        if (Date.now() >= deadline || signal.aborted) throw timeoutError();
        throw error;
      }
    }
    throw incomplete('transport');
  }

  async #cancel(callID, headers, requestID, serverDeadline) {
    const deadline = Date.now() + this.cleanupTimeoutMs;
    const result = await this.#request(
      'POST',
      `${this.basePath}/calls/${encodeURIComponent(callID)}/cancel`,
      headers,
      {},
      deadline,
      undefined,
    );
    this.#validateCall(result, requestID, callID);
    if (result.deadline_at !== serverDeadline) throw new Error('Paimos call deadline changed');
  }
}
