import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession, inputRevision, htmlPreviewHostPolicy } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { bandStyles } from '../src/band-styles.js';

// CSP/sandbox execution is covered by the remote Chrome regressions. Here we
// simulate the policy proof to check actual frame nodes and session lifecycle.
const window = new Window({ url: 'http://localhost/', settings: { disableJavaScriptEvaluation: true, disableIframePageLoading: true } });
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
const previewURL = 'http://localhost/_aithema/html-preview';
const HTML_PREVIEW_HOST_CSP = htmlPreviewHostPolicy(previewURL);
const tick = () => new Promise(resolve => setImmediate(resolve));
const bytes = new TextEncoder().encode('<!doctype html><html><head><title>Populated canvas</title></head><body><input value="Draft state"></body></html>');
const artifact = (mediaType = 'text/html') => ({ id: 'draft1', mediaType, turnIds: ['source'], referenceIds: [], archived: false,
  feedback: { vote: 'clear', chips: [] }, provenance: { origin: 'ai-generated', generator: { provider: 'local-demo-fake' } } });

function fixture(t, { copy = en, model = 'mock', label, offered = false, served = {}, concepts = [artifact()], host, htmlResponse, visuals = { available: true }, kind = 'html', cost } = {}) {
  const c = document.createElement('aithema-session'), session = createSession({ demo: true, locale: copy === de ? 'de' : 'en' });
  session.settings = { ...session.settings, origin: 'chosen', model, effort: 'none', voice: 'off', visuals: 'off' };
  if (label !== undefined) session.engine = { preset: 'best', model: { id: model, label, offered, ...served } };
  session.transcript = concepts.length ? [{ id: 'source', role: 'user', content: 'A populated interactive draft' }] : [];
  session.inputRevision = session.transcript.length; session.concepts = concepts; session.conceptVisualKind = kind; session.conceptCost = cost;
  session.featureMatrix = { best: { text: { available: true }, analysis: { available: true }, html: kind === 'html' ? visuals : { available: true }, images: kind === 'image' ? visuals : { available: true } } };
  const calls = []; let snapshot;
  t.mock.method(URL, 'createObjectURL', () => 'blob:canvas-regression');
  t.mock.method(URL, 'revokeObjectURL', () => {});
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push(String(url));
    if (url.endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
      options.signal.addEventListener('abort', () => controller.close(), { once: true });
    } }));
    if (url.endsWith('/features')) return Response.json(c.session.featureMatrix);
    if (url.endsWith('/preview')) return htmlResponse ? htmlResponse() : Response.json({ url: previewURL + '?cap=' + String(calls.length).padStart(43, 'a'), expiresInMs: 60000 });
    if (url.endsWith('/html')) return htmlResponse ? htmlResponse() : new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } });
    if (url.endsWith('/image')) return new Response(Uint8Array.from([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
    if (url.endsWith('/settings')) return Response.json({ processingPreset: 'best', settings: session.settings, engine: session.engine,
      presets: { best: { offered: true, status: 'available', models: offered ? [{ id: model, label, status: 'available' }] : [], voices: [], visuals: [] } } });
    if (String(url).startsWith('/api/library')) return Response.json({ items: [], total: 0 });
    return Response.json(snapshot ?? c.session);
  });
  const meta = document.createElement('meta'); meta.httpEquiv = 'Content-Security-Policy'; meta.content = HTML_PREVIEW_HOST_CSP;
  if (!document.head.querySelector('meta[http-equiv]')) document.head.append(meta);
  c.configure({ copy, copyForLocale: locale => ({ en, de })[locale], session, host, concepts: { previewURL } }); document.body.append(c);
  t.after(() => c.remove());
  const refresh = async (visuals, cost = { maxMicro: 400_000 }) => {
    snapshot = c.session; snapshot.featureMatrix.best[kind === 'html' ? 'html' : 'images'] = visuals;
    snapshot.conceptCost = cost; snapshot.seq += 1;
    const refreshed = new Promise(resolve => c.addEventListener('aithema-features', resolve, { once: true }));
    receive(c, 'session.paused', { paused: false });
    await refreshed;
  };
  return { c, root: c.shadowRoot, calls, refresh };
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

test('AIT-155: scrolled band is solid through the hairline; its 12px fade is outside the box', () => {
  const surface = /\.band\[data-scrolled\] \{([^}]+)\}/u.exec(bandStyles)[1];
  assert.match(surface, /background:color-mix\(in srgb,var\(--aithema-accent\) 7%,var\(--aithema-paper\)\);/u);
  assert.doesNotMatch(surface, /transparent|gradient|padding|height|margin/u);
  const fade = /\.band\[data-scrolled\]::before \{([^}]+)\}/u.exec(bandStyles)[1];
  assert.match(fade, /content:''; position:absolute; inset:100% 0 auto; height:12px; pointer-events:none;/u);
  assert.match(fade, /background:linear-gradient\(to bottom,color-mix\(in srgb,var\(--aithema-accent\) 7%,var\(--aithema-paper\)\),transparent\);/u);
  assert.match(bandStyles, /\.band::after \{ content:''; position:absolute; inset:auto 0 0; height:1px;/u);
  assert.match(bandStyles, /\.audio-rail button \{ background:color-mix\(in srgb,var\(--aithema-surface\) 50%,transparent\);/u);
});

test('AIT-155: band restores scroll-zero paint and tracks scroll containers through detach/reattach', t => {
  const { c, root } = fixture(t), band = root.querySelector('.band'), workspace = root.querySelector('.workspace');
  const children = [...band.children]; let top = 0;
  t.mock.method(band, 'getBoundingClientRect', () => ({ top: 0 }));
  t.mock.method(workspace, 'getBoundingClientRect', () => ({ top }));
  const scroll = () => document.body.dispatchEvent(new window.Event('scroll'));
  assert.equal(band.hasAttribute('data-scrolled'), false);
  top = -80; scroll(); assert.equal(band.hasAttribute('data-scrolled'), true);
  top = 0; scroll(); assert.equal(band.hasAttribute('data-scrolled'), false);
  assert.deepEqual([...band.children], children, 'scroll paint adds no layout node');
  c.remove(); top = -80; scroll(); assert.equal(band.hasAttribute('data-scrolled'), false, 'detached component removes the scroll listener');
  document.body.append(c); assert.equal(band.hasAttribute('data-scrolled'), true, 'reattach reads the current offset');
  top = 0; scroll(); assert.equal(band.hasAttribute('data-scrolled'), false);
});

test('AIT-131: unfolding unloads a populated canvas and refolding restores only eligible bytes', async t => {
  const { root, calls } = fixture(t), canvas = root.querySelector('.canvas-html');
  root.querySelector('.fold').click(); const frame = await ready(canvas);
  root.querySelector('.fold-strip').click();
  assert.equal(canvas.artifact, null, 'a hidden canvas retains no draft bytes');
  assert.equal(canvas.shadowRoot.querySelector('iframe'), null, 'unfold stops the executable frame');
  assert.equal(frame.isConnected, false);
  root.querySelector('.fold').click(); await ready(canvas);
  assert.equal(calls.filter(url => url.endsWith('/preview')).length, 2, 'refolding mints a fresh single-use source');
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
    if (!folded) { canvas.artifact = { previewURL, mediaType: 'text/html', mint: async () => ({ url: previewURL + '?cap=' + 'a'.repeat(43), expiresInMs: 60000 }) }; await ready(canvas); }
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
  { model: 'openrouter/openai/gpt-4.1-mini', expected: 'GPT-4.1 mini' },
  { model: '~anthropic/claude-haiku-latest', label: '~anthropic/claude-haiku-latest', expected: 'Claude Haiku' },
  { model: 'retired/private-model', expected: copy.display.modelUnknown },
  { model: 'retired/private-model', label: 'retired/private-model', offered: true, expected: copy.display.modelUnknown },
  { model: 'default', label: 'Anthropic via OpenRouter', offered: true, expected: copy.catalogLabels['Anthropic via OpenRouter'] },
  { model: 'default', label: 'Anthropic via OpenRouter', offered: true, served: { reply: 'default', understanding: 'default' },
    expected: copy.catalogLabels['Anthropic via OpenRouter'] },
  { model: 'default', label: 'Anthropic via OpenRouter', offered: true, served: { reply: 'host/private-reply', understanding: 'host/private-understanding' },
    expected: copy.catalogLabels['Anthropic via OpenRouter'], replyExpected: copy.display.modelUnknown, understandingExpected: copy.display.modelUnknown },
  // AIT-267: intended behaviour change per Tick: an unknown served route cannot inherit the option's provider claim.
  { model: 'default', label: 'Anthropic via OpenRouter', offered: true, served: { reply: 'anthropic/claude-opus-5.5', understanding: 'host/private-route' },
    expected: copy.catalogLabels['Anthropic via OpenRouter'], replyExpected: 'Claude Opus 5.5', understandingExpected: copy.display.modelUnknown },
  { model: 'default', label: 'Anthropic via OpenRouter', offered: true, served: { reply: '~anthropic/claude-haiku-latest', understanding: 'openai/gpt-4.1-mini' },
    expected: copy.catalogLabels['Anthropic via OpenRouter'], replyExpected: 'Claude Haiku', understandingExpected: 'GPT-4.1 mini' },
  { model: 'default', label: 'Anthropic via OpenRouter', offered: true, served: { reply: 'host/private-reply', understanding: 'default' },
    expected: copy.catalogLabels['Anthropic via OpenRouter'], replyExpected: copy.display.modelUnknown },
  { model: 'default', label: 'Anthropic via OpenRouter', offered: true, served: { reply: 'default', understanding: 'host/private-understanding' },
    expected: copy.catalogLabels['Anthropic via OpenRouter'], understandingExpected: copy.display.modelUnknown },
  { model: 'anthropic/claude-opus-5.5', label: 'Anthropic via OpenRouter', offered: true, expected: 'Claude Opus 5.5' },
  ...['Uncurated host model', '~anthropic/claude-opus-latest via OpenRouter', '', undefined].map(label =>
    ({ model: 'default', label, offered: true, served: { reply: 'default', understanding: 'default' }, expected: copy.display.modelUnknown })),
]) test(`AIT-265/AIT-267: ${locale} ready card, settings and footer name ${route.model} (${route.label ?? 'missing label'}; ${route.served?.reply ?? 'option'}/${route.served?.understanding ?? 'option'}) without raw ids`, async t => {
  const { c, root } = fixture(t, { copy, ...route, concepts: [] });
  assert.equal(root.querySelector('[data-ready="model"] dd > span:last-child').textContent, route.expected);
  const details = root.querySelector('.engine__detail').textContent.split('\n');
  assert.equal(details[1], `${copy.display.reply}: ${route.replyExpected ?? route.expected}`);
  assert.equal(details[2], `${copy.display.understanding}: ${route.understandingExpected ?? route.expected}`);
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
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
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
  assert.deepEqual(counts(), { click: 2 });
  root.querySelector('.conversations-toggle').click(); assert.equal(root.querySelector('.conversations-menu').hidden, false);
  c.remove(); assert.deepEqual(counts(), { click: 0 }); assert.equal(root.querySelector('.conversations-menu').hidden, true);
  document.body.append(c); await tick(); assert.deepEqual(counts(), { click: 2 });
  root.querySelector('.conversations-toggle').click(); assert.equal(root.querySelector('.conversations-menu').hidden, false);
  document.body.click(); assert.equal(root.querySelector('.conversations-menu').hidden, true);
  c.remove(); document.body.append(c); assert.deepEqual(counts(), { click: 2 }, 'another reconnect does not duplicate the listener');
});

for (const copy of [de, en]) for (const kind of ['html', 'image']) {
  test(`AIT-229: ${copy === de ? 'DE' : 'EN'}/${kind} no-drafts host keeps transcript through fold attempts and incoming replies`, t => {
    const { c, root } = fixture(t, { copy, kind, concepts: [], visuals: { available: false, reason: 'not configured' } });
    receive(c, 'turn.final', { id: 'source', role: 'user', content: 'A shop for cushions' });
    // Exercise both the ordinary conversation and the final open-question card.
    for (const options of [[], [{ text: 'Yes' }, { text: 'No' }]]) {
      receive(c, 'turn.final', { id: `question-${options.length}`, role: 'assistant', content: 'Which option?', question_short: 'Which option?', options, inputRevision: inputRevision(c.session) });
      assert.equal(root.querySelector('.qcard').hidden, !options.length);
      root.querySelector('.fold').click();
      assert.equal(root.querySelector('.conversation').hidden, false, 'the transcript owns the space');
      assert.equal(root.querySelector('.fold-view').hidden, true, 'no empty canvas or promise');
      assert.equal(root.querySelector('.workspace').hasAttribute('data-folded'), false);
      assert.equal(root.querySelector('.concept-activity-text').textContent, copy.display.draftsOff);
    }
  });
  test(`AIT-229: ${copy === de ? 'DE' : 'EN'}/${kind} configured host can show empty canvas without a price quote`, t => {
    const { root } = fixture(t, { copy, kind, concepts: [] });
    root.querySelector('.fold').click();
    assert.equal(root.querySelector('.conversation').hidden, true);
    assert.equal(root.querySelector('.fold-view').hidden, false);
    assert.equal(root.querySelector('.canvas-empty > span').textContent, `${copy.display.draftsQuote}\u00a0· ${copy.display.draftsRetry}`);
    assert.equal(root.querySelector('.canvas-empty .drafts-settings-action').textContent, copy.display.draftsRetry);
    root.querySelector('.fold-strip').click();
    assert.equal(root.querySelector('.conversation').hidden, false);
  });
}

test('AIT-229: removing the selected capability while HTML loads restores transcript and rejects late bytes', async t => {
  let finish; const pending = new Promise(resolve => { finish = resolve; });
  const { c, root } = fixture(t, { htmlResponse: () => pending });
  root.querySelector('.fold').click();
  assert.equal(root.querySelector('.fold-view').hidden, false);
  receive(c, 'settings.changed', { processingPreset: 'device', settings: c.session.settings });
  assert.equal(root.querySelector('.conversation').hidden, false);
  assert.equal(root.querySelector('.fold-view').hidden, true);
  finish(new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }));
  await tick(); await tick();
  assert.equal(root.querySelector('.canvas-html').artifact, null);
  assert.equal(root.querySelector('.canvas-html').shadowRoot.querySelector('iframe'), null);
});

