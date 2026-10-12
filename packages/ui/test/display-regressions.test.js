import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession, HTML_PREVIEW_HOST_CSP } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';

// CSP/sandbox execution is covered by the remote Chrome regressions. Here we
// simulate the policy proof to check actual frame nodes and session lifecycle.
const window = new Window({ url: 'http://localhost/', settings: { disableJavaScriptEvaluation: true, disableIframePageLoading: true } });
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const bytes = new TextEncoder().encode('<!doctype html><html><head><title>Populated canvas</title></head><body><input value="Draft state"></body></html>');
const artifact = (mediaType = 'text/html') => ({ id: 'draft1', mediaType, turnIds: ['source'], referenceIds: [], archived: false,
  feedback: { vote: 'clear', chips: [] }, provenance: { origin: 'ai-generated', generator: { provider: 'local-demo-fake' } } });

function fixture(t, { copy = en, model = 'mock', label, offered = false, concepts = [artifact()], host, htmlResponse } = {}) {
  const c = document.createElement('aithema-session'), session = createSession({ demo: true, locale: copy === de ? 'de' : 'en' });
  session.settings = { ...session.settings, origin: 'chosen', model, effort: 'none', voice: 'off', visuals: 'off' };
  if (label !== undefined) session.engine = { preset: 'best', model: { id: model, label, offered } };
  session.transcript = concepts.length ? [{ id: 'source', role: 'user', content: 'A populated interactive draft' }] : [];
  session.inputRevision = session.transcript.length; session.concepts = concepts; session.conceptVisualKind = 'html';
  session.featureMatrix = { best: Object.fromEntries(['text', 'analysis', 'html', 'images'].map(key => [key, { available: true }])) };
  const calls = [];
  t.mock.method(URL, 'createObjectURL', () => 'blob:canvas-regression');
  t.mock.method(URL, 'revokeObjectURL', () => {});
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push(String(url));
    if (url.endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
      options.signal.addEventListener('abort', () => controller.close(), { once: true });
    } }));
    if (url.endsWith('/features')) return Response.json(c.session.featureMatrix);
    if (url.endsWith('/html')) return htmlResponse ? htmlResponse() : new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } });
    if (url.endsWith('/image')) return new Response(Uint8Array.from([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
    if (url.endsWith('/settings')) return Response.json({ processingPreset: 'best', settings: session.settings, engine: session.engine,
      presets: { best: { offered: true, status: 'available', models: offered ? [{ id: model, label, status: 'available' }] : [], voices: [], visuals: [] } } });
    if (String(url).startsWith('/api/library')) return Response.json({ items: [], total: 0 });
    return Response.json(c.session);
  });
  const meta = document.createElement('meta'); meta.httpEquiv = 'Content-Security-Policy'; meta.content = HTML_PREVIEW_HOST_CSP;
  if (!document.head.querySelector('meta[http-equiv]')) document.head.append(meta);
  c.configure({ copy, copyForLocale: locale => ({ en, de })[locale], session, host }); document.body.append(c);
  t.after(() => c.remove());
  return { c, root: c.shadowRoot, calls };
}
async function ready(preview) {
  await tick(); await tick();
  if (document.querySelector('[data-aithema-html-policy-probe]')) {
    const proof = new window.Event('securitypolicyviolation');
    Object.assign(proof, { isTrusted: true, disposition: 'enforce', effectiveDirective: 'frame-src', blockedURI: 'data', originalPolicy: HTML_PREVIEW_HOST_CSP });
    document.dispatchEvent(proof);
  }
  await tick(); assert.equal(preview.state, 'ready', 'the regression starts with a populated executable iframe');
  return preview.shadowRoot.querySelector('iframe');
}
const receive = (c, type, data) => c.receive({ seq: c.session.seq + 1, type, data });
const revoke = (c, cause) => cause === 'consent' ? receive(c, 'consent.revised', { granted: false }) : receive(c, 'turn.withdrawn', { turnId: 'source' });

test('AIT-131: unfolding unloads a populated canvas and refolding restores only eligible bytes', async t => {
  const { root, calls } = fixture(t), canvas = root.querySelector('.canvas-html');
  root.querySelector('.fold').click(); const frame = await ready(canvas);
  root.querySelector('.fold-strip').click();
  assert.equal(canvas.artifact, null, 'a hidden canvas retains no draft bytes');
  assert.equal(canvas.shadowRoot.querySelector('iframe'), null, 'unfold stops the executable frame');
  assert.equal(frame.isConnected, false);
  root.querySelector('.fold').click(); await ready(canvas);
  assert.equal(calls.filter(url => url.endsWith('/html')).length, 1, 'eligible bytes can be restored from the owner cache');
});

