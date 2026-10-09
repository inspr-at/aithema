import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { HTML_PREVIEW_CSP } from '@inspr/aithema-core';
// happy-dom enforces neither sandbox nor CSP; it checks the markup. The browser test proves isolation.
const window = new Window({ settings: { disableJavaScriptEvaluation: true, disableIframePageLoading: true } });
for (const key of ['HTMLElement', 'customElements', 'document']) globalThis[key] = window[key];
const { frameDocument, PREVIEW_SANDBOX, previewCopy } = await import('../src/html-preview.js');
const dummy = readFileSync(new URL('../../../test/fixtures/click-dummy.html', import.meta.url), 'utf8');
const html = text => ({ bytes: new TextEncoder().encode(text), mediaType: 'text/html' });
function setup() { const element = document.createElement('aithema-html-preview'); document.body.append(element); return element; }
test('renders a draft only in an allow-scripts sandbox with the strict CSP first in its srcdoc', () => {
  const element = setup(), root = element.shadowRoot;
  assert.equal(element.state, 'empty'); assert.equal(root.querySelector('iframe'), null);
  assert.equal(root.querySelector('.state').textContent, previewCopy.empty);
  element.artifact = html(dummy);
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
test('refuses unsafe, non-html and broken bytes in place, without a frame', () => {
  const element = setup(), root = element.shadowRoot;
  for (const value of [html(dummy.replace('<main', '<img src="https://example.invalid/p.png"><main')),
    { bytes: new TextEncoder().encode(dummy), mediaType: 'image/png' }, { bytes: Uint8Array.from([0xff]), mediaType: 'text/html' },
    { mediaType: 'text/html', bytes: dummy }, html('<p>fragment</p>')]) {
    element.artifact = html(dummy); assert.ok(root.querySelector('iframe'));
    element.artifact = value;
    assert.equal(element.state, 'invalid'); assert.equal(root.querySelector('iframe'), null);
    assert.equal(root.querySelector('.state').textContent, previewCopy.invalid);
  }
  element.artifact = null; assert.equal(element.state, 'empty');
});
test('width switch changes only the frame width, keeps a fixed stage and works by keyboard', () => {
  const element = setup(), root = element.shadowRoot, stage = root.querySelector('.stage');
  element.artifact = html(dummy);
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
test('host copy replaces every visible string, including in the empty state', () => {
  const element = setup(), root = element.shadowRoot;
  element.copy = { label: 'Entwurf — generiert', empty: 'Noch kein Entwurf.', wide: 'Breit', phone: 'Telefon', width: 'Vorschaubreite' };
  assert.equal(root.querySelector('.label-text').textContent, 'Entwurf — generiert');
  assert.equal(root.querySelector('.state').textContent, 'Noch kein Entwurf.');
  assert.deepEqual([...root.querySelectorAll('.seg button')].map(b => b.textContent), ['Breit', 'Telefon']);
  assert.equal(root.querySelector('.seg').getAttribute('aria-label'), 'Vorschaubreite');
  element.copy = { label: '<img src=x onerror=alert(1)>' }; assert.equal(root.querySelector('.label-text img'), null);
});
test('a second frame load is treated as navigation: the frame is removed and the state says so', () => {
  const element = setup(), root = element.shadowRoot; element.artifact = html(dummy);
  const frame = root.querySelector('iframe');
  frame.dispatchEvent(new window.Event('load')); assert.equal(element.state, 'ready');
  frame.dispatchEvent(new window.Event('load'));
  assert.equal(element.state, 'navigated'); assert.equal(root.querySelector('iframe'), null);
  assert.equal(root.querySelector('.state').textContent, previewCopy.navigated);
});
test('a replaced draft keeps keyboard focus in the preview', () => {
  const element = setup(), root = element.shadowRoot; element.artifact = html(dummy);
  root.querySelector('iframe').dispatchEvent(new window.FocusEvent('focus'));
  let focused = null; const focus = window.HTMLElement.prototype.focus;
  window.HTMLElement.prototype.focus = function () { focused = this; };
  try { element.artifact = html(dummy.replace('Revision 1', 'Revision 2')); } finally { window.HTMLElement.prototype.focus = focus; }
  assert.equal(focused, root.querySelector('iframe')); assert.match(focused.getAttribute('srcdoc'), /Revision 2/u);
});