for (const copy of [de, en]) test(`AIT-229: ${copy === de ? 'DE' : 'EN'} missing capability fails closed even with an old draft`, t => {
  const { root } = fixture(t, { copy, visuals: null });
  root.querySelector('.fold').click();
  assert.equal(root.querySelector('.conversation').hidden, false);
  assert.equal(root.querySelector('.fold-view').hidden, true);
});

// Admission restrictions must preserve the current fold even before the first draft.
for (const copy of [de, en]) for (const [name, reason, cost] of [
  ['quote-missing', null, null],
  ['admission-timeout', 'admission deadline', { maxMicro: 400_000 }],
  ['temporarily-unavailable', 'plugin unhealthy', { maxMicro: 400_000 }],
  ['consent-needed', 'current processing consent required', { maxMicro: 400_000 }],
  ['credits-low', 'budget denied', { maxMicro: 400_000 }],
  ['future-temporary-reason', 'new transient restriction', { maxMicro: 400_000 }],
]) test(`AIT-229: ${copy === de ? 'DE' : 'EN'} ${name} keeps an empty fold and blocks requests`, async t => {
  const { c, root, calls, refresh } = fixture(t, { copy, concepts: [], cost: { maxMicro: 400_000 } });
  receive(c, 'turn.final', { id: 'source', role: 'user', content: 'A shop for cushions' });
  root.querySelector('.fold').click();
  assert.equal(root.querySelector('.workspace').hasAttribute('data-folded'), true);
  await refresh(reason ? { available: false, reason } : { available: true }, cost);
  assert.equal(root.querySelector('.workspace').hasAttribute('data-folded'), true, 'temporary restriction keeps the fold');
  assert.equal(root.querySelector('.conversation').hidden, true);
  assert.equal(root.querySelector('.concept-request').disabled, true);
  assert.equal(root.querySelector('.concept-request').hidden, true);
  root.querySelector('.concept-request').click(); await tick();
  assert.equal(calls.some(url => /\/concepts(?:\/request|\/regenerate)?$/u.test(url)), false, 'no generation request');
  const notice = root.querySelector('.canvas-empty > span');
  assert.notEqual(notice.textContent, copy.layout.canvasEmpty, 'empty canvas explains the restriction');
  if (name === 'quote-missing' || name === 'admission-timeout') assert.equal(notice.querySelector('button').textContent, copy.display.draftsRetry);
  if (name === 'consent-needed') {
    assert.equal(notice.querySelector('button').textContent, copy.featureConsent.action);
    assert.notEqual(notice.querySelector('[id]').id, root.querySelector('.concept-activity-text [id]').id, 'unique accessible labels');
    notice.querySelector('button').click();
    assert.equal(root.querySelector('dialog.settings').open, true, 'canvas action opens consent settings');
  }
  // The same restriction permits a fresh fold attempt on a capable host.
  root.querySelector('.fold-strip').click(); root.querySelector('.fold').click();
  assert.equal(root.querySelector('.workspace').hasAttribute('data-folded'), true);
});

