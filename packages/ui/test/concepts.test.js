import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { conceptProgress, conceptKind, conceptStateText } from '../src/concept-view.js';
const window = new Window({ url: 'http://localhost/' });
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
const tick = () => new Promise(r => setImmediate(r));
function item(id, extra = {}) { return { id, mediaType: 'image/png', width: 480, height: 320, turnIds: ['first'], referenceIds: [], archived: false,
  feedback: { vote: 'clear', chips: [] }, provenance: { origin: 'ai-generated', generator: { provider: 'local-demo-fake' } }, ...extra }; }
// A clickable draft as the server publishes it (AIT-113): text/html, no pixel size.
const draftBytes = revision => new TextEncoder().encode(`<!doctype html><html><head><title>Draft</title></head><body><p>Revision ${revision}</p></body></html>`);
function draft(id, extra = {}) { return item(id, { mediaType: 'text/html', width: undefined, height: undefined, visualKind: 'html',
  provenance: { origin: 'ai-generated', modality: 'html', generator: { provider: 'local-demo-fake' } }, ...extra }); }
function setup(t, { concepts = [item('image1')], copy = en, sessionToken = 'owner-fixture', baseUrl = '', session: extra = {}, refuse } = {}) {
  const c = document.createElement('aithema-session'), session = createSession({ demo: true });
  session.transcript = [{ id: 'first', role: 'user', content: 'An API dashboard' }]; session.inputRevision = 1;
  session.concepts = concepts; session.conceptCost = { maxMicro: 1234 };
  session.featureMatrix = { best: { text: { available: true }, analysis: { available: true }, images: { available: true }, html: { available: true } } };
  Object.assign(session, extra);
  const calls = [], downloads = [], revoked = []; let blobId = 0;
  t.mock.method(URL, 'createObjectURL', () => 'blob:concept-fixture-' + ++blobId); t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));
  t.mock.method(window.HTMLAnchorElement.prototype, 'click', function () { downloads.push({ href: this.href, name: this.download }); });
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/events')) return new Response(new ReadableStream({ start(controller) { options.signal.addEventListener('abort', () => controller.close(), { once: true }); } }));
    if (url.endsWith('/image') || url.includes('/image?')) return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
    if (url.endsWith('/html')) return new Response(draftBytes(/(\d+)\/html$/u.exec(url)?.[1] ?? 0), { headers: { 'content-type': 'application/octet-stream' } });
    if (!options.body) return Response.json(c.session);
    if (refuse) return Response.json(refuse.body, { status: refuse.status });
    const body = JSON.parse(options.body); let event;
    if (url.endsWith('/feedback') || url.endsWith('/reject')) event = { seq: c.session.seq + 1, type: 'concept.feedback', data: { artifactId: /\/concepts\/([^/]+)\/(?:feedback|reject)$/u.exec(url)[1],
      vote: body.vote, chips: body.chips, archived: url.endsWith('/reject') } };
    else event = { seq: c.session.seq + 1, type: 'concept.state', data: { intent: c.session.conceptIntent, status: { phase: 'waiting' } } };
    return Response.json({ event });
  });
  c.configure({ copy, session, sessionToken, baseUrl }); t.after(() => c.remove());
  return { c, root: c.shadowRoot, calls, downloads, revoked };
}
test('viewer opens cached bytes without spending and has accessible title, count, keyboard navigation and disclosure', async t => {
  const { c, root, calls } = setup(t, { concepts: [item('image1'), item('image2', { provenance: { origin: 'ai-manipulated', generator: { provider: 'openai' } } })] });
  await tick(); root.querySelector('.concept-tab').click(); await tick();
  const dialog = root.querySelector('.concept-viewer'); assert.equal(dialog.open, true);
  assert.equal(root.querySelector('#concept-title').textContent, 'Visual concept 2');
  assert.equal(root.querySelector('.concept-count').textContent, '2 of 2'); assert.equal(root.querySelector('.concept-disclosure').textContent, en.conceptManipulated);
  assert.ok(root.querySelector('.concept-image').src.startsWith('blob:')); assert.equal(root.querySelector('.concept-next').disabled, true);
  dialog.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft' })); await tick();
  assert.equal(root.querySelector('.concept-count').textContent, '1 of 2'); assert.equal(root.querySelector('.concept-disclosure').textContent, en.conceptFake);
  dialog.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })); assert.equal(dialog.open, false);
  assert.ok(calls.every(c => !c.options.body), 'opening, navigation and close are GET-only');
  assert.ok(calls.every(c => new Headers(c.options.headers).get('x-aithema-session-token') === 'owner-fixture'));
  assert.equal(root.innerHTML.includes('owner-fixture'), false); assert.equal(c.session.conceptIntent.visualIntent, null);
});
test('thumbs and guidance toggles persist on their artifact; regenerate shows cost and records explicit intent', async t => {
  const { c, root, calls } = setup(t); root.querySelector('.concept-tab').click(); await tick();
  assert.match(root.querySelector('.concept-regenerate').textContent, /1234/);
  root.querySelector('.concept-up').click(); await tick(); assert.equal(c.session.concepts[0].feedback.vote, 'up');
  assert.equal(root.querySelector('.concept-up').getAttribute('aria-pressed'), 'true');
  const toggle = root.querySelector('.concept-guidance-options button'); assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  toggle.click(); await tick();
  assert.deepEqual(c.session.concepts[0].feedback.chips, ['Simpler layout']); assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  // Pressing the same toggle again removes the guidance (GUI-27: toggles, not pills with a separate remove row).
  toggle.click(); await tick(); assert.deepEqual(c.session.concepts[0].feedback.chips, []); assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(root.querySelector('.concept-guidance-selected'), null);
  root.querySelector('.concept-regenerate').click(); await tick();
  const spending = calls.filter(c => c.url.endsWith('/regenerate')); assert.equal(spending.length, 1);
  assert.deepEqual(JSON.parse(spending[0].options.body), { clientEventId: JSON.parse(spending[0].options.body).clientEventId, intent: true, sourceTurnId: 'first' });
  assert.equal(calls.filter(c => c.options.body).length, 4, 'feedback never generates implicitly');
});
test('a focused guidance toggle keeps its node and focus through unsolicited live renders (AIT-116 focus)', async t => {
  const { c, root } = setup(t, { concepts: [item('image1', { feedback: { vote: 'up', chips: ['Simpler layout', 'Older guidance'] } })] });
  document.body.append(c); root.querySelector('.concept-tab').click(); await tick();
  const pressed = () => [...root.querySelectorAll('.concept-guidance-options button[aria-pressed="true"]')].map(b => b.textContent);
  // Guidance outside the fixed choices (e.g. saved in another language) is an extra pressed toggle after them.
  assert.deepEqual(pressed(), ['Simpler layout', 'Older guidance']);
  const chip = root.querySelector('.concept-guidance-options button[data-value="Simpler layout"]'); chip.focus();
  assert.ok(root.activeElement === chip);
  c.receive({ seq: c.session.seq + 1, type: 'concept.state', data: { intent: c.session.conceptIntent, status: { phase: 'ready' }, artifact: item('image2') } });
  c.receive({ seq: c.session.seq + 1, type: 'concept.feedback', data: { artifactId: 'image1', vote: 'up', chips: ['Simpler layout', 'More contrast'], archived: false } });
  assert.ok(root.querySelector('.concept-guidance-options button[data-value="Simpler layout"]') === chip, 'the pressed guidance toggle survives');
  assert.equal(chip.isConnected, true); assert.ok(root.activeElement === chip, 'keyboard focus stays on it');
  assert.deepEqual(pressed(), ['Simpler layout', 'More contrast'], 'the extra toggle went with its guidance');
  assert.equal(root.querySelectorAll('.concept-guidance-options button').length, en.conceptGuidance.length);
  root.querySelector('.concept-guidance-options button[data-value="More contrast"]').click(); await tick();
  assert.deepEqual(c.session.concepts[0].feedback.chips, ['Simpler layout'], 'removal uses the current chips');
});
test('a live pending update that disables the focused Regenerate keeps focus in the viewer, in both POST/SSE orders (AIT-116 gate 3)', async t => {
  for (const order of ['ack-first', 'sse-first']) {
    const { c, root } = setup(t); document.body.append(c); root.querySelector('.concept-tab').click(); await tick();
    const dialog = root.querySelector('.concept-viewer'), regenerate = root.querySelector('.concept-regenerate');
    const pending = () => c.receive({ seq: c.session.seq + 1, type: 'concept.state', data: { intent: c.session.conceptIntent, status: { phase: 'pending', startedAt: Date.now(), estimateMs: 45000 } } });
    regenerate.focus(); assert.ok(root.activeElement === regenerate, order);
    if (order === 'sse-first') pending();
    regenerate.click(); await tick();
    if (order === 'ack-first') pending();
    const active = root.activeElement;
    assert.ok(active && dialog.contains(active), `${order}: focus stays inside the viewer`);
    assert.equal(active.disabled, false, `${order}: focus is on an enabled control, so arrow keys still reach the viewer`);
    c.receive({ seq: c.session.seq + 1, type: 'concept.state', data: { intent: c.session.conceptIntent, status: { phase: 'ready' }, artifact: item('image2') } });
    assert.ok(dialog.contains(root.activeElement), `${order}: focus is still inside after the new concept arrives`);
    c.remove();
  }
});
test('reject archives the exact item and returns to conversation without a paid request', async t => {
  const { c, root, calls } = setup(t); root.querySelector('.concept-tab').click(); await tick();
  root.querySelector('.concept-reject').click(); await tick();
  assert.equal(c.session.concepts[0].archived, true); assert.equal(root.querySelector('.concept-viewer').open, false);
  assert.equal(root.querySelector('.concept-tab').disabled, true);
  assert.equal(calls.filter(c => c.options.body).length, 1); assert.ok(calls.find(c => c.url.endsWith('/reject')));
});
test('download is a real same-origin owner-authenticated GET and revokes its temporary URL', async t => {
  const { root, calls, downloads, revoked } = setup(t); root.querySelector('.concept-tab').click(); await tick();
  root.querySelector('.concept-download').click(); await tick();
  const get = calls.find(c => c.url.endsWith('/image?download=1')); assert.ok(get); assert.equal(get.options.body, undefined);
  assert.equal(new Headers(get.options.headers).get('x-aithema-session-token'), 'owner-fixture');
  assert.match(downloads[0].name, /^concept-image1.png$/); assert.ok(revoked.includes(downloads[0].href));
});
test('foreign image URLs cannot receive ownership headers or become download targets', async t => {
  const { root, calls, downloads } = setup(t, { baseUrl: 'https://other.example' });
  root.querySelector('.concept-tab').click(); await tick(); root.querySelector('.concept-download').click(); await tick();
  assert.equal(calls.length, 0); assert.equal(downloads.length, 0); assert.equal(root.querySelector('.concept-image').hasAttribute('src'), false);
});
test('a foreign baseUrl receives no owner-authenticated concept request: request, regenerate, Like, Dislike, guidance, Reject and eligibility are refused before sending', async t => {
  for (const kind of ['image', 'html']) {
    const concepts = [kind === 'html' ? draft('c1', { feedback: { vote: 'clear', chips: ['Simpler layout'] } }) : item('c1', { feedback: { vote: 'clear', chips: ['Simpler layout'] } })];
    const { c, root, calls } = setup(t, { baseUrl: 'https://other.example', concepts, session: { conceptVisualKind: kind } });
    // Views left from earlier tests also hear the page's visibility signal; they post to their own (same) origin.
    const foreign = () => calls.filter(call => new URL(call.url, 'http://localhost/').origin !== 'http://localhost');
    const owned = () => foreign().filter(call => new Headers(call.options.headers).get('x-aithema-session-token') !== null).length;
    const steps = {
      'request': () => root.querySelector('.concept-request').click(),
      'open': () => root.querySelector('.concept-tab').click(),
      'regenerate': () => root.querySelector('.concept-regenerate').click(),
      'Like': () => root.querySelector('.concept-up').click(),
      'Dislike': () => root.querySelector('.concept-down').click(),
      'add guidance': () => root.querySelector('.concept-guidance-options button:nth-child(2)').click(),
      'remove guidance': () => root.querySelector('.concept-guidance-options button[aria-pressed="true"]').click(),
      'download': () => root.querySelector('.concept-download').click(),
      'Reject': () => root.querySelector('.concept-reject').click(),
      'eligibility': () => { t.mock.method(document, 'hidden', () => true, { getter: true }); document.dispatchEvent(new window.Event('visibilitychange')); },
    };
    for (const [name, step] of Object.entries(steps)) {
      step(); await tick(); await tick();
      assert.equal(owned(), 0, `${kind} ${name}: no request carries the owner header`); assert.deepEqual(foreign().map(call => call.url), [], `${kind} ${name}: nothing is sent`);
    }
    assert.equal(root.querySelector('.concept-viewer').open, true, `${kind}: a refused Reject leaves the viewer open`);
    assert.equal(root.querySelector('.concept-viewer-message').textContent, en.controlFailed);
    assert.equal(root.querySelector('.concept-activity-text').textContent, en.conceptFailed);
    assert.deepEqual(c.session.concepts[0].feedback, { vote: 'clear', chips: ['Simpler layout'] }); assert.equal(c.session.concepts[0].archived, false);
    c.remove(); t.mock.restoreAll();
  }
});
test('automatic concept arrivals render under the pointer; composer, tabs and viewer controls keep their nodes and fixed geometry', async t => {
  const { c, root } = setup(t); root.querySelector('.concept-tab').click(); await tick();
  const composer = root.querySelector('.composer'), tab = root.querySelector('.concept-tab'), controls = root.querySelector('.concept-viewer-controls');
  const regenerate = root.querySelector('.concept-regenerate'), count = root.querySelector('.concept-count');
  controls.dispatchEvent(new window.Event('pointerenter'));
  const prior = root.querySelector('#concept-title').textContent;
  c.receive({ seq: c.session.seq + 1, type: 'concept.state', data: { intent: c.session.conceptIntent, status: { phase: 'ready' }, artifact: item('image2') } });
  assert.equal(root.querySelector('#concept-title').textContent, prior, 'the shown concept stays selected');
  assert.equal(count.textContent, '1 of 2', 'the count updates at once (AIT-116 D3)'); assert.equal(root.querySelector('.concept-next').disabled, false);
  assert.equal(root.querySelector('.composer'), composer); assert.equal(root.querySelector('.concept-tab'), tab); assert.equal(root.querySelector('.concept-regenerate'), regenerate);
  root.querySelector('.concept-viewer').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(count.textContent, '2 of 2', 'ArrowRight navigates to the new concept');
  controls.dispatchEvent(new window.Event('pointerleave')); assert.equal(count.textContent, '2 of 2');
  const css = root.querySelector('style').textContent;
  assert.match(css, /grid-template-rows:3.6rem 8rem 5.4rem minmax\(0,1fr\) 10rem/);
  assert.match(css, /grid-template-rows:4rem minmax\(0,1fr\) 12.5rem/);
  assert.match(css, /concept-navigation, \.concept-feedback \{ display:flex; align-items:center; gap:\.25rem; height:2\.75rem; \}/);
});
test('progress never reports estimated completion; failure offers an explicit retry; pause disables spending without hiding cached viewer', async t => {
  assert.deepEqual(conceptProgress({ startedAt: 0, estimateMs: 45000 }, 50000), { percent: 99, seconds: 0, overdue: true });
  const { c, root, calls } = setup(t);
  c.receive({ seq: c.session.seq + 1, type: 'concept.state', data: { intent: c.session.conceptIntent,
    status: { phase: 'pending', startedAt: Date.now(), estimateMs: 45000 } } });
  assert.match(root.querySelector('.concept-countdown').textContent, /estimate/); assert.equal(root.querySelector('.concept-request').disabled, true);
  c.receive({ seq: c.session.seq + 1, type: 'concept.state', data: { intent: c.session.conceptIntent, status: { phase: 'failed' } } });
  assert.match(root.querySelector('.concept-request').textContent, /Retry/);
  root.querySelector('.concept-request').click(); await tick(); assert.equal(calls.filter(c => c.options.body).length, 1);
  c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true } });
  assert.equal(root.querySelector('.concept-request').disabled, true); root.querySelector('.concept-tab').click(); await tick();
  assert.equal(root.querySelector('.concept-viewer').open, true); assert.equal(root.querySelector('.concept-regenerate').disabled, true);
  assert.equal(root.querySelector('.concept-regenerate').title, en.paused);
});
test('withdrawal revokes dependent images immediately while hovered; host copy remains literal and device gives a reason', async t => {
  const copy = { ...en, conceptTitle: '<script>Concept {number}</script>', conceptView: 'Bild ansehen', conceptGuidance: ['<b>literal</b>'] };
  const { c, root, revoked } = setup(t, { copy }); root.querySelector('.concept-tab').click(); await tick();
  assert.equal(root.querySelector('#concept-title script'), null); assert.match(root.querySelector('#concept-title').textContent, /<script>/);
  root.querySelector('.concept-viewer-controls').dispatchEvent(new window.Event('pointerenter'));
  c.receive({ seq: c.session.seq + 1, type: 'turn.withdrawn', data: { turnId: 'first', at: new Date().toISOString() } });
  assert.equal(root.querySelector('.concept-image').hasAttribute('src'), false); assert.equal(root.querySelector('.concept-viewer').open, false); assert.ok(revoked.length > 0);
  c.configure({ copy, session: createSession({ processingPreset: 'device' }) });
  assert.equal(root.querySelector('.concept-request').disabled, true); assert.equal(root.querySelector('.concept-request').title, en.reasons['unavailable on device']);
});

