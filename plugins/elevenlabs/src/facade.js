import { createHash, timingSafeEqual } from 'node:crypto';
import { PluginError } from '../../../packages/core/src/invocation.js';
import { operationScope } from '../../../packages/core/src/reasoning.js';
import { voiceOperation } from '../../../packages/core/src/live-voice.js';
import { aiTextOrigin } from '../../../packages/core/src/text-origin.js';
import { readJson } from './server.js';

const spendReason = error => ['OpenRouter spend cap exhausted', 'OpenRouter request exceeds spend reservation'].includes(error?.message) ? error.message : undefined;
const json = (error, status, reason) => Response.json({ error, ...(reason ? { reason } : {}) }, { status, headers: { 'cache-control': 'no-store' } });
const digest = value => createHash('sha256').update(value).digest();
export function bearerMatches(header, secret) {
  if (typeof secret !== 'string' || !secret || !header?.startsWith('Bearer ')) return false;
  return timingSafeEqual(digest(header.slice(7)), digest(secret));
}
const statusFor = error => error?.code === 'auth' ? 401 : error?.code === 'not-admitted' ? 403
  : error?.code === 'limit' ? 413 : error?.code === 'invalid-output' ? 400 : error?.code === 'deadline' ? 504 : 502;

/** A host resolves this private call object by route identity; body/model never select a binding. */
export function createCompletionsHandler({ getCall, resolveSecret = ref => process.env[ref],
  buildRequest, admitReasoning, onCompletion, staticSecretRef, now = Date.now, timeoutMs = 30_000, maxRequestBytes = 65_536 } = {}) {
  if (![getCall, buildRequest, admitReasoning].every(port => typeof port === 'function')) throw new TypeError('Facade call, context and admission ports required');
  const active = call => call && !call.closing && !call.terminal && !call.paused && !call.signal?.aborted &&
    now() < Math.min(call.spendDeadlineAt, call.browserLivenessDeadlineAt);
  return async request => {
    if (request.method !== 'POST') return json('method-not-allowed', 405);
    const localCancellation = new AbortController();
    const scope = operationScope({ signal: AbortSignal.any([request.signal, localCancellation.signal]), deadlineAt: Date.now() + timeoutMs });
    let admission, iterator, invocationOptions, reports = 0, finishPromise, callTimer, callSignal, callAbort;
    const cleanup = async failed => {
      finishPromise ??= Promise.resolve().then(async () => {
        try { await admission?.finish?.({ failed }); }
        finally { clearTimeout(callTimer); callSignal?.removeEventListener('abort', callAbort);
          invocationOptions?.signal.removeEventListener('abort', expire);
          scope.signal.removeEventListener('abort', expire); scope.dispose(); }
      });
      return finishPromise;
    };
    const expire = () => { if (iterator) void disposeIterator(iterator).then(() => cleanup(true)).catch(() => {}); };
    scope.signal.addEventListener('abort', expire, { once: true });
    const next = () => voiceOperation(invocationOptions, () => iterator.next());
    try {
      let call, body;
      if (!staticSecretRef) call = await voiceOperation({ signal: scope.signal }, opts => getCall(request, opts));
      const secretRef = staticSecretRef ?? call?.facadeSecretRef;
      const secret = secretRef && await voiceOperation({ signal: scope.signal }, () => resolveSecret(secretRef));
      if (!bearerMatches(request.headers.get('authorization'), secret)) { await cleanup(true); return json('unauthorized', 401); }
      if (staticSecretRef) {
        // START src/pages/api/v2/llm/chat/completions.ts: authenticate before any body read.
        body = await voiceOperation({ signal: scope.signal }, () => readJson(request, maxRequestBytes));
        const identity = body?.elevenlabs_extra_body?.aithema_call;
        if (typeof identity !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(identity)) throw new PluginError('not-admitted', 'Call identity required');
        call = await voiceOperation({ signal: scope.signal }, opts => getCall(request, opts, identity));
      }
      if (!active(call)) throw new PluginError('not-admitted', 'Call inactive');
      if (call.signal) {
        callSignal = call.signal; callAbort = () => localCancellation.abort();
        callSignal.addEventListener('abort', callAbort, { once: true });
      }
      body ??= await voiceOperation({ signal: scope.signal }, () => readJson(request, maxRequestBytes));
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
      // Rebuild the trusted session prompt. Discard provider system/model/options and private callback fields.
      const input = await voiceOperation(opts, bounded => buildRequest({ callId: call.callId,
        messages: body.messages.filter(message => ['user', 'assistant'].includes(message.role) && typeof message.content === 'string')
          .map(({ role, content }) => ({ role, content })) }, bounded));
      const latest = await voiceOperation(opts, bounded => getCall(request, bounded, expectedIdentity));
      if (!active(latest) || latest.callId !== call.callId || latest.providerSessionId !== call.providerSessionId ||
        latest.facadeSecretRef !== call.facadeSecretRef || latest.facadeCallId !== call.facadeCallId) throw new PluginError('not-admitted', 'Call changed');
      admission = await voiceOperation(opts, bounded => admitReasoning({ callId: call.callId, request: input, options: bounded }));
      if (!admission?.plugin?.stream || !admission.options?.attempt || typeof admission.options.report !== 'function' ||
        typeof admission.finish !== 'function') throw new PluginError('not-admitted', 'Reasoning admission required');
      const textOrigin = aiTextOrigin(admission.producer ?? admission.plugin.binding ??
        { model: admission.plugin.model, plugin: admission.plugin.manifest?.id ?? admission.plugin.id });
      const report = admission.options.report;
      invocationOptions = { ...admission.options,
        signal: admission.options.signal ? AbortSignal.any([scope.signal, admission.options.signal]) : scope.signal,
        deadlineAt: Math.min(deadlineAt, admission.options.deadlineAt ?? deadlineAt),
        report(terminal) { if (++reports !== 1) throw new PluginError('already-claimed'); return report(terminal); } };
      invocationOptions.signal.addEventListener('abort', expire, { once: true });
      iterator = admission.plugin.stream(input, invocationOptions)[Symbol.asyncIterator]();
      let first = await next(); // Dispatch/auth failures can still be returned as HTTP errors.
      const id = `chatcmpl-${crypto.randomUUID()}`;
      const frame = delta => ({ id, object: 'chat.completion.chunk', created: Math.floor(now() / 1000),
        model: 'session-reasoning', choices: [{ index: 0, delta, finish_reason: null }] });
      if (body.stream !== true) {
        let content = '';
        while (!first.done) {
          if (typeof first.value !== 'string') throw new PluginError('invalid-output');
          content += first.value; if (content.length > 1_048_576) throw new PluginError('limit'); first = await next();
        }
        if (reports !== 1) throw new PluginError('invalid-output', 'Reasoning omitted terminal report');
        await onCompletion?.({ callId: call.callId, providerSessionId: call.providerSessionId, content, textOrigin, engine: admission.engine });
        await cleanup(false);
        return Response.json({ id, object: 'chat.completion', created: Math.floor(now() / 1000), model: 'session-reasoning',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }, { headers: { 'cache-control': 'no-store' } });
      }
      const encoder = new TextEncoder(); let roleSent = false, size = 0, content = '';
      return new Response(new ReadableStream({
        async pull(controller) {
          try {
            if (!roleSent) { roleSent = true; controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame({ role: 'assistant' }))}\n\n`)); return; }
            const part = first; first = null;
            const item = part ?? await next();
            if (item.done) {
              if (reports !== 1) throw new PluginError('invalid-output', 'Reasoning omitted terminal report');
              await onCompletion?.({ callId: call.callId, providerSessionId: call.providerSessionId, content, textOrigin, engine: admission.engine });
              await cleanup(false);
              const stop = frame({}); stop.choices[0].finish_reason = 'stop';
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(stop)}\n\ndata: [DONE]\n\n`)); controller.close(); return;
            }
            if (typeof item.value !== 'string') throw new PluginError('invalid-output');
            size += item.value.length; if (size > 1_048_576) throw new PluginError('limit');
            content += item.value;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame({ content: item.value }))}\n\n`));
          } catch (error) {
            cancelReasoning(); await disposeIterator(iterator); await cleanup(true);
            controller.error(new PluginError(error?.code ?? 'provider', 'Reasoning stream failed'));
          }
        },
        async cancel() {
          // Abort the reasoning operation before iterator.return (it may be waiting on provider I/O).
          cancelReasoning(); await disposeIterator(iterator); await cleanup(true);
        },
      }), { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } });
    } catch (error) {
      cancelReasoning(); await disposeIterator(iterator); await cleanup(true);
      return json(error instanceof PluginError ? error.code : 'provider', statusFor(error), spendReason(error));
    }
    function cancelReasoning() { localCancellation.abort(); }
  };
}
async function disposeIterator(iterator) {
  try { if (iterator?.return) await voiceOperation({ deadlineAt: Date.now() + 1000 }, () => iterator.return()); } catch { /* Host finish settles missing usage conservatively. */ }
}