for (const reason of ['not configured', 'not offered', 'visuals not offered', 'preset not configured', 'unavailable on device', 'plugin not in preset']) {
  test(`AIT-229: ${reason} capability loss unfolds an empty canvas and blocks refolding`, async t => {
    const { c, root, calls, refresh } = fixture(t, { concepts: [] });
    receive(c, 'turn.final', { id: 'source', role: 'user', content: 'A shop for cushions' });
    root.querySelector('.fold').click();
    assert.equal(root.querySelector('.workspace').hasAttribute('data-folded'), true);
    await refresh({ available: false, reason });
    assert.equal(root.querySelector('.conversation').hidden, false);
    assert.equal(root.querySelector('.fold-view').hidden, true);
    root.querySelector('.fold').click(); root.querySelector('.concept-request').click(); await tick();
    assert.equal(root.querySelector('.workspace').hasAttribute('data-folded'), false);
    assert.equal(root.querySelector('.concept-request').disabled, true);
    assert.equal(calls.some(url => /\/concepts(?:\/request|\/regenerate)?$/u.test(url)), false);
  });
}

for (const copy of [de, en]) test(`AIT-229: ${copy === de ? 'DE' : 'EN'} preset-excluded cached draft stays readable with a working choice action`, async t => {
  const { root, calls, refresh } = fixture(t, { copy });
  root.querySelector('.fold').click();
  const canvas = root.querySelector('.canvas-html'), frame = await ready(canvas);
  await refresh({ available: false, reason: 'plugin not in preset' });
  assert.equal(root.querySelector('.workspace').hasAttribute('data-folded'), true);
  assert.ok(canvas.shadowRoot.querySelector('iframe') === frame, 'cached draft remains readable');
  assert.equal(root.querySelector('.concept-request').disabled, true);
  const line = root.querySelector('.concept-activity-text');
  assert.equal(line.textContent, `${copy.display.draftsPreset}\u00a0· ${copy.display.draftsChoose}`);
  line.querySelector('button').click(); await tick();
  assert.equal(root.querySelector('dialog.settings').open, true);
  assert.equal(calls.filter(url => url.endsWith('/preview')).length, 1, 'the mounted source is preserved');
});

