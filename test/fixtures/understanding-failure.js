// Real handlers, visitor wallet and ledger; the only provider is a controlled fake.
import { readFile } from 'node:fs/promises';
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
let release, holdAssessment = false, success = false, current, analysisEntered, enterAnalysis;
const plugin = createOpenRouterReasoning({ binding: config.reaction, prices: config.prices, resolveSecret: () => 'fake-only',
  async fetchImpl(url, init) {
    const result = kit.fetchImpl(url, init), call = await kit.next();
    if (call.body.stream) call.resolve({ content: 'Welche Arbeit? Which work?', scope: 'in', question_short: null, options: [] }, { costUSD: 0.1 });
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
  const host = createDemoHost({ storage, ownerGuard: false });
  return createHandlers({ storage, pluginRuntime: runtime, purposePolicy: start2PurposePolicy, host, consent });
};
let handlers = makeHandlers();
const call = (action, data) => handlers.handle(new Request(`http://fixture/api/sessions/${current.id}/${action}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-aithema-session-token': owner }, body: JSON.stringify(data),
}));
const root = new URL('../../', import.meta.url);
const { server, url } = await listen(async request => {
  const u = new URL(request.url), path = u.pathname;
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
  if (path.startsWith('/api/')) return handlers.handle(new Request(request, { headers: { ...Object.fromEntries(request.headers), 'x-aithema-session-token': owner } }));
  if (path === '/') return new Response('<!doctype html><html><meta charset="utf-8"><style>body{margin:0}aithema-session{display:block;min-height:100vh}</style><aithema-session></aithema-session><script type="module" src="/packages/ui/src/session-element.js"></script></html>', { headers: { 'content-type': 'text/html' } });
  if (!/^\/packages\/(ui|core)\/src\/[a-z0-9/-]+\.(?:js|json)$/u.test(path)) return new Response(null, { status: 404 });
  try { return new Response(await readFile(new URL(path.slice(1), root)), { headers: { 'content-type': path.endsWith('.json') ? 'application/json' : 'text/javascript' } }); }
  catch { return new Response(null, { status: 404 }); }
});
process.send?.({ url });
process.once('SIGTERM', async () => { server.closeAllConnections(); await handlers.close(); storage.close(); server.close(); });
