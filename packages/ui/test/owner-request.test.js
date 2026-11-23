// AIT-625: every client request that can carry the owner credential goes through ONE guarded
// helper. It fails closed without a page origin, resolves the URL once against the document base,
// sends exactly that URL with redirect:'error' and a deadline, and is the only code that names the
// owner header or calls fetch.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import './fixtures/page-origin.js';
import ts from 'typescript';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const HELPER = 'owner-request.js';
const HEADER = 'x-aithema-session-token';
const helper = () => import('../src/owner-request.js');
// The browser voice relay forwards host credentials too; since r6 (gate3c M1) its browser
// requests go through the injected helper, with no check of its own.
const RELAYS = ['packages/server/src/composed/network-client.js', 'plugins/composed-voice/src/network-client.js'];

function sources(dir = SRC) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : name.endsWith('.js') ? [path] : [];
  });
}
// A real JavaScript parse (typescript, already a devDependency): comments are trivia, so a `//`
// inside a string cannot hide code, and string values arrive with their escapes decoded.
function parse(path, source = readFileSync(path, 'utf8')) {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}
function walkAst(node, visit) {
  visit(node);
  ts.forEachChild(node, child => walkAst(child, visit));
}
function staticString(node) {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return staticString(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(node.left), right = staticString(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
}
function offenders(path, label = path, approvedFetch, file = parse(path)) {
  const found = new Set();
  const globals = new Set(['globalThis', 'window', 'self', 'top', 'parent', 'frames', 'view', 'defaultView', 'navigator', 'Reflect']);
  const NETWORK = new Set(['fetch', 'XMLHttpRequest', 'setRequestHeader', 'Headers', 'sendBeacon', 'EventSource', 'WebSocket', 'eval', 'Function']);
  const literal = node => ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isRegularExpressionLiteral(node);
  const receiver = node => ts.isParenthesizedExpression(node) ? receiver(node.expression) :
    ts.isPropertyAccessExpression(node) ? node.name.text : ts.isIdentifier(node) ? node.text : undefined;
  const aliases = [];
  walkAst(file, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) aliases.push([node.name.text, receiver(node.initializer)]);
  });
  for (let size = 0; size !== globals.size;) {
    size = globals.size;
    for (const [name, source] of aliases) if (globals.has(source)) globals.add(name);
  }
  walkAst(file, node => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      if (NETWORK.has(node.text) && !(node.text === 'fetch' && approvedFetch?.(node))) found.add(`${label}: ${node.text} reference`);
    }
    else if (literal(node)) {
      const value = node.text;
      if (/x-aithema-/iu.test(value) && value !== 'x-aithema-now') found.add(`${label}: owner header prefix`);
      if (/session[-_\s]*token$/iu.test(value)) found.add(`${label}: owner header suffix`);
      if (value === 'fetch') found.add(`${label}: fetch in a string`);
    } else if (ts.isElementAccessExpression(node)) {
      // A computed property on a global or a window (`globalThis['fe' + 'tch']`) can name anything.
      const target = receiver(node.expression), key = staticString(node.argumentExpression);
      if (globals.has(target)) found.add(`${label}: computed access on ${target}`);
      else if (NETWORK.has(key)) found.add(`${label}: computed ${key} reference`);
    } else if (ts.isBindingElement(node) && node.propertyName && ts.isComputedPropertyName(node.propertyName)) {
      const initializer = node.parent.parent.initializer;
      if (initializer && globals.has(receiver(initializer))) found.add(`${label}: computed binding on ${receiver(initializer)}`);
    } else if (ts.isPropertyAccessExpression(node) && node.name.text === 'get' && node.expression.getText(file) === 'Reflect') found.add(`${label}: Reflect.get`);
  });
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

test('AIT-625 structural: each browser voice relay sends through the injected helper; only the server transport is its own', () => {
  for (const path of RELAYS) {
    const text = readFileSync(join(ROOT, path), 'utf8');
    assert.equal(text.match(/\brequest\(/gu)?.length, 1, `${path} has one server-side transport call`);
    assert.match(text, /redirect: 'error'/u, `${path} refuses redirects on the server-side transport`);
    // r6 (gate3c M1): the browser path is the helper, not a parallel copy of its checks.
    assert.equal(text.match(/\bownerFetch\(/gu)?.length, 1, `${path} sends browser requests through the helper once`);
    assert.doesNotMatch(text, /view\.origin|baseURI|new URL\(/u, `${path} carries no origin check of its own`);
    // r7 (gate4c M2): the relay names the owner header once, only to map a host header into the
    // helper's sessionToken option (network-relay.test.js proves it never leaves as a raw header).
    assert.equal(text.match(/x-aithema-session-token/giu)?.length, 1, `${path} names the owner header once, for the mapping`);
    assert.match(text, /const OWNER_HEADER = 'x-aithema-session-token';/u, `${path} keeps it in the one mapping constant`);
    assert.deepEqual(offenders(join(ROOT, path), path).filter(found => !/: (fetch reference|owner header prefix|owner header suffix)$/u.test(found)), [], `${path} has no other network or owner-header finding`);
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
  // r4 (gate2c Low): null, not undefined, so the default AbortSignal.any is not selected.
  const a = new AbortController(), b = new AbortController(), combined = anySignal([a.signal, b.signal], null);
  assert.equal(combined.aborted, false); b.abort(new Error('second')); assert.equal(combined.aborted, true); assert.equal(combined.reason.message, 'second');
  const early = new AbortController(); early.abort(new Error('early'));
  assert.equal(anySignal([new AbortController().signal, early.signal], null).reason.message, 'early');
});

test('AIT-625 r4 helper: the fallback really runs when the runtime has no AbortSignal.any', async t => {
  const { anySignal } = await helper();
  const native = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
  let nativeCalls = 0;
  // A spy proves the fallback path ran: the native combinator is never reached.
  Object.defineProperty(AbortSignal, 'any', { configurable: true, writable: true, value: undefined });
  t.after(() => { if (native) Object.defineProperty(AbortSignal, 'any', native); else delete AbortSignal.any; });
  const a = new AbortController(), b = new AbortController(), combined = anySignal([a.signal, b.signal], AbortSignal.any);
  assert.equal(AbortSignal.any, undefined, 'premise: no native AbortSignal.any');
  a.abort(new Error('first')); assert.equal(combined.aborted, true); assert.equal(combined.reason.message, 'first');
  if (native) { AbortSignal.any = (...args) => { nativeCalls++; return native.value.apply(AbortSignal, args); }; }
  anySignal([new AbortController().signal], null);
  assert.equal(nativeCalls, 0, 'the fallback never calls the native combinator');
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

// r4 (gate2c M3): only a SUCCESSFUL event stream leaves its body to the caller's signal.
const pendingAfter = (promise, ms) => Promise.race([promise, new Promise((resolve, reject) => {
  setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms).unref?.();
})]);
test('AIT-625 r4 helper: an event stream answered with an error keeps its body under the deadline', async t => {
  const { ownerFetch } = await helper();
  stubFetch(t, () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }), { status: 404 }));
  // r8: a finite body is buffered natively inside the helper, so the stall rejects ownerFetch itself.
  await assert.rejects(pendingAfter(ownerFetch(page(), '/api/sessions/s1/events', { deadline: 50, stream: true }), 2_000), error => error.name === 'TimeoutError');
});

test('AIT-625 r2 helper (real HTTP): a finite request whose body stalls after the headers ends at the deadline', async t => {
  const { ownerFetch } = await helper();
  const origin = await listen(t, (request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"partial":'); });
  const started = performance.now();
  // r8: the body is buffered inside the helper, so the stall rejects ownerFetch itself.
  await assert.rejects(ownerFetch(page(`${origin}/`), '/api/sessions/s1/turns', { method: 'POST', body: '{}', deadline: 150 }), error => error.name === 'TimeoutError');
  assert.ok(performance.now() - started < 5_000);
  // A complete finite body is read under the deadline and still reads normally.
  const whole = await listen(t, (request, response) => response.end(JSON.stringify({ ok: 1 })));
  const response = await ownerFetch(page(`${whole}/`), '/api/x', { deadline: 1_000 });
  assert.deepEqual(await response.json(), { ok: 1 }); assert.equal(response.status, 200);
});

test('AIT-625 r2 helper: a stalled body that ignores the signal still ends at the deadline', async t => {
  const { ownerFetch } = await helper();
  stubFetch(t, () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } })));
  await assert.rejects(ownerFetch(page(), '/api/sessions/s1/turns', { deadline: 50 }), error => error.name === 'TimeoutError');
  stubFetch(t, () => new Response(null, { status: 204 }));
  assert.equal((await ownerFetch(page(), '/api/x', {})).status, 204);
});

