import { readFile } from 'node:fs/promises';
import { listen } from '../../packages/server/src/http.js';
import { createLaneRaceHarness } from './lane-race-harness.js';
let h, runs, pending;
const root = new URL('../../', import.meta.url);
const snapshot = async () => (await h.route()).json();
const running = await listen(async request => {
  const url = new URL(request.url), path = url.pathname;
  if (path === '/snapshot') {
    await h?.close(); h = await createLaneRaceHarness();
    return Response.json(await snapshot());
  }
  if (path === '/begin') {
    await h?.close(); h = await createLaneRaceHarness();
    const pair = url.searchParams.get('pair').split(',');
    runs = Object.fromEntries(pair.map(lane => [lane, h.run(lane)]));
    pending = Object.fromEntries(await Promise.all(pair.map(async lane => [lane, await h.next(lane)])));
    return Response.json({ session: await snapshot(), pending: pair });
  }
  if (path === '/retry-failure') {
    await h?.close(); h = await createLaneRaceHarness();
    const lane = url.searchParams.get('lane');
    await h.route('retry', {});
    const calls = await Promise.all(['reaction', 'understanding'].map(async name => [name, await h.next(name)]));
    for (const [name, call] of calls) {
      if (name === lane) call.httpError(400); else h.resolve(call);
    }
    await h.handlers.idle();
    return Response.json(await snapshot());
  }
  if (path === '/finish') {
    const order = url.searchParams.get('order').split(',');
    const failure = url.searchParams.get('failure');
    for (const lane of order) {
      if (failure === lane) pending[lane].httpError(400);
      else h.resolve(pending[lane]);
      await Promise.allSettled([runs[lane]]);
    }
    await Promise.allSettled(Object.values(runs));
    return Response.json({ session: await snapshot(), counters: h.runtime.budget.outcomeCounters(),
      attempts: h.storage.db.prepare('SELECT state, outcome, settled_micro AS charged, max_micro AS maximum FROM budget_attempts').all() });
  }
  if (path.startsWith('/api/')) return h.handlers.handle(new Request(request, { headers: { ...Object.fromEntries(request.headers), 'x-aithema-session-token': 'lane-race-owner' } }));
  if (path === '/') return new Response('<!doctype html><html><meta charset="utf-8"><style>body{margin:0}aithema-session{display:block;min-height:100vh}</style><aithema-session></aithema-session><script type="module" src="/packages/ui/src/session-element.js"></script></html>', { headers: { 'content-type': 'text/html' } });
  if (!/^\/packages\/(ui|core)\/src\/[a-z0-9/-]+\.(?:js|json)$/u.test(path)) return new Response(null, { status: 404 });
  try { return new Response(await readFile(new URL(path.slice(1), root)), { headers: { 'content-type': path.endsWith('.json') ? 'application/json' : 'text/javascript' } }); }
  catch { return new Response(null, { status: 404 }); }
});
process.send?.({ url: running.url });
process.once('SIGTERM', async () => { running.server.closeAllConnections(); await h?.close(); running.server.close(); });
