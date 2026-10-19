import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { de } from '../src/i18n/de.js';
import { en } from '../src/i18n/en.js';
import { HTML_PREVIEW_CSP, htmlPreviewHostPolicy } from '@inspr/aithema-core';
// happy-dom enforces neither sandbox nor CSP; it checks the markup. The browser test proves isolation.
const window = new Window({ url: 'http://localhost/', settings: { disableJavaScriptEvaluation: true, disableIframePageLoading: true } });
for (const key of ['HTMLElement', 'customElements', 'document']) globalThis[key] = window[key];
const { frameDocument, PREVIEW_SANDBOX, previewCopy } = await import('../src/html-preview.js');
const dummy = readFileSync(new URL('../../../test/fixtures/click-dummy.html', import.meta.url), 'utf8');
const previewURL = 'http://localhost/_aithema/html-preview';
const HTML_PREVIEW_HOST_CSP = htmlPreviewHostPolicy(previewURL);
let sequence = 0;
const html = text => ({ bytes: new TextEncoder().encode(text), mediaType: 'text/html' });
const source = () => ({ mediaType: 'text/html', previewURL, mint: async () => ({ url: previewURL + '?cap=' + String(++sequence).padStart(43, 'a'), expiresInMs: 60_000 }) });
function testDocument() { const owner = document.implementation.createHTMLDocument(); Object.defineProperty(owner, 'URL', { value: 'http://localhost/' }); return owner; }
function setup(owner = document) { const element = owner.createElement('aithema-html-preview'); owner.body.append(element); return element; }
// Unit tests simulate the browser's policy event; only real Chrome proves CSP.
const proof = { isTrusted: true, disposition: 'enforce', effectiveDirective: 'frame-src', blockedURI: 'data', originalPolicy: HTML_PREVIEW_HOST_CSP };
const violation = (fields, owner = document) => { const event = new window.Event('securitypolicyviolation'); Object.assign(event, fields); owner.dispatchEvent(event); };
async function render(element, value) {
  const document = element.ownerDocument;
  if (!document.head.querySelector('meta[http-equiv]')) {
    const meta = document.createElement('meta'); meta.httpEquiv = 'Content-Security-Policy'; meta.content = HTML_PREVIEW_HOST_CSP; document.head.append(meta);
  }
  element.artifact = value && { previewURL, ...value };
  if (document.querySelector('[data-aithema-html-policy-probe]')) {
    violation({ ...proof, isTrusted: false }, document); await Promise.resolve();
    assert.equal(element.shadowRoot.querySelector('iframe'), null, 'synthetic events cannot authorize rendering');
    violation({ ...proof, disposition: 'report' }, document); await Promise.resolve();
    assert.equal(element.shadowRoot.querySelector('iframe'), null, 'report-only cannot authorize rendering');
    violation({ ...proof, originalPolicy: "frame-src data:; child-src 'none'" }, document); await Promise.resolve();
    assert.equal(element.shadowRoot.querySelector('iframe'), null, 'a weaker policy cannot authorize rendering');
    violation(proof, document);
  }
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
test('missing host policy refuses a draft visibly before it can execute', () => {
  const element = setup(); element.artifact = source();
  assert.equal(element.state, 'policy'); assert.equal(element.shadowRoot.querySelector('iframe'), null);
  assert.equal(element.shadowRoot.querySelector('.state-message').textContent, previewCopy.policy);
});
test('host policy accepts empty, scheme-only and full data probe URIs only while its sole probe is pending', async () => {
  for (const blockedURI of ['', 'data', 'data:text/html,%3Ctitle%3Epolicy%20probe%3C/title%3E']) {
    const owner = testDocument();
    const meta = owner.createElement('meta'); meta.httpEquiv = 'Content-Security-Policy'; meta.content = HTML_PREVIEW_HOST_CSP; owner.head.append(meta);
    const element = setup(owner), event = { ...proof, blockedURI };
    violation(event, owner); element.artifact = source(); await Promise.resolve();
    assert.equal(element.state, 'policy', 'a previous event cannot authorize a new probe');
    const probe = owner.querySelector('[data-aithema-html-policy-probe]'); assert.ok(probe);
    probe.remove(); violation(event, owner); await Promise.resolve();
    assert.equal(element.state, 'policy', 'a detached probe cannot authorize rendering');
    owner.body.append(probe);
    const other = owner.createElement('iframe'); other.setAttribute('data-aithema-html-policy-probe', ''); owner.body.append(other);
    violation(event, owner); await Promise.resolve();
    assert.equal(element.state, 'policy', 'ambiguous pending probes cannot authorize rendering'); other.remove();
    for (const fields of [{ isTrusted: false }, { disposition: 'report' }, { effectiveDirective: 'default-src' },
      { originalPolicy: "frame-src data:; child-src 'none'" }, { originalPolicy: "frame-src 'none'; child-src data:" },
      { originalPolicy: "frame-src 'self'; child-src 'none'" }, { originalPolicy: `frame-src ${previewURL} data:; child-src 'none'` },
      { originalPolicy: `frame-src ${previewURL.replace('/_aithema/html-preview', '/')}; child-src 'none'` },
      { blockedURI: 'http://example.invalid/' }, { blockedURI: 'database' }]) {
      violation({ ...event, ...fields }, owner); await Promise.resolve();
      assert.equal(element.shadowRoot.querySelector('iframe'), null, 'only an enforced host frame-policy data violation authorizes rendering');
    }
    violation({ ...event, effectiveDirective: blockedURI === '' ? 'child-src' : 'frame-src' }, owner); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(element.state, 'ready'); assert.ok(element.shadowRoot.querySelector('iframe'));
    assert.equal(owner.querySelector('[data-aithema-html-policy-probe]'), null); element.remove();
  }
});
test('a late violation cannot authorize a timed-out policy probe', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const owner = testDocument();
  const meta = owner.createElement('meta'); meta.httpEquiv = 'Content-Security-Policy'; meta.content = HTML_PREVIEW_HOST_CSP; owner.head.append(meta);
  const element = setup(owner); element.artifact = source();
  t.mock.timers.tick(1500); await Promise.resolve();
  assert.equal(owner.querySelector('[data-aithema-html-policy-probe]'), null);
  violation({ ...proof, blockedURI: '' }, owner); await Promise.resolve();
  assert.equal(element.state, 'policy'); assert.equal(element.shadowRoot.querySelector('iframe'), null); element.remove();
});
test('the policy probe rejects report-only and wrong-directive event-like objects', async t => {
  const owner = testDocument();
  const meta = owner.createElement('meta'); meta.httpEquiv = 'Content-Security-Policy'; meta.content = HTML_PREVIEW_HOST_CSP; owner.head.append(meta);
  let handler;
  const addEventListener = owner.addEventListener;
  t.mock.method(owner, 'addEventListener', function (type, listener, ...options) {
    if (type === 'securitypolicyviolation') handler = listener;
    return addEventListener.call(this, type, listener, ...options);
  });
  const element = setup(owner); element.artifact = source();
  const probe = owner.querySelector('[data-aithema-html-policy-probe]'); assert.ok(probe); assert.equal(typeof handler, 'function');
  // Call the captured listener directly; production still requires isTrusted.
  for (const fields of [{ disposition: 'report' }, { effectiveDirective: 'default-src' }]) {
    handler({ ...proof, ...fields }); await Promise.resolve();
    assert.equal(element.state, 'policy'); assert.equal(element.shadowRoot.querySelector('iframe'), null);
    assert.equal(owner.querySelector('[data-aithema-html-policy-probe]'), probe, 'rejected evidence leaves the probe pending');
  }
  handler(proof); for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(element.state, 'ready'); assert.ok(element.shadowRoot.querySelector('iframe'));
  assert.equal(owner.querySelector('[data-aithema-html-policy-probe]'), null); element.remove();
});
test('renders only the scoped src in an allow-scripts sandbox; the route owns CSP', async () => {
  const element = setup(), root = element.shadowRoot;
  assert.equal(element.state, 'empty'); assert.equal(root.querySelector('iframe'), null);
  assert.equal(root.querySelector('.state-message').textContent, previewCopy.empty);
  await render(element, source());
  const frame = root.querySelector('iframe'); assert.equal(element.state, 'ready');
  assert.equal(PREVIEW_SANDBOX, 'allow-scripts'); assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
  assert.doesNotMatch(frame.getAttribute('sandbox'), /same-origin|top-navigation|popups|forms|modals|downloads/u);
  assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer'); assert.match(frame.getAttribute('allow'), /camera 'none'/u);
  assert.equal(frame.hasAttribute('srcdoc'), false); assert.equal(frame.getAttribute('title'), previewCopy.title);
  assert.match(frame.src, /^http:\/\/localhost\/_aithema\/html-preview\?cap=[A-Za-z0-9_-]{43}$/u);
  assert.equal(root.querySelector('.label-text').textContent, 'Draft, generated');
});
test('refuses unsafe, non-html and broken bytes in place, without a frame', async () => {
  const element = setup(), root = element.shadowRoot;
  for (const value of [html(dummy), html(dummy.replace('<main', '<img src="https://example.invalid/p.png"><main')),
    { bytes: new TextEncoder().encode(dummy), mediaType: 'image/png' }, { bytes: Uint8Array.from([0xff]), mediaType: 'text/html' },
    { mediaType: 'text/html', bytes: dummy }, html('<p>fragment</p>')]) {
    await render(element, source()); assert.ok(root.querySelector('iframe'));
    await render(element, value);
    assert.equal(element.state, 'invalid'); assert.equal(root.querySelector('iframe'), null);
    assert.equal(root.querySelector('.state-message').textContent, previewCopy.invalid);
  }
  element.artifact = null; assert.equal(element.state, 'empty');
});
test('width switch changes only the frame width, keeps a fixed stage and works by keyboard', async () => {
  const element = setup(), root = element.shadowRoot, stage = root.querySelector('.stage');
  await render(element, source());
  const style = root.querySelector('style').textContent;
  assert.match(style, /\.stage \{[^}]*height:var\(--preview-height\)/u); assert.match(style, /contain:strict/u);
  assert.doesNotMatch(style, /font-style:\s*italic|100dvh|100vh/u);
  const [wide, phone] = root.querySelectorAll('.seg button');
  assert.equal(wide.getAttribute('aria-checked'), 'true'); assert.equal(phone.tabIndex, -1);
  phone.click(); assert.equal(stage.dataset.width, 'phone'); assert.equal(phone.getAttribute('aria-checked'), 'true'); assert.equal(phone.tabIndex, 0);
  const frame = root.querySelector('iframe');
  root.querySelector('.seg').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(element.width, 'wide'); assert.equal(root.querySelector('iframe'), frame, 'switching width never reloads the draft');
  assert.equal(root.activeElement, wide);
});
test('host copy replaces every visible string, including in the empty state', async () => {
  const element = setup(), root = element.shadowRoot;
  element.copy = { label: 'Entwurf — generiert', empty: 'Noch kein Entwurf.', wide: 'Breit', phone: 'Telefon', width: 'Vorschaubreite' };
  assert.equal(root.querySelector('.label-text').textContent, 'Entwurf — generiert');
  assert.equal(root.querySelector('.state-message').textContent, 'Noch kein Entwurf.');
  assert.deepEqual([...root.querySelectorAll('.seg button')].map(b => b.textContent), ['Breit', 'Telefon']);
  assert.equal(root.querySelector('.seg').getAttribute('aria-label'), 'Vorschaubreite');
  element.copy = { label: '<img src=x onerror=alert(1)>' }; assert.equal(root.querySelector('.label-text img'), null);
});
test('a stale policy verification cannot remount a cleared or disconnected draft', async () => {
  const element = setup(), root = element.shadowRoot; await render(element, source());
  element.artifact = source(); element.artifact = null; await Promise.resolve();
  assert.equal(element.state, 'empty'); assert.equal(root.querySelector('iframe'), null);
  element.artifact = source(); element.remove(); await Promise.resolve();
  assert.equal(root.querySelector('iframe'), null);
});
test('a replaced draft keeps keyboard focus in the preview', async () => {
  const element = setup(), root = element.shadowRoot; await render(element, source());
  const beforeSource = root.querySelector('iframe').src;
  root.querySelector('iframe').dispatchEvent(new window.FocusEvent('focus'));
  let focused = null; const focus = window.HTMLElement.prototype.focus;
  window.HTMLElement.prototype.focus = function () { focused = this; };
  try { await render(element, source()); } finally { window.HTMLElement.prototype.focus = focus; }
  assert.equal(focused, root.querySelector('iframe')); assert.notEqual(focused.src, beforeSource);
});