// r8 (gate5c M3): a finite body is buffered natively (no wrapper stream); onSettled fires once when
// the buffer completes, before the caller gets the response; the body is bounded by maxBytes.
test('AIT-625 r8 helper: a finite body is complete and settled once when ownerFetch resolves', async t => {
  const { ownerFetch } = await helper();
  let settled = 0;
  stubFetch(t, () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"ok":')); setTimeout(() => { controller.enqueue(new TextEncoder().encode('1}')); controller.close(); }, 20); } }), { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json', 'x-kept': 'yes' } }));
  const response = await ownerFetch(page(), '/api/x', { onSettled: () => settled++ });
  assert.equal(settled, 1, 'settled when the native buffer completed, before the caller reads');
  assert.equal(response.status, 200); assert.equal(response.statusText, 'OK'); assert.equal(response.headers.get('x-kept'), 'yes');
  assert.deepEqual(await response.json(), { ok: 1 });
  assert.equal(settled, 1, 'onSettled once');
  // A null-body status keeps a null body.
  stubFetch(t, () => new Response(null, { status: 204 }));
  const empty = await ownerFetch(page(), '/api/x', { onSettled: () => settled++ });
  assert.equal(empty.status, 204); assert.equal(empty.body, null); assert.equal(settled, 2);
});

test('AIT-625 r8 helper: a body above maxBytes is refused before buffering when Content-Length says so', async t => {
  const { ownerFetch, OWNER_RESPONSE_MAX_BYTES } = await helper();
  assert.ok(Number.isSafeInteger(OWNER_RESPONSE_MAX_BYTES) && OWNER_RESPONSE_MAX_BYTES > 0, 'a stated default bound');
  let pulled = 0, cancelled = 0, settled = 0;
  stubFetch(t, () => new Response(new ReadableStream({
    pull(controller) { pulled += 1024; controller.enqueue(new Uint8Array(1024)); },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 }), { headers: { 'content-length': String(OWNER_RESPONSE_MAX_BYTES + 1) } }));
  await assert.rejects(ownerFetch(page(), '/api/x', { onSettled: () => settled++ }), error => error.name === 'RangeError');
  assert.equal(pulled, 0, 'nothing buffered: refused from the header');
  assert.equal(cancelled, 1, 'the unread body is cancelled');
  assert.equal(settled, 1, 'onSettled once');
  // A per-call maxBytes refuses the same way.
  stubFetch(t, () => new Response(new Uint8Array(10), { headers: { 'content-length': '10' } }));
  await assert.rejects(ownerFetch(page(), '/api/x', { maxBytes: 9, onSettled: () => settled++ }), error => error.name === 'RangeError');
  assert.equal(settled, 2);
  stubFetch(t, () => new Response(new Uint8Array(10), { headers: { 'content-length': '10' } }));
  assert.equal((await (await ownerFetch(page(), '/api/x', { maxBytes: 10 })).arrayBuffer()).byteLength, 10, 'at the bound it is accepted');
});

test('AIT-625 r8 helper: without Content-Length a body above maxBytes is rejected and never returned', async t => {
  const { ownerFetch } = await helper();
  let settled = 0;
  stubFetch(t, () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(6)); controller.enqueue(new Uint8Array(6)); controller.close(); } })));
  await assert.rejects(ownerFetch(page(), '/api/x', { maxBytes: 8, onSettled: () => settled++ }), error => error.name === 'RangeError');
  assert.equal(settled, 1, 'onSettled once');
});