test('AIT-131: a pending canvas load cannot mount a hidden iframe after unfold', async t => {
  let finish; const pending = new Promise(resolve => { finish = resolve; });
  const { root } = fixture(t, { htmlResponse: () => pending }), canvas = root.querySelector('.canvas-html');
  root.querySelector('.fold').click(); root.querySelector('.fold-strip').click();
  finish(new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })); await tick(); await tick();
  assert.equal(canvas.artifact, null, 'late eligible bytes stay cached without starting a hidden frame');
  assert.equal(canvas.shadowRoot.querySelector('iframe'), null);
});

for (const cause of ['consent', 'source']) for (const folded of [true, false]) {
  test(`AIT-131: ${cause} withdrawal redacts every populated artifact surface while ${folded ? 'folded' : 'unfolded'}`, async t => {
    const { c, root } = fixture(t), canvas = root.querySelector('.canvas-html'), modal = root.querySelector('.concept-html');
    root.querySelector('.fold').click(); await ready(canvas);
    if (!folded) root.querySelector('.fold-strip').click();
    // A hidden canvas can still hold data from an earlier paint or a late callback.
    // Revocation must clear it regardless of the current fold state.
    if (!folded) { canvas.artifact = { bytes, mediaType: 'text/html' }; await ready(canvas); }
    root.querySelector('.concept-tab').click(); await ready(modal);
    const frames = [canvas.shadowRoot.querySelector('iframe'), modal.shadowRoot.querySelector('iframe')];
    revoke(c, cause); await tick();
    assert.equal(c.session.concepts.length, 0);
    for (const preview of [canvas, modal]) {
      assert.equal(preview.artifact, null, 'revoked bytes are redacted from every surface');
      assert.equal(preview.shadowRoot.querySelector('iframe'), null);
    }
    assert.ok(frames.every(frame => !frame.isConnected));
    assert.equal(root.querySelector('.concept-viewer').open, false);
  });
}

for (const cause of ['consent', 'source']) test(`AIT-131: ${cause} withdrawal clears hidden populated canvas images`, async t => {
  const { c, root } = fixture(t, { concepts: [artifact('image/png')] });
  root.querySelector('.fold').click(); await tick(); await tick();
  const image = root.querySelector('.canvas-image'); assert.equal(image.hasAttribute('src'), true);
  root.querySelector('.fold-strip').click(); revoke(c, cause); await tick();
  assert.equal(image.hasAttribute('src'), false, 'revoked images disappear even when the canvas is hidden');
});

test('AIT-131: durable events preserve the populated canvas iframe, width selection and focus', async t => {
  const { c, root } = fixture(t), canvas = root.querySelector('.canvas-html');
  root.querySelector('.fold').click(); const frame = await ready(canvas), shown = canvas.artifact;
  canvas.width = 'phone'; const width = canvas.shadowRoot.querySelector('[data-width="phone"]'); width.focus();
  for (const [type, data] of [['session.paused', { paused: true }], ['concept.feedback', { artifactId: 'draft1', vote: 'up', chips: [] }],
    ['concept.state', { intent: c.session.conceptIntent, status: { phase: 'ready' } }]]) {
    receive(c, type, data); await tick(); await tick();
    assert.ok(canvas.shadowRoot.querySelector('iframe') === frame, `${type}: no browsing context replacement`);
    assert.ok(canvas.artifact === shown); assert.equal(canvas.width, 'phone'); assert.ok(canvas.shadowRoot.activeElement === width);
  }
});

test('AIT-131: translating preview copy preserves the existing frame and draft focus', async t => {
  const { root } = fixture(t), preview = root.querySelector('.canvas-html'); root.querySelector('.fold').click();
  const frame = await ready(preview); frame.focus();
  preview.copy = de.conceptPreview; await tick();
  assert.ok(preview.shadowRoot.querySelector('iframe') === frame, 'a label update must not restart interactive content');
  assert.ok(preview.shadowRoot.activeElement === frame); assert.equal(frame.title, de.conceptPreview.title);
  assert.equal(preview.shadowRoot.querySelector('.label-text').textContent, de.conceptPreview.label);
});

