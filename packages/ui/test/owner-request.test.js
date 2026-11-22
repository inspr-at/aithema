// AIT-625: every client request that can carry the owner credential goes through ONE guarded
// helper. It fails closed without a page origin, resolves the URL once against the document base,
// sends exactly that URL with redirect:'error' and a deadline, and is the only code that names the
// owner header or calls fetch.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import ts from 'typescript';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const HELPER = 'owner-request.js';
const HEADER = 'x-aithema-session-token';
const helper = () => import('../src/owner-request.js');
// The browser voice relay forwards host credentials too; it carries its own guard (AIT-625 r2).
const RELAYS = ['packages/server/src/composed/network-client.js', 'plugins/composed-voice/src/network-client.js'];

function sources(dir = SRC) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : name.endsWith('.js') ? [path] : [];
  });
}
// A real JavaScript parse (typescript, already a devDependency): comments are trivia, so a `//`
// inside a string cannot hide code, and string values arrive with their escapes decoded.
function offenders(path, label = path) {
  const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), found = new Set();
  const GLOBALS = new Set(['globalThis', 'window', 'self', 'top', 'parent', 'frames', 'view', 'defaultView']);
  const NETWORK = new Set(['fetch', 'XMLHttpRequest', 'setRequestHeader', 'Headers', 'sendBeacon', 'EventSource', 'eval', 'Function']);
  const literal = node => ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isRegularExpressionLiteral(node);
  const visit = node => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) { if (NETWORK.has(node.text)) found.add(`${label}: ${node.text} reference`); }
    else if (literal(node)) {
      const value = node.text;
      if (/x-aithema-/iu.test(value)) found.add(`${label}: owner header prefix`);
      if (/session[-_\s]*token$/iu.test(value)) found.add(`${label}: owner header suffix`);
      if (/\bfetch\b/u.test(value)) found.add(`${label}: fetch in a string`);
    } else if (ts.isElementAccessExpression(node)) {
      // A computed property on a global or a window (`globalThis['fe' + 'tch']`) can name anything.
      const target = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText(file);
      if (GLOBALS.has(target)) found.add(`${label}: computed access on ${target}`);
    } else if (ts.isPropertyAccessExpression(node) && node.name.text === 'get' && node.expression.getText(file) === 'Reflect') found.add(`${label}: Reflect.get`);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...found];
}