test('AIT-625 r8 helper: the export raises the bound to its derived maximum; nothing else does', async () => {
  const source = readFileSync(new URL('../src/session-element.js', import.meta.url), 'utf8');
  const { OWNER_EXPORT_MAX_BYTES, OWNER_RESPONSE_MAX_BYTES } = await helper();
  assert.ok(OWNER_EXPORT_MAX_BYTES > OWNER_RESPONSE_MAX_BYTES);
  assert.match(source, /\/export`, \{ sessionToken: this\.#sessionToken, maxBytes: OWNER_EXPORT_MAX_BYTES \}/u);
  assert.equal(source.match(/maxBytes/gu).length, 1, 'only the export call raises the bound');
});

// One page for the element tests: the custom element registers once per module graph.
// r4: the page closes after the file's last test. Registered inside a test, the hook ran when
// that first element test ended, so every later element test met a closed page.
let elementWindow;
after(() => elementWindow?.happyDOM.close());
function elementPage() {
  if (elementWindow) return elementWindow;
  elementWindow = page('http://app.test/');
  for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = elementWindow[key];
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

// r4 (gate2c M3): a /events 404 whose body stalls settles at the deadline and the stream reconnects.
test('AIT-625 r4 element: a stalled /events error body ends at the deadline and reconnecting continues', async t => {
  const { createSession } = await import('@inspr/aithema-core');
  const { en } = await import('../src/i18n/en.js');
  const window = elementPage();
  const stalled = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }), { status: 404 });
  const { calls, strays } = guardFetch(t, url => String(url).endsWith('/events') ? stalled() : Response.json({}), [window]);
  await import('../src/session-element.js');
  const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const component = window.document.createElement('aithema-session');
  component.configure({ copy: structuredClone(en), session: createSession({ demo: true }), sessionToken: 'tok' });
  window.document.body.append(component); await tick();
  t.after(() => component.remove());
  const events = () => calls.filter(call => String(call.url).endsWith('/events')).length;
  assert.equal(events(), 1, 'the event stream was requested');
  t.mock.timers.tick(30_000); await tick();
  t.mock.timers.tick(1_000); await tick();
  assert.equal(events(), 2, 'the stalled error body ended at the deadline and the stream reconnected');
  assert.deepEqual(strays, [], 'nothing but the helper read fetch');
});

// r4 (gate2c M4): erasure aborts a finite request until its body is consumed, not only until headers.
test('AIT-625 r4 element: erasure during an export body read aborts it and starts no download', async t => {
  const { createSession } = await import('@inspr/aithema-core');
  const { en } = await import('../src/i18n/en.js');
  const window = elementPage();
  let held;
  const { calls } = guardFetch(t, url => String(url).endsWith('/events') ? new Response(new ReadableStream({ start() {} }))
    : String(url).endsWith('/export') ? new Response(new ReadableStream({ start(controller) { held = controller; controller.enqueue(new Uint8Array([80, 75])); } }))
      : Response.json({}), [window]);
  const downloads = t.mock.method(URL, 'createObjectURL', () => 'blob:fixture');
  t.mock.method(URL, 'revokeObjectURL', () => {});
  await import('../src/session-element.js');
  const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
  const component = window.document.createElement('aithema-session');
  component.configure({ copy: structuredClone(en), session: createSession({ demo: true }), sessionToken: 'tok' });
  window.document.body.append(component); await tick();
  t.after(() => component.remove());
  component.shadowRoot.querySelector('.export').click(); await tick();
  assert.ok(calls.some(call => String(call.url).endsWith('/export')), 'the export was requested');
  assert.ok(held, 'the export body is being read');
  component.receive({ seq: component.session.seq + 1, type: 'session.erased', data: { at: '2026-11-22T12:00:00.000Z' } }); await tick();
  try { held.enqueue(new Uint8Array([3, 4])); held.close(); } catch { /* the aborted read already cancelled the body */ }
  await tick();
  assert.equal(downloads.mock.callCount(), 0, 'an erased conversation starts no download');
});

// r4 (gate2c M2): the cookie-authenticated export link is resolved through the same origin check.
test('AIT-625 r4 element: in cookie mode a foreign <base> yields no export link; the same-origin link is absolute', async t => {
  const { createSession } = await import('@inspr/aithema-core');
  const { en } = await import('../src/i18n/en.js');
  const window = elementPage();
  guardFetch(t, url => String(url).endsWith('/events') ? new Response(new ReadableStream({ start() {} })) : Response.json({}), [window]);
  await import('../src/session-element.js');
  const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
  const mount = async () => {
    const component = window.document.createElement('aithema-session');
    component.configure({ copy: structuredClone(en), session: createSession({ demo: true }) });
    window.document.body.append(component); await tick();
    t.after(() => component.remove());
    return component;
  };
  const links = component => ['.export', '.composer-out__export'].map(selector => component.shadowRoot.querySelector(selector));
  const same = await mount();
  // r6 (gate3c M2): no navigable href in any mode (the r4 absolute href is gone).
  for (const link of links(same)) assert.equal(link.hasAttribute('href'), false, link.className);
  const base = window.document.createElement('base'); base.href = 'https://evil.example/'; window.document.head.append(base);
  t.after(() => base.remove());
  // A base added later leaves nothing to re-point.
  for (const link of links(same)) assert.equal(link.hasAttribute('href'), false, link.className);
  const foreign = await mount();
  for (const link of links(foreign)) {
    assert.equal(link.hasAttribute('href'), false, `${link.className}: no link to a foreign origin`);
  }
  assert.equal(foreign.shadowRoot.querySelector('.export').getAttribute('aria-disabled'), 'true');
});

// r6 (gate3c M4): the helper releases the erasure controller at the body's end, before blob()
// resolves; erasure keeps the session id, so the export must check the erasure state itself.
test('AIT-625 r6 element: erasure between the export body end and blob() resolving starts no download', async t => {
  const { createSession } = await import('@inspr/aithema-core');
  const { en } = await import('../src/i18n/en.js');
  const window = elementPage();
  const { calls } = guardFetch(t, url => String(url).endsWith('/events') ? new Response(new ReadableStream({ start() {} }))
    : String(url).endsWith('/export') ? new Response('PK-fixture', { headers: { 'content-type': 'application/zip' } }) : Response.json({}), [window]);
  const downloads = t.mock.method(URL, 'createObjectURL', () => 'blob:fixture');
  t.mock.method(URL, 'revokeObjectURL', () => {});
  await import('../src/session-element.js');
  const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
  const component = window.document.createElement('aithema-session');
  component.configure({ copy: structuredClone(en), session: createSession({ demo: true }), sessionToken: 'tok' });
  window.document.body.append(component); await tick();
  t.after(() => component.remove());
  const blob = Response.prototype.blob;
  let gap = 0;
  // The body is fully read (the helper has settled) when the erasure lands; blob() resolves after it.
  t.mock.method(Response.prototype, 'blob', async function () {
    const value = await blob.call(this); gap++;
    component.receive({ seq: component.session.seq + 1, type: 'session.erased', data: { at: '2026-11-22T12:00:00.000Z' } });
    return value;
  });
  component.shadowRoot.querySelector('.export').click(); await tick();
  assert.ok(calls.some(call => String(call.url).endsWith('/export')), 'the export was requested');
  assert.equal(gap, 1, 'the erasure landed after the body was consumed');
  assert.equal(component.hasAttribute('data-aithema-erased'), true, 'the conversation is erased');
  assert.equal(downloads.mock.callCount(), 0, 'no object URL and no download after erasure');
});

// r6 (gate3c M2): no owner-credential export request outside the helper, in cookie mode too.
// Neither export control exposes a navigable href (middle click, open in new tab, drag and
// keyboard would bypass a click handler); both export only through #export().
test('AIT-625 r6 element: cookie mode exports through the helper only; no export control has an href', async t => {
  const { createSession } = await import('@inspr/aithema-core');
  const { en } = await import('../src/i18n/en.js');
  const window = elementPage();
  let redirecting = false;
  const { calls, strays } = guardFetch(t, (url, init) => String(url).endsWith('/events') ? new Response(new ReadableStream({ start() {} }))
    : String(url).endsWith('/export') ? (redirecting && init.redirect === 'error' ? Promise.reject(new TypeError('redirect mode is set to error'))
      : new Response('PK-cookie', { headers: { 'content-type': 'application/zip' } }))
      : Response.json({}), [window]);
  const blobs = [];
  t.mock.method(URL, 'createObjectURL', value => { blobs.push(value); return 'blob:cookie-fixture'; });
  t.mock.method(URL, 'revokeObjectURL', () => {});
  const downloaded = [], nativeClick = window.HTMLAnchorElement.prototype.click;
  t.mock.method(window.HTMLAnchorElement.prototype, 'click', function () {
    if (this.download) downloaded.push({ href: this.href, download: this.download }); else nativeClick.call(this);
  });
  await import('../src/session-element.js');
  const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
  const mount = async () => {
    const component = window.document.createElement('aithema-session');
    component.configure({ copy: structuredClone(en), session: createSession({ demo: true }) });
    window.document.body.append(component); await tick();
    t.after(() => component.remove());
    return component;
  };
  const controls = component => ['.export', '.composer-out__export'].map(selector => component.shadowRoot.querySelector(selector));
  const exports = () => calls.filter(call => String(call.url).endsWith('/export'));
  const activate = async (control, how = 'click') => {
    const event = how === 'click' ? new window.MouseEvent('click', { bubbles: true, cancelable: true }) : new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    control.dispatchEvent(event); await tick();
    return event;
  };
  const same = await mount();
  for (const control of controls(same)) {
    assert.equal(control.hasAttribute('href'), false, `${control.className}: no navigable href`);
    assert.equal(control.getAttribute('role'), 'link', `${control.className}: keeps the link role`);
    assert.equal(control.tabIndex, 0, `${control.className}: keyboard reachable`);
  }
  const [footer, composer] = controls(same);
  assert.equal((await activate(footer)).defaultPrevented, true, 'the footer click is handled, not navigated');
  assert.equal(exports().length, 1, 'exactly one export request');
  assert.equal(exports()[0].url, `http://app.test/api/sessions/${same.session.id}/export`);
  assert.equal(exports()[0].init.redirect, 'error'); assert.ok(exports()[0].init.signal instanceof AbortSignal);
  assert.equal(new Headers(exports()[0].init.headers).get(HEADER), null, 'cookie mode names no owner header');
  assert.deepEqual(downloaded, [{ href: 'blob:cookie-fixture', download: 'aithema-session.zip' }]);
  assert.equal(await blobs[0].text(), 'PK-cookie', 'the download is the fetched blob');
  await activate(composer);
  assert.equal(exports().length, 2, 'the composer export goes through the helper too');
  assert.equal(downloaded.length, 2);
  await activate(footer, 'Enter');
  assert.equal(exports().length, 3, 'Enter activates the footer export');
  assert.equal(downloaded.length, 3);
  redirecting = true;
  await activate(footer);
  assert.equal(exports().length, 4, 'the redirecting export was requested once');
  assert.equal(exports()[3].init.redirect, 'error');
  assert.equal(downloaded.length, 3, 'a redirected export is rejected and downloads nothing');
  redirecting = false;
  const base = window.document.createElement('base'); base.href = 'https://evil.example/'; window.document.head.append(base);
  t.after(() => base.remove());
  const foreign = await mount(), before = calls.length;
  for (const control of controls(foreign)) { assert.equal(control.hasAttribute('href'), false); await activate(control); }
  assert.equal(calls.length, before, 'a foreign <base> sends zero requests');
  assert.equal(downloaded.length, 3);
  assert.equal(foreign.shadowRoot.querySelector('.export').getAttribute('aria-disabled'), 'true');
  assert.deepEqual(strays, [], 'nothing but the helper read fetch');
});

// Keep the inventory tied to both first-party asset mounts. The qualification
// handler runs first and maps its /composed scripts to the ops directory.
const QUALIFICATION = 'plugins/composed-voice/ops';
function regexp(node) {
  const end = node.text.lastIndexOf('/');
  return new RegExp(node.text.slice(1, end), node.text.slice(end + 1));
}
function servedPattern() {
  const demo = parse(join(ROOT, 'demo/server.js'));
  const qualification = parse(join(ROOT, QUALIFICATION, 'qualification-server.mjs'));
  let demoAssets, qualificationAssets, qualificationScripts;
  walkAst(demo, node => {
    if (ts.isRegularExpressionLiteral(node) && node.text.includes(String.raw`demo\/(?:index\.html`)) demoAssets = regexp(node);
  });
  walkAst(qualification, node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(qualification) === 'asset' && ts.isRegularExpressionLiteral(node.initializer)) {
      qualificationAssets = regexp(node.initializer);
    }
    if (ts.isArrayLiteralExpression(node) && node.elements.some(element =>
      ts.isStringLiteral(element) && /^\/composed\/[\w-]+\.js$/u.test(element.text))) {
      assert.ok(node.elements.every(ts.isStringLiteral), 'qualification script URLs are explicit');
      qualificationScripts = new Set(node.elements.map(element => QUALIFICATION + element.text.slice('/composed'.length)));
    }
  });
  assert.ok(demoAssets && qualificationAssets && qualificationScripts, 'both mounts expose their browser assets to the scan');
  return path => demoAssets.test('/' + path) || qualificationAssets.test('/' + path) || qualificationScripts.has(path);
}
const SERVED_ROOTS = ['demo', 'plugins', 'packages/server/src', 'packages/core/src', 'packages/ui/src'];
const sourceLabel = (root, path) => relative(root, path).split('\\').join('/');
function servedModules(root, isServed) {
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ['node_modules', 'test', 'fixtures'].includes(entry.name) ? [] : walk(path);
    return /\.(?:[cm]?js|html)$/u.test(entry.name) && isServed(sourceLabel(root, path)) ? [path] : [];
  });
  return SERVED_ROOTS.flatMap(dir => {
    try { return walk(join(root, dir)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  });
}
function omitsCredentials(call) {
  const options = call.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return false;
  // A later spread, computed key or duplicate can override credentials.
  for (const property of [...options.properties].reverse()) {
    if (ts.isSpreadAssignment(property) || ts.isComputedPropertyName(property.name)) return false;
    if (property.name.text === 'credentials') return ts.isPropertyAssignment(property) && staticString(property.initializer) === 'omit';
  }
  return false;
}

const OPERATOR_PATH = /\/api\/operator(?:[/?#]|$)/u;
const OPERATOR_ACTIONS = 'packages/ui/src/operator-actions.js';
function memberName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) return staticString(node.argumentExpression);
  if (ts.isIdentifier(node)) return node.text;
}
function importedGuards(file, label) {
  const guards = new Map();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const path = specifier.startsWith('/') ? specifier.slice(1) : posix.normalize(posix.join(posix.dirname(label), specifier));
    const expected = path === 'packages/ui/src/owner-request.js' ? ['ownerFetch', 'ownerURL'] : path === 'packages/ui/src/post-json.js' ? ['postJson'] : [];
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const entry of bindings.elements) {
      const name = (entry.propertyName ?? entry.name).text;
      if (expected.includes(name)) guards.set(entry.name.text, name === 'postJson' ? 0 : 1);
    }
  }
  return guards;
}
function nativeOperatorRoutes(file, label) {
  const found = new Set(), guards = importedGuards(file, label);
  walkAst(file, node => {
    const value = ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) ? node.text : staticString(node);
    if (!value || !OPERATOR_PATH.test(value)) return;
    let arg = node;
    while (ts.isBinaryExpression(arg.parent) && arg.parent.operatorToken.kind === ts.SyntaxKind.PlusToken ||
      ts.isParenthesizedExpression(arg.parent) || ts.isTemplateSpan(arg.parent) || ts.isTemplateExpression(arg.parent)) arg = arg.parent;
    const parent = arg.parent;
    if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.arguments[guards.get(parent.expression.text)] === arg) return;
    if (label === OPERATOR_ACTIONS && ts.isVariableDeclaration(parent) && parent.initializer === arg &&
      (parent.name.getText(file) === 'operatorLoginRoute' && value === '/api/operator/login/' ||
        parent.name.getText(file) === 'operatorLogoutRoute' && value === '/api/operator/logout/')) return;
    found.add(`${label}: operator route outside the guarded helper`);
  });
  return [...found];
}
function nativeActions(file, label) {
  const findings = new Set();
  const formMember = name => ['action', 'formaction'].includes(name?.toLowerCase());
  const safePaimosForm = node => {
    if (label !== 'packages/ui/src/session-element.js' || !['form.action = action', 'form.submit()'].includes(node.getText(file))) return false;
    let scope = node.parent;
    while (scope && !ts.isMethodDeclaration(scope)) scope = scope.parent;
    return scope?.name.getText(file) === '#createProject';
  };
  // These destinations are checked by consentReturnPath and paimosImportUrl.
  const safeNavigation = new Map([
    ['demo/consent-page.js', 'location.assign(new URL(consentReturnPath(path, location.origin), location.origin).href)'],
    [OPERATOR_ACTIONS, "view.location.assign(new URL('/?operator=signed-out#settings-general', view.origin).href)"],
  ]);
  walkAst(file, node => {
    if (ts.isCallExpression(node) && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))) {
      const called = memberName(node.expression), receiver = memberName(node.expression.expression);
      if ((['submit', 'requestSubmit'].includes(called) || called === 'setAttribute' && formMember(staticString(node.arguments[0]))) && !safePaimosForm(node))
        findings.add(`${label}: native form submission or action`);
      if (receiver === 'location' && ['assign', 'replace'].includes(called) && node.getText(file) !== safeNavigation.get(label))
        findings.add(`${label}: unguarded location navigation`);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))) {
      const target = memberName(node.left), receiver = memberName(node.left.expression);
      if (formMember(target) && receiver !== 'dataset' && !safePaimosForm(node)) findings.add(`${label}: native form action`);
      if (target === 'location' || target === 'href' && receiver === 'location') findings.add(`${label}: unguarded location navigation`);
    }
  });
  return [...findings];
}
function servedJavaScriptOffenders(path, label, source) {
  const file = parse(path, source), relay = RELAYS.includes(label);
  const transport = relay ? 'request' : ['plugins/device/src/index.js', 'packages/core/src/chat-completions.js'].includes(label) ? 'fetchImpl' : null;
  const approvedFetch = node => {
    if (label === 'packages/ui/src/owner-request.js') return true;
    if (relay && ts.isBindingElement(node.parent) && node.parent.propertyName === node && node.parent.name.getText(file) === 'request') return true;
    const callee = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node ? node.parent : node;
    const call = callee.parent;
    return ts.isCallExpression(call) && call.expression === callee && omitsCredentials(call);
  };
  const findings = offenders(path, label, approvedFetch, file).filter(item =>
    !(relay && [`${label}: owner header prefix`, `${label}: owner header suffix`].includes(item)));
  walkAst(file, node => {
    if (transport && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === transport && !omitsCredentials(node))
      findings.push(`${label}: ${transport} must use credentials: 'omit'`);
  });
  return [...new Set([...findings, ...nativeOperatorRoutes(file, label), ...nativeActions(file, label)])];
}
function servedOffenders(root, isServed) {
  return servedModules(root, isServed).flatMap(path => {
    const label = sourceLabel(root, path), source = readFileSync(path, 'utf8');
    const findings = [];
    if (/<(?:form\b[^>]*\saction|(?:button|input)\b[^>]*\sformaction)\s*=/iu.test(source))
      findings.push(`${label}: native form action`);
    if (path.endsWith('.html')) {
      if (OPERATOR_PATH.test(source)) findings.push(`${label}: native operator route`);
      for (const [, script] of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/giu)) findings.push(...servedJavaScriptOffenders(path, label, script));
    } else findings.push(...servedJavaScriptOffenders(path, label, source));
    return findings;
  });
}