test('clearing or rejecting a focused draft restores focus to the selected width control', async () => {
  for (const value of [null, html('<p>fragment</p>')]) {
    const element = setup(), root = element.shadowRoot; element.width = 'phone'; await render(element, source());
    root.querySelector('iframe').focus();
    await render(element, value);
    assert.equal(root.querySelector('iframe'), null);
    assert.equal(root.activeElement, root.querySelector('.seg [data-width="phone"]'));
  }
});
function mockChannels(t) {
  const channels = [];
  t.mock.method(globalThis, 'MessageChannel', function () {
    const channel = { port1: { close() { this.closed = true; } }, port2: {} }; channels.push(channel); return channel;
  });
  return channels;
}
test('only the preview reply port confirms a first load; late probe events cannot retire a draft', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const channels = mockChannels(t);
  const owner = testDocument(), element = setup(owner); await render(element, source());
  const frame = element.shadowRoot.querySelector('iframe'); let ping;
  if (!frame.contentWindow) { const target = { postMessage() {} }; t.mock.getter(frame, 'contentWindow', () => target); }
  t.mock.method(frame.contentWindow, 'postMessage', (message, target, ports) => {
    ping = message; assert.equal(target, '*'); assert.deepEqual(ports, [channels[0].port2]);
  });
  violation({ ...proof, blockedURI: '' }, owner);
  frame.dispatchEvent(new window.Event('load'));
  const reply = channels[0].port1;
  window.dispatchEvent(new window.MessageEvent('message', { data: ping }));
  reply.onmessage({ data: 'unrelated' }); t.mock.timers.tick(1499);
  assert.equal(element.state, 'ready'); assert.equal(reply.closed, undefined, 'unrelated messages cannot confirm the load');
  reply.onmessage({ data: ping }); t.mock.timers.tick(1);
  assert.equal(element.state, 'ready'); assert.equal(reply.closed, true);
  violation({ ...proof, blockedURI: '' }, owner); assert.equal(element.state, 'ready'); element.remove();
});
test('blocked navigation is visible both before first load and after load, with focus restored', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const channels = mockChannels(t);
  for (const loaded of [false, true]) {
    const owner = testDocument(), element = setup(owner), root = element.shadowRoot;
    element.width = 'phone'; await render(element, source());
    const frame = root.querySelector('iframe');
    if (!frame.contentWindow) { const target = { postMessage() {} }; t.mock.getter(frame, 'contentWindow', () => target); }
  t.mock.method(frame.contentWindow, 'postMessage', message => {
      if (loaded) channels.at(-1).port1.onmessage({ data: message });
    });
    frame.dispatchEvent(new window.FocusEvent('focus'));
    frame.dispatchEvent(new window.Event('load'));
    if (loaded) frame.dispatchEvent(new window.Event('load')); else t.mock.timers.tick(1500);
    assert.equal(element.state, 'navigated'); assert.equal(root.querySelector('iframe'), null);
    assert.equal(root.querySelector('.state').hidden, false); assert.equal(root.querySelector('.state-message').textContent, previewCopy.navigated);
    assert.equal(root.activeElement, root.querySelector('.seg [data-width="phone"]'));
    assert.equal(channels.at(-1).port1.closed, true);
    element.artifact = null; frame.dispatchEvent(new window.Event('load')); t.mock.timers.tick(1500);
    assert.equal(element.state, 'empty', 'discarded frames cannot change the state'); element.remove();
  }
});
test('clearing a draft during its first-load check cancels the timeout and closes the reply port', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const channels = mockChannels(t);
  const owner = testDocument(), element = setup(owner); await render(element, source());
  const frame = element.shadowRoot.querySelector('iframe');
  if (!frame.contentWindow) { const target = { postMessage() {} }; t.mock.getter(frame, 'contentWindow', () => target); }
  t.mock.method(frame.contentWindow, 'postMessage', () => {}); frame.dispatchEvent(new window.Event('load'));
  element.artifact = null; t.mock.timers.tick(1500); channels[0].port1.onmessage({ data: 'aithema-html-preview-ready' });
  assert.equal(channels[0].port1.closed, true); assert.equal(element.state, 'empty'); element.remove();
});

