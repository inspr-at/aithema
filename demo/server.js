import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import { SQLiteStorage, createHandlers } from '@inspr/aithema-server';
import { listen } from '@inspr/aithema-server/http';
import { createMockReasoning } from '@inspr/aithema-core';
import { createOpenRouterReasoning } from '@inspr/aithema-plugin-openrouter';
import { config } from './config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const defaultDb = resolve(root, '.data/session.sqlite');
if (!process.env.AITHEMA_DB) await mkdir(resolve(root, '.data'), { recursive: true });
const storage = new SQLiteStorage(process.env.AITHEMA_DB ?? defaultDb);
// The sole credential read is at runtime. Never send the binding/key to the browser.
const apiKey = process.env.OPENROUTER_API_KEY;
const reasoning = apiKey ? createOpenRouterReasoning({ apiKey, model: process.env.OPENROUTER_MODEL ?? config.model }) : createMockReasoning();
const handlers = createHandlers({ storage, reasoning }); handlers.resume();
let allowedHosts = new Set();
async function handle(request) {
  if (!allowedHosts.has(request.headers.get('host'))) return new Response(null, { status: 403 });
  if (request.method === 'POST' && request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return new Response(null, { status: 415 });
  }
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return handlers.handle(request);
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
  if (url.pathname === '/demo/config') return Response.json({ label: reasoning.label });
  const path = url.pathname === '/' ? '/demo/index.html' : url.pathname;
  // Explicit source/static allowlist; no arbitrary files, lockfiles or credentials.
  if (!/^\/(?:demo\/(?:index\.html|host\.js)|packages\/(?:ui|core)\/src\/[a-z0-9/-]+\.js)$/u.test(path)) return new Response(null, { status: 404 });
  const file = resolve(root, `.${path}`);
  if (!file.startsWith(root + (root.endsWith(sep) ? '' : sep))) return new Response(null, { status: 404 });
  try {
    const bytes = await readFile(file);
    return new Response(request.method === 'HEAD' ? null : bytes, { headers: {
      'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    } });
  } catch { return new Response(null, { status: 404 }); }
}
const { server, url } = await listen(handle, { port: Number(process.env.PORT ?? config.port) });
const port = server.address().port;
allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
console.log(`Demo — Aithema reset slice 1: ${url} (${reasoning.label})`);
process.send?.({ url });
async function close() {
  server.close(); await handlers.close(); server.closeAllConnections(); storage.close();
}
process.once('SIGTERM', () => void close()); process.once('SIGINT', () => void close());
