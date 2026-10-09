import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { HTML_PREVIEW_CSP, HTML_PREVIEW_HOST_CSP } from '@inspr/aithema-core';
// happy-dom enforces neither sandbox nor CSP; it checks the markup. The browser test proves isolation.
const window = new Window({ settings: { disableJavaScriptEvaluation: true, disableIframePageLoading: true } });
for (const key of ['HTMLElement', 'customElements', 'document']) globalThis[key] = window[key];
const { frameDocument, PREVIEW_SANDBOX, previewCopy } = await import('../src/html-preview.js');
const dummy = readFileSync(new URL('../../../test/fixtures/click-dummy.html', import.meta.url), 'utf8');
const html = text => ({ bytes: new TextEncoder().encode(text), mediaType: 'text/html' });
function setup(owner = document) { const element = owner.createElement('aithema-html-preview'); owner.body.append(element); return element; }
// Unit tests simulate the browser's policy event; only real Chrome proves CSP.
const proof = { isTrusted: true, disposition: 'enforce', effectiveDirective: 'frame-src', blockedURI: 'data', originalPolicy: HTML_PREVIEW_HOST_CSP };
const violation = (fields, owner = document) => { const event = new window.Event('securitypolicyviolation'); Object.assign(event, fields); owner.dispatchEvent(event); };
async function render(element, value) {
  const document = element.ownerDocument;
  if (!document.head.querySelector('meta[http-equiv]')) {
    const meta = document.createElement('meta'); meta.httpEquiv = 'Content-Security-Policy'; meta.content = HTML_PREVIEW_HOST_CSP; document.head.append(meta);
  }
  element.artifact = value;
  if (document.querySelector('[data-aithema-html-policy-probe]')) {
    violation({ ...proof, isTrusted: false }, document); await Promise.resolve();
    assert.equal(element.shadowRoot.querySelector('iframe'), null, 'synthetic events cannot authorize rendering');
    violation({ ...proof, disposition: 'report' }, document); await Promise.resolve();
    assert.equal(element.shadowRoot.querySelector('iframe'), null, 'report-only cannot authorize rendering');
    violation({ ...proof, originalPolicy: "frame-src data:; child-src 'none'" }, document); await Promise.resolve();
    assert.equal(element.shadowRoot.querySelector('iframe'), null, 'a weaker policy cannot authorize rendering');
    violation(proof, document);
  }
  await Promise.resolve();
}
test('missing host policy refuses a draft visibly before it can execute', () => {
  const element = setup(); element.artifact = html(dummy);
  assert.equal(element.state, 'policy'); assert.equal(element.shadowRoot.querySelector('iframe'), null);
  assert.equal(element.shadowRoot.querySelector('.state').textContent, previewCopy.policy);
});
test('host policy accepts empty, scheme-only and full data probe URIs only while its sole probe is pending', async () => {
  for (const blockedURI of ['', 'data', 'data:text/html,%3Ctitle%3Epolicy%20probe%3C/title%3E']) {
    const owner = document.implementation.createHTMLDocument();
    const meta = owner.createElement('meta'); meta.httpEquiv = 'Content-Security-Policy'; meta.content = HTML_PREVIEW_HOST_CSP; owner.head.append(meta);
    const element = setup(owner), event = { ...proof, blockedURI };
    violation(event, owner); element.artifact = html(dummy); await Promise.resolve();
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
      { blockedURI: 'http://example.invalid/' }, { blockedURI: 'database' }]) {
      violation({ ...event, ...fields }, owner); await Promise.resolve();
      assert.equal(element.shadowRoot.querySelector('iframe'), null, 'only an enforced host frame-policy data violation authorizes rendering');
    }
    violation({ ...event, effectiveDirective: blockedURI === '' ? 'child-src' : 'frame-src' }, owner); await Promise.resolve();
    assert.equal(element.state, 'ready'); assert.ok(element.shadowRoot.querySelector('iframe'));
    assert.equal(owner.querySelector('[data-aithema-html-policy-probe]'), null); element.remove();
  }
});
test('a late violation cannot authorize a timed-out policy probe', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const owner = document.implementation.createHTMLDocument();
  const meta = owner.createElement('meta'); meta.httpEquiv = 'Content-Security-Policy'; meta.content = HTML_PREVIEW_HOST_CSP; owner.head.append(meta);
  const element = setup(owner); element.artifact = html(dummy);
  t.mock.timers.tick(1500); await Promise.resolve();
  assert.equal(owner.querySelector('[data-aithema-html-policy-probe]'), null);
  violation({ ...proof, blockedURI: '' }, owner); await Promise.resolve();
  assert.equal(element.state, 'policy'); assert.equal(element.shadowRoot.querySelector('iframe'), null); element.remove();
});
test('renders a draft only in an allow-scripts sandbox with the strict CSP first in its srcdoc', async () => {
  const element = setup(), root = element.shadowRoot;
  assert.equal(element.state, 'empty'); assert.equal(root.querySelector('iframe'), null);
  assert.equal(root.querySelector('.state').textContent, previewCopy.empty);
  await render(element, html(dummy));
  const frame = root.querySelector('iframe'); assert.equal(element.state, 'ready');
  assert.equal(PREVIEW_SANDBOX, 'allow-scripts'); assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
  assert.doesNotMatch(frame.getAttribute('sandbox'), /same-origin|top-navigation|popups|forms|modals|downloads/u);
  assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer'); assert.match(frame.getAttribute('allow'), /camera 'none'/u);
  assert.equal(frame.hasAttribute('src'), false); assert.equal(frame.getAttribute('title'), previewCopy.title);
  const srcdoc = frame.getAttribute('srcdoc');
  assert.ok(srcdoc.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`));
  assert.equal(srcdoc.match(/<!doctype/giu).length, 1, 'one doctype keeps standards mode');
  assert.equal(srcdoc, frameDocument(dummy)); assert.match(srcdoc, /<html lang="en">/u);
  assert.equal(root.querySelector('.label-text').textContent, 'Draft — generated');
});
test('refuses unsafe, non-html and broken bytes in place, without a frame', async () => {
  const element = setup(), root = element.shadowRoot;
  for (const value of [html(dummy.replace('<main', '<img src="https://example.invalid/p.png"><main')),
    { bytes: new TextEncoder().encode(dummy), mediaType: 'image/png' }, { bytes: Uint8Array.from([0xff]), mediaType: 'text/html' },
    { mediaType: 'text/html', bytes: dummy }, html('<p>fragment</p>')]) {
    await render(element, html(dummy)); assert.ok(root.querySelector('iframe'));
    await render(element, value);
    assert.equal(element.state, 'invalid'); assert.equal(root.querySelector('iframe'), null);
    assert.equal(root.querySelector('.state').textContent, previewCopy.invalid);
  }
  element.artifact = null; assert.equal(element.state, 'empty');
});
test('width switch changes only the frame width, keeps a fixed stage and works by keyboard', async () => {
  const element = setup(), root = element.shadowRoot, stage = root.querySelector('.stage');
  await render(element, html(dummy));
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
  assert.equal(root.querySelector('.state').textContent, 'Noch kein Entwurf.');
  assert.deepEqual([...root.querySelectorAll('.seg button')].map(b => b.textContent), ['Breit', 'Telefon']);
  assert.equal(root.querySelector('.seg').getAttribute('aria-label'), 'Vorschaubreite');
  element.copy = { label: '<img src=x onerror=alert(1)>' }; assert.equal(root.querySelector('.label-text img'), null);
});
test('a stale policy verification cannot remount a cleared or disconnected draft', async () => {
  const element = setup(), root = element.shadowRoot; await render(element, html(dummy));
  element.artifact = html(dummy); element.artifact = null; await Promise.resolve();
  assert.equal(element.state, 'empty'); assert.equal(root.querySelector('iframe'), null);
  element.artifact = html(dummy); element.remove(); await Promise.resolve();
  assert.equal(root.querySelector('iframe'), null);
});
test('a replaced draft keeps keyboard focus in the preview', async () => {
  const element = setup(), root = element.shadowRoot; await render(element, html(dummy));
  root.querySelector('iframe').dispatchEvent(new window.FocusEvent('focus'));
  let focused = null; const focus = window.HTMLElement.prototype.focus;
  window.HTMLElement.prototype.focus = function () { focused = this; };
  try { await render(element, html(dummy.replace('Revision 1', 'Revision 2'))); } finally { window.HTMLElement.prototype.focus = focus; }
  assert.equal(focused, root.querySelector('iframe')); assert.match(focused.getAttribute('srcdoc'), /Revision 2/u);
});

test('clearing or rejecting a focused draft restores focus to the selected width control', async () => {
  for (const value of [null, html('<p>fragment</p>')]) {
    const element = setup(), root = element.shadowRoot; element.width = 'phone'; await render(element, html(dummy));
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
test('only the srcdoc reply port confirms a first load; late probe events cannot retire a draft', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const channels = mockChannels(t);
  const owner = document.implementation.createHTMLDocument(), element = setup(owner); await render(element, html(dummy));
  const frame = element.shadowRoot.querySelector('iframe'); let ping;
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
    const owner = document.implementation.createHTMLDocument(), element = setup(owner), root = element.shadowRoot;
    element.width = 'phone'; await render(element, html(dummy));
    const frame = root.querySelector('iframe');
    t.mock.method(frame.contentWindow, 'postMessage', message => {
      if (loaded) channels.at(-1).port1.onmessage({ data: message });
    });
    frame.dispatchEvent(new window.FocusEvent('focus'));
    frame.dispatchEvent(new window.Event('load'));
    if (loaded) frame.dispatchEvent(new window.Event('load')); else t.mock.timers.tick(1500);
    assert.equal(element.state, 'navigated'); assert.equal(root.querySelector('iframe'), null);
    assert.equal(root.querySelector('.state').hidden, false); assert.equal(root.querySelector('.state').textContent, previewCopy.navigated);
    assert.equal(root.activeElement, root.querySelector('.seg [data-width="phone"]'));
    assert.equal(channels.at(-1).port1.closed, true);
    element.artifact = null; frame.dispatchEvent(new window.Event('load')); t.mock.timers.tick(1500);
    assert.equal(element.state, 'empty', 'discarded frames cannot change the state'); element.remove();
  }
});
test('clearing a draft during its first-load check cancels the timeout and closes the reply port', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const channels = mockChannels(t);
  const owner = document.implementation.createHTMLDocument(), element = setup(owner); await render(element, html(dummy));
  const frame = element.shadowRoot.querySelector('iframe');
  t.mock.method(frame.contentWindow, 'postMessage', () => {}); frame.dispatchEvent(new window.Event('load'));
  element.artifact = null; t.mock.timers.tick(1500); channels[0].port1.onmessage({ data: 'aithema-html-preview-ready' });
  assert.equal(channels[0].port1.closed, true); assert.equal(element.state, 'empty'); element.remove();
});
