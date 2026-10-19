import { collectPurposeReply, purposeReplySchema, unsafeReplyOutput } from '@inspr/aithema-core/safeguards';
import { createHash, timingSafeEqual } from 'node:crypto';
import { PluginError, PLUGIN_ERROR_CODES } from '@inspr/aithema-core/invocation';
import { operationScope } from '@inspr/aithema-core/reasoning';
import { voiceOperation } from '@inspr/aithema-core/live-voice';
import { aiTextOrigin } from '@inspr/aithema-core/text-origin';
import { unfenceReply } from '@inspr/aithema-core/reply';
import { ReplyOpenerStream, stripThanksOpener } from '@inspr/aithema-core/reply-opener';
import { readJson } from './server.js';
import { runElevenLabsReply, elevenLabsReplyChunk, elevenLabsCompletion } from './reply.js';

const spendReason = error => ['OpenRouter spend cap exhausted', 'OpenRouter request exceeds spend reservation'].includes(error?.message) ? error.message : undefined;
const turnReason = error => /^voice-turn-(?:obsolete|replay-expired|replacement-required|revoked|fenced|limit)$/u.test(error?.message) ? error.message : undefined;
const digest = value => createHash('sha256').update(value).digest();
// Observed growth (~72 KiB / 4 min) projects to ~2.1 MiB at the 120-minute voice cap.
// 8 MiB leaves room for faster turns, JSON overhead and multibyte text, while remaining bounded.
// Leave 1.5 s after the first-audio deadline, and 0.5 s below the provider's ~7 s budget.
export const VOICE_CALLBACK_TIMEOUT_MS = 6500;
export const FIRST_AUDIO_DEADLINE_MS = 5000;
const HOLDING_LINES = Object.freeze({ de: 'Einen Moment, bitte.', en: 'One moment, please.' });
export const MAX_COMPLETION_REQUEST_BYTES = 8 * 1_048_576;
const codeFor = error => error instanceof PluginError && PLUGIN_ERROR_CODES.includes(error.code) ? error.code : 'provider';
export function bearerMatches(header, secret) {
  if (typeof secret !== 'string' || !secret || !header?.startsWith('Bearer ')) return false;
  return timingSafeEqual(digest(header.slice(7)), digest(secret));
}
const statusFor = error => error?.code === 'auth' ? 401 : error?.code === 'not-admitted' ? 403
  : error?.code === 'limit' ? 413 : error?.code === 'invalid-output' ? 400 : error?.code === 'deadline' ? 504 : 502;

