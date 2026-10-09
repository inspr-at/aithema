import { createPluginRuntime } from './plugin-runtime.js';
import { randomUUID } from 'node:crypto';
import { SessionLanes, createMockReasoning, inputRevision, activeTurns } from '@inspr/aithema-core';
import { ConflictError, NotFoundError } from './storage.js';
import { exportSession } from './export.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
const encoder = new TextEncoder();
function sse(event) {
  return encoder.encode(`${event.seq ? `id: ${event.seq}\n` : ''}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}
export async function readBody(request, limit = 32_768) {
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
  deadlineMs = 30_000, hostPrompt = '', pluginRuntime, consent = pluginRuntime?.consent,
  ownership = { token: request => request.headers.get('x-aithema-session-token') } }) {
  pluginRuntime ??= createPluginRuntime({ storage, reasoning, consent: consent ?? { coverage: () => ({ covered: false }) } });
  const listeners = new Map(), jobs = new Map(), failures = new Map(), stop = new AbortController();
  const broadcast = (id, event) => {
    for (const listener of listeners.get(id) ?? []) listener(event);
  };
  const operations = session => {
    const revision = inputRevision(session), failure = failures.get(session.id);
    return { inputRevision: revision, running: [...jobs.values()].filter(job => job.id === session.id).map(job => job.lane),
      lastFailure: failure?.inputRevision === revision ? failure : null };
  };
  const snapshot = async id => { const { ownerHash, ...session } = storage.get(id); return { ...session, operations: operations(session), featureMatrix: await pluginRuntime.matrix(session) }; };
  const status = id => broadcast(id, { sessionId: id, type: 'lane.status', data: operations(storage.get(id)) });
  const lanes = new SessionLanes({ reasoning, getSession: id => storage.get(id), deadlineMs, hostPrompt,
    admit: args => pluginRuntime.admit(args),
    publish(id, type, data, revision) {
      if (stop.signal.aborted) return false;
      const event = storage.append(id, type, data, revision);
      if (event) broadcast(id, event);
      return Boolean(event);
    }, transient: (id, event) => broadcast(id, { sessionId: id, ...event }),
  });
  function schedule(id) {
    for (const lane of ['reaction', 'understanding']) scheduleLane(id, lane);
  }
  function scheduleLane(id, lane) {
    const key = `${id}:${lane}`;
    if (jobs.has(key) || stop.signal.aborted) return;
    const job = { id, lane, promise: null };
    jobs.set(key, job);
    job.promise = Promise.resolve().then(async () => {
      try {
        while (!stop.signal.aborted) {
          const revision = inputRevision(storage.get(id));
          try {
            await lanes.run(id, lane, { signal: stop.signal });
            const failure = failures.get(id);
            if (inputRevision(storage.get(id)) === revision && failure?.inputRevision === revision && failure.lane === lane) {
              failures.delete(id);
            }
          } catch {
            if (!stop.signal.aborted && inputRevision(storage.get(id)) === revision) {
              const failure = { inputRevision: revision, lane, error: 'reasoning-unavailable', retryable: true };
              failures.set(id, failure);
              broadcast(id, { sessionId: id, type: 'lane.failed', data: failure });
            }
          }
          if (stop.signal.aborted || inputRevision(storage.get(id)) === revision) {
            // Remove synchronously with the last revision check: a subsequent
            // schedule can start work even before this promise settles.
            jobs.delete(key); status(id); return;
          }
        }
      } finally {
        if (jobs.get(key) === job) { jobs.delete(key); status(id); }
      }
    });
    status(id);
    // Failures never include provider text or request content in logs or responses.
    job.promise.catch(() => {});
  }
  function unfinished(session) {
    const revision = inputRevision(session);
    return !session.tombstone && activeTurns(session).some(t => t.role === 'user') &&
      (!activeTurns(session).some(t => t.role === 'assistant' && t.inputRevision === revision) ||
        session.understanding.inputRevision !== revision || session.understanding.draft);
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
        else if (!closed) {
          if (unfinished(session)) schedule(id);
          status(id);
        }
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
        const ownerToken = ownership.token(request) || randomUUID();
        const session = storage.create({ ...sessionOptions, locale: options.locale ?? 'en', ownerToken,
          processingPreset: options.processingPreset ?? sessionOptions.processingPreset ?? 'best' });
        const response = json(await snapshot(session.id), 201);
        if (ownership.created) ownership.created(response, ownerToken, request);
        else response.headers.set('x-aithema-session-token', ownerToken);
        return response;
      }
      const match = /^\/api\/sessions\/([a-zA-Z0-9_-]{1,128})(?:\/(turns|events|export|retry|pause|withdraw|consent|erase))?$/u.exec(url.pathname);
      if (!match) return json({ error: 'not-found' }, 404);
      const [, id, action] = match;
      const ownerToken = ownership.token(request), authorized = storage.authorize(id, ownerToken);
      const guard = { ownerToken, revision: inputRevision(authorized) };
      if (!action && request.method === 'GET') return json(await snapshot(id));
      if (action === 'events' && request.method === 'GET') return events(request, id);
      if (action === 'turns' && request.method === 'POST') {
        const bytes = await readBody(request);
        const body = JSON.parse(Buffer.from(bytes).toString('utf8'));
        if (!body || typeof body.clientEventId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(body.clientEventId) ||
          typeof body.content !== 'string' || !body.content.trim() || body.content.length > 8000) return json({ error: 'invalid-turn' }, 400);
        const { event, replayed } = storage.postTurn(id, body.clientEventId, bytes, body.content,
          { ...guard, revision: body.inputRevision ?? guard.revision });
        if (!replayed) lanes.supersede(id);
        if (!replayed) broadcast(id, event);
        schedule(id);
        return json(event, 200);
      }
      if (action === 'retry' && request.method === 'POST') {
        schedule(id); return json({ accepted: true }, 202);
      }
      if (action === 'pause' && request.method === 'POST') {
        const body = JSON.parse(Buffer.from(await readBody(request)).toString('utf8'));
        if (typeof body?.paused !== 'boolean') return json({ error: 'invalid-pause' }, 400);
        const event = storage.pause(id, body.paused, guard); broadcast(id, event);
        if (!body.paused) schedule(id);
        return json({ paused: storage.get(id).paused, event });
      }
      if (action === 'withdraw' && request.method === 'POST') {
        const body = JSON.parse(Buffer.from(await readBody(request)).toString('utf8'));
        if (typeof body?.turnId !== 'string') return json({ error: 'invalid-withdrawal' }, 400);
        const event = storage.withdraw(id, body.turnId, 'withdrawal', guard);
        lanes.cancel(id); failures.delete(id); broadcast(id, event); schedule(id);
        return json({ withdrawn: body.turnId, event });
      }
      if (action === 'consent' && request.method === 'POST') {
        const body = JSON.parse(Buffer.from(await readBody(request)).toString('utf8'));
        if (typeof body?.granted !== 'boolean') return json({ error: 'invalid-consent' }, 400);
        if (body.granted) {
          if (!consent?.grant) return json({ error: 'host-consent-required' }, 409);
          await consent.grant({ sessionId: id, consentRevision: authorized.consentRevision + 1 });
        }
        const event = storage.reviseConsent(id, body.granted, guard);
        lanes.cancel(id); failures.delete(id); broadcast(id, event);
        if (body.granted) schedule(id);
        else await consent?.withdraw?.({ sessionId: id });
        return json({ granted: body.granted, consentRevision: storage.get(id).consentRevision, event });
      }
      if (action === 'erase' && request.method === 'POST') {
        const event = storage.erase(id, guard); lanes.cancel(id); failures.delete(id); broadcast(id, event);
        return json({ erased: true, event, providerDeletion: 'not-confirmed' });
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
    withdrawConsent(id) {
      const event = storage.reviseConsent(id, false); lanes.cancel(id); failures.delete(id); broadcast(id, event);
      return event;
    },
    expire(before) {
      for (const id of storage.list()) {
        const session = storage.get(id);
        if (session.tombstone) continue;
        for (const turn of activeTurns(session).filter(t => t.role === 'user' && Date.parse(t.at) < before)) {
          const event = storage.expire(id, turn.id); lanes.cancel(id); failures.delete(id); broadcast(id, event); schedule(id);
        }
      }
    },
    resume() {
      pluginRuntime.budget.recover();
      for (const id of storage.list()) if (unfinished(storage.get(id))) schedule(id);
    },
    async idle() { while (jobs.size) await Promise.allSettled([...jobs.values()].map(job => job.promise)); },
    async close() { stop.abort(); await Promise.allSettled([...jobs.values()].map(job => job.promise)); },
  };
}