test('AIT-625 structural: the owner header, fetch and XHR appear only in the guarded helper', () => {
  const found = sources().filter(path => relative(SRC, path) !== HELPER).flatMap(path => offenders(path, relative(SRC, path)));
  assert.deepEqual(found, [], 'only owner-request.js may name the owner header or reach the network');
  const own = readFileSync(join(SRC, HELPER), 'utf8');
  assert.match(own, new RegExp(HEADER, 'u'), 'the helper names the header');
  assert.equal(own.match(/\bfetch\(/gu)?.length, 1, 'the helper calls fetch exactly once');
  assert.doesNotMatch(own, /export\s+(const|let|var)\s+\w*HEADER/iu, 'the header constant is not exported');
});

test('AIT-625 structural: the scanner sees code a regex comment stripper would eat, and computed references', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ait-625-scan-')), probe = join(dir, 'probe.js');
  try {
    for (const [source, expected] of [
      ["const a = '//'; fetch('/api');", 'fetch reference'], ["const u = 'http://x/'; globalThis.fetch(u);", 'fetch reference'],
      ["const f = globalThis['fe' + 'tch'];", 'computed access on globalThis'], ["const f = view.document.defaultView[name];", 'computed access on defaultView'],
      ["const h = { 'x\\x2daithema-session-token': t };", 'owner header prefix'], ["const f = Reflect.get(globalThis, k);", 'Reflect.get'],
      ['const h = `x-aithema-${"session"}`;', 'owner header prefix'], ["/* fetch() */ const ok = 1; // fetch()", null],
    ]) {
      writeFileSync(probe, source);
      const found = offenders(probe, 'probe');
      if (expected) assert.ok(found.includes(`probe: ${expected}`), `${source} → ${found}`); else assert.deepEqual(found, [], source);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AIT-625 structural: each browser voice relay keeps its own guard and calls its transport once', () => {
  for (const path of RELAYS) {
    const text = readFileSync(join(ROOT, path), 'utf8');
    assert.equal(text.match(/\brequest\(/gu)?.length, 1, `${path} sends through one call`);
    assert.match(text, /redirect: 'error'/u, `${path} refuses redirects`);
    assert.match(text, /view\.origin/u, `${path} checks the document's actual origin`);
    assert.deepEqual(offenders(join(ROOT, path), path).filter(found => !/: fetch reference$/u.test(found)), [], `${path} names no owner header`);
  }
  assert.equal(readFileSync(join(ROOT, RELAYS[0]), 'utf8'), readFileSync(join(ROOT, RELAYS[1]), 'utf8'), 'the two relay copies stay identical');
});

test('AIT-625 r2 docs: no embedding example sends the owner header through a direct fetch', () => {
  const found = [];
  for (const doc of ['README.md', 'docs/embedding.md']) {
    const text = readFileSync(join(ROOT, doc), 'utf8');
    for (const [, block] of text.matchAll(/```(?:js|javascript)\n([\s\S]*?)```/gu)) {
      const file = ts.createSourceFile('example.js', block, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const visit = node => {
        if (ts.isCallExpression(node) && /(^|\.)fetch$/u.test(node.expression.getText(file)) && /x-aithema-session-token|sessionToken/iu.test(node.getText(file)))
          found.push(`${doc}: ${node.getText(file).slice(0, 60)}`);
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
  }
  assert.deepEqual(found, [], 'examples use the guarded ownerFetch helper');
});

// Runtime guard: reading fetch (directly, through an alias, or computed) from anywhere but the
// helper is recorded and gets a function that throws, on the global and on the page window.
function guardFetch(t, respond, views = []) {
  const strays = [], calls = [];
  const impl = async (url, init = {}) => { calls.push({ url, init }); return respond(url, init); };
  for (const target of [globalThis, ...views]) {
    const original = Object.getOwnPropertyDescriptor(target, 'fetch');
    Object.defineProperty(target, 'fetch', { configurable: true, get() {
      const caller = new Error().stack.split('\n')[2] ?? '';
      if (/\/src\/owner-request\.js:/u.test(caller)) return impl;
      strays.push(caller.trim());
      return () => { throw new Error('fetch outside the owner-request helper'); };
    } });
    t.after(() => { if (original) Object.defineProperty(target, 'fetch', original); else delete target.fetch; });
  }
  return { calls, strays };
}

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
  await assert.rejects(ownerFetch({ origin: 'null', location: { origin: 'null', protocol: 'https:', href: 'https://x/' }, document: { baseURI: 'https://x/' } }, '/a', {}), /page origin/u, 'opaque origin');
  // An about:srcdoc/about:blank child inherits its parent's origin but is not an owner page.
  await assert.rejects(ownerFetch({ origin: 'http://app.test', location: { origin: 'http://app.test', protocol: 'about:', href: 'about:srcdoc' }, document: { baseURI: 'http://app.test/' } }, '/a', {}), /page origin/u, 'srcdoc');
  assert.equal(calls.length, 0);
});

test('AIT-625 r2 helper: the document\'s actual origin decides, not its URL (a sandboxed HTTPS document sends nothing)', async t => {
  const { ownerFetch } = await helper();
  const calls = stubFetch(t);
  const location = { origin: 'https://app.test', protocol: 'https:', href: 'https://app.test/' }, document = { baseURI: 'https://app.test/' };
  // A sandboxed iframe (no allow-same-origin) keeps its https URL, but window.origin is "null".
  await assert.rejects(ownerFetch({ origin: 'null', location, document }, '/api/sessions/s1', { sessionToken: 'tok' }), /page origin/u, 'sandboxed');
  await assert.rejects(ownerFetch({ location, document }, '/api/sessions/s1', { sessionToken: 'tok' }), /page origin/u, 'no window.origin');
  // window.origin is what counts: a URL origin that differs from it is not the page origin.
  await assert.rejects(ownerFetch({ origin: 'https://other.test', location, document }, 'https://app.test/api/sessions/s1', { sessionToken: 'tok' }), /same origin/u, 'URL vs real origin');
  assert.equal(calls.length, 0);
  assert.equal(page('http://app.test/x').origin, 'http://app.test', 'the fixture page exposes window.origin');
});

test('AIT-625 r2 helper: without AbortSignal.any the signals are still combined', async () => {
  const { anySignal } = await helper();
  const a = new AbortController(), b = new AbortController(), combined = anySignal([a.signal, b.signal], undefined);
  assert.equal(combined.aborted, false); b.abort(new Error('second')); assert.equal(combined.aborted, true); assert.equal(combined.reason.message, 'second');
  const early = new AbortController(); early.abort(new Error('early'));
  assert.equal(anySignal([new AbortController().signal, early.signal], undefined).reason.message, 'early');
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

test('AIT-625 helper: for a stream (events) the deadline covers the response headers only, so the body keeps flowing', async t => {
  const { ownerFetch } = await helper();
  const origin = await listen(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' }); response.write('a');
    setTimeout(() => response.end('b'), 250);
  });
  const response = await ownerFetch(page(`${origin}/`), '/api/sessions/s1/events', { deadline: 100, stream: true });
  assert.equal(await response.text(), 'ab');
});

test('AIT-625 r2 helper (real HTTP): a finite request whose body stalls after the headers ends at the deadline', async t => {
  const { ownerFetch } = await helper();
  const origin = await listen(t, (request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"partial":'); });
  const started = performance.now();
  const stalled = await ownerFetch(page(`${origin}/`), '/api/sessions/s1/turns', { method: 'POST', body: '{}', deadline: 150 });
  await assert.rejects(stalled.json(), error => error.name === 'TimeoutError');
  assert.ok(performance.now() - started < 5_000);
  // A complete finite body is read under the deadline and still reads normally.
  const whole = await listen(t, (request, response) => response.end(JSON.stringify({ ok: 1 })));
  const response = await ownerFetch(page(`${whole}/`), '/api/x', { deadline: 1_000 });
  assert.deepEqual(await response.json(), { ok: 1 }); assert.equal(response.status, 200);
});

test('AIT-625 r2 helper: a stalled body that ignores the signal still ends at the deadline', async t => {
  const { ownerFetch } = await helper();
  stubFetch(t, () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } })));
  await assert.rejects((await ownerFetch(page(), '/api/sessions/s1/turns', { deadline: 50 })).text(), error => error.name === 'TimeoutError');
  stubFetch(t, () => new Response(null, { status: 204 }));
  assert.equal((await ownerFetch(page(), '/api/x', {})).status, 204);
});

// One page for the element tests: the custom element registers once per module graph.
let elementWindow;
function elementPage() {
  if (elementWindow) return elementWindow;
  elementWindow = page('http://app.test/');
  for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = elementWindow[key];
  after(() => elementWindow.happyDOM.close());
  return elementWindow;
}

test('AIT-625 element: same-origin session requests carry the guard; a foreign <base> stops every one; a stalled turn body ends (r2)', async t => {
  const { createSession } = await import('@inspr/aithema-core');
  const { en } = await import('../src/i18n/en.js');
  const window = elementPage();
  // Runtime guard (r2): only the helper may read fetch, on the global or on the page window.
  const stalled = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }));
  const { calls, strays } = guardFetch(t, (url, init) => String(url).endsWith('/events') ? new Response(new ReadableStream({ start() {} }))
    : String(url).endsWith('/turns') ? stalled()
    : String(url).endsWith('/locale') && init.method === 'POST' ? Response.json({ error: 'session-not-found' }, { status: 404 }) : Response.json({}), [window]);
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
  base.remove();
  // r2: a turn whose body stalls after the headers ends at the deadline; the existing error path
  // re-enables the composer and keeps the statement.
  const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
  const component = window.document.createElement('aithema-session'), session = createSession({ demo: true });
  session.featureMatrix = { best: { text: { available: true, reason: null }, analysis: { available: true, reason: null } } };
  component.configure({ copy: structuredClone(en), session, sessionToken: 'tok' });
  window.document.body.append(component); await tick();
  t.after(() => component.remove());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = component.shadowRoot, send = root.querySelector('.send');
  root.querySelector('textarea').value = 'A statement whose reply stalls';
  root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true })); await tick();
  assert.ok(calls.some(call => String(call.url).endsWith('/turns')), 'the turn was sent');
  assert.equal(send.disabled, true, 'the composer waits while the turn is in flight');
  t.mock.timers.tick(30_000); await tick();
  assert.equal(send.disabled, false, 'the deadline ended the stalled body and the composer is enabled again');
  assert.equal(root.querySelector('textarea').value, 'A statement whose reply stalls', 'the unsent statement is kept');
  assert.deepEqual(strays, [], 'nothing but the helper read fetch');
});