test('AIT-625 r7 structural: every browser-served demo and plugin module reaches owner routes only through the helper', t => {
  const pattern = servedPattern(), served = servedModules(ROOT, pattern).map(path => relative(ROOT, path));
  const roots = [...new Set(served.map(path => path.split('/').slice(0, -1).join('/')))].sort();
  t.diagnostic(`scanned roots: ${roots.join(', ')}`);
  for (const expected of ['demo/host.js', 'demo/consent-page.js', 'demo/post-json.js', 'demo/admin-page.js', 'plugins/grok-voice/src/client.js'])
    assert.ok(served.includes(expected), `the scan covers ${expected}`);
  assert.deepEqual(servedOffenders(ROOT, pattern), [], 'browser-served modules send owner requests only through owner-request.js');
  // The scan fails on a native fetch to an owner route in demo/.
  const probe = mkdtempSync(join(tmpdir(), 'ait-625-served-'));
  try {
    mkdirSync(join(probe, 'demo')); mkdirSync(join(probe, 'plugins/device/src'), { recursive: true });
    writeFileSync(join(probe, 'demo/post-json.js'), "export const post = id => fetch(`/api/sessions/${id}/consent`, { method: 'POST' });");
    writeFileSync(join(probe, 'plugins/device/src/index.js'), "export const read = (f = globalThis.fetch) => f('/api/sessions/x');");
    assert.deepEqual(servedOffenders(probe, pattern).sort().filter(finding => /: fetch reference$/u.test(finding)),
      ['demo/post-json.js: fetch reference', 'plugins/device/src/index.js: fetch reference']);
  } finally { rmSync(probe, { recursive: true, force: true }); }
});

