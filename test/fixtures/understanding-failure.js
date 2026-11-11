// Real handlers, visitor wallet and ledger; the only provider is a controlled fake.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { SQLiteStorage, createHandlers, createPluginRuntime } from '../../packages/server/src/index.js';
import { PluginRegistry, inputRevision } from '../../packages/core/src/index.js';
import { listen } from '../../packages/server/src/http.js';
import { createOpenRouterReasoning } from '../../plugins/openrouter/src/index.js';
import { createDemoHost } from '../../demo/host-ports.js';
import { openRouterConfig } from '../../demo/openrouter-config.js';
import { start2PurposePolicy } from '../../demo/safeguards.js';
import { createFakeProviderKit, assessment } from './fake-provider-kit.js';
const kit = createFakeProviderKit();
const consent = { coverage: ({ scope, consentRevision }) => ({ covered: true, ...scope, scope, consentRevision, checkedAt: Date.now(), expiresAt: Date.now() + 60_000 }) };

let storage = new SQLiteStorage(process.env.AITHEMA_DB);
const owner = 'understanding-fixture-owner';
const config = openRouterConfig({ OPENROUTER_MODEL: 'anthropic/fixture', OPENROUTER_ANALYSIS_EFFORT: 'low',
  AITHEMA_OPENROUTER_PRICES: '{"anthropic/fixture":{"prompt":0.000001,"completion":0.0001}}' });
let replyHold = null;
let release, holdAssessment = false, success = false, current, analysisEntered, enterAnalysis;
const plugin = createOpenRouterReasoning({ binding: config.reaction, prices: config.prices, resolveSecret: () => 'fake-only',
  async fetchImpl(url, init) {
    const result = kit.fetchImpl(url, init), call = await kit.next();
    if (call.body.stream) {
      const finish = verdict => verdict === 'fail' ? call.httpError(400)
        : call.resolve({ content: 'Welche Arbeit? Which work?', scope: 'in', question_short: null, options: [] }, { costUSD: 0.1 });
      if (replyHold && !replyHold.release) { replyHold.release = finish; replyHold.entered.resolve(); } else finish('success');
    }
    else if (success && !holdAssessment) call.resolve(assessment, { costUSD: 0.1 });
    else { release = verdict => {
      if (verdict === 'success') call.resolve(assessment, { costUSD: 0.1 });
      else if (['400', '408', '499'].includes(verdict)) call.httpError(Number(verdict));
      else if (verdict === 'uncertain') call.httpError(503);
      else call.resolve({}, { finishReason: 'length', costUSD: 0.1 });
    }; enterAnalysis?.(); }
    return result;
  } });