for (const [locale, copy] of [['en', en], ['de', de]]) for (const route of [
  { model: 'anthropic/claude-opus-5.5', expected: 'Claude Opus 5.5' },
  { model: '~anthropic/claude-haiku-latest', label: '~anthropic/claude-haiku-latest', expected: 'Claude Haiku' },
  { model: 'retired/private-model', expected: copy.display.modelUnknown },
  { model: 'retired/private-model', label: 'retired/private-model', offered: true, expected: copy.display.modelUnknown },
]) test(`AIT-131: ${locale} readiness and settings name ${route.model} (${route.offered ? 'catalog' : route.label ? 'raw label' : 'missing metadata'}) without raw ids`, async t => {
  const { c, root } = fixture(t, { copy, ...route, concepts: [] });
  assert.equal(root.querySelector('[data-ready="model"] dd > span:last-child').textContent, route.expected);
  c.openSettings(); await tick(); await tick();
  const select = root.querySelector('[data-select="model"]');
  assert.equal(select.querySelector('.select__value').textContent, route.expected);
  assert.equal(select.querySelector('.select__option strong').textContent, route.expected);
  assert.doesNotMatch(root.querySelector('.ready').textContent + root.querySelector('dialog.settings').textContent, /anthropic\/|retired\//u);
});

function track(t, target, types) {
  const listeners = new Map(types.map(type => [type, new Set()]));
  const add = target.addEventListener, remove = target.removeEventListener;
  t.mock.method(target, 'addEventListener', function (type, fn, ...options) { listeners.get(type)?.add(fn); return add.call(this, type, fn, ...options); });
  t.mock.method(target, 'removeEventListener', function (type, fn, ...options) { listeners.get(type)?.delete(fn); return remove.call(this, type, fn, ...options); });
  return () => Object.fromEntries([...listeners].map(([type, callbacks]) => [type, callbacks.size]));
}
test('AIT-131: detach removes reveal document, window and media listeners; reattach restores them once', async t => {
  const docCounts = track(t, document, ['keydown', 'visibilitychange']), viewCounts = track(t, window, ['resize']);
  const media = new window.EventTarget(); media.matches = false;
  const mediaCounts = track(t, media, ['change']); t.mock.method(window, 'matchMedia', () => media);
  const { c, root } = fixture(t); await tick();
  const before = [docCounts(), viewCounts(), mediaCounts()];
  root.querySelector('.band-orb .orb').click(); assert.equal(root.querySelector('.band').dataset.aithemaRevealState, 'open');
  c.remove();
  assert.deepEqual(docCounts(), { keydown: 0, visibilitychange: 0 });
  assert.deepEqual(viewCounts(), { resize: 0 }); assert.deepEqual(mediaCounts(), { change: 0 });
  assert.equal(root.querySelector('.band').dataset.aithemaRevealState, 'closed');
  document.body.append(c); await tick();
  assert.deepEqual([docCounts(), viewCounts(), mediaCounts()], before, 'reattach registers each global listener once');
  root.querySelector('.band-orb .orb').click(); assert.equal(root.querySelector('.band').dataset.aithemaRevealState, 'open');
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(root.querySelector('.band').dataset.aithemaRevealState, 'exiting', 'restored keyboard listener closes the reveal');
});

test('AIT-131: detach removes the conversations outside-click listener and reattach restores menu dismissal', async t => {
  const counts = track(t, document, ['click']); const { c, root } = fixture(t, { host: { library: true } });
  assert.deepEqual(counts(), { click: 1 });
  root.querySelector('.conversations-toggle').click(); assert.equal(root.querySelector('.conversations-menu').hidden, false);
  c.remove(); assert.deepEqual(counts(), { click: 0 }); assert.equal(root.querySelector('.conversations-menu').hidden, true);
  document.body.append(c); await tick(); assert.deepEqual(counts(), { click: 1 });
  root.querySelector('.conversations-toggle').click(); assert.equal(root.querySelector('.conversations-menu').hidden, false);
  document.body.click(); assert.equal(root.querySelector('.conversations-menu').hidden, true);
  c.remove(); document.body.append(c); assert.deepEqual(counts(), { click: 1 }, 'another reconnect does not duplicate the listener');
});