test('fresh sources on replacement/reconnect; stale mint responses never mount and widths never mint', async () => {
  const owner = testDocument(), element = setup(owner), pending = [];
  const value = { mediaType: 'text/html', previewURL, mint: signal => new Promise(resolve => pending.push({ signal, resolve })) };
  await render(element, value); assert.equal(element.state, 'loading'); assert.equal(pending.length, 1);
  element.width = 'phone'; element.copy = { label: 'Updated' }; assert.equal(pending.length, 1);
  element.artifact = value; for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(pending[0].signal.aborted, true); assert.equal(pending.length, 2);
  const result = { url: previewURL + '?cap=' + 'b'.repeat(43), expiresInMs: 60_000 };
  pending[0].resolve(result); for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(element.shadowRoot.querySelector('iframe'), null);
  element.remove(); element.disconnectedCallback(); assert.equal(pending[1].signal.aborted, true);
  owner.body.append(element); element.connectedCallback(); for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(pending.length, 3);
  pending[1].resolve(result); for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(element.shadowRoot.querySelector('iframe'), null);
  pending[2].resolve(result); for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.ok(element.shadowRoot.querySelector('iframe')); element.remove();
});

test('mint failure is stable without automatic retries, and off-route responses fail closed', async () => {
  for (const result of [null, { url: previewURL + '?cap=' + 'a'.repeat(43), expiresInMs: 60_001 },
    { url: 'http://other.invalid/_aithema/html-preview?cap=' + 'a'.repeat(43), expiresInMs: 60_000 },
    { url: previewURL + '?cap=' + 'a'.repeat(43) + '&extra=1', expiresInMs: 60_000 }]) {
    const owner = testDocument(), element = setup(owner); let calls = 0;
    await render(element, { mediaType: 'text/html', previewURL, mint: async () => { calls++; return result; } });
    assert.equal(element.state, 'failure'); assert.equal(element.shadowRoot.querySelector('iframe'), null);
    element.width = 'phone'; element.copy = {}; await Promise.resolve(); assert.equal(calls, 1); element.remove();
  }
});

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
test('AIT-358: each explicit Reload mints once, hides in flight and focuses the fresh frame or repeated-failure action', async () => {
  const element = setup(testDocument()), root = element.shadowRoot, pending = [];
  let calls = 0;
  await render(element, { ...source(), mint: () => {
    if (++calls === 1) return Promise.reject(new Error('unavailable'));
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  } });
  const button = root.querySelector('.reload'); assert.ok(button, 'failure offers Reload');
  assert.equal(button.textContent, 'Reload'); assert.equal(button.disabled, false);
  const status = root.querySelector('.state'); assert.equal(status.getAttribute('aria-live'), 'polite');
  assert.equal(status.tabIndex, -1);
  button.focus(); button.click(); button.click(); await settle();
  assert.equal(calls, 2, 'a double click cannot start a second in-flight mint');
  assert.equal(element.state, 'loading'); assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-hidden'), 'true', 'loading Reload is hidden in its reserved slot');
  assert.equal(button.style.visibility, 'hidden'); assert.equal(button.hidden, false);
  assert.equal(root.activeElement, status);
  pending[0].resolve(await source().mint()); await settle();
  assert.equal(element.state, 'ready'); assert.equal(root.activeElement, root.querySelector('iframe'));
  assert.equal(button.getAttribute('aria-hidden'), 'true');
  await render(element, { ...source(), mint: async () => { throw new Error('unavailable'); } });
  button.click(); await settle();
  assert.equal(element.state, 'failure'); assert.equal(button.disabled, false);
  assert.equal(root.activeElement, button); element.remove();
});

