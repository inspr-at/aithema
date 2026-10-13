import { randomUUID } from 'node:crypto';
import { PluginError, PLUGIN_ERROR_CODES } from '../../../packages/core/src/invocation.js';
import { voiceOperation } from '../../../packages/core/src/live-voice.js';

const codeFor = error => error instanceof PluginError && PLUGIN_ERROR_CODES.includes(error.code) ? error.code : 'provider';
const statusFor = code => code === 'not-admitted' ? 403 : code === 'deadline' ? 504 : code === 'limit' ? 413 : 502;
export const elevenLabsReplyChunk = (reply, delta, finishReason = null) => ({ id: reply.replyId,
  object: 'chat.completion.chunk', created: reply.created, model: 'session-reasoning',
  ...(delta.role === 'assistant' ? { metadata: { aithema_reply_id: reply.replyId } } : {}),
  choices: [{ index: 0, delta, finish_reason: finishReason }] });
const frame = (reply, delta, finishReason = null) => `data: ${JSON.stringify(elevenLabsReplyChunk(reply, delta, finishReason))}\n\n`;
export const elevenLabsCompletion = (reply, text, { metadata = true } = {}) => ({ id: reply.replyId,
  object: 'chat.completion', created: reply.created, model: 'session-reasoning',
  ...(metadata ? { metadata: { aithema_reply_id: reply.replyId } } : {}),
  choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });

/** The historical durable wire record is decoded only inside this adapter. */
export function readElevenLabsStoredReply(reply) {
  return reply.replyId ? reply : { replyId: reply.id, created: reply.created, text: reply.choices?.[0]?.message?.content };
}

/** Decode the adapter's admitted worker stream before crossing the shared boundary. */
export async function decodeElevenLabsReply(response, options) {
  if (!response.ok) {
    const body = await response.json(), error = new PluginError(body.error);
    error.replyResponse = { body, status: response.status };
    throw error;
  }
  const reader = response.body?.getReader();
  if (!reader) throw new PluginError('invalid-output');
  const decoder = new TextDecoder();
  let buffer = '', replyId, created, text = '', stopped = false, terminated = false;
  async function* decode() {
    try {
      for (;;) {
        const item = options ? await voiceOperation(options, () => reader.read()) : await reader.read();
        if (item.done) { buffer += decoder.decode(); break; }
        buffer += decoder.decode(item.value, { stream: true });
        if (buffer.length > 8 * 1_048_576) throw new PluginError('limit');
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const data = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          if (data === 'data: [DONE]') { terminated = true; continue; }
          if (!data.startsWith('data: ')) throw new PluginError('invalid-output');
          let value;
          try { value = JSON.parse(data.slice(6)); } catch { throw new PluginError('invalid-output'); }
          if (value.error) throw new PluginError(value.error);
          if (terminated || typeof value.id !== 'string' || !value.id || !Number.isSafeInteger(value.created) ||
            replyId && value.id !== replyId) throw new PluginError('invalid-output');
          if (!replyId) { replyId = value.id; created = value.created; yield { type: 'identity' }; }
          created = value.created;
          const choice = value.choices?.[0];
          if (choice?.finish_reason === 'stop') stopped = true;
          if (typeof choice?.delta?.content === 'string') {
            text += choice.delta.content;
            if (text.length > 1_048_576) throw new PluginError('limit');
            yield { type: 'delta', text: choice.delta.content, created };
          }
        }
      }
      if (!replyId || !stopped || !terminated || buffer) throw new PluginError('invalid-output');
      yield { type: 'completion', replyId, text, created };
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  const events = decode();
  if ((await events.next()).done) throw new PluginError('invalid-output');
  return { replyId, created, events, cancel() { void reader.cancel().catch(() => {}); } };
}

/** Encode reader events; the shared worker owns execution and settlement. */
export async function encodeElevenLabsReply(reply, { stream = false } = {}) {
  const reader = reply.events.getReader();
  if (!stream) {
    let completion;
    try {
      for (;;) {
        const item = await reader.read(); if (item.done) break;
        if (item.value.type === 'completion') completion = item.value;
      }
      if (!completion) throw new PluginError('invalid-output');
      return Response.json(elevenLabsCompletion(reply, completion.text),
        { headers: { 'cache-control': 'no-store' } });
    } finally { reader.releaseLock(); }
  }
  const encoder = new TextEncoder(); let ended = false;
  const detach = () => { void reader.cancel().catch(() => {}); reader.releaseLock(); };
  return new Response(new ReadableStream({
    async pull(controller) {
      if (ended) return;
      try {
        const item = await reader.read();
        if (ended) return;
        if (item.done) { ended = true; detach(); controller.close(); return; }
        const event = item.value;
        const data = event.type === 'operation' ? frame(reply, { role: 'assistant' })
          : event.type === 'delta' ? frame(reply, { content: event.text })
          : event.type === 'completion' ? frame(reply, {}, 'stop') + 'data: [DONE]\n\n' : undefined;
        if (!data) throw new PluginError('invalid-output');
        controller.enqueue(encoder.encode(data));
        if (event.type === 'completion') { ended = true; detach(); controller.close(); }
      } catch (error) {
        if (ended) return;
        ended = true; detach(); controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: codeFor(error) })}\n\n`)); controller.close();
      }
    },
    cancel() { if (ended) return; ended = true; detach(); },
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } });
}

export async function runElevenLabsReply(turns, context, execute, options = {}) {
  const created = Math.floor((options.now ?? Date.now)() / 1000);
  try {
    const reply = await turns.run(context, async worker => decodeElevenLabsReply(await execute(worker)),
      { ...options, readStoredReply: readElevenLabsStoredReply,
        writeStoredReply: reply => elevenLabsCompletion(reply, reply.text) });
    return await encodeElevenLabsReply(reply, context);
  } catch (error) {
    if (error.replyResponse) return Response.json(error.replyResponse.body, { status: error.replyResponse.status });
    // Claim/replay policy refusals still use the facade's reason-bearing errors.
    if (/^voice-turn-/u.test(error.message ?? '')) throw error;
    if (context.stream === true) {
      // Main emitted its own role frame even when the worker's first frame was
      // an error. Reuse the codec to preserve separate frames and SSE headers.
      let role = false;
      return encodeElevenLabsReply({ replyId: `chatcmpl-${randomUUID()}`, created,
        events: new ReadableStream({ pull(controller) {
          if (!role) { role = true; controller.enqueue({ type: 'operation' }); }
          else controller.error(error);
        } }, { highWaterMark: 0 }) }, context);
    }
    return Response.json({ error: codeFor(error) }, { status: statusFor(codeFor(error)) });
  }
}

/** Legacy compatibility reader. The shared executor now produces text events;
 * existing hosts that inject an HTTP response can continue using this reader.
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
      const reply = await voiceOperation(options, () => decodeElevenLabsReply(response, options));
      yield { type: 'operation', operation, replyId: reply.replyId };
      const events = reply.events;
      try {
        for (;;) {
          const item = await voiceOperation(options, () => events.next());
          if (item.done) break;
          const event = item.value;
          yield event.type === 'delta' ? { type: 'delta', text: event.text }
            : { type: 'completion', replyId: event.replyId, text: event.text };
        }
      } finally { reply.cancel(); void events.return().catch(() => {}); }
    },
  });
}
