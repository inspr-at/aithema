import { createHash, timingSafeEqual } from 'node:crypto';
import { PluginError, PLUGIN_ERROR_CODES } from '../../../packages/core/src/invocation.js';
import { operationScope } from '../../../packages/core/src/reasoning.js';
import { voiceOperation } from '../../../packages/core/src/live-voice.js';
import { aiTextOrigin } from '../../../packages/core/src/text-origin.js';
import { ReplyOpenerStream, stripThanksOpener } from '../../../packages/core/src/reply-opener.js';
import { readJson } from './server.js';

const spendReason = error => ['OpenRouter spend cap exhausted', 'OpenRouter request exceeds spend reservation'].includes(error?.message) ? error.message : undefined;
const turnReason = error => /^voice-turn-(?:obsolete|replay-expired|replacement-required|revoked|fenced|limit)$/u.test(error?.message) ? error.message : undefined;
const digest = value => createHash('sha256').update(value).digest();
// Observed growth (~72 KiB / 4 min) projects to ~2.1 MiB at the 120-minute voice cap.
// 8 MiB leaves room for faster turns, JSON overhead and multibyte text, while remaining bounded.
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
  buildRequest, admitReasoning, onCompletion, staticSecretRef, now = Date.now, timeoutMs = 30_000,
  maxRequestBytes = MAX_COMPLETION_REQUEST_BYTES, log = console.log, turnOperations,
  beforeAdmission, beforeOutput, onAdmission, reportAllowed, onOpenerStripped } = {}) {
  if (![getCall, buildRequest, admitReasoning].every(port => typeof port === 'function')) throw new TypeError('Facade call, context and admission ports required');
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes <= 0) throw new TypeError('Positive facade byte limit required');
  const active = call => call && !call.closing && !call.terminal && !call.paused && !call.signal?.aborted &&
    now() < Math.min(call.spendDeadlineAt, call.browserLivenessDeadlineAt);
  return async request => {
    const started = performance.now();
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
    const next = () => voiceOperation(invocationOptions, () => iterator.next());
    const readBody = () => voiceOperation({ signal: scope.signal }, opts => readJson(request, maxRequestBytes,
      { signal: opts.signal, onBytes: bytes => { requestBytes = bytes; } }));
    try {
      let call, body;
      if (!staticSecretRef) call = await voiceOperation({ signal: scope.signal }, opts => getCall(request, opts));
      if (typeof call?.callId === 'string') callIdHash = digest(call.callId).toString('hex').slice(0, 16);
      const secretRef = staticSecretRef ?? call?.facadeSecretRef;
      const secret = secretRef && await voiceOperation({ signal: scope.signal }, () => resolveSecret(secretRef));
      if (!bearerMatches(request.headers.get('authorization'), secret)) { await cleanup(true); return json('unauthorized', 401); }
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
        const response = await voiceOperation(opts, bounded => turnOperations.run({ callId: call.callId,
          providerSessionId: call.providerSessionId, messages, callbackBody: body, historyUnknownReason, stream: body.stream }, async operation => {
          // The durable operation owns its lifetime; an HTTP retry owns only a reader.
          const worker = createCompletionsHandler({ getCall, resolveSecret, buildRequest, admitReasoning,
            onCompletion: event => onCompletion?.({ ...event, userTurnOrdinal: operation.ordinal }),
            staticSecretRef, now, timeoutMs, maxRequestBytes, log: () => {}, onOpenerStripped,
            beforeAdmission: operation.beforeAdmission, beforeOutput: operation.assertCurrent,
            onAdmission: operation.admitted, reportAllowed: operation.reportAllowed });
          return worker(new Request(request.url, { method: 'POST', headers: request.headers,
            body: JSON.stringify({ ...body, stream: true }), signal: operation.signal }));
        }, { ...bounded, signal: request.signal }));
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
              if (item.done) { ended = true; controller.close(); logResult(responseError); }
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
      const latest = await voiceOperation(opts, bounded => getCall(request, bounded, expectedIdentity));
      if (!active(latest) || latest.callId !== call.callId || latest.providerSessionId !== call.providerSessionId ||
        latest.facadeSecretRef !== call.facadeSecretRef || latest.facadeCallId !== call.facadeCallId) throw new PluginError('not-admitted', 'Call changed');
      beforeAdmission?.();
      // The consume check outlives this bounded admission call. Retain the
      // operation lifetime signal so closing/revoking the call still cancels it.
      admission = await voiceOperation(opts, bounded => admitReasoning({ callId: call.callId, request: input, messages,
        options: { ...bounded, signal: opts.signal }, beforeAdmission }));
      if (!admission?.plugin?.stream || !admission.options?.attempt || typeof admission.options.report !== 'function' ||
        typeof admission.finish !== 'function') throw new PluginError('not-admitted', 'Reasoning admission required');
      beforeOutput?.();
      onAdmission?.(admission.options.attempt.attemptId);
      const textOrigin = aiTextOrigin(admission.producer ?? admission.plugin.binding ??
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
      iterator = admission.plugin.stream(admission.request ?? input, invocationOptions)[Symbol.asyncIterator]();
      let first = await next(); // Dispatch/auth failures can still be returned as HTTP errors.
      const locale = (admission.request ?? input).locale;
      const stripped = () => {
        try { onOpenerStripped?.(); } catch { /* Diagnostics cannot affect paid work. */ }
      };
      const id = `chatcmpl-${crypto.randomUUID()}`;
      const frame = delta => ({ id, object: 'chat.completion.chunk', created: Math.floor(now() / 1000),
        model: 'session-reasoning', ...(delta.role === 'assistant' ? { metadata: { aithema_reply_id: id } } : {}),
        choices: [{ index: 0, delta, finish_reason: null }] });
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
        return reply({ id, object: 'chat.completion', created: Math.floor(now() / 1000), model: 'session-reasoning',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
      }
      const encoder = new TextEncoder(), opener = new ReplyOpenerStream(locale, { bufferNormal: false });
      let roleSent = false, size = 0, content = '', streamEnded = false, cancelled = false, openerCounted = false;
      const enqueue = (controller, text) => {
        const bytes = encoder.encode(text); controller.enqueue(bytes); responseBytes += bytes.byteLength;
      };
      const emitContent = (controller, text) => {
        if (opener.stripped && !openerCounted) { openerCounted = true; stripped(); }
        if (!text) return;
        content += text;
        enqueue(controller, `data: ${JSON.stringify(frame({ content: text }))}\n\n`);
      };
      return new Response(new ReadableStream({
        start(controller) {
          streamFailure = async error => {
            if (streamEnded) return; streamEnded = true;
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
              const item = part ?? await next();
              if (item.done) {
                if (reports !== 1) throw new PluginError('invalid-output', 'Reasoning omitted terminal report');
                beforeOutput?.();
                emitContent(controller, opener.finish());
                await voiceOperation(opts, () => onCompletion?.({ callId: call.callId, providerSessionId: call.providerSessionId, replyId: id, content, textOrigin, engine: admission.engine }));
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
          if (streamEnded) return; streamEnded = true;
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