test('AIT-358: messages cannot request Reload; replacement and disconnect retire pending reloads', async () => {
  const element = setup(testDocument()), root = element.shadowRoot, pending = [];
  let calls = 0;
  const value = { ...source(), mint: signal => {
    if (++calls === 1) return Promise.reject(new Error('unavailable'));
    return new Promise(resolve => pending.push({ signal, resolve }));
  } };
  await render(element, value);
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'reload' } })); await settle();
  assert.equal(calls, 1, 'draft messages cannot re-mint');
  const button = root.querySelector('.reload'); assert.ok(button);
  button.click(); await settle(); assert.equal(calls, 2);
  await render(element, source()); const current = root.querySelector('iframe');
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve(await source().mint()); await settle();
  assert.equal(root.querySelector('iframe'), current, 'stale reload cannot replace a new revision');
  calls = 0; await render(element, value); button.click(); await settle(); element.remove();
  // Detached test documents do not deliver custom-element disconnect callbacks.
  element.disconnectedCallback();
  assert.equal(pending[1].signal.aborted, true);
  pending[1].resolve(await source().mint()); await settle(); assert.equal(root.querySelector('iframe'), null);
  const policy = setup(testDocument()); policy.artifact = { ...source(), previewURL: undefined };
  const hidden = policy.shadowRoot.querySelector('.reload'); assert.ok(hidden);
  assert.equal(hidden.disabled, true); assert.equal(hidden.getAttribute('aria-hidden'), 'true');
  hidden.click(); await settle(); assert.equal(policy.state, 'policy'); policy.remove();
});