test('AIT-228: rendered overview, locale flag and all draft actions retain their nodes across quote changes', async t => {
  for (const copy of [de, en]) {
    const { c, root, refresh } = fixture(t, { copy, cost: { maxMicro: 0 } });
    receive(c, 'concept.state', { intent: c.session.conceptIntent, status: { phase: 'failed' } });
    assert.equal(root.querySelector('#understanding-title').textContent, copy.understanding);
    assert.equal(root.querySelector('.concept-tab').textContent, copy.conceptTab);
    assert.equal(root.querySelector('.engine__flag').dataset.kind, copy.display.locale);
    const request = root.querySelector('.concept-request'), regenerate = root.querySelector('.concept-regenerate');
    for (const [micro, label] of [[0, ''], [1, `<\u00a01\u00a0${copy.display.credit}`], [10000, copy.display.creditUpperBound.replace('{cost}', `1 ${copy.display.credit}`).replaceAll(' ', '\u00a0')], [20000, copy.display.creditUpperBound.replace('{cost}', `2 ${copy.display.credits}`).replaceAll(' ', '\u00a0')]]) {
      await refresh({ available: true }, { maxMicro: micro });
      assert.equal(root.querySelector('.concept-request'), request);
      assert.equal(root.querySelector('.concept-regenerate'), regenerate);
      assert.equal(request.textContent, [copy.conceptRetry, label].filter(Boolean).join('\u00a0· '));
      assert.equal(regenerate.textContent, [copy.conceptRegenerate, label].filter(Boolean).join('\u00a0· '));
    }
  }
});

