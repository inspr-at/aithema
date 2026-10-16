import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { qualificationRequestDigest, readPersistedQualificationSnapshot } from '../src/persisted-budget.js';

const keyNames = Object.freeze(['ELEVENLABS_API_KEY', 'OPENROUTER_API_KEY']);

/** Server-only, flag-only source of qualification credentials. Errors deliberately
 * omit filesystem errors, paths, input lines and values, including their causes. */
export async function loadQualificationKeys(values = process.env, { uid = process.getuid() } = {}) {
  if (values.AITHEMA_COMPOSED_QUALIFICATION !== '1') return undefined;
  const path = values.AITHEMA_COMPOSED_KEYS_FILE;
  if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError('Absolute AITHEMA_COMPOSED_KEYS_FILE required');
  let file;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error();
    // NOFOLLOW closes the final-component symlink race; NONBLOCK avoids a FIFO
    // replacement hanging startup. Validate the opened inode before reading it.
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || before.dev !== stat.dev || before.ino !== stat.ino ||
      stat.uid !== uid || (stat.mode & 0o7777) !== 0o600 || stat.size > 16_384) throw new Error();
  } catch {
    await file?.close();
    throw new Error('Qualification keys file must be a regular non-symlink file, owned by the running user, mode exactly 0600 (maximum 16 KiB)');
  }
  let content;
  try { content = await file.readFile('utf8'); }
  catch { throw new Error('Qualification keys file could not be read'); }
  finally { await file.close(); }
  const keys = Object.create(null);
  for (const line of content.split(/\r?\n/u)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const entry = /^([A-Z_]+)=(.*)$/u.exec(line);
    if (!entry || !keyNames.includes(entry[1])) throw new Error('Unknown key or invalid KEY=VALUE line in qualification keys file');
    const [, name, value] = entry;
    if (Object.hasOwn(keys, name)) throw new Error(`Duplicate qualification key: ${name}`);
    if (!value.trim()) throw new Error(`Missing qualification key: ${name}`);
    keys[name] = value.trim();
  }
  for (const name of keyNames) if (!keys[name]) throw new Error(`Missing qualification key: ${name}`);
  return Object.freeze(keys);
}

/** CLI-created, server-only per-run authority. Never sent to the browser. */
export async function loadQualificationControl(values = process.env) {
  if (values.AITHEMA_COMPOSED_QUALIFICATION !== '1') return undefined;
  const path = values.AITHEMA_COMPOSED_CONTROL_FILE;
  if (!isAbsolute(path ?? '')) throw new TypeError('Absolute AITHEMA_COMPOSED_CONTROL_FILE required');
  let file;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error();
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || before.dev !== stat.dev || before.ino !== stat.ino || stat.uid !== process.getuid() ||
      (stat.mode & 0o7777) !== 0o600 || stat.size > 16_384) throw new Error();
    return validateControl(JSON.parse(await file.readFile('utf8')));
  } catch { throw new Error('Qualification control file must contain valid per-run authority in a user-owned regular non-symlink 0600 file'); }
  finally { await file?.close(); }
}