const makeHandlers = () => {
  const runtime = createPluginRuntime({ storage, consent, registry: new PluginRegistry().register(plugin),
  presets: { best: { plugins: ['openrouter'], bindings: { reaction: config.reaction, understanding: config.understanding }, policy: { endpoints: [config.reaction.endpoint] } } } });
  const host = createDemoHost({ storage, ownerGuard: false, ...(process.env.AITHEMA_HOST_LOCK === '1' ? { verificationRequired: true, demoBypass: false } : {}) });
  return createHandlers({ storage, pluginRuntime: runtime, purposePolicy: start2PurposePolicy, host, consent });
};
let handlers = makeHandlers();
const inertSessions = new Set();
const call = (action, data) => handlers.handle(new Request(`http://fixture/api/sessions/${current.id}/${action}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-aithema-session-token': owner }, body: JSON.stringify(data),
}));
const root = new URL('../../', import.meta.url);
const { server, url } = await listen(async request => {
  const u = new URL(request.url), path = u.pathname;
  if (path === '/seed' && request.method === 'POST') {
    const { inert = false, ...session } = await request.json();
    // These UI scenarios own their synthetic timeline. On main their ids were
    // unknown, so the server did no work; the element now treats unknown ids as
    // erased, so they must exist without server work.
    if (inert === true) inertSessions.add(session.id);
    storage.db.prepare('INSERT INTO sessions (id, snapshot) VALUES (?, ?)').run(session.id,
      JSON.stringify({ ...session, ownerHash: createHash('sha256').update(owner).digest('hex') }));
    storage.transitionHost(session.id, () => ({ state: {}, events: [] }));
    return Response.json({ ok: true }, { headers: { 'x-aithema-session-token': owner } });
  }
  if (path === '/hold-reply') { replyHold = { entered: Promise.withResolvers(), release: null }; return Response.json({ ok: true }); }
  if (path === '/release-reply') {
    const held = replyHold;
    if (!held) return Response.json({ error: 'reply-not-held' }, { status: 409 });
    await held.entered.promise; replyHold = null; held.release(u.searchParams.get('verdict'));
    await handlers.idle(); return Response.json({ ok: true });
  }
  if (path === '/locked-reply-failure') {
    current = await (await handlers.handle(new Request('http://fixture/api/sessions', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aithema-session-token': owner }, body: '{}' }))).json();
    storage.changeLocale(current.id, u.searchParams.get('locale') ?? 'de', { ownerToken: owner });
    storage.append(current.id, 'turn.final', { id: crypto.randomUUID(), role: 'user', content: 'Wir möchten die Auftragsbearbeitung vereinfachen.' });
    storage.setLaneFailure(current.id, { inputRevision: inputRevision(storage.get(current.id)), lane: 'reaction' });
    return handlers.handle(new Request(`http://fixture/api/sessions/${current.id}`, { headers: { 'x-aithema-session-token': owner } }));
  }
  if (path === '/reply-failure') {
    success = true; holdAssessment = true;
    current = storage.create({ demo: true, ownerToken: owner, locale: u.searchParams.get('locale') ?? 'de' });
    const off = u.searchParams.get('off') === '1';
    storage.append(current.id, 'turn.final', { id: crypto.randomUUID(), role: 'user', content: off ? 'Give me a soup recipe.' : 'Wir möchten die Auftragsbearbeitung vereinfachen.' });
    if (off) storage.appendPurposeReply(current.id, { id: crypto.randomUUID(), role: 'assistant', content: 'What should the project improve?', inputRevision: inputRevision(storage.get(current.id)) }, inputRevision(storage.get(current.id)), true, 3);
    storage.setLaneFailure(current.id, { inputRevision: inputRevision(storage.get(current.id)), lane: 'reaction' });
    return handlers.handle(new Request(`http://fixture/api/sessions/${current.id}`, { headers: { 'x-aithema-session-token': owner } }));
  }
  if (path === '/two-failures') {
    holdAssessment = false;
    success = true;
    current = storage.create({ demo: true, ownerToken: owner, locale: u.searchParams.get('locale') ?? 'de' });
    storage.append(current.id, 'turn.final', { id: crypto.randomUUID(), role: 'user', content: 'Wir möchten die Auftragsbearbeitung vereinfachen.' });
    for (const lane of ['reaction', 'understanding']) storage.setLaneFailure(current.id, { inputRevision: inputRevision(storage.get(current.id)), lane });
    return handlers.handle(new Request(`http://fixture/api/sessions/${current.id}`, { headers: { 'x-aithema-session-token': owner } }));
  }
  if (path === '/fixture') {
    success = false; release = undefined;
    analysisEntered = new Promise(resolve => { enterAnalysis = resolve; });
    current = storage.create({ demo: true, ownerToken: owner, locale: u.searchParams.get('locale') ?? 'de' });
    await call('turns', { content: 'Wir möchten die Auftragsbearbeitung vereinfachen.', clientEventId: crypto.randomUUID() });
    // The provider call is the rendezvous, not elapsed wall time.
    await analysisEntered;
    return handlers.handle(new Request(`http://fixture/api/sessions/${current.id}`, { headers: { 'x-aithema-session-token': owner } }));
  }
  if (path === '/settle') { release(u.searchParams.get('verdict')); await handlers.idle(); return Response.json({ ok: true }); }
  if (path === '/restart') {
    await handlers.close(); storage.close();
    storage = new SQLiteStorage(process.env.AITHEMA_DB); handlers = makeHandlers();
    await handlers.resume(); await handlers.idle();
    return Response.json({ ok: true });
  }
  if (path === '/stats') {
    await handlers.idle();
    return Response.json({ providerCalls: kit.calls.length, lanes: kit.calls.map(call => call.body.stream ? 'reaction' : 'understanding'), attempts: storage.db.prepare('SELECT * FROM budget_attempts ORDER BY rowid').all() });
  }
  if (path === '/success') { success = true; return Response.json({ ok: true }); }
  const seededRoute = /^\/api\/sessions\/([^/]+)(?:\/(events))?$/u.exec(path);
  if (request.method === 'GET' && seededRoute && inertSessions.has(seededRoute[1])) {
    const id = seededRoute[1], { ownerHash, ...session } = storage.get(id);
    if (!seededRoute[2]) return Response.json(session, { headers: { 'cache-control': 'no-store' } });
    const raw = request.headers.get('last-event-id') ?? u.searchParams.get('after') ?? '0';
    if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > session.seq)
      return Response.json({ error: 'invalid-cursor' }, { status: 400 });
    let cleanup;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const send = event => controller.enqueue(encoder.encode(`${event.seq ? `id: ${event.seq}\n` : ''}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        for (const event of storage.read(id, Number(raw))) send(event);
        // Preserve the seeded operations instead of rebuilding them from jobs.
        if (session.operations) send({ sessionId: id, type: 'lane.status', data: session.operations });
        const heartbeat = setInterval(() => controller.enqueue(encoder.encode(': heartbeat\n\n')), 15_000);
        const abort = () => { cleanup(); controller.close(); };
        cleanup = () => { clearInterval(heartbeat); request.signal.removeEventListener('abort', abort); };
        request.signal.addEventListener('abort', abort, { once: true });
        if (request.signal.aborted) abort();
      },
      cancel() { cleanup?.(); },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive', 'x-accel-buffering': 'no' } });
  }
  if (path.startsWith('/api/')) return handlers.handle(new Request(request, { headers: { ...Object.fromEntries(request.headers), 'x-aithema-session-token': owner } }));
  if (path === '/') return new Response('<!doctype html><html><meta charset="utf-8"><style>body{margin:0}aithema-session{display:block;min-height:100vh}</style><aithema-session></aithema-session><script type="module" src="/packages/ui/src/session-element.js"></script></html>', { headers: { 'content-type': 'text/html' } });
  if (!/^\/packages\/(ui|core)\/src\/[a-z0-9/-]+\.(?:js|json)$/u.test(path)) return new Response(null, { status: 404 });
  try { return new Response(await readFile(new URL(path.slice(1), root)), { headers: { 'content-type': path.endsWith('.json') ? 'application/json' : 'text/javascript' } }); }
  catch { return new Response(null, { status: 404 }); }
});
process.send?.({ url });
process.once('SIGTERM', async () => { server.closeAllConnections(); await handlers.close(); storage.close(); server.close(); });
