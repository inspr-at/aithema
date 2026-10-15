import { randomUUID } from 'node:crypto';
import { PluginError } from '../../../packages/core/src/invocation.js';

const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
async function boundedBody(request, limit) {
  if (Number(request.headers.get('content-length')) > limit) throw new PluginError('limit');
  const reader = request.body?.getReader(); if (!reader) return new Uint8Array();
  const parts = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength; if (length > limit) throw new PluginError('limit'); parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(parts);
}

/** Mount only in an explicitly enabled host. Authentication is a trusted host
 * port, never a browser owner claim. No CORS or query-string capabilities. */
export function createComposedRelayRoute({ authenticate, connect, authorize, path = '/composed/relay', origin, now = Date.now,
  maxConnections = 64, bytesPerSecond = 64_000, requestsPerSecond = 80 } = {}) {
  if (![authenticate, connect, authorize].every(fn => typeof fn === 'function')) throw new TypeError('Authenticated owner ports required');
  const connections = new Map(), openings = new Map();
  const close = (entry, disconnect = true) => {
    if (entry.closed) return;
    entry.closed = true; clearTimeout(entry.timer); connections.delete(entry.id);
    void Promise.resolve(disconnect ? entry.transport.disconnect() : entry.transport.frames.return?.()).catch(() => {});
  };
  async function assertActive(entry, owner) {
    if (entry.closed || now() >= entry.expiresAt) { close(entry); throw new PluginError('not-admitted'); }
    if (await authorize(entry.grant, owner) !== true || entry.closed || now() >= entry.expiresAt) {
      close(entry); throw new PluginError('not-admitted');
    }
  }
  function charge(entry, bytes = 0) {
    const at = now();
    if (at - entry.windowAt >= 1000) { entry.windowAt = at; entry.requests = 0; entry.bytes = 0; }
    if (++entry.requests > requestsPerSecond || (entry.bytes += bytes) > bytesPerSecond) {
      if (entry.transport) close(entry);
      throw new PluginError('limit');
    }
  }
  return Object.freeze({
    async handle(request) {
      const url = new URL(request.url);
      if (url.pathname !== path) return null;
      try {
        const owner = await authenticate(request);
        if (typeof owner !== 'string' || !owner) return json({ error: 'owner-required' }, 401);
        // Header-based same-origin transports only; reject cross-site cookie use.
        if (request.headers.get('origin') && request.headers.get('origin') !== (origin ?? url.origin) ||
          request.headers.get('sec-fetch-site') === 'cross-site') return json({ error: 'not-admitted' }, 403);
        const action = request.headers.get('x-composed-action');
        if (request.method !== 'POST') return json({ error: 'method' }, 405);
        if (action === 'open') {
          let rate = openings.get(owner);
          if (!rate) {
            if (openings.size >= maxConnections * 4) {
              for (const [key, row] of openings) if (now() - row.windowAt >= 1000) openings.delete(key);
              if (openings.size >= maxConnections * 4) throw new PluginError('limit');
            }
            rate = { windowAt: now(), requests: 0, bytes: 0 }; openings.set(owner, rate);
          }
          charge(rate);
          if (connections.size >= maxConnections) throw new PluginError('limit');
          const grant = JSON.parse(Buffer.from(await boundedBody(request, 4096)).toString());
          // The connect port checks the server's stored session owner before consuming a grant.
          const transport = await connect(grant, owner);
          const id = randomUUID(), entry = { id, owner, transport, grant, closed: false, polling: false,
            expiresAt: Math.min(grant.expiresAt, grant.opaque.spendDeadlineAt), windowAt: now(), requests: 0, bytes: 0 };
          if (connections.size >= maxConnections || entry.expiresAt <= now()) { close(entry); throw new PluginError('not-admitted'); }
          entry.timer = setTimeout(() => close(entry), entry.expiresAt - now()); entry.timer.unref?.();
          connections.set(id, entry); return json({ connectionId: id });
        }
        const entry = connections.get(request.headers.get('x-composed-connection'));
        if (!entry || entry.owner !== owner) throw new PluginError('not-admitted');
        await assertActive(entry, owner);
        charge(entry);
        if (action === 'frame') {
          if (entry.polling) throw new PluginError('limit');
          entry.polling = true;
          const aborted = () => close(entry); request.signal.addEventListener('abort', aborted, { once: true });
          try {
            if (request.signal.aborted) { close(entry); throw new PluginError('cancelled'); }
            const next = await entry.transport.frames.next();
            // Recheck ownership after a pending read and before publishing media.
            if (entry.closed || await authorize(entry.grant, owner) !== true) { close(entry); return json({ done: true }); }
            if (next.done) { close(entry); return json({ done: true }); }
            const frame = next.value;
            return json({ frame: frame.type === 'audio' ? { ...frame, bytes: Buffer.from(frame.bytes).toString('base64') } : frame });
          } finally { entry.polling = false; request.signal.removeEventListener('abort', aborted); }
        }
        if (action === 'audio') {
          const bytes = await boundedBody(request, 16_000);
          await assertActive(entry, owner); charge(entry, bytes.length);
          if (entry.ingress) throw new PluginError('limit');
          entry.ingress = true;
          try { await entry.transport.sendAudio(bytes); } finally { entry.ingress = false; }
          return json({ acknowledged: true });
        }
        if (action === 'command') {
          const { name, args = [] } = JSON.parse(Buffer.from(await boundedBody(request, 8192)).toString());
          await assertActive(entry, owner);
          if (!Array.isArray(args) || !['pause', 'resume', 'interrupt', 'setInput', 'setOutput', 'updateContext', 'heartbeat', 'close'].includes(name)) throw new PluginError('not-admitted');
          // A paused network grant is revoked. Resume obtains a new admitted segment via AIT-138.
          const pending = entry.transport.command(name, ...args);
          if (name === 'pause' || name === 'close') close(entry, name !== 'pause');
          const result = await pending; return json({ result: result ?? null });
        }
        if (action === 'disconnect') { close(entry); return json({ acknowledged: true }); }
        return json({ error: 'action' }, 400);
      } catch (error) {
        return json({ error: error?.code ?? 'invalid-request' }, error?.code === 'limit' ? 429 : ['not-admitted', 'deadline'].includes(error?.code) ? 403 : 400);
      }
    },
    revoke(providerSessionId) { for (const entry of connections.values()) if (entry.grant.providerSessionId === providerSessionId) close(entry, false); },
    close() { for (const entry of connections.values()) close(entry); openings.clear(); },
  });
}
