// Copied into the scratch host: all bare imports resolve from its own node_modules.
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { Window } from 'happy-dom';
const window = new Window({ url: 'http://localhost/', settings: { disableIframePageLoading: true } });
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
const guide = readFileSync('embedding.md', 'utf8');
let imports = 0, symbols = 0;
for (const [, example] of guide.matchAll(/```js\n([\s\S]*?)```/gu)) {
  for (const match of example.matchAll(/import\s+(?:\{([^}]+)\}\s+from\s+)?['"]([^'"]+)['"]/gu)) {
    const module = await import(match[2]); imports++;
    for (const field of (match[1] ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
      const symbol = field.split(/\s+as\s+/u)[0];
      assert.ok(Object.hasOwn(module, symbol), `${match[2]} exports ${symbol}`); symbols++;
    }
  }
}
const pin = JSON.parse(readFileSync('deployment-pin.json'));
for (const pkg of pin.packages) {
  const directory = realpathSync(`node_modules/${pkg.name}`);
  assert.ok(directory.startsWith(realpathSync('.') + '/node_modules/'), 'No workspace link');
  assert.equal(JSON.parse(readFileSync(directory + '/package.json')).version, pin.version);
  // Import every runtime export, including browser clients and internal adapter helpers.
  const metadata = JSON.parse(readFileSync(directory + '/package.json'));
  for (const [subpath, target] of Object.entries(metadata.exports)) {
    if (typeof target === 'object' && !target.default) continue; // type-only contract
    await import(pkg.name + (subpath === '.' ? '' : subpath.slice(1)));
  }
}
const { SQLiteStorage, SQLiteBudgetLedger, createHandlers, createMemoryConsentLedger, createPluginRuntime, mockPresets } = await import('@inspr/aithema-server');
const { listen } = await import('@inspr/aithema-server/http');
const { PluginRegistry, createMockReasoning } = await import('@inspr/aithema-core');
const { en } = await import('@inspr/aithema-ui/i18n/en');
const storage = new SQLiteStorage(':memory:'), consent = createMemoryConsentLedger();
const reasoning = createMockReasoning(), registry = new PluginRegistry().register(reasoning);
const budget = new SQLiteBudgetLedger(storage, { sessionCapMicro: 0 });
const pluginRuntime = createPluginRuntime({ storage, consent, reasoning, registry, presets: mockPresets(), budget });
const handlers = createHandlers({ storage, consent, pluginRuntime });
await handlers.resume();
const { server, url } = await listen(handlers.handle);
let element, preview;
try {
  const token = crypto.randomUUID();
  const response = await fetch(url + '/api/sessions', { method: 'POST', headers: {
    'content-type': 'application/json', 'x-aithema-session-token': token }, body: JSON.stringify({ locale: 'en' }) });
  assert.equal(response.status, 201);
  const session = await response.json();
  assert.equal((await fetch(`${url}/api/sessions/${session.id}`, { headers: { 'x-aithema-session-token': token } })).status, 200);
  assert.equal((await fetch(`${url}/api/sessions/${session.id}`, { headers: { 'x-aithema-session-token': 'another-owner' } })).status, 404);
  element = document.createElement('aithema-session');
  element.configure({ session, sessionToken: token, baseUrl: url, copy: en });
  document.body.append(element);
  assert.equal(element.session.id, session.id);
  assert.ok(element.shadowRoot.querySelector('.transcript-shell'));
  preview = document.createElement('aithema-html-preview'); document.body.append(preview);
  assert.ok(preview.shadowRoot);
  const exported = await fetch(`${url}/api/sessions/${session.id}/export`, { headers: { 'x-aithema-session-token': token } });
  assert.equal(exported.status, 200);
  assert.ok(Buffer.from(await exported.arrayBuffer()).includes(Buffer.from(pin.source_commit)), 'Export binds candidate source');
  console.log(JSON.stringify({ imports, symbols, runtime_exports: 'all', handlers: 'HTTP create/read/export and owner isolation',
    components: ['aithema-session', 'aithema-html-preview'], dom: 'happy-dom mount; browser policy/layout is covered by the browser suite', version: pin.version }));
} finally {
  element?.remove(); preview?.remove(); await window.happyDOM.close();
  server.close(); server.closeAllConnections(); await handlers.close(); storage.close();
}