test('closing an already closed viewer during withdrawal leaves composer focus in place', async t => {
  const { c, root } = setup(t); t.mock.method(c, 'connectedCallback', () => {}); document.body.append(c); await tick();
  const trigger = root.querySelector('.concept-tab'); trigger.focus(); trigger.click(); await tick();
  root.querySelector('.concept-close').click(); assert.equal(root.activeElement === trigger, true);
  const composer = root.querySelector('textarea'); composer.focus();
  c.receive({ seq: c.session.seq + 1, type: 'turn.withdrawn', data: { turnId: 'first', at: new Date().toISOString() } });
  assert.equal(root.activeElement === composer, true);
});
test('hiding the page sends durable ineligibility without requesting a concept', async t => {
  const { c, calls } = setup(t); await tick();
  t.mock.method(document, 'hidden', () => true, { getter: true });
  document.dispatchEvent(new window.Event('visibilitychange')); await tick();
  const signal = calls.find(c => c.url.endsWith('/concepts/eligibility'));
  assert.ok(signal); assert.deepEqual(JSON.parse(signal.options.body), { eligible: false });
  assert.equal(calls.filter(c => c.options.body && !c.url.endsWith('/concepts/eligibility')).length, 0);
});

test('concept kinds and the rail state in plain words: pending, ready revision, failure reasons, limits and spend cap (AIT-113 B2)', () => {
  assert.equal(conceptKind(draft('html1')), 'html'); assert.equal(conceptKind(item('image1')), 'image'); assert.equal(conceptKind(undefined), 'image');
  const on = { available: true, reason: null }, state = (status, extra = {}) => conceptStateText({ copy: en, status, feature: on, items: [], kind: 'html', ...extra });
  assert.equal(state({ phase: 'pending' }), 'Creating your clickable draft…');
  assert.equal(state({ phase: 'pending' }, { items: [draft('html1')] }), 'Updating your draft with your latest answers…');
  assert.equal(state({ phase: 'pending' }, { kind: 'image' }), en.conceptRendering);
  assert.equal(state({ phase: 'ready' }, { items: [draft('html1'), item('image1'), draft('html2')] }), 'Draft revision 2 is ready.');
  assert.equal(state({ phase: 'ready' }, { items: [draft('html1'), item('image1')] }), en.conceptReady, 'the ready sentence follows the latest item');
  assert.equal(state({ phase: 'failed', error: 'rate-limit', reason: 'UI render limit reached for this session' }), 'Visual concept limit reached for this conversation.');
  assert.equal(state({ phase: 'failed', error: 'rate-limit', reason: 'UI render limit reached for this UTC day' }), 'Visual concept limit reached for today (UTC).');
  assert.equal(state({ phase: 'failed', error: 'concept-unavailable', reason: 'OpenRouter spend cap exhausted' }), 'OpenRouter spending limit reached.');
  assert.equal(state({ phase: 'failed', error: 'restart' }), en.conceptRestarted); assert.equal(state({ phase: 'failed', error: 'source-removed' }), en.conceptSourceRemoved);
  assert.equal(state({ phase: 'failed', error: 'concept-unavailable' }), en.conceptFailed);
  assert.equal(state({ phase: 'idle' }, { feature: { available: false, reason: 'Budget used up' }, items: [draft('html1')] }), 'Budget used up.', 'a closed feature says why, also with drafts shown');
  assert.equal(state({ phase: 'failed' }, { requestError: 'Refused.' }), 'Refused.');
  assert.equal(state({ phase: 'idle' }), en.conceptIntro);
  const german = (status, extra) => conceptStateText({ copy: de, status, feature: on, items: [draft('html1')], kind: 'html', ...extra });
  assert.equal(german({ phase: 'ready' }), 'Fassung 1 des Entwurfs ist fertig.');
  assert.equal(german({ phase: 'failed', reason: 'OpenRouter spend cap exhausted' }), 'Ausgabenlimit für OpenRouter erreicht.');
  for (const key of Object.keys(en)) if (key.startsWith('concept')) assert.ok(key in de, `German bundle has ${key}`);
  assert.deepEqual(Object.keys(de.conceptPreview).sort(), Object.keys(en.conceptPreview).sort());
});
test('rail and viewer switch by media type: drafts render in the sandboxed preview from fetched bytes, images stay images', async t => {
  const { root, calls } = setup(t, { concepts: [item('image1'), draft('html1')], session: { conceptVisualKind: 'html' } }); await tick();
  const thumb = root.querySelector('.concept-preview');
  assert.equal(thumb.querySelector('img').hidden, true); assert.equal(thumb.querySelector('.concept-preview-glyph').hidden, false);
  assert.equal(thumb.querySelector('.concept-preview-label').textContent, 'Open clickable draft'); assert.equal(thumb.getAttribute('aria-label'), 'Open clickable draft');
  assert.equal(calls.some(c => /\/(?:image|html)/u.test(c.url)), false, 'the rail loads no draft bytes and never frames one');
  root.querySelector('.concept-tab').click(); await tick(); await tick();
  const preview = root.querySelector('.concept-html'), image = root.querySelector('.concept-image');
  assert.equal(preview.hidden, false); assert.equal(image.hidden, true); assert.equal(image.hasAttribute('src'), false);
  assert.equal(root.querySelector('.concept-viewer').dataset.kind, 'html');
  assert.equal(new TextDecoder().decode(preview.artifact.bytes).includes('Revision 1'), true); assert.equal(preview.artifact.mediaType, 'text/html');
  assert.equal(preview.copy.label, en.conceptPreview.label);
  assert.equal(root.querySelector('#concept-title').textContent, 'Draft revision 1'); assert.equal(root.querySelector('.concept-count').textContent, '2 of 2');
  assert.equal(root.querySelector('.concept-disclosure').textContent, en.conceptDraftFake); assert.equal(root.querySelector('.concept-download').textContent, 'Download draft');
  const get = calls.find(c => c.url.endsWith('/concepts/html1/html'));
  assert.ok(get); assert.equal(get.options.body, undefined); assert.equal(get.options.cache, 'no-store');
  assert.equal(new Headers(get.options.headers).get('x-aithema-session-token'), 'owner-fixture');
  root.querySelector('.concept-viewer').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft' })); await tick();
  assert.equal(preview.hidden, true); assert.equal(preview.artifact, null, 'a hidden preview runs no draft');
  assert.equal(image.hidden, false); assert.ok(image.src.startsWith('blob:')); assert.equal(root.querySelector('#concept-title').textContent, 'Visual concept 1');
  assert.equal(root.querySelector('.concept-download').textContent, en.conceptDownload); assert.ok(calls.some(c => c.url.endsWith('/concepts/image1/image')));
  root.querySelector('.concept-viewer').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight' })); await tick();
  assert.equal(calls.filter(c => c.url.endsWith('/html')).length, 1, 'draft bytes are cached for the session');
  // The width switch's own arrow keys (default prevented) never change the revision.
  const arrow = new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }); arrow.preventDefault();
  root.querySelector('.concept-viewer').dispatchEvent(arrow); assert.equal(root.querySelector('.concept-count').textContent, '2 of 2');
  root.querySelector('.concept-close').click(); assert.equal(preview.artifact, null, 'closing the viewer stops the draft');
});
test('a refresh revision replaces the shown latest draft in place; an older revision or a draft in use stays put (AIT-113 B2)', async t => {
  const { c, root } = setup(t, { concepts: [draft('html1')], session: { conceptVisualKind: 'html' } });
  root.querySelector('.concept-tab').click(); await tick(); await tick();
  const preview = root.querySelector('.concept-html'), regenerate = root.querySelector('.concept-regenerate'), up = root.querySelector('.concept-up');
  const arrive = id => c.receive({ seq: c.session.seq + 1, type: 'concept.state', data: { intent: c.session.conceptIntent, status: { phase: 'ready' }, artifact: draft(id) } });
  arrive('html2'); await tick(); await tick();
  assert.equal(root.querySelector('.concept-count').textContent, '2 of 2'); assert.equal(root.querySelector('#concept-title').textContent, 'Draft revision 2');
  assert.match(new TextDecoder().decode(preview.artifact.bytes), /Revision 2/u);
  assert.equal(root.querySelector('.concept-regenerate'), regenerate); assert.equal(root.querySelector('.concept-up'), up, 'controls keep their nodes');
  assert.equal(root.querySelector('.concept-activity-text').textContent, 'Draft revision 2 is ready.');
  const shown = preview.artifact; c.receive({ seq: c.session.seq + 1, type: 'concept.feedback', data: { artifactId: 'html2', vote: 'up', chips: [], archived: false } });
  assert.equal(preview.artifact, shown, 'a live render of the same revision keeps its frame');
  root.querySelector('.concept-previous').click(); await tick();
  arrive('html3'); await tick();
  assert.equal(root.querySelector('.concept-count').textContent, '1 of 3', 'an older revision being read stays');
  assert.equal(root.querySelector('.concept-viewer-message').textContent, en.conceptDraftNewer);
  root.querySelector('.concept-next').click(); root.querySelector('.concept-next').click(); await tick();
  assert.equal(root.querySelector('.concept-viewer-message').textContent, '');
  t.mock.getter(preview, 'draftFocused', () => true);
  arrive('html4'); await tick();
  assert.equal(root.querySelector('.concept-count').textContent, '3 of 4', 'someone working inside the draft keeps it');
  assert.equal(root.querySelector('.concept-viewer-message').textContent, en.conceptDraftNewer);
});
test('a revision waits while a viewer control holds focus or the pointer rests on the controls; focus never disappears (AIT-113 B2 gate)', async t => {
  const arrive = (c, id) => c.receive({ seq: c.session.seq + 1, type: 'concept.state', data: { intent: c.session.conceptIntent, status: { phase: 'ready' }, artifact: draft(id) } });
  // One viewer on the page at a time (happy-dom cannot resolve focus held in another shadow root).
  let previous;
  const viewer = async () => {
    previous?.root.activeElement?.blur(); previous?.c.remove();
    const view = previous = setup(t, { concepts: [draft('html1', { feedback: { vote: 'up', chips: ['Simpler layout'] } })], session: { conceptVisualKind: 'html' } });
    document.body.append(view.c); view.root.querySelector('.concept-tab').click(); await tick(); await tick(); return view;
  };
  // A pressed guidance toggle on the latest draft holds focus while a revision arrives.
  const { c, root } = await viewer(), preview = root.querySelector('.concept-html'), shown = preview.artifact;
  const chip = root.querySelector('.concept-guidance-options button[aria-pressed="true"]'); chip.focus(); assert.ok(root.activeElement === chip);
  arrive(c, 'html2'); await tick(); await tick();
  assert.ok(root.activeElement === chip, 'focus stays on the pressed Simpler layout toggle'); assert.equal(chip.isConnected, true);
  assert.deepEqual([...root.querySelectorAll('.concept-guidance-options button[aria-pressed="true"]')].map(b => b.textContent), ['Simpler layout'], 'nothing is removed');
  assert.equal(root.querySelector('.concept-viewer-message').textContent, en.conceptDraftNewer, 'the newer-revision notice appears');
  assert.equal(root.querySelector('.concept-count').textContent, '1 of 2'); assert.equal(root.querySelector('#concept-title').textContent, 'Draft revision 1');
  assert.equal(preview.artifact, shown, 'the shown draft keeps its frame'); assert.equal(root.querySelector('.concept-next').disabled, false);
  // Any other viewer control, and a pointer resting on the controls, defer the same way.
  for (const mode of ['Like', 'Regenerate', 'Download', 'draft pointer', 'pointer']) {
    const view = await viewer(), before = view.root.querySelector('.concept-html').artifact;
    const target = { Like: '.concept-up', Regenerate: '.concept-regenerate', Download: '.concept-download' }[mode];
    if (target) view.root.querySelector(target).focus();
    else view.root.querySelector(mode === 'draft pointer' ? '.concept-stage' : '.concept-viewer-controls').dispatchEvent(new window.Event('pointerenter'));
    const focused = view.root.activeElement;
    arrive(view.c, 'html2'); await tick(); await tick();
    assert.equal(view.root.querySelector('.concept-count').textContent, '1 of 2', `${mode}: the shown revision stays`);
    assert.equal(view.root.querySelector('.concept-html').artifact, before, `${mode}: the frame stays`);
    assert.equal(view.root.querySelector('.concept-viewer-message').textContent, en.conceptDraftNewer, `${mode}: notice`);
    assert.ok(view.root.activeElement === focused, `${mode}: focus is where it was`);
    if (mode !== 'pointer') continue;
    // Once the pointer leaves and no control holds focus, the next revision replaces the latest in place.
    view.root.querySelector('.concept-next').click(); await tick();
    view.root.querySelector('.concept-viewer-controls').dispatchEvent(new window.Event('pointerleave')); view.root.querySelector('.concept-close').focus();
    arrive(view.c, 'html3'); await tick(); await tick();
    assert.equal(view.root.querySelector('.concept-count').textContent, '3 of 3', 'replaced in place when nobody is at work in the viewer');
    assert.match(new TextDecoder().decode(view.root.querySelector('.concept-html').artifact.bytes), /Revision 3/u);
    assert.ok(view.root.activeElement === view.root.querySelector('.concept-close'));
  }
});
test('Like, guidance, Regenerate and Reject work for drafts exactly like images', async t => {
  const { c, root, calls } = setup(t, { concepts: [draft('html1')], session: { conceptVisualKind: 'html' } });
  root.querySelector('.concept-tab').click(); await tick();
  root.querySelector('.concept-up').click(); await tick(); assert.equal(c.session.concepts[0].feedback.vote, 'up');
  assert.equal(root.querySelector('.concept-up').getAttribute('aria-pressed'), 'true');
  root.querySelector('.concept-guidance-options button').click(); await tick(); assert.deepEqual(c.session.concepts[0].feedback.chips, ['Simpler layout']);
  root.querySelector('.concept-regenerate').click(); await tick();
  assert.ok(calls.find(c => c.url.endsWith('/concepts/html1/regenerate')));
  root.querySelector('.concept-reject').click(); await tick();
  assert.ok(calls.find(c => c.url.endsWith('/concepts/html1/reject'))); assert.equal(c.session.concepts[0].archived, true);
  assert.equal(root.querySelector('.concept-viewer').open, false); assert.equal(root.querySelector('.concept-html').artifact, null);
});
test('a draft downloads as the static export file with scripts off, never as the raw bytes', async t => {
  const blobs = [];
  const { root, downloads, revoked } = setup(t, { concepts: [draft('html1')], session: { conceptVisualKind: 'html' } });
  URL.createObjectURL.mock.mockImplementation(blob => { blobs.push(blob); return 'blob:draft-download'; });
  root.querySelector('.concept-tab').click(); await tick(); await tick();
  root.querySelector('.concept-download').click(); await tick(); await tick();
  assert.equal(downloads[0].name, 'concept-html1.html'); assert.ok(revoked.includes('blob:draft-download'));
  const text = await blobs.at(-1).text();
  assert.equal(blobs.at(-1).type, 'text/html'); assert.match(text, /^<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'/u);
  assert.match(text, /content="script-src 'none'"/u); assert.match(text, /Revision 1/u);
});
test('the request gate follows the host visual kind; a refused request says why in plain words', async t => {
  const limited = { best: { text: { available: true }, analysis: { available: true }, images: { available: true },
    html: { available: false, reason: 'UI render limit reached for this session' } } };
  const { root } = setup(t, { concepts: [], session: { conceptVisualKind: 'html', featureMatrix: limited } }); await tick();
  assert.equal(root.querySelector('.concept-request').disabled, true);
  assert.equal(root.querySelector('.concept-request').title, 'Visual concept limit reached for this conversation');
  assert.equal(root.querySelector('.concept-activity-text').textContent, 'Visual concept limit reached for this conversation.');
  const refused = setup(t, { concepts: [], session: { conceptVisualKind: 'html' }, refuse: { status: 403, body: { error: 'not-admitted', reason: 'OpenRouter spend cap exhausted' } } });
  await tick(); refused.root.querySelector('.concept-request').click(); await tick(); await tick();
  assert.equal(refused.root.querySelector('.concept-activity-text').textContent, 'OpenRouter spending limit reached.');
  refused.c.receive({ seq: refused.c.session.seq + 1, type: 'concept.state', data: { intent: refused.c.session.conceptIntent, status: { phase: 'pending', startedAt: Date.now(), estimateMs: 45000 } } });
  assert.equal(refused.root.querySelector('.concept-activity-text').textContent, 'Creating your clickable draft…', 'the refusal stands only until the state moves on');
});
