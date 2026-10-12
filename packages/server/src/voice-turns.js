import { randomUUID } from 'node:crypto';
import { PluginError, PLUGIN_ERROR_CODES } from '../../core/src/invocation.js';
import { voiceOperation } from '../../core/src/live-voice.js';

export const DEFAULT_VOICE_TURN_REPLAY_MS = 120_000;
const codeFor = error => error instanceof PluginError && PLUGIN_ERROR_CODES.includes(error.code) ? error.code : 'provider';
const statusFor = code => code === 'not-admitted' ? 403 : code === 'deadline' ? 504 : code === 'limit' ? 413 : 502;
const completion = flight => ({ id: flight.id, object: 'chat.completion', created: flight.created, model: 'session-reasoning',
  metadata: { aithema_reply_id: flight.id },
  choices: [{ index: 0, message: { role: 'assistant', content: flight.content }, finish_reason: 'stop' }] });
const frame = (flight, delta, finishReason = null) => `data: ${JSON.stringify({ id: flight.id,
  object: 'chat.completion.chunk', created: flight.created, model: 'session-reasoning',
  ...(delta.role === 'assistant' ? { metadata: { aithema_reply_id: flight.id } } : {}),
  choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;

/** One writer owns execution; HTTP readers own only their subscriptions. */
export function createVoiceTurnOperations({ storage, now = Date.now, replayWindowMs = DEFAULT_VOICE_TURN_REPLAY_MS,
  authorizeReplacement } = {}) {
  if (!Number.isSafeInteger(replayWindowMs) || replayWindowMs <= 0 ||
    authorizeReplacement !== undefined && typeof authorizeReplacement !== 'function') throw new TypeError('Invalid voice turn policy');
  const store = storage.voiceTurnStore, flights = new Map();
  function wake(flight) { for (const resolve of flight.waiters) resolve(); flight.waiters.clear(); }
  function start(operation, execute) {
    const ready = Promise.withResolvers(), done = Promise.withResolvers(), controller = new AbortController();
    const flight = { operation, controller, ready: ready.promise, done: done.promise, waiters: new Set(),
      id: `chatcmpl-${randomUUID()}`, created: Math.floor(now() / 1000), content: '', finished: false };
    flights.set(operation.key, flight);
    const assertCurrent = () => store.pending(operation.key, operation.fence);
    flight.job = (async () => {
      try {
        const response = await execute({ signal: controller.signal, assertCurrent,
          ordinal: operation.ordinal, beforeAdmission: () => store.beforeAdmission(operation.key, operation.fence),
          admitted: attemptId => store.admitted(operation.key, operation.fence, attemptId),
          reportAllowed: () => {
            const current = store.get(operation.key);
            return current?.fence === operation.fence && current.state === 'pending';
          } });
        if (!response.ok) {
          flight.httpError = { body: await response.json(), status: response.status };
          throw new PluginError(flight.httpError.body.error);
        }
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let buffer = '', stopped = false, terminated = false;
        try {
          for (;;) {
            const item = await reader.read();
            if (item.done) break;
            buffer += decoder.decode(item.value, { stream: true });
            let end;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const data = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              if (data === 'data: [DONE]') { terminated = true; continue; }
              if (!data.startsWith('data: ')) throw new PluginError('invalid-output');
              const value = JSON.parse(data.slice(6));
              if (value.error) throw new PluginError(value.error);
              assertCurrent();
              if (typeof value.id === 'string') flight.id = value.id;
              if (Number.isSafeInteger(value.created)) flight.created = value.created;
              ready.resolve();
              const choice = value.choices?.[0];
              if (choice?.finish_reason === 'stop') stopped = true;
              const text = choice?.delta?.content;
              if (typeof text === 'string') {
                flight.content += text;
                if (flight.content.length > 1_048_576) throw new PluginError('limit');
                wake(flight);
              }
            }
            if (buffer.length > 8 * 1_048_576) throw new PluginError('limit');
          }
          if (!stopped || !terminated || buffer) throw new PluginError('invalid-output');
          // Readers receive stop/DONE only after the reply and terminal state commit.
          store.complete(operation.key, operation.fence, completion(flight), now(), replayWindowMs);
        } finally { reader.releaseLock(); }
      } catch (error) {
        flight.error = codeFor(error);
        controller.abort();
        store.fail(operation.key, operation.fence, flight.error, now());
      } finally {
        flight.finished = true; ready.resolve(); done.resolve(); wake(flight);
        if (flights.get(operation.key) === flight) flights.delete(operation.key);
      }
    })();
    flight.job.catch(() => {});
    return flight;
  }
  function stream(flight, signal, assertCurrent) {
    const encoder = new TextEncoder();
    let offset = 0, role = false, ended = false, cancelled = false, waiting;
    const cancel = () => { ended = true; waiting?.(); };
    const detach = () => { signal?.removeEventListener('abort', cancel); if (waiting) flight.waiters.delete(waiting); };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    return new Response(new ReadableStream({
      async pull(controller) {
        for (;;) {
          if (ended) { detach(); if (!cancelled) controller.close(); return; }
          try { assertCurrent(); } catch (error) {
            ended = true; detach(); controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: codeFor(error) })}\n\n`)); controller.close(); return;
          }
          if (!role) { role = true; controller.enqueue(encoder.encode(frame(flight, { role: 'assistant' }))); return; }
          if (flight.error) {
            ended = true; detach(); controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: flight.error })}\n\n`)); controller.close(); return;
          }
          if (offset < flight.content.length) {
            // Shared content is bounded once; a stalled reader queues no frames
            // and catches up in bounded pieces only when it asks for another.
            let end = Math.min(offset + 16_384, flight.content.length);
            if (end < flight.content.length && /[\uD800-\uDBFF]/u.test(flight.content[end - 1])) end--;
            const text = flight.content.slice(offset, end); offset = end;
            controller.enqueue(encoder.encode(frame(flight, { content: text }))); return;
          }
          if (flight.finished) {
            ended = true; detach(); controller.enqueue(encoder.encode(frame(flight, {}, 'stop') + 'data: [DONE]\n\n')); controller.close(); return;
          }
          await new Promise(resolve => { waiting = resolve; flight.waiters.add(resolve); });
          flight.waiters.delete(waiting); waiting = undefined;
        }
      },
      cancel() { cancelled = true; cancel(); detach(); },
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } });
  }
  async function respond(operation, flight, context, options) {
    await voiceOperation(options, () => flight.ready);
    if (flight.httpError) return Response.json(flight.httpError.body, { status: flight.httpError.status });
    if (context.stream === true) return stream(flight, options?.signal, () => {
      const current = store.get(operation.key);
      if (current.fence !== operation.fence) throw new PluginError('not-admitted', 'voice-turn-fenced');
      return store.assertCurrent(current);
    });
    await voiceOperation(options, () => flight.done);
    if (flight.error) return Response.json({ error: flight.error }, { status: statusFor(flight.error) });
    return Response.json(store.readReply(store.get(operation.key), now()), { headers: { 'cache-control': 'no-store' } });
  }
  return {
    async run(context, execute, options = {}) {
      let { operation, claimed } = store.claim(context, { now: now() });
      if (operation.state === 'completed') {
        const reply = store.readReply(operation, now());
        if (context.stream !== true) return Response.json(reply, { headers: { 'cache-control': 'no-store' } });
        return stream({ id: reply.id, created: reply.created, content: reply.choices[0].message.content, finished: true, waiters: new Set() },
          options.signal, () => store.assertCurrent(store.get(operation.key)));
      }
      let flight = flights.get(operation.key);
      if (flight?.operation.fence === operation.fence) return respond(operation, flight, context, options);
      if (!claimed && operation.state === 'pending') {
        // No worker owns this durable claim after a crash. Never dispatch implicitly.
        store.fail(operation.key, operation.fence, 'server-restart', now()); operation = store.get(operation.key);
      }
      if (operation.state === 'failed') {
        const authorized = authorizeReplacement && await voiceOperation(options,
          bounded => authorizeReplacement({ operation: structuredClone(operation), context, options: bounded }));
        if (authorized !== true) throw new PluginError('not-admitted', 'voice-turn-replacement-required');
        ({ operation, claimed } = store.replace(operation.key, operation.fence, now()));
        flight = flights.get(operation.key);
        if (!claimed && flight?.operation.fence === operation.fence) return respond(operation, flight, context, options);
        if (!claimed && operation.state === 'completed') return this.run(context, execute, options);
        if (!claimed) throw new PluginError('not-admitted', 'voice-turn-fenced');
      }
      flight = start(operation, execute);
      return respond(operation, flight, context, options);
    },
    recover() {
      for (const operation of store.list()) if (operation.state === 'pending' && !flights.has(operation.key))
        store.fail(operation.key, operation.fence, 'server-restart', now());
    },
    async idle() { await Promise.allSettled([...flights.values()].map(flight => flight.job)); },
  };
}
