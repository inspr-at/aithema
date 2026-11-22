// AIT-625: every client request that can carry the owner credential goes through ONE guarded
// helper. It fails closed without a page origin, resolves the URL once against the document base,
// sends exactly that URL with redirect:'error' and a deadline, and is the only code that names the
// owner header or calls fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const HELPER = 'owner-request.js';
const HEADER = 'x-aithema-session-token';
const helper = () => import('../src/owner-request.js');

function sources(dir = SRC) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : name.endsWith('.js') ? [path] : [];
  });
}
// Comments may explain the policy; only code counts.
const code = text => text.replace(/(^|\s)\/\*[\s\S]*?\*\//gu, '$1').replace(/(^|[^:\\'"`])\/\/.*$/gmu, '$1');

test('AIT-625 structural: the owner header, fetch and XHR appear only in the guarded helper', () => {
  const offenders = [];
  for (const path of sources()) {
    const name = relative(SRC, path);
    if (name === HELPER) continue;
    const text = code(readFileSync(path, 'utf8'));
    const rules = [
      // The header name, any spelling or split: the prefix alone, or the token suffix alone.
      [/x-aithema-/iu, 'owner header prefix'], [/session[-_\s]*token['"`]/iu, 'owner header suffix'],
      [/x\\x2d|\\u002d|\\u\{2d\}/iu, 'escaped header text'],
      // Any reference to fetch (calls, aliases, globalThis.fetch, view.fetch, bracket access).
      [/\bfetch\b/u, 'fetch reference'], [/\[\s*['"`]fetch['"`]\s*\]/u, 'bracket fetch'],
      [/XMLHttpRequest|setRequestHeader/u, 'XHR'], [/\bnew\s+Headers\b/u, 'Headers object'],
    ];
    for (const [pattern, label] of rules) if (pattern.test(text)) offenders.push(`${name}: ${label}`);
  }
  assert.deepEqual(offenders, [], 'only owner-request.js may name the owner header or reach the network');
  const own = readFileSync(join(SRC, HELPER), 'utf8');
  assert.match(own, new RegExp(HEADER, 'u'), 'the helper names the header');
  assert.equal(own.match(/\bfetch\(/gu)?.length, 1, 'the helper calls fetch exactly once');
  assert.doesNotMatch(own, /export\s+(const|let|var)\s+\w*HEADER/iu, 'the header constant is not exported');
});

function stubFetch(t, respond = () => new Response('{}')) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => { calls.push({ url, init }); return respond(url, init); });
  return calls;
}
const page = (url = 'http://app.test/', html = '') => {
  const window = new Window({ url }); window.document.write(`<!doctype html><head>${html}</head><body></body>`);
  return window;
};

test('AIT-625 helper: same-origin use resolves once and fetches exactly that URL with redirect:error and a signal', async t => {
  const { ownerFetch, OWNER_REQUEST_DEADLINE_MS } = await helper();
  assert.equal(OWNER_REQUEST_DEADLINE_MS, 30_000);
  const calls = stubFetch(t), view = page('http://app.test/conversation');
  const response = await ownerFetch(view, '/api/sessions/s1/turns', { method: 'POST', sessionToken: 'tok', body: '{}', headers: { 'content-type': 'application/json' } });
  assert.equal(response.ok, true); assert.equal(calls.length, 1);
  const [{ url, init }] = calls;
  assert.equal(url, 'http://app.test/api/sessions/s1/turns');
  assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
  assert.equal(new Headers(init.headers).get(HEADER), 'tok');
  assert.equal(new Headers(init.headers).get('content-type'), 'application/json');
  // Without a token, no owner header is attached; the guard still applies.
  await ownerFetch(view, '/api/sessions/s1', {});
  assert.equal(new Headers(calls[1].init.headers).has(HEADER), false); assert.equal(calls[1].init.redirect, 'error');
});

test('AIT-625 helper: a foreign <base> or a foreign absolute URL sends nothing', async t => {
  const { ownerFetch } = await helper();
  const calls = stubFetch(t), view = page('http://app.test/', '<base href="https://evil.example/">');
  assert.equal(view.document.baseURI, 'https://evil.example/');
  await assert.rejects(ownerFetch(view, '/api/sessions/s1', { sessionToken: 'tok' }), /same origin/u);
  await assert.rejects(ownerFetch(page(), 'https://evil.example/api/sessions/s1', { sessionToken: 'tok' }), /same origin/u);
  await assert.rejects(ownerFetch(page(), '//evil.example/api', { sessionToken: 'tok' }), /same origin/u);
  assert.equal(calls.length, 0);
});

test('AIT-625 helper: no page origin fails closed (about:blank, opaque origin, missing view)', async t => {
  const { ownerFetch } = await helper();
  const calls = stubFetch(t);
  await assert.rejects(ownerFetch(new Window(), '/api/sessions/s1', { sessionToken: 'tok' }), /page origin/u, 'about:blank');
  await assert.rejects(ownerFetch(new Window(), 'http://app.test/api/sessions/s1', { sessionToken: 'tok' }), /page origin/u, 'absolute URL from about:blank');
  await assert.rejects(ownerFetch(null, '/api/sessions/s1', { sessionToken: 'tok' }), /page origin/u);
  await assert.rejects(ownerFetch({ location: { origin: 'null', protocol: 'https:', href: 'https://x/' }, document: { baseURI: 'https://x/' } }, '/a', {}), /page origin/u, 'opaque origin');
  // An about:srcdoc/about:blank child inherits its parent's origin but is not an owner page.
  await assert.rejects(ownerFetch({ location: { origin: 'http://app.test', protocol: 'about:', href: 'about:srcdoc' }, document: { baseURI: 'http://app.test/' } }, '/a', {}), /page origin/u, 'srcdoc');
  assert.equal(calls.length, 0);
});

test('AIT-625 helper: a caller-supplied owner header is never forwarded unguarded', async t => {
  const { ownerFetch } = await helper();
  const calls = stubFetch(t);
  await ownerFetch(page(), '/api/x', { headers: { [HEADER.toUpperCase()]: 'smuggled' } });
  assert.equal(new Headers(calls[0].init.headers).has(HEADER), false);
});

function listen(t, handler) {
  const server = createServer(handler); t.after(() => { server.closeAllConnections?.(); server.close(); });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

test('AIT-625 helper (real HTTP): a same-origin redirect to a foreign origin is rejected and the header never leaves', async t => {
  const { ownerFetch } = await helper();
  const foreign = []; const foreignOrigin = await listen(t, (request, response) => { foreign.push(request.headers); response.end('{}'); });
  const pageOrigin = await listen(t, (request, response) => { response.writeHead(302, { location: `${foreignOrigin}/steal` }); response.end(); });
  await assert.rejects(ownerFetch(page(`${pageOrigin}/`), '/api/sessions/s1', { sessionToken: 'tok' }));
  assert.equal(foreign.length, 0, 'the foreign origin received no request, so no owner header');
});

test('AIT-625 helper (real HTTP): a stalled request is aborted at the deadline; a caller abort also ends it', async t => {
  const { ownerFetch } = await helper();
  const origin = await listen(t, () => { /* never answers */ });
  const started = performance.now();
  await assert.rejects(ownerFetch(page(`${origin}/`), '/api/sessions/s1', { sessionToken: 'tok', deadline: 150 }), error => error.name === 'TimeoutError');
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 140 && elapsed < 5_000, `aborted near the deadline (${Math.round(elapsed)} ms)`);
  const controller = new AbortController(), pending = ownerFetch(page(`${origin}/`), '/api/sessions/s1', { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, error => error.name === 'AbortError');
});

test('AIT-625 helper: the deadline covers the response headers only, so a streamed body (events) keeps flowing', async t => {
  const { ownerFetch } = await helper();
  const origin = await listen(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' }); response.write('a');
    setTimeout(() => response.end('b'), 250);
  });
  const response = await ownerFetch(page(`${origin}/`), '/api/sessions/s1/events', { deadline: 100 });
  assert.equal(await response.text(), 'ab');
});

test('AIT-625 element: same-origin session requests carry the guard; a foreign <base> stops every one', async t => {
  const calls = stubFetch(t, (url, init) => String(url).endsWith('/events') ? new Response(new ReadableStream({ start() {} }))
    : String(url).endsWith('/locale') && init.method === 'POST' ? Response.json({ error: 'session-not-found' }, { status: 404 }) : Response.json({}));
  const { createSession } = await import('@inspr/aithema-core');
  const { en } = await import('../src/i18n/en.js');
  const window = page('http://app.test/');
  for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
  t.after(() => window.happyDOM.close());
  await import('../src/session-element.js');
  const mount = async (act = async () => {}) => {
    const before = calls.length, component = window.document.createElement('aithema-session');
    component.configure({ copy: structuredClone(en), session: createSession({ demo: true }), sessionToken: 'tok', copyForLocale: () => structuredClone(en) });
    window.document.body.append(component);
    await new Promise(resolve => setTimeout(resolve, 30));
    await act(component); await new Promise(resolve => setTimeout(resolve, 30));
    component.remove();
    return calls.slice(before);
  };
  let sessionId;
  // A locale POST answered 404 session-not-found triggers the owner-authenticated confirmation GET.
  const same = await mount(async component => { sessionId = component.session.id; await component.changeLocale('de'); });
  assert.ok(same.some(call => String(call.url).endsWith('/events')), 'the connected element opens its event stream');
  assert.ok(same.some(call => String(call.url).endsWith('/locale')), 'the locale request was sent');
  assert.ok(same.some(call => String(call.url) === `http://app.test/api/sessions/${sessionId}` && (call.init.method ?? 'GET') === 'GET'), 'the 404 confirmation was sent');
  for (const { url, init } of same) {
    assert.equal(new URL(url).origin, 'http://app.test', String(url)); assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
    assert.equal(new Headers(init.headers).get(HEADER), 'tok');
  }
  const base = window.document.createElement('base'); base.href = 'https://evil.example/'; window.document.head.append(base);
  assert.equal(window.document.baseURI, 'https://evil.example/');
  assert.deepEqual((await mount()).map(call => String(call.url)), [], 'a foreign base sends nothing');
});
