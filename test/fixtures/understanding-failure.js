// Real handlers, visitor wallet and ledger; the only provider is a controlled fake.
import { readFile } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { SQLiteStorage, createHandlers, createPluginRuntime } from '../../packages/server/src/index.js';
import { PluginRegistry } from '../../packages/core/src/index.js';
import { listen } from '../../packages/server/src/http.js';
import { createOpenRouterReasoning } from '../../plugins/openrouter/src/index.js';
import { createDemoHost } from '../../demo/host-ports.js';
import { openRouterConfig } from '../../demo/openrouter-config.js';
import { start2PurposePolicy } from '../../demo/safeguards.js';
const consent = { coverage: ({ scope, consentRevision }) => ({ covered: true, ...scope, scope, consentRevision, checkedAt: Date.now(), expiresAt: Date.now() + 60_000 }) };

const storage = new SQLiteStorage(), owner = 'understanding-fixture-owner';
const config = openRouterConfig({ OPENROUTER_MODEL: 'anthropic/fixture',
  AITHEMA_OPENROUTER_PRICES: '{"anthropic/fixture":{"prompt":0.000001,"completion":0.0001}}' });
let release, success = false, current;
const assessment = { summary: 'Ein Überblick. An overview.', signals: [], openQuestions: [],
  constraints: { operations: null, data: null, systems: null, reach: null, requirements: null },
  progress: { talk: { value: 0.2, reasoning: 'First details' }, build: { value: 0, reasoning: 'Pending' } },
  actor: null, engagement: null, conceptIntent: null };
const plugin = createOpenRouterReasoning({ binding: config.reaction, prices: config.prices, resolveSecret: () => 'fake-only',
  async fetchImpl(_url, init) {
    const body = JSON.parse(init.body), usage = { prompt_tokens: 30, completion_tokens: 40, cost: 0.1 };
    if (body.stream) {
      const content = JSON.stringify({ content: 'Welche Arbeit? Which work?', scope: 'in', question_short: null, options: [] });
      return new Response(`data: ${JSON.stringify({ usage, choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    }
    if (!success) {
      const verdict = await new Promise(resolve => { release = resolve; });
      if (verdict === 'uncertain') return new Response(null, { status: 503 });
      return Response.json({ usage, choices: [{ finish_reason: 'length', message: { content: '{}' } }] });
    }
    return Response.json({ usage, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(assessment) } }] });
  } });
const runtime = createPluginRuntime({ storage, consent, registry: new PluginRegistry().register(plugin),
  presets: { best: { plugins: ['openrouter'], bindings: { reaction: config.reaction, understanding: config.understanding }, policy: { endpoints: [config.reaction.endpoint] } } } });
const host = createDemoHost({ storage, ownerGuard: false });
const handlers = createHandlers({ storage, pluginRuntime: runtime, purposePolicy: start2PurposePolicy, host, consent });
const call = (action, data) => handlers.handle(new Request(`http://fixture/api/sessions/${current.id}/${action}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-aithema-session-token': owner }, body: JSON.stringify(data),
}));
const root = new URL('../../', import.meta.url);
const { server, url } = await listen(async request => {
  const u = new URL(request.url), path = u.pathname;
  if (path === '/fixture') {
    success = false; release = undefined;
    current = storage.create({ demo: true, ownerToken: owner, locale: u.searchParams.get('locale') ?? 'de' });
    await call('turns', { content: 'Wir möchten die Auftragsbearbeitung vereinfachen.', clientEventId: crypto.randomUUID() });
    const deadline = Date.now() + 5000;
    while (!release && Date.now() < deadline) await nextTurn();
    if (!release) throw new Error('Analysis never dispatched');
    return handlers.handle(new Request(`http://fixture/api/sessions/${current.id}`, { headers: { 'x-aithema-session-token': owner } }));
  }
  if (path === '/settle') { release(u.searchParams.get('verdict')); await handlers.idle(); return Response.json({ ok: true }); }
  if (path === '/success') { success = true; await call('retry', {}); await handlers.idle(); return Response.json({ ok: true }); }
  if (path.startsWith('/api/')) return handlers.handle(new Request(request, { headers: { ...Object.fromEntries(request.headers), 'x-aithema-session-token': owner } }));
  if (path === '/') return new Response('<!doctype html><html><meta charset="utf-8"><style>body{margin:0}aithema-session{display:block;min-height:100vh}</style><aithema-session></aithema-session><script type="module" src="/packages/ui/src/session-element.js"></script></html>', { headers: { 'content-type': 'text/html' } });
  if (!/^\/packages\/(ui|core)\/src\/[a-z0-9/-]+\.(?:js|json)$/u.test(path)) return new Response(null, { status: 404 });
  try { return new Response(await readFile(new URL(path.slice(1), root)), { headers: { 'content-type': path.endsWith('.json') ? 'application/json' : 'text/javascript' } }); }
  catch { return new Response(null, { status: 404 }); }
});
process.send?.({ url });
process.once('SIGTERM', async () => { server.closeAllConnections(); await handlers.close(); storage.close(); server.close(); });