function validateControl(control) {
  if (!/^[a-f0-9]{64}$/u.test(control?.capability ?? '') || typeof control.runId !== 'string' || !control.runId ||
    !isAbsolute(control.budgetPath ?? '')) throw new TypeError('Per-run qualification control authority required');
  return Object.freeze({ capability: control.capability, runId: control.runId, budgetPath: control.budgetPath });
}

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
export function createQualificationMount({ enabled = false, hostname, relayOrigin, authenticateRelay, networkRelay, createSample, control } = {}) {
  if (enabled) {
    qualificationSettings({ AITHEMA_COMPOSED_QUALIFICATION: '1', AITHEMA_LISTEN_HOST: hostname, AITHEMA_COMPOSED_RELAY_ORIGIN: relayOrigin });
    if (![authenticateRelay, networkRelay?.handle, createSample].every(fn => typeof fn === 'function')) throw new TypeError('OPS qualification server ports required');
    control = validateControl(control);
  }
  const capabilityHash = enabled ? createHash('sha256').update(control.capability).digest() : undefined;
  function authorized(request) {
    // Fixed-length digests keep the comparison constant-time even for wrong-length inputs.
    return timingSafeEqual(capabilityHash, createHash('sha256').update(request.headers.get('x-aithema-qualification-control') ?? '').digest());
  }
  function acknowledged(row, pending, value) {
    const snapshot = readPersistedQualificationSnapshot(control.budgetPath);
    if (snapshot.blocked || !snapshot.runs?.includes(control.runId)) throw new Error();
    const attemptId = pending.type === 'admit' ? pending.payload.spec.attemptId : pending.payload.attemptId;
    const stored = snapshot.records.find(record => record.attemptId === attemptId && record.runId === control.runId && record.lane === row.lane);
    if (!stored) throw new Error();
    if (pending.type === 'admit') {
      const spec = pending.payload.spec;
      if (stored.state !== 'reserved' || row.admissions.has(attemptId) ||
        ['provider', 'model', 'operation', 'accountRef', 'endpoint', 'role', 'maxMicro'].some(key => stored[key] !== spec[key]) ||
        stored.retryOf !== (spec.retryOf ?? null) || stored.requestDigest !== qualificationRequestDigest(spec.request) ||
        value?.attemptId !== stored.attemptId || value.claimId !== `qualification-${stored.attemptId}` || value.maxMicro !== stored.maxMicro) throw new Error();
      // Resolve from the ledger, never from client-supplied identity fields.
      const identity = { attemptId: stored.attemptId, claimId: `qualification-${stored.attemptId}`, maxMicro: stored.maxMicro };
      row.admissions.set(attemptId, { consumed: false });
      return identity;
    }
    const admission = row.admissions.get(attemptId);
    if (!admission) throw new Error();
    if (pending.type === 'consume') {
      if (stored.state !== 'dispatched' || admission.consumed) throw new Error();
      admission.consumed = true;
    } else if (pending.type === 'report') {
      if (stored.state !== 'settled' || stored.outcome !== pending.payload.terminal?.outcome) throw new Error();
    } else throw new Error();
  }
  let active;
  function dispose(row) {
    if (!row) return;
    if (row.closing) return row.closing;
    row.closed = true; clearTimeout(row.timer);
    row.controller.abort();
    for (const pending of row.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Sample closed')); }
    row.pending.clear(); row.wake?.();
    row.closing = (async () => {
      await row.setup.promise;
      await row.sample?.close();
      // Keep the lane occupied until OPS confirms the dispatcher stopped.
      if (active === row) active = undefined;
    })();
    row.closing.catch(() => {});
    return row.closing;
  }
  function publish(row, event) {
    if (row.closed) throw new Error('Sample closed');
    if (row.queue.length >= 128) throw new Error('Control queue limit');
    row.queue.push(event); row.wake?.();
  }
  function rpc(row, type, payload) {
    if (row.closed) return Promise.reject(new Error('Sample closed'));
    if (row.pending.size >= 128) return Promise.reject(new Error('Admission queue limit'));
    const id = randomUUID(), pending = Promise.withResolvers();
    pending.type = type; pending.payload = payload;
    pending.timer = setTimeout(() => { row.pending.delete(id); pending.reject(new Error('Admission acknowledgement timeout')); }, 30_000);
    row.pending.set(id, pending); publish(row, { type, id, ...payload });
    // Ports may report synchronously; keep failures observed until drain below.
    pending.promise.catch(() => {});
    return pending.promise;
  }
  async function start(row, input) {
    const reports = [];
    try {
      row.sample = await createSample({ ...input, owner: row.owner, signal: row.controller.signal, async admit(spec) {
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
      row.setup.resolve();
      if (row.closed) return;
      if (!row.sample?.grant || typeof row.sample.close !== 'function' || typeof row.sample.result?.then !== 'function') throw new TypeError('OPS sample grant, result promise and close port required');
      publish(row, { type: 'ready', grant: row.sample.grant });
      const result = await row.sample.result;
      await Promise.all(reports);
      if (!(result.ttsPCM instanceof Uint8Array) || result.ttsPCM.length > 16_000_000) throw new Error('Bounded server PCM required');
      publish(row, { type: 'result', result: { hypothesis: result.hypothesis, entities: result.entities,
        ttsConfig: result.ttsConfig, ttsFormat: result.ttsFormat, ttsPCM: Buffer.from(result.ttsPCM).toString('base64') } });
    } catch {
      row.setup.resolve();
      if (!row.closed) publish(row, { type: 'failure', error: 'OPS sample failed; retain reservations and inspect server evidence' });
    }
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
      if (path === '/composed/qualification/control' && !authorized(request)) return new Response(null, { status: 403 });
      // Worklet fetches do not inherit Puppeteer's page-only authentication
      // headers. These exact key-free assets need only the flagged origin guard.
      if (request.method === 'GET' && (asset.test(path) || ['/composed/qualification-page.js', '/composed/qualification-output-timing.js'].includes(path))) {
        const file = path.startsWith('/composed/') ? new URL('.' + path.slice('/composed'.length), import.meta.url) : new URL('../../..' + path, import.meta.url);
        try { return new Response(await readFile(file), { headers: { 'content-type': 'text/javascript', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } }); }
        catch { return new Response(null, { status: 404 }); }
      }
      const owner = await authenticateRelay(request);
      if (typeof owner !== 'string' || !owner) return new Response(null, { status: 401 });
      if (path === '/composed/relay') return networkRelay.handle(request);
      if (path === '/composed/qualification' && request.method === 'GET') return new Response(
        '<!doctype html><meta charset="utf-8"><title>Composed qualification</title><link rel="icon" href="data:,"><p>OPS loopback qualification</p><script type="module" src="/composed/qualification-page.js"></script>',
        { headers: { 'content-type': 'text/html', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'self'; connect-src 'self'; img-src data:; object-src 'none'; frame-ancestors 'none'" } });
      if (path !== '/composed/qualification/control' || request.method !== 'POST') return new Response(null, { status: 404 });
      try {
        const input = await body(request);
        if (input.action === 'start') {
          if (input.runId !== control.runId) return new Response(null, { status: 403 });
          const snapshot = readPersistedQualificationSnapshot(control.budgetPath);
          if (snapshot.blocked || !snapshot.runs?.includes(control.runId)) return new Response(null, { status: 403 });
          if (active || !['candidate', 'baseline'].includes(input.lane) || !input.item) throw new Error('Invalid or concurrent sample');
          const row = { id: randomUUID(), owner, queue: [], pending: new Map(), closed: false, polling: false,
            lane: input.lane, admissions: new Map(), setup: Promise.withResolvers(), controller: new AbortController() };
          active = row; row.timer = setTimeout(() => void dispose(row)?.catch(() => {}), 120_000); row.timer.unref?.();
          void start(row, { item: input.item, lane: input.lane, runId: input.runId });
          return json({ sampleId: row.id });
        }
        const row = active;
        if (!row || row.closed || row.owner !== owner || input.sampleId !== row.id) return new Response(null, { status: 403 });
        if (input.action === 'ack') {
          const pending = row.pending.get(input.id); if (!pending) return new Response(null, { status: 403 });
          let value;
          if (!input.error) {
            try { value = acknowledged(row, pending, input.value); }
            catch { return new Response(null, { status: 403 }); }
          }
          row.pending.delete(input.id); clearTimeout(pending.timer);
          if (input.error) pending.reject(new Error('Admission refused')); else pending.resolve(value);
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
  await loadQualificationKeys({ AITHEMA_COMPOSED_QUALIFICATION: options.enabled ? '1' : '0', AITHEMA_COMPOSED_KEYS_FILE: options.keysFile });
  const { listen } = await import('../../../packages/server/src/http.js');
  const mount = createQualificationMount(options);
  const { server, url } = await listen(async request => await mount.handle(request) ?? new Response(null, { status: 404 }),
    { hostname: options.hostname ?? '127.0.0.1', port: options.port ?? 0 });
  return { url: options.hostname === '::1' ? `http://[::1]:${server.address().port}` : url,
    async close() { await mount.close(); server.close(); server.closeAllConnections(); } };
}
