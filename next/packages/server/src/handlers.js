import { SessionLanes, createMockReasoning, inputRevision } from '@inspr/aithema-next-core';
import { ConflictError, NotFoundError } from './storage.js';
import { exportSession } from './export.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
const encoder = new TextEncoder();
function sse(event) {
  return encoder.encode(`${event.seq ? `id: ${event.seq}\n` : ''}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}
export async function readBody(request, limit = 16_384) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new RangeError('Request limit'); }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { reader.releaseLock(); }
}

export function createHandlers({ storage, reasoning = createMockReasoning(), sessionOptions = { demo: true },
  deadlineMs = 30_000, hostPrompt = '' }) {
  const listeners = new Map(), jobs = new Map(), stop = new AbortController();
  const broadcast = (id, event) => {
    for (const listener of listeners.get(id) ?? []) listener(event);
  };
  const lanes = new SessionLanes({ reasoning, getSession: id => storage.get(id), deadlineMs, hostPrompt,
    publish(id, type, data, revision) {
      if (stop.signal.aborted) return false;
      const event = storage.append(id, type, data, revision);
      if (event) broadcast(id, event);
      return Boolean(event);
    }, transient: (id, event) => broadcast(id, { sessionId: id, ...event }),
  });
  function schedule(id) {
    if (jobs.has(id) || stop.signal.aborted) return;
    const job = (async () => {
      while (!stop.signal.aborted) {
        const revision = inputRevision(storage.get(id));
        const outcomes = await Promise.allSettled(['reaction', 'understanding'].map(lane =>
          lanes.run(id, lane, { signal: stop.signal })));
        if (stop.signal.aborted) return;
        for (let i = 0; i < outcomes.length; i++) if (outcomes[i].status === 'rejected' && inputRevision(storage.get(id)) === revision) {
          broadcast(id, { sessionId: id, type: 'lane.failed', data: { lane: i === 0 ? 'reaction' : 'understanding',
            error: 'reasoning-unavailable', retryable: true } });
        }
        if (inputRevision(storage.get(id)) === revision) return;
      }
    })().finally(() => jobs.delete(id));
    jobs.set(id, job);
    // Failures never include provider text or request content in logs or responses.
    job.catch(() => {});
  }
  function events(request, id) {
    const session = storage.get(id);
    const raw = request.headers.get('last-event-id') ?? new URL(request.url).searchParams.get('after') ?? '0';
    if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > session.seq) return json({ error: 'invalid-cursor' }, 400);
    let cleanup;
    const stream = new ReadableStream({
      start(controller) {
        let closed = false, count = 0;
        const send = event => {
          if (closed) return;
          if (controller.desiredSize < -256 || ++count > 10_000) { cleanup(); controller.close(); return; }
          controller.enqueue(sse(event));
        };
        const set = listeners.get(id) ?? new Set();
        listeners.set(id, set);
        const heartbeat = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(': heartbeat\n\n')); }, 15_000);
        const abort = () => { cleanup(); try { controller.close(); } catch {} };
        cleanup = () => {
          if (closed) return;
          closed = true; clearInterval(heartbeat); set.delete(send);
          if (!set.size) listeners.delete(id);
          request.signal.removeEventListener('abort', abort); stop.signal.removeEventListener('abort', abort);
        };
        request.signal.addEventListener('abort', abort, { once: true });
        stop.signal.addEventListener('abort', abort, { once: true });
        // Synchronous replay + subscription cannot interleave with a publication.
        for (const event of storage.read(id, Number(raw))) send(event);
        if (!closed) set.add(send);
        if (request.signal.aborted || stop.signal.aborted) abort();
      },
      cancel() { cleanup?.(); },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive', 'x-accel-buffering': 'no' } });
  }
  async function handle(request) {
    if (stop.signal.aborted) return json({ error: 'server-stopping' }, 503);
    try {
      const url = new URL(request.url);
      if (url.pathname === '/api/sessions' && request.method === 'POST') {
        const bytes = await readBody(request);
        const options = bytes.length ? JSON.parse(Buffer.from(bytes).toString('utf8')) : {};
        if (!options || typeof options !== 'object' || Array.isArray(options)) return json({ error: 'invalid-session' }, 400);
        const session = storage.create({ ...sessionOptions, locale: options.locale ?? 'en' });
        return json(session, 201);
      }
      const match = /^\/api\/sessions\/([a-zA-Z0-9_-]{1,128})(?:\/(turns|events|export|retry))?$/u.exec(url.pathname);
      if (!match) return json({ error: 'not-found' }, 404);
      const [, id, action] = match;
      if (!action && request.method === 'GET') return json(storage.get(id));
      if (action === 'events' && request.method === 'GET') return events(request, id);
      if (action === 'turns' && request.method === 'POST') {
        const bytes = await readBody(request);
        const body = JSON.parse(Buffer.from(bytes).toString('utf8'));
        if (!body || typeof body.clientEventId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(body.clientEventId) ||
          typeof body.content !== 'string' || !body.content.trim() || body.content.length > 8000) return json({ error: 'invalid-turn' }, 400);
        const { event, replayed } = storage.postTurn(id, body.clientEventId, bytes, body.content);
        if (!replayed) broadcast(id, event);
        schedule(id);
        return json(event, 200);
      }
      if (action === 'retry' && request.method === 'POST') {
        storage.get(id); schedule(id); return json({ accepted: true }, 202);
      }
      if (action === 'export' && request.method === 'GET') return new Response(exportSession(storage.get(id)), {
        headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="aithema-session.zip"', 'cache-control': 'no-store' },
      });
      return json({ error: 'method-not-allowed' }, 405);
    } catch (error) {
      if (error instanceof NotFoundError) return json({ error: 'session-not-found' }, 404);
      if (error instanceof ConflictError) return json({ error: 'idempotency-conflict' }, 409);
      if (error instanceof SyntaxError || error instanceof TypeError) return json({ error: 'invalid-request' }, 400);
      if (error instanceof RangeError) return json({ error: 'size-limit' }, 413);
      return json({ error: 'server-error' }, 500);
    }
  }
  return { handle, lanes,
    resume() {
      for (const id of storage.list()) if (storage.get(id).transcript.some(t => t.role === 'user')) schedule(id);
    },
    async idle() { while (jobs.size) await Promise.allSettled([...jobs.values()]); },
    async close() { stop.abort(); await Promise.allSettled([...jobs.values()]); },
  };
}