test('pre-load budget expires into failure, never navigation, and only explicit retry mints again', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); mockChannels(t);
  // TTL margin is up to 1 s (10% for short capabilities); the network cap is 30 s.
  for (const expiresInMs of [1, 1000, 5000, 10_000, 60_000]) {
    const budget = Math.min(expiresInMs - Math.min(1000, expiresInMs / 10), 30_000);
    const owner = testDocument(), element = setup(owner), root = element.shadowRoot; let calls = 0;
    const value = { ...source(), mint: async () => { calls++; return { url: previewURL + '?cap=' + 'c'.repeat(43), expiresInMs }; } };
    await render(element, value);
    const frame = root.querySelector('iframe'); frame.dispatchEvent(new window.FocusEvent('focus'));
    t.mock.timers.tick(budget / 2); assert.equal(root.querySelector('iframe'), frame);
    t.mock.timers.tick(budget / 2);
    assert.equal(element.state, 'failure'); assert.equal(root.querySelector('iframe'), null);
    assert.equal(root.querySelector('.state-message').textContent, previewCopy.failure);
    assert.equal(root.activeElement, root.querySelector('.seg [data-width="wide"]'));
    element.width = 'phone'; element.copy = {}; t.mock.timers.tick(60_000); await Promise.resolve();
    assert.equal(element.state, 'failure'); assert.equal(calls, 1, 'timeouts do not automatically spend another capability');
    frame.dispatchEvent(new window.Event('load')); assert.equal(element.state, 'failure', 'a late response cannot revive a timed-out generation');
    await render(element, value); assert.equal(calls, 2, 'explicit reopen mints a fresh capability');
    assert.ok(root.querySelector('iframe'));
    t.mock.timers.tick(budget);
    const reload = root.querySelector('.reload'); reload.click(); await settle();
    assert.equal(calls, 3, 'Reload after expiry mints exactly once');
    assert.ok(root.querySelector('iframe'));
    t.mock.timers.tick(budget);
    assert.equal(element.state, 'failure');
    assert.equal(root.activeElement, reload, 'a repeated route timeout returns focus to Reload'); element.remove();
  }
});