test('AIT-228: fractional quotes gate Retry and Regenerate exactly like missing quotes', async t => {
  for (const copy of [de, en]) {
    const { c, root, refresh } = fixture(t, { copy, cost: { maxMicro: 10000 } });
    root.querySelector('.concept-tab').click(); await tick();
    const request = root.querySelector('.concept-request'), regenerate = root.querySelector('.concept-regenerate');
    for (const phase of ['idle', 'failed', 'ready']) {
      receive(c, 'concept.state', { intent: c.session.conceptIntent, status: { phase } });
      await refresh({ available: true }, null);
      const missingLine = root.querySelector('.concept-activity-text').textContent;
      await refresh({ available: true }, { maxMicro: 1234.5 });
      assert.equal(root.querySelector('.concept-activity-text').textContent, missingLine);
      assert.equal(request.textContent, `${copy.display.draftsQuote}\u00a0· ${copy.display.draftsRetry}`);
      for (const button of [request, regenerate]) {
        assert.equal(button.disabled, true, `${phase}: unpriced paid action is disabled`);
        assert.equal(button.hidden, true, `${phase}: unpriced paid action is hidden`);
      }
      await refresh({ available: true }, { maxMicro: 10000 });
      assert.equal(request.disabled, false, `${phase}: a valid quote restores the action`);
      assert.equal(regenerate.disabled, false);
    }
    root.querySelector('.concept-close').click(); await tick();
    root.activeElement?.blur();
  }
});

