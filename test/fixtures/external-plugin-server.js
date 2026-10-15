import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SQLiteStorage } from '@inspr/aithema-server';
import { listen } from '@inspr/aithema-server/http';
import { createExternalHost } from './external-plugin-host.js';

globalThis.fetch = async () => assert.fail('External plugin proof must never contact a provider');
const host = createExternalHost({ storage: new SQLiteStorage(process.env.AITHEMA_DB) });
await host.handlers.resume();
const root = new URL('../../', import.meta.url);
const { server, url } = await listen(async request => {
  const path = new URL(request.url).pathname;
  if (path.startsWith('/api/')) return host.handlers.handle(request);
  // Local test diagnostics wait for actual lane completion, then expose receipts.
  if (path === '/proof') {
    await host.handlers.idle();
    return Response.json(host.storage.db.prepare('SELECT lane,state,outcome,settled_micro,usage FROM budget_attempts').all());
  }
  const file = path === '/' ? 'test/fixtures/external-plugin-page.html' : path.slice(1);
  if (!/^(?:test\/fixtures\/external-plugin-page\.(?:html|js)|packages\/(?:ui|core)\/src\/[a-zA-Z0-9/-]+\.(?:js|json))$/u.test(file)) return new Response(null, { status: 404 });
  try {
    return new Response(await readFile(fileURLToPath(new URL(file, root))), { headers: {
      'content-type': file.endsWith('.html') ? 'text/html' : file.endsWith('.json') ? 'application/json' : 'text/javascript' } });
  } catch { return new Response(null, { status: 404 }); }
}, { hostname: '127.0.0.1', port: Number(process.env.PORT ?? 0) });
process.send?.({ url });
process.once('SIGTERM', () => { void (async () => { server.close(); server.closeAllConnections(); await host.close(); })(); });
