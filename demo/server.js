import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import { SQLiteStorage, createHandlers, createPluginRuntime, createMemoryConsentLedger } from '@inspr/aithema-server';
import { listen } from '@inspr/aithema-server/http';
import { createMockReasoning, PluginRegistry } from '@inspr/aithema-core';
import { createOpenRouterReasoning } from '@inspr/aithema-plugin-openrouter';
import { createMistralReasoning } from '@inspr/aithema-plugin-mistral';
import { config } from './config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const defaultDb = resolve(root, '.data/session.sqlite');
if (!process.env.AITHEMA_DB) await mkdir(resolve(root, '.data'), { recursive: true });
const storage = new SQLiteStorage(process.env.AITHEMA_DB ?? defaultDb);
// The demo is deterministic unless the operator explicitly selects a provider.
// Private references resolve from the environment at dispatch, never into public config.
const provider = process.env.AITHEMA_PROVIDER ?? 'mock';
if (!['mock', 'openrouter', 'mistral'].includes(provider)) throw new TypeError('Unknown demo provider');
const privateBinding = { plugin: provider, model: provider === 'mistral' ? (process.env.MISTRAL_MODEL ?? 'mistral-small-latest')
  : (process.env.OPENROUTER_MODEL ?? config.model), effort: 'none',
  endpoint: provider === 'mistral' ? 'https://api.mistral.ai/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions',
  accountRef: 'unverified', secretRef: provider === 'mistral' ? 'MISTRAL_API_KEY' : 'OPENROUTER_API_KEY',
  maxMicro: 1_000_000, maxTokens: 4096, rates: { inputMicro: 0, outputMicro: 0 } };
const reasoning = provider === 'mock' ? createMockReasoning() : provider === 'openrouter'
  ? createOpenRouterReasoning({ binding: privateBinding }) : createMistralReasoning({ binding: privateBinding });
const consent = createMemoryConsentLedger();
const pluginRuntime = provider === 'mock' ? createPluginRuntime({ storage, reasoning, consent }) : createPluginRuntime({ storage, consent,
  registry: new PluginRegistry().register(reasoning), presets: {
    best: { plugins: [provider], bindings: { reaction: privateBinding, understanding: privateBinding } },
    eu: { plugins: [], bindings: {} }, custom: { plugins: [], bindings: {} },
  } });
const ownership = {
  token(request) {
    const value = /(?:^|;\s*)aithema-visitor=([a-zA-Z0-9_-]{1,128})(?:;|$)/u.exec(request.headers.get('cookie') ?? '');
    return value?.[1] ?? null;
  },
  created(response, token) {
    response.headers.set('set-cookie', `aithema-visitor=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
  },
};
const handlers = createHandlers({ storage, reasoning, pluginRuntime, consent, ownership }); handlers.resume();
const expiry = setInterval(() => handlers.expire(Date.now() - 365 * 24 * 60 * 60 * 1000), 60_000);
expiry.unref();
let allowedHosts = new Set();
async function handle(request) {
  if (!allowedHosts.has(request.headers.get('host'))) return new Response(null, { status: 403 });
  if (request.method === 'POST' && request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return new Response(null, { status: 415 });
  }
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return handlers.handle(request);
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
  if (url.pathname === '/demo/config') return Response.json({ label: reasoning.label, defaultPreset: 'best' });
  const path = url.pathname === '/' ? '/demo/index.html' : url.pathname;
  // Explicit source/static allowlist; no arbitrary files, lockfiles or credentials.
  if (!/^\/(?:demo\/(?:index\.html|host\.js)|plugins\/device\/src\/index\.js|packages\/(?:ui|core)\/src\/[a-z0-9/-]+\.js)$/u.test(path)) return new Response(null, { status: 404 });
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
  clearInterval(expiry);
  server.close(); await handlers.close(); server.closeAllConnections(); storage.close();
}
process.once('SIGTERM', () => void close()); process.once('SIGINT', () => void close());