for (const [name, source] of [
  ['assembled URL', "export const read = parts => fetch(parts.join('/'));"],
  ['imported URL', "import { route } from './routes.js'; export const read = () => fetch(route);"],
  ['computed transport', 'export const read = (key, route) => globalThis[key](route);'],
  ['aliased computed transport', 'const page = globalThis; export const read = (key, route) => page[key](route);'],
  ['overridden omit', "export const read = (route, init) => fetch(route, { credentials: 'omit', ...init });"],
  ['native POST form', 'export const markup = `<form action="/api/operator/logout/" method="post"></form>`;'],
  ['assembled native form action', 'export const markup = route => `<form method="post" action="${route}"></form>`;'],
  ['imported native form action', "import { route } from './routes.js'; export const go = form => { form.action = route; };"],
  ['native operator navigation', "export const go = () => location.assign('/api/operator/admin/state');"],
  ['imported operator navigation', "import { route } from './routes.js'; export const go = () => location.assign(route);"],
  ['assembled operator navigation', "export const go = () => location.assign('/api/' + 'operator/admin/state');"],
  ['native operator link', 'export const markup = `<a href="/api/operator/admin/state">State</a>`;'],
  ['lookalike guard binding', "import { ownerFetch } from './unrelated.js'; export const go = view => ownerFetch(view, '/api/operator/admin/state');"],
]) test(`AIT-633 served scan rejects ${name}`, () => {
  const probe = mkdtempSync(join(tmpdir(), 'ait-633-served-')), label = 'plugins/device/src/index.js';
  try {
    mkdirSync(join(probe, 'plugins/device/src'), { recursive: true });
    writeFileSync(join(probe, label), source);
    assert.ok(servedOffenders(probe, servedPattern()).some(finding => finding.startsWith(`${label}:`)), label);
  } finally { rmSync(probe, { recursive: true, force: true }); }
});