/** A host resolves this private call object by route identity; body/model never select a binding. */
export function createCompletionsHandler({ getCall, resolveSecret = ref => process.env[ref],
  buildRequest, admitReasoning, onCompletion, onDelivered, staticSecretRef, now = Date.now, timeoutMs = VOICE_CALLBACK_TIMEOUT_MS,
  maxRequestBytes = MAX_COMPLETION_REQUEST_BYTES, log = console.log, turnOperations,
  beforeAdmission, beforeOutput, onAdmission, onRetry, reportAllowed, onOpenerStripped, onBearerRejected } = {}) {
  if (![getCall, buildRequest, admitReasoning].every(port => typeof port === 'function')) throw new TypeError('Facade call, context and admission ports required');
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes <= 0) throw new TypeError('Positive facade byte limit required');
  const active = call => call && !call.closing && !call.terminal && !call.paused && !call.signal?.aborted &&
    now() < Math.min(call.spendDeadlineAt, call.browserLivenessDeadlineAt);
  return async request => {
    const started = performance.now(), turnStartedAt = now();
    let requestBytes = 0, responseBytes = 0, status = 200, callIdHash = null, logged = false;
    const logResult = (errorCode = null) => {
      if (logged) return; logged = true;
      const line = JSON.stringify({ time: new Date(now()).toISOString(), level: errorCode ? 'error' : 'info',
        event: 'voice-callback', status, latencyMs: Math.round(performance.now() - started),
        requestBytes, responseBytes, errorCode, callIdHash });
      // Only these value-free fields reach the logger; never error messages, headers, URLs or bodies.
      const fallback = () => {
        try { Promise.resolve(console.error(line)).catch(() => {}); } catch { /* Logging cannot change the response. */ }
      };
      try { Promise.resolve(log(line)).catch(fallback); } catch { fallback(); }
    };
    const reply = (body, responseStatus = 200, errorCode = null) => {
      const text = JSON.stringify(body); status = responseStatus; responseBytes = Buffer.byteLength(text);
      const response = new Response(text, { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
      logResult(errorCode); return response;
    };
    const json = (error, status, reason) => reply({ error, ...(reason ? { reason } : {}) }, status, error);
    if (request.method !== 'POST') return json('method-not-allowed', 405);
    const localCancellation = new AbortController();
    const scope = operationScope({ signal: AbortSignal.any([request.signal, localCancellation.signal]), deadlineAt: Date.now() + timeoutMs });
    let admission, iterator, invocationOptions, invocationScope, reports = 0, finishPromise, callTimer, callSignal, callAbort, streamFailure;
    const cleanup = async failed => {
      finishPromise ??= Promise.resolve().then(async () => {
        try { if (admission?.finish) await voiceOperation({ deadlineAt: Date.now() + 1000 }, () => admission.finish({ failed })); }
        finally { clearTimeout(callTimer); callSignal?.removeEventListener('abort', callAbort);
          invocationOptions?.signal.removeEventListener('abort', expire);
          invocationScope?.dispose(); scope.signal.removeEventListener('abort', expire); scope.dispose(); }
      });
      return finishPromise;
    };
    const expire = () => {
      const signal = invocationOptions?.signal.aborted ? invocationOptions.signal : scope.signal;
      if (streamFailure) void streamFailure(new PluginError(signal.reason?.name === 'TimeoutError' ? 'deadline' : 'cancelled'));
      else if (iterator) void disposeIterator(iterator).then(() => cleanup(true)).catch(() => {});
    };
    scope.signal.addEventListener('abort', expire, { once: true });
    const next = () => voiceOperation(invocationOptions ?? { signal: scope.signal }, () => iterator.next());
    const readBody = () => voiceOperation({ signal: scope.signal }, opts => readJson(request, maxRequestBytes,
      { signal: opts.signal, onBytes: bytes => { requestBytes = bytes; } }));
    try {
      let call, body;
      if (!staticSecretRef) call = await voiceOperation({ signal: scope.signal }, opts => getCall(request, opts));
      if (typeof call?.callId === 'string') callIdHash = digest(call.callId).toString('hex').slice(0, 16);
      const secretRef = staticSecretRef ?? call?.facadeSecretRef;
      const secret = secretRef && await voiceOperation({ signal: scope.signal }, () => resolveSecret(secretRef));
      if (!bearerMatches(request.headers.get('authorization'), secret)) {
        // The signal carries no header/value and cannot change auth or read the body.
        try { onBearerRejected?.(); } catch { /* Repair is best-effort; authentication stays closed. */ }
        await cleanup(true); return json('unauthorized', 401);
      }
      if (staticSecretRef) {
        // START src/pages/api/v2/llm/chat/completions.ts: authenticate before any body read.
        body = await readBody();
        const identity = body?.elevenlabs_extra_body?.aithema_call;
        if (typeof identity !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(identity)) throw new PluginError('not-admitted', 'Call identity required');
        call = await voiceOperation({ signal: scope.signal }, opts => getCall(request, opts, identity));
        if (typeof call?.callId === 'string') callIdHash = digest(call.callId).toString('hex').slice(0, 16);
      }
      if (!active(call)) throw new PluginError('not-admitted', 'Call inactive');
      if (call.signal) {
        callSignal = call.signal; callAbort = () => localCancellation.abort();
        callSignal.addEventListener('abort', callAbort, { once: true });
      }
      body ??= await readBody();
      const platformIdentity = body?.elevenlabs_extra_body?.aithema_call;
      const expectedIdentity = staticSecretRef ? call.facadeCallId : call.callId;
      if ((body?.aithema_call ?? platformIdentity) !== expectedIdentity ||
        body?.aithema_call !== undefined && body.aithema_call !== expectedIdentity ||
        platformIdentity !== undefined && platformIdentity !== expectedIdentity || !Array.isArray(body.messages) || !body.messages.length ||
        body.messages.some(message => !message || typeof message !== 'object' || Array.isArray(message) || typeof message.role !== 'string' ||
          ['system', 'user', 'assistant'].includes(message.role) && message.content != null && typeof message.content !== 'string') ||
        (body.stream !== undefined && typeof body.stream !== 'boolean')) throw new PluginError('invalid-output', 'Invalid completion request');
      const deadlineAt = Math.min(Date.now() + timeoutMs, call.spendDeadlineAt, call.browserLivenessDeadlineAt);
      callTimer = setTimeout(() => localCancellation.abort(new DOMException('Voice call deadline', 'TimeoutError')), Math.max(0, deadlineAt - now()));
      const opts = { signal: scope.signal, deadlineAt };
      const providerMessages = body.messages.filter(message => ['user', 'assistant'].includes(message.role) && typeof message.content === 'string');
      const messages = providerMessages
        .map(({ role, content }) => ({ role, content }));
      if (turnOperations) {
        // Count the original user entries; filtering null/unsupported content
        // must never turn a partial history into a plausible earlier ordinal.
        const historyUnknownReason = [body, body.elevenlabs_extra_body].some(source =>
          source?.history_truncated === true || source?.messages_truncated === true) ? 'truncated'
          : body.messages.some(message => message.role === 'user' && typeof message.content !== 'string') ? 'null-user' : undefined;
        const response = await voiceOperation(opts, bounded => runElevenLabsReply(turnOperations, { callId: call.callId,
          providerSessionId: call.providerSessionId, messages, callbackBody: body, historyUnknownReason, stream: body.stream }, async operation => {
          // The durable operation owns its lifetime; an HTTP retry owns only a reader.
          const worker = createCompletionsHandler({ getCall, resolveSecret, buildRequest, admitReasoning,
            onCompletion: event => onCompletion?.({ ...event, userTurnOrdinal: operation.ordinal }),
            staticSecretRef, now, timeoutMs, maxRequestBytes, log: () => {}, onOpenerStripped,
            beforeAdmission: operation.beforeAdmission, beforeOutput: operation.assertCurrent,
            onAdmission: operation.admitted, onRetry: operation.retry, reportAllowed: operation.reportAllowed });
          return worker(new Request(request.url, { method: 'POST', headers: request.headers,
            body: JSON.stringify({ ...body, stream: true }), signal: operation.signal }));
        }, { ...bounded, signal: request.signal, now }));
        await cleanup(false);
        status = response.status;
        if (!response.ok) {
          const body = await response.json();
          return reply(body, response.status, PLUGIN_ERROR_CODES.includes(body.error) ? body.error : 'provider');
        }
        if (!response.body) { logResult(); return response; }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let ended = false, responseError = null;
        return new Response(new ReadableStream({
          async pull(controller) {
            try {
              const item = await reader.read();
              if (ended) return;
              // A frame can have been queued before takeover while this read
              // awaited it. Detach only the retired reader, never the paid job.
              if (call.readerCurrent?.() === false) {
                ended = true; await reader.cancel(); controller.close(); logResult('cancelled'); return;
              }
              if (item.done) { ended = true; controller.close(); await onDelivered?.({ callId: call.callId }); logResult(responseError); }
              else {
                // The operation emits complete error frames, containing only a coded error.
                const text = decoder.decode(item.value, { stream: true });
                if (text.startsWith('data: {"error":')) responseError = codeFor(new PluginError(JSON.parse(text.slice(6)).error));
                responseBytes += item.value.byteLength; controller.enqueue(item.value);
              }
            } catch (error) { ended = true; controller.error(error); logResult(codeFor(error)); }
          },
          async cancel() { if (ended) return; ended = true; await reader.cancel(); logResult('cancelled'); },
        }, { highWaterMark: 0 }), { status: response.status, headers: response.headers });
      }
      // Rebuild the trusted session prompt. Discard provider system/model/options and private callback fields.
      const input = await voiceOperation(opts, bounded => buildRequest({ callId: call.callId, messages }, bounded));
      // Later admission/analysis may rebuild its prompt; validation keeps this turn-start specification.
      const pinned = pinSpecification(input);
      let textOrigin;
      const prepareInvocation = async () => {
        const latest = await voiceOperation(opts, bounded => getCall(request, bounded, expectedIdentity));
        if (!active(latest) || latest.callId !== call.callId || latest.providerSessionId !== call.providerSessionId ||
          latest.facadeSecretRef !== call.facadeSecretRef || latest.facadeCallId !== call.facadeCallId) throw new PluginError('not-admitted', 'Call changed');
        beforeAdmission?.();
        // The consume check outlives this bounded admission call. Retain the
        // operation lifetime signal so closing/revoking the call still cancels it.
        admission = await voiceOperation(opts, bounded => admitReasoning({ callId: call.callId, request: input, messages,
          options: { ...bounded, signal: opts.signal }, beforeAdmission, onRetry }));
        if (!admission?.plugin?.stream || !admission.options?.attempt || typeof admission.options.report !== 'function' ||
          typeof admission.finish !== 'function') throw new PluginError('not-admitted', 'Reasoning admission required');
        beforeOutput?.();
        onAdmission?.(admission.options.attempt.attemptId);
        textOrigin = aiTextOrigin(admission.producer ?? admission.plugin.binding ??
          { model: admission.plugin.model, plugin: admission.plugin.manifest?.id ?? admission.plugin.id });
        const report = admission.options.report;
        const invocationDeadline = Math.min(deadlineAt, admission.options.deadlineAt ?? deadlineAt);
        // One lifetime signal owns the earliest deadline, including a response nobody reads.
        invocationScope = operationScope({ deadlineAt: invocationDeadline,
          signal: admission.options.signal ? AbortSignal.any([scope.signal, admission.options.signal]) : scope.signal });
        invocationOptions = { ...admission.options,
          signal: invocationScope.signal, deadlineAt: invocationDeadline,
          report(terminal) {
            if (reportAllowed && !reportAllowed()) return;
            if (++reports !== 1) throw new PluginError('already-claimed'); return report(terminal);
          } };
        invocationOptions.signal.addEventListener('abort', expire, { once: true });
        // Admission may rebuild against a newer session snapshot after async checks.
        return admission.request ?? input;
      };
      const admittedRequest = body.stream === true ? undefined : await prepareInvocation();
      if (admittedRequest?.purposePolicy && body.stream !== true) {
        const initialAdmission = admission;
        const safe = await collectPurposeReply(admittedRequest, async function* (guardedRequest, attempt) {
          let selected = initialAdmission;
          if (attempt) {
            beforeOutput?.();
            selected = await voiceOperation(opts, bounded => admitReasoning({ callId: call.callId, request: guardedRequest,
              messages, options: { ...bounded, signal: opts.signal }, safeguardRetry: true }));
          }
          let failed = false;
          try {
            const stream = selected.plugin.stream(guardedRequest, attempt ? selected.options : invocationOptions)[Symbol.asyncIterator]();
            try {
              for (;;) {
                const item = await voiceOperation(invocationOptions, () => stream.next());
                if (item.done) break;
                beforeOutput?.(); yield item.value;
              }
            } finally { await disposeIterator(stream); }
          } catch (error) { failed = true; throw error; }
          finally { if (attempt) await selected.finish({ failed }); }
        }, { guardDirection: initialAdmission.guardDirection });
        if (reports !== 1) throw new PluginError('invalid-output', 'Reasoning omitted terminal report');
        beforeOutput?.();
        const guarded = stripThanksOpener(safe.content, admittedRequest.locale);
        if (guarded.stripped) onOpenerStripped?.();
        const id = `chatcmpl-${crypto.randomUUID()}`, created = Math.floor(now() / 1000);
        await voiceOperation(invocationOptions, () => onCompletion?.({ callId: call.callId, providerSessionId: call.providerSessionId,
          replyId: id, content: guarded.text, textOrigin, engine: admission.engine, scope: safe.scope,
          safeguardRevision: admittedRequest.safeguardRevision }));
        await cleanup(false);
        const response = reply(elevenLabsCompletion({ replyId: id, created }, guarded.text, { metadata: false }));
        await onDelivered?.({ callId: call.callId }); return response;
      }
      let safeScope;
      const generate = async function* () {
        await prepareInvocation();
        if (pinned.purposePolicy) yield* committedPurposeSegments(pinned, admission, invocationOptions, {
          beforeOutput, onRetry, reportAllowed,
          admit: request => voiceOperation(invocationOptions, bounded => admitReasoning({ callId: call.callId, request,
            messages, options: { ...bounded, signal: invocationOptions.signal }, safeguardRetry: true })),
          scope: value => { safeScope = value; },
        });
        else yield* admission.plugin.stream(admission.request ?? input, invocationOptions);
      };
      iterator = (body.stream === true ? generate() : admission.plugin.stream(admittedRequest, invocationOptions))[Symbol.asyncIterator]();
      let first = body.stream === true ? null : await next(); // Dispatch/auth failures can still be returned as HTTP errors.
      const locale = pinned.locale;
      const stripped = () => {
        try { onOpenerStripped?.(); } catch { /* Diagnostics cannot affect paid work. */ }
      };
      const id = `chatcmpl-${crypto.randomUUID()}`;
      const frame = delta => elevenLabsReplyChunk({ replyId: id, created: Math.floor(now() / 1000) }, delta);
      if (body.stream !== true) {
        let content = '';
        while (!first.done) {
          if (typeof first.value !== 'string') throw new PluginError('invalid-output');
          content += first.value; if (content.length > 1_048_576) throw new PluginError('limit'); first = await next();
        }
        if (reports !== 1) throw new PluginError('invalid-output', 'Reasoning omitted terminal report');
        beforeOutput?.();
        const guarded = stripThanksOpener(content, locale); content = guarded.text;
        if (guarded.stripped) stripped();
        await voiceOperation(invocationOptions, () => onCompletion?.({ callId: call.callId, providerSessionId: call.providerSessionId, replyId: id, content, textOrigin, engine: admission.engine }));
        await cleanup(false);
        return reply(elevenLabsCompletion({ replyId: id, created: Math.floor(now() / 1000) }, content, { metadata: false }));
      }
      const encoder = new TextEncoder(), opener = new ReplyOpenerStream(locale, { bufferNormal: false });
      let roleSent = false, size = 0, content = '', streamEnded = false, cancelled = false, openerCounted = false;
      let holdingTimer, firstPending, holdingSent = false, hasValidatedContent = false;
      const enqueue = (controller, text) => {
        const bytes = encoder.encode(text); controller.enqueue(bytes); responseBytes += bytes.byteLength;
      };
      const emitContent = (controller, text) => {
        if (opener.stripped && !openerCounted) { openerCounted = true; stripped(); }
        if (!text) return;
        hasValidatedContent = true; clearTimeout(holdingTimer);
        if (holdingSent && content === HOLDING_LINES[locale === 'de' ? 'de' : 'en']) text = ' ' + text;
        content += text;
        enqueue(controller, `data: ${JSON.stringify(frame({ content: text }))}\n\n`);
      };
      return new Response(new ReadableStream({
        start(controller) {
          // Dispatch once even if the HTTP reader stalls; its lifetime still expires.
          firstPending = next(); firstPending.catch(() => {});
          // A fixed, pre-validated segment is independent of generation, validation and retries.
          holdingTimer = setTimeout(() => {
            if (streamEnded || hasValidatedContent || holdingSent) return;
            try {
              (invocationOptions?.signal ?? scope.signal).throwIfAborted(); beforeOutput?.();
              if (!roleSent) { roleSent = true; enqueue(controller, `data: ${JSON.stringify(frame({ role: 'assistant' }))}\n\n`); }
              holdingSent = true; content = HOLDING_LINES[locale === 'de' ? 'de' : 'en'];
              enqueue(controller, `data: ${JSON.stringify(frame({ content }))}\n\n`);
            } catch (error) { void streamFailure(error); }
          }, Math.max(0, turnStartedAt + FIRST_AUDIO_DEADLINE_MS - now()));
          streamFailure = async error => {
            if (streamEnded) return; streamEnded = true; clearTimeout(holdingTimer);
            const code = codeFor(error);
            cancelReasoning(); void disposeIterator(iterator);
            try { await cleanup(true); } catch { /* Preserve the original failure; settlement must not hide its JSON error. */ }
            try {
              if (!cancelled) { enqueue(controller, `data: ${JSON.stringify({ error: code })}\n\n`); controller.close(); }
            } finally { logResult(code); }
          };
        },
        async pull(controller) {
          if (streamEnded) return;
          try {
            beforeOutput?.();
            if (!roleSent) { roleSent = true; enqueue(controller, `data: ${JSON.stringify(frame({ role: 'assistant' }))}\n\n`); return; }
            // Read only until the first safe clause. All subsequent chunks pass
            // straight through, and the completion receipt uses emitted bytes.
            while (!streamEnded) {
              const part = first; first = null;
              const pending = firstPending; firstPending = null;
              const item = part ?? await (pending ?? next());
              if (item.done) {
                if (reports !== 1) throw new PluginError('invalid-output', 'Reasoning omitted terminal report');
                clearTimeout(holdingTimer);
                beforeOutput?.();
                emitContent(controller, opener.finish());
                await voiceOperation(opts, () => onCompletion?.({ callId: call.callId, providerSessionId: call.providerSessionId, replyId: id, content, textOrigin, engine: admission.engine, ...(safeScope ? { scope: safeScope, safeguardRevision: pinned.safeguardRevision } : {}) }));
                await cleanup(false);
                if (streamEnded) return; streamEnded = true;
                const stop = frame({}); stop.choices[0].finish_reason = 'stop';
                enqueue(controller, `data: ${JSON.stringify(stop)}\n\ndata: [DONE]\n\n`); controller.close(); logResult(); return;
              }
              if (streamEnded) return;
              beforeOutput?.();
              if (typeof item.value !== 'string') throw new PluginError('invalid-output');
              size += item.value.length; if (size > 1_048_576) throw new PluginError('limit');
              const text = opener.push(item.value);
              emitContent(controller, text);
              if (text) return;
            }
          } catch (error) {
            await streamFailure(error);
          }
        },
        async cancel() {
          cancelled = true;
          if (streamEnded) return; streamEnded = true; clearTimeout(holdingTimer);
          // Abort the reasoning operation before iterator.return (it may be waiting on provider I/O).
          cancelReasoning(); await disposeIterator(iterator);
          try { await cleanup(true); } catch { /* A disconnected client still gets one failure log. */ }
          logResult('cancelled');
        },
      }), { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } });
    } catch (error) {
      const code = codeFor(error);
      cancelReasoning(); await disposeIterator(iterator);
      try { await cleanup(true); } catch { /* A failed settlement cannot replace the original JSON error with an empty 5xx. */ }
      return json(code, statusFor({ code }), spendReason(error) ?? turnReason(error));
    }
    function cancelReasoning() { localCancellation.abort(); }
  };
}
async function disposeIterator(iterator) {
  try { if (iterator?.return) await voiceOperation({ deadlineAt: Date.now() + 1000 }, () => iterator.return()); } catch { /* Host finish settles missing usage conservatively. */ }
}

