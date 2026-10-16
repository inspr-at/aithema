import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export function loopbackOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('Explicit loopback http(s) origin required'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.origin !== value || url.username || url.password) throw new TypeError('Explicit loopback http(s) origin required');
  return value;
}

export function qualificationSettings(values = process.env) {
  if (values.AITHEMA_COMPOSED_QUALIFICATION !== '1') return { enabled: false };
  const hostname = values.AITHEMA_LISTEN_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '::1'].includes(hostname)) throw new TypeError('Qualification bind must be loopback (127.0.0.1 or ::1)');
  return { enabled: true, hostname, relayOrigin: loopbackOrigin(values.AITHEMA_COMPOSED_RELAY_ORIGIN) };
}

const asset = /^\/(?:plugins\/composed-voice\/src\/(?:browser-audio|network-client|pcm-capture-worklet|client|manifest)|packages\/core\/src\/[a-z-]+)\.js$/u;
const reserved = path => path.startsWith('/composed/') || path.startsWith('/plugins/composed-voice/');
const json = value => Response.json(value, { headers: { 'cache-control': 'no-store' } });
async function body(request) {
  const reader = request.body?.getReader(), chunks = []; let size = 0;
  if (!reader) throw new Error('JSON body required');
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      if ((size += value.length) > 65_536) throw new Error('Control body limit');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString());
}

/** No listener or provider is started here. OPS builds its composed factory with
 * this same authenticateRelay and relayOrigin, retaining stored owner/consent
 * checks and revoke propagation. Only this mount is added to the demo host. */
