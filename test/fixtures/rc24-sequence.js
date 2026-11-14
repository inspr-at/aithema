// Real session handlers and SSE; deterministic, non-billable mock only.
import { readFile } from 'node:fs/promises';
import { SQLiteStorage, createHandlers, createPluginRuntime } from '../../packages/server/src/index.js';
import { createMockReasoning } from '../../packages/core/src/index.js';
import { listen } from '../../packages/server/src/http.js';
import { purposePolicy } from '../safeguards-corpus.js';
const NativeDate = Date;
let clock = 1_800_000_000_000;
globalThis.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [clock])); }
  static now() { return clock; }
};
const now = () => clock, owner = 'rc24-fixture-owner';
const storage = new SQLiteStorage(':memory:', { now });
const mock = createMockReasoning();
const plugin = { ...mock, async structured(request, options) {
  const result = await mock.structured(request, options);
  const count = request.messages.filter(m => m.role === 'user' && !m.content.startsWith('{"kind":')).length;
  result.progress.talk.value = count / 10; result.progress.build.value = count / 20;
  return result;
} };
const consent = { coverage: ({ scope, consentRevision }) => ({ covered: true, ...scope, scope, consentRevision, checkedAt: now(), expiresAt: now() + 60_000 }) };
const runtime = createPluginRuntime({ storage, reasoning: mock, consent, now });
const admit = runtime.admit;
runtime.admit = async args => ({ ...await admit(args), plugin });
const handlers = createHandlers({ storage, pluginRuntime: runtime, purposePolicy, log() {} });
const root = new URL('../../', import.meta.url);
const { server, url } = await listen(async request => {
  const u = new URL(request.url), path = u.pathname;
  if (path === '/sequence') {
    const session = storage.create({ demo: true, locale: u.searchParams.get('locale') ?? 'en', ownerToken: owner });
    storage.append(session.id, 'turn.final', { id: 'initial', role: 'user', content: 'We improve invoice approvals.' });
    await handlers.handle(new Request(`http://fixture/api/sessions/${session.id}/retry`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aithema-session-token': owner }, body: '{}' }));
    await handlers.idle();
    return handlers.handle(new Request(`http://fixture/api/sessions/${session.id}`, { headers: { 'x-aithema-session-token': owner } }));
  }
  if (path === '/clock') { clock += 1000; return Response.json({ now: now() }); }
  if (path.startsWith('/api/')) return handlers.handle(new Request(request, { headers: { ...Object.fromEntries(request.headers), 'x-aithema-session-token': owner } }));
  if (path === '/') return new Response('<!doctype html><html><meta charset="utf-8"><style>body{margin:0}aithema-session{display:block;min-height:100vh}</style><aithema-session></aithema-session><script type="module" src="/packages/ui/src/session-element.js"></script></html>', { headers: { 'content-type': 'text/html' } });
  if (!/^\/packages\/(ui|core)\/src\/[a-z0-9/-]+\.(?:js|json)$/u.test(path)) return new Response(null, { status: 404 });
  try { return new Response(await readFile(new URL(path.slice(1), root)), { headers: { 'content-type': path.endsWith('.json') ? 'application/json' : 'text/javascript' } }); }
  catch { return new Response(null, { status: 404 }); }
});
process.send?.({ url });
process.once('SIGTERM', async () => { server.closeAllConnections(); await handlers.close(); storage.close(); server.close(); });