for (const surface of ['modal', 'canvas']) for (const cause of ['close', 'switch', 'consent', 'source', 'erasure']) {
  test(`AIT-353: ${surface} rejects a late minted source after ${cause}`, async t => {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const { c, root, calls } = fixture(t, { htmlResponse: () => pending });
    const preview = root.querySelector(surface === 'modal' ? '.concept-html' : '.canvas-html');
    root.querySelector(surface === 'modal' ? '.concept-tab' : '.fold').click();
    await tick();
    if (document.querySelector('[data-aithema-html-policy-probe]')) {
      const proof = new window.Event('securitypolicyviolation');
      Object.assign(proof, { isTrusted: true, disposition: 'enforce', effectiveDirective: 'frame-src', blockedURI: 'data', originalPolicy: HTML_PREVIEW_HOST_CSP });
      document.dispatchEvent(proof);
    }
    await tick();
    assert.equal(preview.state, 'loading');
    assert.equal(calls.filter(url => url.endsWith('/preview')).length, 1, 'the scoped owner mint is actually pending');
    if (cause === 'close') root.querySelector(surface === 'modal' ? '.concept-close' : '.fold-strip').click();
    else if (cause === 'switch') c.configure({ copy: en, session: createSession({ demo: true }), concepts: { previewURL } });
    else if (cause === 'erasure') receive(c, 'session.erased', {});
    else revoke(c, cause === 'source' ? 'source' : 'consent');
    finish(Response.json({ url: previewURL + '?cap=' + 'z'.repeat(43), expiresInMs: 60000 })); await tick(); await tick();
    assert.equal(preview.artifact, null);
    assert.equal(preview.shadowRoot.querySelector('iframe'), null, 'late capabilities never mount after scope termination');
    assert.equal(calls.some(url => /\/concepts(?:\/[^/]+\/regenerate)?$/u.test(url)), false, 'viewing makes no generation or spend call');
  });
}