test('a delayed first load gets its own full 1.5 s readiness ping budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const channels = mockChannels(t);
  const element = setup(testDocument()); await render(element, source());
  const frame = element.shadowRoot.querySelector('iframe');
  t.mock.timers.tick(3500);
  assert.equal(element.state, 'ready', 'network time cannot be classified as navigation');
  assert.equal(element.shadowRoot.querySelector('iframe'), frame, 'a slow route response must survive past 1.5 s');
  if (!frame.contentWindow) { const target = { postMessage() {} }; t.mock.getter(frame, 'contentWindow', () => target); }
  t.mock.method(frame.contentWindow, 'postMessage', () => {}); frame.dispatchEvent(new window.Event('load'));
  t.mock.timers.tick(1499); assert.equal(element.state, 'ready');
  channels[0].port1.onmessage({ data: 'aithema-html-preview-ready' });
  t.mock.timers.tick(60_000); assert.equal(element.state, 'ready'); element.remove();
});


test('only the current frame first message starts a single readiness ping; cleanup retires its listener', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const channels = mockChannels(t);
  const owner = testDocument(), element = setup(owner); let listener, removed;
  const host = {
    addEventListener(type, fn) { assert.equal(type, 'message'); listener = fn; },
    removeEventListener(type, fn) { assert.equal(type, 'message'); removed = fn; },
  };
  t.mock.getter(owner, 'defaultView', () => host);
  await render(element, source()); const frame = element.shadowRoot.querySelector('iframe');
  if (!frame.contentWindow) { const target = { postMessage() {} }; t.mock.getter(frame, 'contentWindow', () => target); }
  t.mock.method(frame.contentWindow, 'postMessage', () => {});
  const early = listener;
  early({ isTrusted: false, source: frame.contentWindow }); early({ isTrusted: true, source: {} });
  assert.equal(channels.length, 0, 'synthetic and foreign messages leave the pre-load budget alone');
  t.mock.timers.tick(3500); early({ isTrusted: true, source: frame.contentWindow });
  assert.equal(channels.length, 1);
  t.mock.timers.tick(1499); assert.equal(element.state, 'ready');
  frame.dispatchEvent(new window.Event('load')); assert.equal(channels.length, 1, 'load cannot restart a ping begun by a message');
  channels[0].port1.onmessage({ data: 'aithema-html-preview-ready' });
  t.mock.timers.tick(30_000); assert.equal(element.state, 'ready', 'readiness clears both phase timers');
  element.artifact = null; assert.equal(removed, early);
  early({ isTrusted: true, source: frame.contentWindow }); frame.dispatchEvent(new window.Event('load'));
  t.mock.timers.tick(30_000); assert.equal(channels.length, 1); assert.equal(element.state, 'empty'); element.remove();
});

