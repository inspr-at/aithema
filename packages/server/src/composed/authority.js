import { randomUUID } from 'node:crypto';
import { PluginError, aiTextOrigin, collectPurposeReply, stripThanksOpener } from '@inspr/aithema-core';
import { voiceOperation } from '@inspr/aithema-core/live-voice';
import { boundedEvents } from '@inspr/aithema-core/voice-components';
import { createVoiceReplyExecutor } from '../voice-turns.js';

/** The ordinary voice mount supplies these private authorities. There is no
 * browser transcript, reasoning model selection or provider-authored answer. */
export function createComposedVoiceAuthority(operations) {
  const { authorizeComposition, commitCoordinator, turnOperations, admitReasoning, onCompletion, onDelivered } = operations;
  if ([authorizeComposition, commitCoordinator, turnOperations?.run, admitReasoning].some(port => typeof port !== 'function')) {
    throw new TypeError('Production composed voice authorities required');
  }
  const authorize = (request, options) => authorizeComposition(request, options);
  return Object.freeze({ authorize,
    admitComponent: request => operations.admitComponent(request),
    commitUtterance: (envelope, options) => commitCoordinator(envelope, options),
    replyExecutor: createVoiceReplyExecutor({ execute(envelope, options) {
      const context = envelope.payload, { callId, providerSessionId, callbackBody } = context;
      return turnOperations.run(context, async worker => {
        worker.beforeAdmission();
        let admission, textOrigin, engine, admitted = false;
        async function* invoke(_input, retry = 0) {
          let failed = true, reports = 0;
          admission = await voiceOperation({ ...options, signal: worker.signal }, bounded => admitReasoning({ callId,
            messages: callbackBody.messages, options: { ...bounded, signal: worker.signal },
            beforeAdmission: worker.beforeAdmission, safeguardRetry: retry > 0 }));
          if (!admission?.plugin?.stream || !admission.options?.attempt || typeof admission.finish !== 'function') throw new PluginError('not-admitted');
          if (!admitted) { worker.admitted(admission.options.attempt.attemptId); admitted = true; }
          textOrigin = aiTextOrigin(admission.producer ?? admission.plugin.binding);
          engine = admission.engine;
          const report = admission.options.report;
          try {
            const opts = { ...admission.options, signal: worker.signal,
              report(terminal) { if (++reports !== 1) throw new PluginError('already-claimed'); return report(terminal); } };
            let size = 0;
            for await (const delta of boundedEvents(admission.plugin.stream(admission.request, opts), opts)) {
              worker.assertCurrent();
              if (typeof delta !== 'string' || (size += delta.length) > 32768) throw new PluginError('limit');
              yield delta;
            }
            if (reports !== 1) throw new PluginError('invalid-output', 'Reasoning omitted terminal report');
            failed = false;
          } finally { await admission.finish({ failed }); }
        }
        // Admission owns the prompt, including the current purpose policy. Prime
        // once so the same request controls decoding and dispatch.
        const source = invoke()[Symbol.asyncIterator]();
        let first;
        try { first = await voiceOperation({ ...options, signal: worker.signal }, () => source.next()); }
        catch (error) { void source.return?.().catch(() => {}); throw error; }
        const request = admission.request;
        const initial = async function* () {
          try { if (!first.done) yield first.value; yield* source; }
          finally { void source.return?.().catch(() => {}); }
        };
        const safe = request.purposePolicy ? await collectPurposeReply(request,
          (input, attempt) => attempt ? invoke(input, attempt) : initial(), { guardDirection: reply => admission.guardDirection(reply) })
          : { content: await (async () => { let text = ''; for await (const delta of initial()) text += delta; return text; })() };
        const text = stripThanksOpener(safe.content, request.locale).text, replyId = `reply-${randomUUID()}`;
        worker.assertCurrent();
        await onCompletion?.({ callId, providerSessionId, replyId, content: text, textOrigin, engine,
          userTurnOrdinal: worker.ordinal, scope: safe.scope, safeguardRevision: request.safeguardRevision });
        await commitCoordinator(envelope, { ...options, role: 'assistant', text, replyId, textOrigin, engine, ordinal: worker.ordinal });
        return { replyId, created: Math.floor((options.now ?? Date.now)() / 1000), events: (async function* () {
          yield { type: 'delta', text }; yield { type: 'completion', text }; await onDelivered?.({ callId });
        })() };
      }, options);
    } }),
  });
}