export function createQualificationMount({ enabled = false, hostname, relayOrigin, authenticateRelay, networkRelay, createSample } = {}) {
  if (enabled) {
    qualificationSettings({ AITHEMA_COMPOSED_QUALIFICATION: '1', AITHEMA_LISTEN_HOST: hostname, AITHEMA_COMPOSED_RELAY_ORIGIN: relayOrigin });
    if (![authenticateRelay, networkRelay?.handle, createSample].every(fn => typeof fn === 'function')) throw new TypeError('OPS qualification server ports required');
  }
  let active;
  async function dispose(row) {
    if (!row || row.closed) return;
    row.closed = true; clearTimeout(row.timer);
    for (const pending of row.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Sample closed')); }
    row.pending.clear(); row.wake?.();
    if (active === row) active = undefined;
    await row.sample?.close();
  }
  function publish(row, event) {
    if (row.closed) throw new Error('Sample closed');
    if (row.queue.length >= 128) throw new Error('Control queue limit');
    row.queue.push(event); row.wake?.();
  }
  function rpc(row, type, payload) {
    if (row.pending.size >= 128) return Promise.reject(new Error('Admission queue limit'));
    const id = randomUUID(), pending = Promise.withResolvers();
    pending.timer = setTimeout(() => { row.pending.delete(id); pending.reject(new Error('Admission acknowledgement timeout')); }, 30_000);
    row.pending.set(id, pending); publish(row, { type, id, ...payload });
    // Ports may report synchronously; keep failures observed until drain below.
    pending.promise.catch(() => {});
    return pending.promise;
  }
  async function start(row, input) {
    const reports = [];
    try {
      row.sample = await createSample({ ...input, owner: row.owner, async admit(spec) {
        const identity = await rpc(row, 'admit', { spec });
        let reported = false;
        const report = terminal => {
          reported = true;
          const pending = rpc(row, 'report', { attemptId: identity.attemptId, terminal }); reports.push(pending); return pending;
        };
        const attempt = { ...identity, consume: () => rpc(row, 'consume', { attemptId: identity.attemptId }), report };
        return { attempt, report, async dispatch(action) {
          await attempt.consume();
          try { return await action({ attempt, report }); }
          finally { if (!reported) await report({ attemptId: attempt.attemptId, outcome: 'uncertain' }); }
        } };
      } });
      if (row.closed) { await row.sample.close(); return; }
      publish(row, { type: 'ready', grant: row.sample.grant });
      const result = await row.sample.result;
      await Promise.all(reports);
      if (!(result.ttsPCM instanceof Uint8Array) || result.ttsPCM.length > 16_000_000) throw new Error('Bounded server PCM required');
      publish(row, { type: 'result', result: { ...result, ttsPCM: Buffer.from(result.ttsPCM).toString('base64') } });
    } catch { if (!row.closed) publish(row, { type: 'failure', error: 'OPS sample failed; retain reservations and inspect server evidence' }); }
  }
  return {
    async handle(request) {
      const path = new URL(request.url).pathname;
      if (!reserved(path) && !asset.test(path)) return null;
      if (!enabled) return reserved(path) ? new Response(null, { status: 404 }) : null;
      // Host is the browser-facing tunnel authority, never the internal adapter URL.
      if (request.headers.get('host') !== new URL(relayOrigin).host ||
        request.headers.get('origin') && request.headers.get('origin') !== relayOrigin ||
        request.headers.get('sec-fetch-site') === 'cross-site') return new Response(null, { status: 403 });
      if (path === '/composed/relay') return networkRelay.handle(request);
      const owner = await authenticateRelay(request);
      if (typeof owner !== 'string' || !owner) return new Response(null, { status: 401 });
      if (path === '/composed/qualification' && request.method === 'GET') return new Response(
        '<!doctype html><meta charset="utf-8"><title>Composed qualification</title><link rel="icon" href="data:,"><p>OPS loopback qualification</p><script type="module" src="/composed/qualification-page.js"></script>',
        { headers: { 'content-type': 'text/html', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'self'; connect-src 'self'; img-src data:; object-src 'none'; frame-ancestors 'none'" } });
      if (request.method === 'GET' && (asset.test(path) || path === '/composed/qualification-page.js')) {
        const file = path === '/composed/qualification-page.js' ? new URL('./qualification-page.js', import.meta.url) : new URL('../../..' + path, import.meta.url);
        try { return new Response(await readFile(file), { headers: { 'content-type': 'text/javascript', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } }); }
        catch { return new Response(null, { status: 404 }); }
      }
      if (path !== '/composed/qualification/control' || request.method !== 'POST') return new Response(null, { status: 404 });
      try {
        const input = await body(request);
        if (input.action === 'start') {
          if (active || !['candidate', 'baseline'].includes(input.lane) || typeof input.runId !== 'string' || !input.item) throw new Error('Invalid or concurrent sample');
          const row = { id: randomUUID(), owner, queue: [], pending: new Map(), closed: false, polling: false };
          active = row; row.timer = setTimeout(() => void dispose(row), 120_000); row.timer.unref?.();
          void start(row, { item: input.item, lane: input.lane, runId: input.runId });
          return json({ sampleId: row.id });
        }
        const row = active;
        if (!row || row.closed || row.owner !== owner || input.sampleId !== row.id) return new Response(null, { status: 403 });
        if (input.action === 'ack') {
          const pending = row.pending.get(input.id); if (!pending) throw new Error('Unknown acknowledgement');
          row.pending.delete(input.id); clearTimeout(pending.timer);
          if (input.error) pending.reject(new Error('Admission refused')); else pending.resolve(input.value);
          return json({ acknowledged: true });
        }
        if (input.action === 'poll') {
          if (row.polling) throw new Error('Concurrent control poll');
          row.polling = true;
          try {
            if (!row.queue.length && !row.closed) await new Promise(resolve => {
              const wake = () => { clearTimeout(timer); request.signal.removeEventListener('abort', wake); row.wake = undefined; resolve(); };
              const timer = setTimeout(wake, 10_000); row.wake = wake;
              request.signal.addEventListener('abort', wake, { once: true }); if (request.signal.aborted) wake();
            });
            return json({ event: row.queue.shift() ?? null });
          } finally { row.polling = false; }
        }
        if (input.action === 'close') { await dispose(row); return json({ closed: true }); }
        throw new Error('Unknown action');
      } catch { return new Response(null, { status: 400 }); }
    },
    async close() { await dispose(active); networkRelay?.close?.(); },
  };
}

/** Test-only local listener. The OPS browser template never calls this helper. */
export async function startLocalQualificationHost(options) {
  const { listen } = await import('../../../packages/server/src/http.js');
  const mount = createQualificationMount(options);
  const { server, url } = await listen(async request => await mount.handle(request) ?? new Response(null, { status: 404 }),
    { hostname: options.hostname ?? '127.0.0.1', port: options.port ?? 0 });
  return { url, async close() { await mount.close(); server.close(); server.closeAllConnections(); } };
}
