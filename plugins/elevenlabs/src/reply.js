import { PluginError } from '../../../packages/core/src/invocation.js';
import { voiceOperation } from '../../../packages/core/src/live-voice.js';

/** Compatibility reader over today's admitted operation response. PR 2b will
 * make the shared executor produce these events directly and keep codecs here.
 * execute is a host-injected, trusted in-process operation, never a browser port.
 * It returns {operation, response}; identity comes from the existing Rule C store,
 * never from an envelope field or a transcript receipt.
 */
export function createElevenLabsReplyExecutor({ execute } = {}) {
  if (typeof execute !== 'function') throw new TypeError('Admitted reply execution required');
  return Object.freeze({
    async *execute(envelope, options) {
      if (!['authenticated-provider', 'server-coordinator'].includes(envelope?.source)) throw new PluginError('not-admitted', 'Trusted voice reply envelope required');
      const { operation, response } = await voiceOperation(options, opts => execute(envelope, opts));
      if (typeof operation?.key !== 'string' || !operation.key || typeof operation.callId !== 'string' || !operation.callId ||
        typeof operation.providerSessionId !== 'string' || !operation.providerSessionId ||
        operation.ordinal !== null && (!Number.isSafeInteger(operation.ordinal) || operation.ordinal < 1)) throw new PluginError('invalid-output', 'Server operation identity required');
      if (!response.ok) {
        const body = await voiceOperation(options, () => response.json());
        throw new PluginError(body.error);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new PluginError('invalid-output', 'Missing reply stream');
      const decoder = new TextDecoder();
      let buffer = '', replyId, text = '', stopped = false, doneFrame = false;
      try {
        for (;;) {
          const item = await voiceOperation(options, () => reader.read());
          if (item.done) { buffer += decoder.decode(); break; }
          buffer += decoder.decode(item.value, { stream: true });
          if (buffer.length > 8 * 1_048_576) throw new PluginError('limit');
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            if (frame === 'data: [DONE]') { doneFrame = true; continue; }
            if (!frame.startsWith('data: ')) throw new PluginError('invalid-output');
            let value;
            try { value = JSON.parse(frame.slice(6)); } catch { throw new PluginError('invalid-output'); }
            if (value.error) throw new PluginError(value.error);
            if (typeof value.id !== 'string' || !value.id || replyId && value.id !== replyId) throw new PluginError('invalid-output');
            if (!replyId) { replyId = value.id; yield { type: 'operation', operation, replyId }; }
            const choice = value.choices?.[0];
            if (choice?.finish_reason === 'stop') stopped = true;
            if (typeof choice?.delta?.content === 'string') {
              text += choice.delta.content;
              if (text.length > 1_048_576) throw new PluginError('limit');
              yield { type: 'delta', text: choice.delta.content };
            }
          }
        }
        if (!replyId || !stopped || !doneFrame || buffer) throw new PluginError('invalid-output', 'Incomplete reply stream');
        yield { type: 'completion', replyId, text };
      } finally {
        // Detach only this reader. The existing operation owns paid-work lifetime.
        void reader.cancel().catch(() => {}); reader.releaseLock();
      }
    },
  });
}