// Copy only plain request data; policy callbacks remain host-owned functions.
function pinSpecification(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(pinSpecification));
  if (value && Object.getPrototypeOf(value) === Object.prototype) return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, pinSpecification(child)])));
  return value;
}

/** A segment commits only at its closing JSON brace, including its own scope.
 * Old providers may return one legacy envelope; that envelope commits at EOF.
 * Parsing never releases partial strings, nested objects or JSON syntax to TTS.
 */
class PurposeSegments {
  wire = ''; cursor = null; count = 0; separator = false;
  push(delta) {
    if (typeof delta !== 'string' || this.wire.length + delta.length > 300_000) throw new TypeError('Invalid reasoning stream');
    this.wire += delta;
    if (this.cursor === null) {
      const prefix = /^\s*\{\s*"segments"\s*:\s*\[/u.exec(this.wire);
      if (!prefix) return [];
      this.cursor = prefix[0].length;
    }
    const segments = [];
    for (;;) {
      while (/\s/u.test(this.wire[this.cursor] ?? '') && this.cursor < this.wire.length) this.cursor++;
      if (this.separator) {
        if (this.wire[this.cursor] !== ',') break;
        this.cursor++; this.separator = false;
        while (/\s/u.test(this.wire[this.cursor] ?? '') && this.cursor < this.wire.length) this.cursor++;
      }
      if (this.cursor >= this.wire.length || this.wire[this.cursor] === ']') break;
      if (this.wire[this.cursor] !== '{') throw new TypeError('Invalid segment');
      let depth = 0, quoted = false, escaped = false, end = this.cursor;
      for (; end < this.wire.length; end++) {
        const char = this.wire[end];
        if (quoted) {
          if (!escaped && char === '"') quoted = false;
          escaped = !escaped && char === '\\';
        } else if (char === '"') quoted = true;
        else if (char === '{' || char === '[') depth++;
        else if (char === '}' || char === ']') { if (--depth === 0) { end++; break; } }
      }
      if (depth || quoted) break;
      if (++this.count > 8) throw new TypeError('Too many segments');
      const raw = this.wire.slice(this.cursor, end); JSON.parse(raw);
      segments.push(raw); this.cursor = end; this.separator = true;
    }
    return segments;
  }
  finish() {
    if (this.cursor === null) return [this.wire];
    const value = JSON.parse(this.wire);
    if (Object.keys(value).length !== 1 || !Array.isArray(value.segments) || !this.count || value.segments.length !== this.count) {
      throw new TypeError('Invalid segment envelope');
    }
    return [];
  }
}

/** One admitted generation at a time; all segments/retries use the same pinned
 * validation policy and original operation lifetime. No analysis lane is joined.
 */
async function* committedPurposeSegments(pinned, initial, options, ports) {
  const schema = { type: 'object', additionalProperties: false, required: ['segments'], properties: {
    segments: { type: 'array', minItems: 1, maxItems: 8, items: purposeReplySchema } } };
  let accepted = '', scope = 'in', unsafe = false, promptOnly = false, lastRaw = '';
  const rejected = new Error('Segment rejected');
  const updateScope = value => { if (value === 'off' || scope === 'in') scope = value; ports.scope(scope); };
  const validate = async raw => {
    // Check accumulated visible text too: splitting a canary, code or private
    // prompt span across individually valid envelopes cannot evade the policy.
    const value = JSON.parse(unfenceReply(raw));
    if (unsafeReplyOutput({ content: accepted + (value.content ?? '') }, pinned.purposePolicy, pinned.hiddenGuidance)) {
      unsafe = true; throw rejected;
    }
    unsafe ||= unsafeReplyOutput(raw, pinned.purposePolicy, pinned.hiddenGuidance);
    const safe = await collectPurposeReply(pinned, async function* (_, attempt) {
      if (attempt) throw rejected;
      yield raw;
    });
    // Preserve the existing sticky unsafe-output redirect across the retry.
    if (unsafe && safe.scope !== 'off') {
      return collectPurposeReply(pinned, async function* () {
        yield JSON.stringify({ ...safe, scope: 'off' });
      });
    }
    return safe;
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const request = { ...pinned, schema, ...(promptOnly ? { replySchemaConstrained: false } : {}),
      system: pinned.system + '\nFor spoken delivery, replace the single reply envelope above with {"segments":[reply,...]}. '
        + 'Each reply is one short, independently committed spoken segment matching the original reply schema, including its scope. '
        + 'Do not split words or sentences across segments. Return only this JSON object. '
        + (attempt ? 'The previous output was rejected. Continue safely without repeating already committed speech. Never echo rejected text.' : '') };
    const selected = attempt ? await ports.admit(request) : initial;
    const cancellation = new AbortController();
    const lifetime = operationScope({ deadlineAt: Math.min(options.deadlineAt, selected.options.deadlineAt ?? options.deadlineAt),
      signal: AbortSignal.any([options.signal, cancellation.signal, ...(selected.options.signal ? [selected.options.signal] : [])]) });
    let count = 0, failed = true, stream;
    const invocation = { ...selected.options, signal: lifetime.signal,
      deadlineAt: Math.min(options.deadlineAt, selected.options.deadlineAt ?? options.deadlineAt),
      report(terminal) {
        if (ports.reportAllowed && !ports.reportAllowed()) return;
        if (++count !== 1) throw new PluginError('already-claimed');
        return (attempt ? selected.options : options).report(terminal);
      } };
    const parser = new PurposeSegments();
    try {
      stream = selected.plugin.stream(request, invocation)[Symbol.asyncIterator]();
      const commit = async raw => {
        lastRaw = raw;
        const safe = await validate(raw);
        ports.beforeOutput?.();
        const guarded = initial.guardDirection?.(safe) ?? safe;
        updateScope(guarded.scope); accepted += guarded.content;
        return guarded.content;
      };
      for (;;) {
        const item = await voiceOperation(invocation, () => stream.next());
        if (item.done) break;
        for (const raw of parser.push(item.value)) yield await commit(raw);
      }
      for (const raw of parser.finish()) yield await commit(raw);
      if (count !== 1) throw new PluginError('invalid-output', 'Reasoning omitted terminal report');
      failed = false; return;
    } catch (error) {
      if (error.responseFormatUnsupported === true && !promptOnly) promptOnly = true;
      else if (error !== rejected && !(error instanceof TypeError) && !(error instanceof SyntaxError) && error.code !== 'invalid-output') throw error;
      ports.onRetry?.('purpose-segment-rejected');
    } finally {
      cancellation.abort(); await disposeIterator(stream); lifetime.dispose();
      // Initial settlement belongs to outer cleanup; retry settlement is bounded
      // by the same operation, including ports that ignore cancellation.
      if (attempt) await voiceOperation({ deadlineAt: Date.now() + 1000 }, () => selected.finish({ failed }));
    }
  }
  // Two admitted generations exhausted: retain the existing fixed safe fallback.
  const fallback = await collectPurposeReply(pinned, async function* () { yield unsafe
    ? JSON.stringify({ content: pinned.purposePolicy.canary, scope: 'off', question_short: null, options: [] }) : lastRaw; });
  ports.beforeOutput?.(); updateScope(fallback.scope); yield fallback.content;
}