test('AIT-633 served scan accepts a request whose final options omit credentials', () => {
  const label = 'plugins/device/src/index.js';
  const source = "export const read = (route, init) => fetch(route, { ...init, credentials: 'omit' });";
  assert.deepEqual(servedJavaScriptOffenders(label, label, source), []);
});

test('AIT-633 served scan includes the qualification entry and its relay', () => {
  const paths = servedModules(ROOT, servedPattern()).map(path => relative(ROOT, path));
  for (const label of ['plugins/composed-voice/ops/qualification-page.js', 'plugins/composed-voice/ops/qualification-output-timing.js',
    'plugins/composed-voice/src/network-client.js']) assert.ok(paths.includes(label), label);
  const probe = mkdtempSync(join(tmpdir(), 'ait-633-qualification-'));
  const label = 'plugins/composed-voice/ops/qualification-page.js';
  try {
    mkdirSync(join(probe, 'plugins/composed-voice/ops'), { recursive: true });
    writeFileSync(join(probe, label), 'export const read = route => fetch(route);');
    assert.ok(servedOffenders(probe, servedPattern()).some(finding => finding.startsWith(`${label}:`)), label);
  } finally { rmSync(probe, { recursive: true, force: true }); }
});

test('AIT-625 r7 demo: postJson and the consent page send only through the helper; a foreign <base> sends nothing', async t => {
  const html = readFileSync(join(ROOT, 'demo/consent.html'), 'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/gu, '');
  const at = (base = '') => { const window = new Window({ url: 'http://app.test/consent/?session=s' });
    window.document.write(html.replace('<head>', `<head>${base}`)); t.after(() => window.happyDOM.close()); return window; };
  const own = at(), foreign = at('<base href="https://evil.example/">');
  const { calls, strays } = guardFetch(t, () => Response.json({ error: 'nope' }, { status: 404 }), [own, foreign]);
  const { postJson } = await import('../../../demo/post-json.js');
  await assert.rejects(postJson('/api/sessions', { locale: 'en' }, { view: foreign }), /same origin/u);
  assert.equal(calls.length, 0, 'a foreign <base>: zero owner requests');
  await postJson('/api/sessions', { locale: 'en' }, { view: own });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'http://app.test/api/sessions');
  assert.equal(calls[0].init.redirect, 'error'); assert.equal(calls[0].init.method, 'POST'); assert.ok(calls[0].init.signal instanceof AbortSignal);
  const { mountConsentPage } = await import('../../../demo/consent-page.js');
  const settle = mounting => Promise.race([mounting.catch(() => {}), new Promise(resolve => setTimeout(resolve, 2000))]);
  await settle(mountConsentPage({ document: foreign.document, location: foreign.location, storage: foreign.localStorage, navigate: () => {} }));
  assert.equal(calls.length, 1, 'the consent page on a foreign <base>: zero owner requests');
  await settle(mountConsentPage({ document: own.document, location: own.location, storage: own.localStorage, navigate: () => {} }));
  assert.ok(calls.length > 1, 'the consent page reads through the helper');
  for (const call of calls.slice(1)) { assert.match(call.url, /^http:\/\/app\.test\//u); assert.equal(call.init.redirect, 'error'); }
  assert.deepEqual(strays, [], 'no demo module read fetch itself');
});

// AIT-637 (TICK M1 + L1 on AIT-625): an export control that cannot export looks disabled and says
// why, in both disabled states (no page origin = a foreign <base>; the device preset) and on both
// controls (the footer .export and the composer .composer-out__export). Click, Enter and Space
// send nothing; enabled controls keep main's attributes.
test('AIT-637 element: both disabled states x both controls are muted, described in EN/DE and send nothing', async t => {
  const { createSession } = await import('@inspr/aithema-core');
  const { en } = await import('../src/i18n/en.js');
  const { de } = await import('../src/i18n/de.js');
  const { hostStyles } = await import('../src/host-styles.js');
  const { styles } = await import('../src/styles.js');
  assert.equal(en.exportUnavailable, "Export isn't available on this page.");
  assert.equal(de.exportUnavailable, 'Der Export ist auf dieser Seite nicht verfügbar.');
  assert.notEqual(en.exportUnavailable, de.exportUnavailable, 'AIT-100 B2: EN and DE differ');
  // Style rules: the composer control gets the footer's muted look (no underline, muted ink,
  // cursor default, as it shows no tip); the footer keeps its rule and shows a tip in both states.
  const rule = (css, selector) => css.match(new RegExp(`${selector.replace(/[.[\]]/gu, '\\$&')}\\s*\\{([^}]*)\\}`, 'u'))?.[1].replace(/\s+/gu, '');
  const composerRule = rule(hostStyles, '.composer-out__export[aria-disabled="true"]');
  assert.ok(composerRule, 'a disabled rule exists for the composer export');
  for (const declaration of ['text-decoration:none', 'color:var(--aithema-muted)', 'cursor:default']) assert.ok(composerRule.includes(declaration), `composer: ${declaration}`);
  assert.equal(rule(styles, '.export[aria-disabled="true"]'), 'text-decoration:none;cursor:help;', 'the footer keeps main\'s disabled rule');
  const window = elementPage();
  const { calls } = guardFetch(t, url => String(url).endsWith('/events') ? new Response(new ReadableStream({ start() {} })) : Response.json({}), [window]);
  await import('../src/session-element.js');
  const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
  const mount = async (locale, preset) => {
    const copy = structuredClone(locale === 'de' ? de : en), session = createSession({ demo: true });
    session.locale = locale; if (preset) session.processingPreset = preset;
    const component = window.document.createElement('aithema-session');
    component.configure({ copy, session, sessionToken: 'tok', copyForLocale: () => copy });
    window.document.body.append(component); await tick();
    t.after(() => component.remove());
    return component;
  };
  const described = (root, control) => {
    const ids = (control.getAttribute('aria-describedby') ?? '').split(/\s+/u).filter(Boolean);
    return ids.map(id => root.querySelector(`#${id}`)?.textContent ?? '').join(' ');
  };
  const expected = { noorigin: { en: en.exportUnavailable, de: de.exportUnavailable }, device: { en: en.deviceExportUnavailable, de: de.deviceExportUnavailable } };
  for (const state of ['noorigin', 'device']) for (const locale of ['en', 'de']) {
    const label = `${state}/${locale}`, base = window.document.createElement('base');
    if (state === 'noorigin') { base.href = 'https://evil.example/'; window.document.head.append(base); }
    try {
      const component = await mount(locale, state === 'device' ? 'device' : undefined), root = component.shadowRoot;
      const footer = root.querySelector('.export'), composer = root.querySelector('.composer-out__export'), reason = root.querySelector('.export-reason');
      for (const control of [footer, composer]) {
        assert.equal(control.getAttribute('aria-disabled'), 'true', `${label} ${control.className}: aria-disabled`);
        assert.equal(described(root, control), expected[state][locale], `${label} ${control.className}: accessible description`);
        assert.equal(control.hasAttribute('href'), false, `${label} ${control.className}: no href`);
      }
      // The footer shows the reason in place, where the device state shows its reason line, with a tip.
      assert.equal(reason.textContent, expected[state][locale], `${label}: footer reason line`);
      assert.equal(reason.style.visibility, 'visible', `${label}: footer reason line visible`);
      assert.equal(reason.getAttribute('aria-hidden'), 'false', `${label}: footer reason line exposed`);
      assert.equal(footer.title, expected[state][locale], `${label}: footer tip`);
      // The composer shows no tip, so its cursor stays default.
      assert.equal(composer.title, '', `${label}: composer has no tip`);
      const before = calls.length;
      for (const control of [footer, composer]) {
        control.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
        for (const key of ['Enter', ' ']) control.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      }
      await tick();
      assert.deepEqual(calls.slice(before).map(call => String(call.url)).filter(url => url.endsWith('/export')), [], `${label}: click, Enter and Space send no export`);
    } finally { base.remove(); }
  }
  // Enabled (same origin, default preset): as on main, no aria-disabled, no description, no tip,
  // the footer reason line hidden.
  for (const locale of ['en', 'de']) {
    const root = (await mount(locale)).shadowRoot, reason = root.querySelector('.export-reason');
    for (const control of [root.querySelector('.export'), root.querySelector('.composer-out__export')]) {
      assert.equal(control.hasAttribute('aria-disabled'), false, `enabled/${locale} ${control.className}`);
      assert.equal(control.hasAttribute('aria-describedby'), false, `enabled/${locale} ${control.className}: no description`);
      assert.equal(control.title, '', `enabled/${locale} ${control.className}: no tip`);
    }
    assert.equal(reason.style.visibility, 'hidden'); assert.equal(reason.getAttribute('aria-hidden'), 'true');
  }
});

// AIT-637 r2 (gate1c M1-M4; TICK F1): a disabled footer control does not turn accent on hover; a
// host copy bundle without exportUnavailable still disables both controls with the shipped text;
// click and Enter re-check the page origin live (a removed foreign <base> exports, an added one
// blocks), and both controls agree afterwards; an in-place locale change repaints the footer tip,
// the reason line and the composer description in both disabled states.
test('AIT-637 r2 element: hover, missing host copy, a live <base> change and an in-place locale change', async t => {
  const { createSession } = await import('@inspr/aithema-core');
  const { en } = await import('../src/i18n/en.js');
  const { de } = await import('../src/i18n/de.js');
  const { styles } = await import('../src/styles.js');
  // M1 / TICK F1: one selector; the enabled footer hover is unchanged.
  assert.ok(styles.includes('.export:not([aria-disabled="true"]):hover, .create-project:hover { color:var(--aithema-accent); background:transparent; }'),
    'the footer hover accent applies only to an enabled control');
  assert.doesNotMatch(styles, /(^|[\s,}])\.export:hover/u, 'no hover rule matches a disabled footer control');
  const window = elementPage();
  const { calls } = guardFetch(t, url => String(url).endsWith('/events') ? new Response(new ReadableStream({ start() {} }))
    : String(url).endsWith('/export') ? Response.json({ error: 'fixture' }, { status: 404 }) : Response.json({}), [window]);
  await import('../src/session-element.js');
  const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
  const mount = async ({ locale = 'en', preset, copies = { en: structuredClone(en), de: structuredClone(de) } } = {}) => {
    const session = createSession({ demo: true });
    session.locale = locale; if (preset) session.processingPreset = preset;
    const component = window.document.createElement('aithema-session');
    component.configure({ copy: copies[locale], session, sessionToken: 'tok', copyForLocale: next => copies[next] });
    window.document.body.append(component); await tick();
    t.after(() => component.remove());
    return component;
  };
  const described = (root, control) => (control.getAttribute('aria-describedby') ?? '').split(/\s+/u).filter(Boolean)
    .map(id => root.querySelector(`#${id}`)?.textContent ?? '').join(' ');
  const parts = root => ({ footer: root.querySelector('.export'), composer: root.querySelector('.composer-out__export'), reason: root.querySelector('.export-reason') });
  const assertDisabled = (root, text, label) => {
    const { footer, composer, reason } = parts(root);
    for (const control of [footer, composer]) {
      assert.equal(control.getAttribute('aria-disabled'), 'true', `${label} ${control.className}: aria-disabled`);
      assert.equal(described(root, control), text, `${label} ${control.className}: description`);
    }
    assert.equal(footer.title, text, `${label}: footer tip`);
    assert.equal(reason.textContent, text, `${label}: footer reason line`);
    assert.equal(reason.style.visibility, 'visible', `${label}: footer reason line visible`);
  };
  const assertEnabled = (root, label) => {
    const { footer, composer, reason } = parts(root);
    for (const control of [footer, composer]) {
      assert.equal(control.hasAttribute('aria-disabled'), false, `${label} ${control.className}: enabled`);
      assert.equal(control.hasAttribute('aria-describedby'), false, `${label} ${control.className}: no description`);
    }
    assert.equal(footer.title, '', `${label}: no footer tip`);
    assert.equal(reason.style.visibility, 'hidden', `${label}: footer reason line hidden`);
  };
  const exports = () => calls.filter(call => String(call.url).endsWith('/export')).length;
  const foreignBase = () => { const base = window.document.createElement('base'); base.href = 'https://evil.example/'; window.document.head.append(base); t.after(() => base.remove()); return base; };
  const click = control => control.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const enter = control => control.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

  // M2: a host copy bundle from before this change (no exportUnavailable) falls back to the shipped text.
  for (const locale of ['en', 'de']) {
    const copies = { en: structuredClone(en), de: structuredClone(de) };
    delete copies.en.exportUnavailable; delete copies.de.exportUnavailable;
    const base = foreignBase();
    try {
      const root = (await mount({ locale, copies })).shadowRoot, before = exports();
      assertDisabled(root, (locale === 'de' ? de : en).exportUnavailable, `old host copy/${locale}`);
      for (const control of Object.values(parts(root)).slice(0, 2)) { click(control); enter(control); }
      await tick();
      assert.equal(exports(), before, `old host copy/${locale}: nothing is sent`);
    } finally { base.remove(); }
  }

  // M3: a live <base> change; click and Enter re-check availability, and both controls agree after.
  {
    const base = foreignBase();
    const root = (await mount()).shadowRoot, { footer, composer } = parts(root);
    assertDisabled(root, en.exportUnavailable, 'foreign <base> at mount');
    base.remove();
    let before = exports();
    click(footer); await tick();
    assert.equal(exports(), before + 1, 'the foreign <base> is gone: a footer click exports');
    assertEnabled(root, 'after the footer click');
    const again = foreignBase();
    before = exports();
    enter(composer); await tick();
    assert.equal(exports(), before, 'a foreign <base> was added: composer Enter sends nothing');
    assertDisabled(root, en.exportUnavailable, 'after the blocked composer Enter');
    again.remove();
    before = exports();
    enter(composer); await tick();
    assert.equal(exports(), before + 1, 'the foreign <base> is gone again: composer Enter exports');
    assertEnabled(root, 'after the composer Enter');
    const third = foreignBase();
    before = exports();
    click(footer); await tick();
    assert.equal(exports(), before, 'a foreign <base> was added: a footer click sends nothing');
    assertDisabled(root, en.exportUnavailable, 'after the blocked footer click');
    third.remove();
  }

  // M4: an in-place locale change EN -> DE repaints the tip, the reason line and the description.
  for (const state of ['device', 'noorigin']) {
    const base = state === 'noorigin' ? foreignBase() : null;
    try {
      const component = await mount({ preset: state === 'device' ? 'device' : undefined }), root = component.shadowRoot;
      const text = state === 'device' ? 'deviceExportUnavailable' : 'exportUnavailable';
      assertDisabled(root, en[text], `${state}/en`);
      component.receive({ sessionId: component.session.id, seq: component.session.seq + 1, type: 'session.locale-changed', data: { locale: 'de' } });
      await tick();
      assert.equal(component.session.locale, 'de', `${state}: the locale changed in place`);
      assertDisabled(root, de[text], `${state}/de in place`);
    } finally { base?.remove(); }
  }
});