test('a replaced pre-load timer cannot discard a newer generation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); mockChannels(t);
  const element = setup(testDocument()); await render(element, source());
  const oldFrame = element.shadowRoot.querySelector('iframe'); t.mock.timers.tick(29_000);
  await render(element, source()); const currentFrame = element.shadowRoot.querySelector('iframe');
  oldFrame.dispatchEvent(new window.Event('load')); t.mock.timers.tick(1000);
  assert.equal(element.state, 'ready'); assert.equal(element.shadowRoot.querySelector('iframe'), currentFrame);
  element.remove(); t.mock.timers.tick(30_000); assert.equal(element.shadowRoot.querySelector('iframe'), null);
});

test('AIT-353: localized visitor copy, operator guidance and a persistent decorative alert slot', async () => {
  assert.equal(de.conceptPreview.failure, 'Der Entwurf konnte nicht geladen werden.');
  assert.equal(en.conceptPreview.failure, 'The draft could not be loaded.');
  assert.equal(de.conceptPreview.reload, 'Neu laden'); assert.equal(en.conceptPreview.reload, 'Reload');
  assert.equal(de.conceptPreview.label, 'Entwurf, generiert');
  assert.equal(en.conceptPreview.label, 'Draft, generated');
  assert.equal(de.conceptPreview.policy, 'Die Vorschau ist auf dieser Website nicht freigeschaltet.');
  assert.equal(en.conceptPreview.policy, "Previews aren't enabled on this site.");
  assert.equal(de.conceptPreview.policyOperator, 'Für Betreiber: Die genaue Vorschau-Adresse muss als Rahmen erlaubt sein.');
  assert.equal(en.conceptPreview.policyOperator, 'For site operators: the exact preview address must be allowed as a frame.');
  for (const key of ['label', 'failure', 'policy', 'policyOperator']) assert.equal(previewCopy[key], en.conceptPreview[key]);
  for (const copy of [de.conceptPreview, en.conceptPreview]) {
    const element = setup(), root = element.shadowRoot, icon = root.querySelector('.state-icon');
    element.copy = copy;
    assert.equal(icon.getAttribute('aria-hidden'), 'true');
    let finish;
    await render(element, { ...source(), mint: () => new Promise(resolve => { finish = resolve; }) });
    assert.equal(element.state, 'loading');
    const reload = root.querySelector('.reload');
    assert.equal(reload.style.visibility, 'hidden'); assert.equal(reload.getAttribute('aria-hidden'), 'true');
    assert.equal(reload.disabled, true); assert.equal(reload.hidden, false);
    assert.equal(reload.parentElement, root.querySelector('.state-operator').parentElement, 'operator and Reload share a reserved slot');
    finish(await source().mint()); for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.equal(element.state, 'ready'); assert.equal(root.querySelector('.state').getAttribute('aria-hidden'), 'true');
    await render(element, { ...source(), mint: async () => { throw new Error('fixture'); } });
    assert.equal(element.state, 'failure'); assert.equal(root.querySelector('.state-message').textContent, copy.failure);
    assert.equal(root.querySelector('.operator-message').textContent, '');
    await render(element, { ...source(), previewURL: undefined });
    assert.equal(element.state, 'policy'); assert.equal(root.querySelector('.state-message').textContent, copy.policy);
    assert.equal(root.querySelector('.operator-message').textContent, copy.policyOperator);
    assert.equal(root.querySelector('.state').getAttribute('aria-hidden'), 'false');
    assert.equal(root.querySelector('.state-icon'), icon, 'all state transitions preserve the alert slot');
    assert.deepEqual([...root.querySelectorAll('.state-text .state-sizer')].map(n => n.dataset.reserve),
      ['empty', 'invalid', 'navigated', 'loading', 'failure', 'policy'].map(state => copy[state]));
    assert.equal(root.querySelector('.state-operator .state-sizer').dataset.reserve, copy.policyOperator);
    element.remove();
  }
});
