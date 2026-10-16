// Copied into the scratch host: all bare imports resolve from its own node_modules.
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { Window } from 'happy-dom';
const window = new Window({ url: 'http://localhost/', settings: { disableIframePageLoading: true } });
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
const guide = readFileSync('embedding.md', 'utf8');
let imports = 0, symbols = 0;
const runtimeSubpaths = [], typeSubpaths = [];
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
    const specifier = pkg.name + (subpath === '.' ? '' : subpath.slice(1));
    if (typeof target === 'object' && Object.keys(target).every(key => key === 'types')) {
      // Node intentionally cannot load a types-only subpath. Exercise that contract
      // and verify its declaration is present in the installed tarball.
      await assert.rejects(import(specifier), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
      assert.ok(readFileSync(directory + '/' + target.types, 'utf8').length);
      typeSubpaths.push(specifier);
    } else {
      await import(specifier); runtimeSubpaths.push(specifier);
    }
  }
}
const { SQLiteStorage, SQLiteBudgetLedger, createHandlers, createMemoryConsentLedger, createPluginRuntime, mockPresets } = await import('@inspr/aithema-server');
const { listen } = await import('@inspr/aithema-server/http');
const { PluginRegistry, createMockReasoning, inputRevision } = await import('@inspr/aithema-core');
const { en } = await import('@inspr/aithema-ui/i18n/en');
const { de } = await import('@inspr/aithema-ui/i18n/de');
function keyTree(value) {
  if (!value || typeof value !== 'object') return null;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, keyTree(value[key])]));
}
assert.deepEqual(keyTree(de), keyTree(en), 'German and English bundles have identical recursive keys');
const storage = new SQLiteStorage(':memory:'), consent = createMemoryConsentLedger();
const reasoning = createMockReasoning(), registry = new PluginRegistry().register(reasoning);
const budget = new SQLiteBudgetLedger(storage, { sessionCapMicro: 0 });
const pluginRuntime = createPluginRuntime({ storage, consent, reasoning, registry, presets: mockPresets(), budget });
const handlers = createHandlers({ storage, consent, pluginRuntime, log: record => console.error(record) });
await handlers.resume();
const { server, url } = await listen(request => new URL(request.url).pathname === '/health'
  ? Response.json({ status: 'ok' }) : handlers.handle(request));
let element, preview;
try {
  const health = await fetch(url + '/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  const token = crypto.randomUUID();
  const response = await fetch(url + '/api/sessions', { method: 'POST', headers: {
    'content-type': 'application/json', 'x-aithema-session-token': token }, body: JSON.stringify({ locale: 'en' }) });
  assert.equal(response.status, 201);
  const session = await response.json();
  assert.equal((await fetch(`${url}/api/sessions/${session.id}`, { headers: { 'x-aithema-session-token': token } })).status, 200);
  assert.equal((await fetch(`${url}/api/sessions/${session.id}`, { headers: { 'x-aithema-session-token': 'another-owner' } })).status, 404);
  const base = `${url}/api/sessions/${session.id}`;
  const post = (action, body) => fetch(`${base}/${action}`, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-aithema-session-token': token }, body: JSON.stringify(body) });
  assert.equal((await consent.coverage({ sessionId: session.id })).covered, false, 'Host starts without consent');
  const granted = await post('consent', { granted: true });
  assert.equal(granted.status, 200);
  assert.equal((await granted.json()).granted, true);
  assert.equal((await consent.coverage({ sessionId: session.id })).covered, true);
  const content = 'systems: SAP; operations: hosted; data: public; reach: international';
  const turn = await post('turns', { clientEventId: 'standalone-turn', content });
  assert.equal(turn.status, 200);
  await handlers.idle();
  const overviewResponse = await fetch(base, { headers: { 'x-aithema-session-token': token } });
  assert.equal(overviewResponse.status, 200);
  const overview = await overviewResponse.json();
  assert.equal(overview.transcript.filter(t => t.role === 'user').length, 1);
  assert.equal(overview.transcript.filter(t => t.role === 'assistant').length, 1);
  assert.equal(overview.transcript.find(t => t.role === 'assistant').content, 'What should improve first?');
  assert.equal(overview.understanding.summary, content);
  assert.equal(overview.understanding.constraints.systems.value, 'SAP');
  assert.equal(overview.understanding.inputRevision, inputRevision(overview));
  assert.equal(overview.understanding.draft, false);
  assert.equal(overview.understanding.readinessAssessed, true);
  assert.equal(overview.operations.lastFailure, null);
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
  console.log(JSON.stringify({ imports, symbols, runtime_exports: 'all', runtime_subpaths: runtimeSubpaths, type_subpaths: typeSubpaths, locale_key_parity: 'recursive', handlers: 'HTTP health/session/consent/turn/overview/export and owner isolation', conversation: { model: 'mock', turns: 1, consent: 'granted', overview: 'current, settled and content verified' },
    components: ['aithema-session', 'aithema-html-preview'], dom: 'happy-dom mount; browser policy/layout is covered by the browser suite', version: pin.version }));
} finally {
  element?.remove(); preview?.remove(); await window.happyDOM.close();
  await handlers.close();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  assert.equal(server.listening, false);
  storage.close();
}
