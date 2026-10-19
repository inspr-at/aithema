import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { creditCost } from '../src/display.js';
import { ConceptView, conceptProgress, conceptKind, conceptStateText, WARNING_ICON } from '../src/concept-view.js';
import { styles } from '../src/styles.js';
import { EmailAsk } from '../src/email-ask.js';
const window = new Window({ url: 'http://localhost/' });
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
test.after(() => window.happyDOM.close());
const warningFixture = document.createElement('span'); warningFixture.innerHTML = WARNING_ICON;
const tick = () => new Promise(r => setImmediate(r));
function item(id, extra = {}) { return { id, mediaType: 'image/png', width: 480, height: 320, turnIds: ['first'], referenceIds: [], archived: false,
  feedback: { vote: 'clear', chips: [] }, provenance: { origin: 'ai-generated', generator: { provider: 'local-demo-fake' } }, ...extra }; }
// A clickable draft as the server publishes it (AIT-113): text/html, no pixel size.
const draftBytes = revision => new TextEncoder().encode(`<!doctype html><html><head><title>Draft</title></head><body><p>Revision ${revision}</p></body></html>`);
function draft(id, extra = {}) { return item(id, { mediaType: 'text/html', width: undefined, height: undefined, visualKind: 'html',
  provenance: { origin: 'ai-generated', modality: 'html', generator: { provider: 'local-demo-fake' } }, ...extra }); }
function blurFixtureFocus() {
  // Happy DOM cannot read a sibling ShadowRoot.activeElement while another
  // fixture owns focus. Blur through the actual owner before mounting a peer.
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  active?.blur();
}
function setup(t, { concepts = [item('image1')], copy = en, sessionToken = 'owner-fixture', baseUrl = '', previewResponse, session: extra = {}, refuse, imageResponse, postResponse } = {}) {
  blurFixtureFocus();
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
    if ((url.endsWith('/image') || url.includes('/image?')) && imageResponse) return imageResponse(url, options);
    if (url.endsWith('/image') || url.includes('/image?')) return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
    if (url.endsWith('/preview')) return previewResponse ? previewResponse(url, options) : Response.json({ url: 'http://localhost/_aithema/html-preview?cap=' + String(calls.length).padStart(43, 'a'), expiresInMs: 60000 });
    if (url.endsWith('/html')) return new Response(draftBytes(/(\d+)\/html$/u.exec(url)?.[1] ?? 0), { headers: { 'content-type': 'application/octet-stream' } });
    if (!options.body) return Response.json(c.session);
    if (refuse) return Response.json(refuse.body, { status: refuse.status });
    if (postResponse) return postResponse(url, options);
    const body = JSON.parse(options.body); let event;
    if (url.endsWith('/feedback') || url.endsWith('/reject')) event = { seq: c.session.seq + 1, type: 'concept.feedback', data: { artifactId: /\/concepts\/([^/]+)\/(?:feedback|reject)$/u.exec(url)[1],
      vote: body.vote, chips: body.chips, archived: url.endsWith('/reject') } };
    else event = { seq: c.session.seq + 1, type: 'concept.state', data: { intent: c.session.conceptIntent, status: { phase: 'waiting' } } };
    return Response.json({ event });
  });
  c.configure({ copy, session, sessionToken, baseUrl, concepts: { previewURL: 'http://localhost/_aithema/html-preview' } });
  t.after(async () => {
    blurFixtureFocus();
    // Most concept tests deliberately render without the session SSE transport.
    // Native remove() has no lifecycle callback for an unattached fixture.
    if (c.isConnected) c.remove(); else c.disconnectedCallback();
    await tick();
  });
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
  assert.match(root.querySelector('.concept-regenerate').textContent, /<\u00a01\u00a0credit/);
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
test('AIT-298: reject withdrawal timer is cancelled when its fixture disconnects', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const timeouts = t.mock.method(globalThis, 'setTimeout');
  const clears = t.mock.method(globalThis, 'clearTimeout');
  const { c, root } = setup(t); document.body.append(c);
  root.querySelector('.concept-tab').click(); await tick();
  root.querySelector('.concept-reject').click(); await tick();
  const withdrawal = timeouts.mock.calls.find(call => call.arguments[1] === 4000);
  assert.ok(withdrawal, 'reject schedules the withdrawal notice expiry');
  c.remove();
  assert.ok(clears.mock.calls.some(call => call.arguments[0] === withdrawal.result), 'disconnect cancels the withdrawal callback before another fixture owns focus');
});
test('AIT-298: a reject response after disconnect cannot restart the withdrawal timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const timeouts = t.mock.method(globalThis, 'setTimeout'), reply = Promise.withResolvers();
  const { c, root } = setup(t, { postResponse: () => reply.promise }); document.body.append(c);
  t.after(() => reply.resolve(Response.json({})));
  root.querySelector('.concept-tab').click(); await tick();
  root.querySelector('.concept-reject').click(); await tick();
  const seq = c.session.seq + 1;
  c.remove();
  const before = timeouts.mock.calls.filter(call => call.arguments[1] === 4000).length;
  reply.resolve(Response.json({ event: { seq, type: 'concept.feedback', data: { artifactId: 'image1', vote: 'down', chips: [], archived: true } } }));
  await tick();
  assert.equal(timeouts.mock.calls.filter(call => call.arguments[1] === 4000).length, before, 'late POST completion cannot schedule work on the disconnected view');
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
  // START's live column (AIT-128): head, rail and concept line keep their rows, the transcript takes the rest and
  // the composer's field has a fixed height, so a concept arriving never moves the composer.
  assert.match(css, /\.workspace\[data-stage="live"\] \.conversation \{ grid-template-rows:auto auto auto minmax\(0,1fr\) auto; \}/);
  assert.match(css, /\.concept-bar \{ [^}]*min-height:44px; \}/);
  assert.match(css, /textarea \{ [^}]*min-height:3\.5rem; height:3\.5rem;/);
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
  assert.equal(state({ phase: 'idle' }, { feature: { available: false, reason: 'Budget used up' }, items: [draft('html1')] }), en.display.draftsLow, 'a closed credit feature says why, also with drafts shown');
  assert.equal(state({ phase: 'failed' }, { requestError: 'Refused.' }), 'Refused.');
  assert.equal(state({ phase: 'idle' }), `${en.display.draftsQuote}\u00a0· ${en.display.draftsRetry}`);
  const german = (status, extra) => conceptStateText({ copy: de, status, feature: on, items: [draft('html1')], kind: 'html', ...extra });
  assert.equal(german({ phase: 'ready' }), 'Fassung 1 des Entwurfs ist fertig.');
  assert.equal(german({ phase: 'failed', reason: 'OpenRouter spend cap exhausted' }), 'Ausgabenlimit für OpenRouter erreicht.');
  for (const key of Object.keys(en)) if (key.startsWith('concept')) assert.ok(key in de, `German bundle has ${key}`);
  assert.deepEqual(Object.keys(de.conceptPreview).sort(), Object.keys(en.conceptPreview).sort());
});
test('rail and viewer switch by media type: drafts render in the sandboxed preview from fresh scoped sources, images stay images', async t => {
  const { root, calls } = setup(t, { concepts: [item('image1'), draft('html1')], session: { conceptVisualKind: 'html' } }); await tick();
  const thumb = root.querySelector('.concept-preview');
  assert.equal(thumb.querySelector('img').hidden, true); assert.equal(thumb.querySelector('.concept-preview-glyph').hidden, false);
  assert.equal(thumb.querySelector('.concept-preview-label').textContent, 'Open clickable draft'); assert.equal(thumb.getAttribute('aria-label'), 'Open clickable draft');
  assert.equal(calls.some(c => /\/(?:image|html)/u.test(c.url)), false, 'the rail loads no draft bytes and never frames one');
  root.querySelector('.concept-tab').click(); await tick(); await tick();
  const preview = root.querySelector('.concept-html'), image = root.querySelector('.concept-image');
  assert.equal(preview.hidden, false); assert.equal(image.hidden, true); assert.equal(image.hasAttribute('src'), false);
  assert.equal(root.querySelector('.concept-viewer').dataset.kind, 'html');
  assert.equal(typeof preview.artifact.mint, 'function'); assert.equal(preview.artifact.mediaType, 'text/html');
  assert.equal(preview.copy.label, en.conceptPreview.label);
  assert.equal(root.querySelector('#concept-title').textContent, 'Draft revision 1'); assert.equal(root.querySelector('.concept-count').textContent, '2 of 2');
  assert.equal(root.querySelector('.concept-disclosure').textContent, en.conceptDraftFake); assert.equal(root.querySelector('.concept-download').textContent, 'Download draft');
  await preview.artifact.mint();
  const get = calls.find(c => c.url.endsWith('/concepts/html1/preview'));
  assert.ok(get); assert.equal(get.options.body, '{}'); assert.equal(get.options.method, 'POST'); assert.equal(get.options.cache, 'no-store');
  assert.equal(new Headers(get.options.headers).get('x-aithema-session-token'), 'owner-fixture');
  root.querySelector('.concept-viewer').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft' })); await tick();
  assert.equal(preview.hidden, true); assert.equal(preview.artifact, null, 'a hidden preview runs no draft');
  assert.equal(image.hidden, false); assert.ok(image.src.startsWith('blob:')); assert.equal(root.querySelector('#concept-title').textContent, 'Visual concept 1');
  assert.equal(root.querySelector('.concept-download').textContent, en.conceptDownload); assert.ok(calls.some(c => c.url.endsWith('/concepts/image1/image')));
  root.querySelector('.concept-viewer').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight' })); await tick();
  assert.equal(calls.filter(c => c.url.endsWith('/html')).length, 0, 'viewing never fetches raw draft bytes');
  // The width switch's own arrow keys (default prevented) never change the revision.
  const arrow = new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }); arrow.preventDefault();
  root.querySelector('.concept-viewer').dispatchEvent(arrow); assert.equal(root.querySelector('.concept-count').textContent, '2 of 2');
  root.querySelector('.concept-close').click(); assert.equal(preview.artifact, null, 'closing the viewer stops the draft');
});
test('a refresh revision replaces the shown latest draft in place; an older revision or a draft in use stays put (AIT-113 B2)', async t => {
  const { c, root, calls } = setup(t, { concepts: [draft('html1')], session: { conceptVisualKind: 'html' } });
  root.querySelector('.concept-tab').click(); await tick(); await tick();
  const preview = root.querySelector('.concept-html'), regenerate = root.querySelector('.concept-regenerate'), up = root.querySelector('.concept-up');
  const arrive = id => c.receive({ seq: c.session.seq + 1, type: 'concept.state', data: { intent: c.session.conceptIntent, status: { phase: 'ready' }, artifact: draft(id) } });
  arrive('html2'); await tick(); await tick();
  assert.equal(root.querySelector('.concept-count').textContent, '2 of 2'); assert.equal(root.querySelector('#concept-title').textContent, 'Draft revision 2');
  assert.equal(preview.dataset.id, 'html2'); await preview.artifact.mint(); assert.ok(calls.some(call => call.url.endsWith('/html2/preview')));
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
    assert.equal(view.root.querySelector('.concept-html').dataset.id, 'html3');
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

for (const copy of [de, en]) for (const enabled of [true, false]) for (const reason of ['purpose', 'session']) {
  test(`AIT-189 ${copy.display.locale} drafts ${enabled ? 'on' : 'off'} ${reason}: freshly mounted pause equals unpaused stage`, t => {
    const { c } = setup(t, { copy, concepts: [], session: { locale: copy.display.locale, conceptVisualKind: 'html', conceptCost: { maxMicro: 100_000 } } });
    const session = structuredClone(c.session);
    session.featureMatrix.best.html = enabled ? { available: true } : { available: false, reason: 'not configured' };
    c.configure({ copy, session });
    const stage = root => ['.concept-activity-text', '.concept-request'].filter(selector => {
      const node = root.querySelector(selector); return !node.hidden && !node.parentElement.hidden;
    }).map(selector => root.querySelector(selector).textContent).join('');
    const before = stage(c.shadowRoot);
    assert.ok(before.trim(), 'non-paused stage has text');
    c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true, ...(reason === 'purpose' ? { reason } : {}) } });
    assert.equal(stage(c.shadowRoot), before, 'live pause retains stage');
    const reloaded = structuredClone(c.session);
    if (enabled) reloaded.featureMatrix.best.html = { available: false, reason: 'session paused', unpaused: session.featureMatrix.best.html };
    c.configure({ copy, session: reloaded });
    assert.equal(stage(c.shadowRoot), before, 'freshly mounted paused stage equals same non-paused state');
    assert.equal(c.shadowRoot.querySelector('.concept-request').disabled, true, 'pause still gates generation');
    assert.doesNotMatch(stage(c.shadowRoot), /paused|pausiert/iu, 'pause copy stays in composer');
  });
}

// AIT-282: state changes share a permanent access cell and the authenticated bytes.
const conceptState = (c, status, artifact) => c.receive({ seq: c.session.seq + 1, type: 'concept.state',
  data: { intent: c.session.conceptIntent, status, ...(artifact ? { artifact } : {}) } });
test('AIT-282 round 3: phone access stays inert behind the email ask through stage renders and moves', async t => {
  window.happyDOM.setWindowSize({ width: 390, height: 844 });
  t.after(() => window.happyDOM.setWindowSize({ width: 1024, height: 768 }));
  const { c, root, calls } = setup(t, { session: { visualsBound: true, conceptCost: { maxMicro: 30000 } } });
  document.body.append(c);
  // Happy DOM initializes change listeners to false even when the query matches.
  window.dispatchEvent(new window.Event('resize'));
  const access = root.querySelector('.concept-access'), retry = root.querySelector('.concept-request');
  assert.ok(access.closest('.composer-dock'), 'the real access row is mounted in the phone dock');
  const email = { canCollect: true, address: '', numbers: {}, paintNotice() {} };
  const ask = new EmailAsk({ root, copy: en, verification: { email }, session: () => c.session, streaming: () => false, request: async () => ({ ok: false }) });
  t.after(() => ask.destroy());
  ask.open = true; ask.paint();
  assert.equal(access.inert, true, 'the ready thumbnail is inert behind the modal email ask');
  root.querySelector('.concept-preview').click();
  assert.equal(root.querySelector('.concept-viewer').open, false);
  conceptState(c, { phase: 'failed' });
  assert.equal(access.inert, true, 'stage renders cannot reopen the paid retry behind the modal');
  retry.click(); await tick();
  assert.equal(calls.filter(call => call.options.body).length, 0, 'blocked retry cannot send a paid request');
  window.happyDOM.setWindowSize({ width: 800, height: 844 });
  window.dispatchEvent(new window.Event('resize'));
  assert.ok(access.closest('.concept-bar'));
  assert.equal(access.inert, true, 'moving the same row retains its guard');
  window.happyDOM.setWindowSize({ width: 390, height: 844 });
  window.dispatchEvent(new window.Event('resize'));
  ask.open = false; ask.paint();
  assert.equal(access.inert, false, 'live controls return after dismissal');
  retry.click(); await tick();
  assert.equal(calls.filter(call => call.options.body).length, 1, 'the existing one-click priced retry still works');
});
test('AIT-282 round 3: phone access is hidden and inert outside live, including after email-ask paint', t => {
  window.happyDOM.setWindowSize({ width: 390, height: 844 });
  t.after(() => window.happyDOM.setWindowSize({ width: 1024, height: 768 }));
  for (const origin of ['default', 'chosen']) {
    const { c, root, calls } = setup(t, { session: { transcript: [], visualsBound: true, settings: { origin }, conceptStatus: { phase: 'failed' } } });
    document.body.append(c);
    const access = root.querySelector('.concept-access'), retry = root.querySelector('.concept-request');
    assert.ok(access.closest('.composer-dock'));
    assert.equal(root.querySelector('.workspace').dataset.stage, origin === 'chosen' ? 'ready' : 'entrance');
    const email = { canCollect: true, address: '', numbers: {}, paintNotice() {} };
    const ask = new EmailAsk({ root, copy: en, verification: { email }, session: () => c.session, streaming: () => false, request: async () => ({ ok: false }) });
    t.after(() => ask.destroy());
    ask.paint();
    assert.equal(access.inert, true, 'closed email ask cannot remove the stage guard');
    assert.equal(window.getComputedStyle(access).display, 'none', 'image layout cannot override the not-live hide rule');
    assert.ok(retry.closest('.concept-access').inert, 'retry has an inert ancestor');
    retry.click();
    assert.equal(calls.filter(call => call.options.body).length, 0);
  }
});
test('AIT-282 round 3: phone accessible name matches visible ready text in DE and EN', t => {
  window.happyDOM.setWindowSize({ width: 390, height: 844 });
  t.after(() => window.happyDOM.setWindowSize({ width: 1024, height: 768 }));
  for (const copy of [de, en]) {
    const { root } = setup(t, { copy, session: { visualsBound: true } });
    const preview = root.querySelector('.concept-preview');
    assert.equal(preview.querySelector('.concept-preview-label').textContent, copy.conceptPhoneReady);
    assert.equal(preview.getAttribute('aria-label'), copy.conceptPhoneReady);
  }
});
test('AIT-282 round 3: failure and restart copy name the current retry button in DE and EN', () => {
  for (const copy of [de, en]) for (const text of [copy.conceptFailed, copy.conceptRestarted]) {
    assert.ok(text.includes(`„${copy.conceptRetry}“`) || text.includes(`“${copy.conceptRetry}”`), text);
  }
});
test('AIT-282: generating, ready, replacement, failure, withdrawal and empty keep the same access nodes', async t => {
  const { c, root } = setup(t, { concepts: [], session: { visualsBound: true } });
  const access = root.querySelector('.concept-access'), preview = root.querySelector('.concept-preview'), request = root.querySelector('.concept-request');
  conceptState(c, { phase: 'pending', startedAt: Date.now(), estimateMs: 40000 });
  assert.equal(access.dataset.state, 'gen');
  assert.equal(root.querySelector('.concept-scene').getAttribute('aria-hidden'), 'true');
  assert.equal(root.querySelector('.concept-bottom-label').getAttribute('role'), 'status');
  assert.match(root.querySelector('.concept-bottom-label').textContent, /Creating concept … about 40 s/);
  assert.equal(root.querySelectorAll('.concept-backdrop img[src]').length, 0);
  conceptState(c, { phase: 'ready' }, item('first-concept')); await tick();
  assert.equal(access.dataset.state, 'ready');
  const before = root.querySelector('.concept-backdrop img[data-on]'); assert.ok(before.src.startsWith('blob:'));
  conceptState(c, { phase: 'ready' }, item('replacement')); await tick();
  const after = root.querySelector('.concept-backdrop img[data-on]'); assert.notEqual(before, after);
  assert.equal(before.hasAttribute('data-on'), false); assert.equal(after.dataset.id, 'replacement');
  for (const img of root.querySelectorAll('.concept-backdrop img, .concept-preview img')) {
    assert.equal(img.alt, ''); assert.equal(img.getAttribute('aria-hidden'), 'true');
  }
  conceptState(c, { phase: 'failed' });
  assert.equal(access.dataset.state, 'err'); assert.equal(root.querySelectorAll('.concept-backdrop img[src]').length, 0);
  assert.equal(root.querySelector('.concept-activity-text').textContent, en.conceptBackdropFailed);
  c.receive({ seq: c.session.seq + 1, type: 'turn.withdrawn', data: { turnId: 'first', at: new Date().toISOString() } });
  assert.equal(access.dataset.state, 'gone'); assert.equal(root.querySelector('.concept-withdrawn').textContent, en.conceptWithdrawn);
  assert.equal(root.querySelectorAll('.concept-backdrop img[src], .concept-preview img[src]').length, 0);
  assert.equal(root.querySelector('.concept-preview'), preview); assert.equal(root.querySelector('.concept-request'), request);
});
test('AIT-282: withdrawal during generating clears bytes immediately and shows the notice for exactly four seconds', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const { c, root } = setup(t, { concepts: [], session: { visualsBound: true } });
  conceptState(c, { phase: 'pending', startedAt: Date.now(), estimateMs: 40000 });
  c.receive({ seq: c.session.seq + 1, type: 'turn.withdrawn', data: { turnId: 'first', at: new Date().toISOString() } });
  assert.equal(root.querySelector('.concept-access').dataset.state, 'gone');
  assert.equal(root.querySelector('.concept-bottom-label').textContent, '');
  t.mock.timers.tick(3999); assert.equal(root.querySelector('.concept-access').dataset.state, 'gone');
  t.mock.timers.tick(1); assert.equal(root.querySelector('.concept-withdrawn').textContent, '');
});
test('AIT-282: the priced retry is the confirmation; one click makes one request, and caps refuse in plain words', async t => {
  for (const copy of [de, en]) {
    const { root, calls } = setup(t, { copy, concepts: [], session: { visualsBound: true, conceptCost: { maxMicro: 30000 }, conceptStatus: { phase: 'failed' } },
      refuse: { status: 409, body: { reason: 'OpenRouter spend cap exhausted' } } });
    const retry = root.querySelector('.concept-request');
    assert.equal(retry.textContent, `${copy.conceptRetry}\u00a0· ${creditCost(30000, copy)}`);
    retry.click(); await tick();
    assert.equal(calls.filter(call => call.options.body).length, 1);
    assert.equal(JSON.parse(calls.find(call => call.options.body).options.body).intent, true);
    assert.match(root.querySelector('.concept-activity-text').textContent, copy === de ? /Ausgabenlimit|Ausgaben.*erreicht|Ausgabenlimit/ : /spending limit reached/i);
    assert.equal(root.querySelectorAll('dialog').length > 0, true);
    assert.equal(root.querySelector('.concept-viewer').open, false);
  }
});
test('AIT-282: bubbles and controls win; exposed background opens the existing viewer and focus sharpens it', async t => {
  const { c, root, calls } = setup(t); document.body.append(c); await tick();
  const box = { left:0, top:0, right:300, bottom:200 };
  t.mock.method(root.querySelector('.concept-backdrop'), 'getBoundingClientRect', () => box);
  const click = target => target.dispatchEvent(new window.MouseEvent('click', { bubbles:true, clientX:30, clientY:30 }));
  click(root.querySelector('.turn')); assert.equal(root.querySelector('.concept-viewer').open, false);
  const upload=document.createElement('li');upload.className='upload';upload.textContent='Fixture.pdf';root.querySelector('ol').append(upload);
  click(upload);assert.equal(root.querySelector('.concept-viewer').open,false,'upload row wins the click');upload.remove();
  click(root.querySelector('.transcript-latest')); assert.equal(root.querySelector('.concept-viewer').open, false);
  root.querySelector('.concept-preview').focus(); assert.equal(root.querySelector('.concept-thread').hasAttribute('data-near'), true);
  root.querySelector('.concept-preview').blur();
  click(root.querySelector('.transcript-shell')); assert.equal(root.querySelector('.concept-viewer').open, true);
  assert.equal(calls.filter(call => call.options.body).length, 0);
});
test('AIT-282: erased in-flight bytes never reach any surface or URL cache', async t => {
  let resolve; const pending = new Promise(r => { resolve = r; });
  const { c, root } = setup(t, { imageResponse: () => pending });
  c.receive({ seq: c.session.seq + 1, type: 'turn.withdrawn', data: { turnId: 'first', at: new Date().toISOString() } });
  resolve(new Response(new Uint8Array([137,80,78,71]), { headers: { 'content-type': 'image/png' } })); await tick();
  assert.equal(root.querySelectorAll('.concept-backdrop img[src], .concept-preview img[src], .concept-image[src]').length, 0);
  assert.equal(URL.createObjectURL.mock.callCount(), 0);
});
// The element also reads its independent motion preference during mounting.
const viewedStorageCalls = spy => spy.mock.calls.filter(call => call.arguments[0] === 'aithema-concept-viewed');
for (const visualsBound of [false, undefined]) test(`AIT-296: unbound visuals (${visualsBound}) never read or write storage while constructing and painting a conversation`, async t => {
  const get = t.mock.method(window.localStorage, 'getItem'), set = t.mock.method(window.localStorage, 'setItem');
  const { c, root } = setup(t, { concepts: [], session: { visualsBound, featureMatrix: {
    best: { text: { available: true }, images: { available: false, reason: 'not configured' }, html: { available: false, reason: 'not configured' } },
  } } });
  c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'next', role: 'assistant', content: 'Tell me more.' } });
  assert.match(root.querySelector('.transcript-shell ol').textContent, /Tell me more/);
  assert.equal(viewedStorageCalls(get).length, 0); assert.equal(viewedStorageCalls(set).length, 0);
  // Saved items can outlive a host's visual bindings. Opening and navigating them must stay storage-free too.
  for (const id of ['image1', 'image2']) c.receive({ seq: c.session.seq + 1, type: 'concept.state',
    data: { intent: c.session.conceptIntent, status: { phase: 'ready' }, artifact: item(id) } });
  root.querySelector('.concept-preview').click();
  root.querySelector('.concept-previous').click(); await tick();
  assert.equal(root.querySelector('.concept-viewer').open, true);
  assert.equal(viewedStorageCalls(get).length, 0); assert.equal(viewedStorageCalls(set).length, 0);
});
for (const kind of ['image', 'html']) test(`AIT-296: bound ${kind} visuals read once on the first item and persist only opaque viewed IDs`, async t => {
  window.localStorage.clear();
  window.localStorage.setItem('aithema-concept-viewed', JSON.stringify(['previous', 'image1', 42, { content: 'private' }, 'person@example.com', 'x'.repeat(129)]));
  const get = t.mock.method(window.localStorage, 'getItem'), set = t.mock.method(window.localStorage, 'setItem');
  const { c, root } = setup(t, { concepts: [], session: { visualsBound: true, conceptVisualKind: kind } });
  assert.equal(viewedStorageCalls(get).length, 0, 'a binding without an item needs no storage');
  assert.equal(viewedStorageCalls(set).length, 0);
  const artifact = kind === 'html' ? draft : item;
  const arrive = id => c.receive({ seq: c.session.seq + 1, type: 'concept.state',
    data: { intent: c.session.conceptIntent, status: { phase: 'ready' }, artifact: artifact(id) } });
  arrive('image1');
  assert.deepEqual(viewedStorageCalls(get).map(call => call.arguments), [['aithema-concept-viewed']]);
  assert.equal(root.querySelector('.concept-tab').dataset.unread, 'false', 'the first paint restores viewed state');
  assert.equal(viewedStorageCalls(set).length, 0, 'painting only reads');
  arrive('image2');
  assert.equal(root.querySelector('.concept-tab').dataset.unread, 'true');
  root.querySelector('.concept-preview').click(); await tick();
  root.querySelector('.concept-close').click();
  assert.equal(viewedStorageCalls(get).length, 1, 'updates and opening do not repeat the read');
  assert.deepEqual(viewedStorageCalls(set).map(call => [call.arguments[0], JSON.parse(call.arguments[1])]),
    [['aithema-concept-viewed', ['previous', 'image1', 'image2']]]);
  const reloaded = setup(t, { concepts: [artifact('image2')], session: { visualsBound: true, conceptVisualKind: kind } });
  assert.equal(reloaded.root.querySelector('.concept-tab').dataset.unread, 'false', 'a fresh viewer restores persisted state');
  assert.equal(viewedStorageCalls(get).length, 2);
  assert.equal(viewedStorageCalls(set).length, 1);
});
test('AIT-296: failed storage methods are attempted once per read and leave viewing usable', async t => {
  const get = t.mock.method(window.localStorage, 'getItem', () => { throw new Error('read denied'); });
  const set = t.mock.method(window.localStorage, 'setItem', () => { throw new Error('write denied'); });
  const { c, root } = setup(t, { concepts: [], session: { visualsBound: true } });
  assert.equal(viewedStorageCalls(get).length, 0);
  c.receive({ seq: c.session.seq + 1, type: 'concept.state',
    data: { intent: c.session.conceptIntent, status: { phase: 'ready' }, artifact: item('image1') } });
  root.querySelector('.concept-preview').click(); await tick();
  assert.equal(root.querySelector('.concept-viewer').open, true);
  assert.ok(root.querySelector('.concept-image').src.startsWith('blob:'));
  assert.equal(root.querySelector('.concept-tab').dataset.unread, 'false');
  root.querySelector('.concept-close').click(); root.querySelector('.concept-preview').click(); await tick();
  assert.equal(viewedStorageCalls(get).length, 1, 'failing reads are not retried on every render or open');
  assert.equal(viewedStorageCalls(set).length, 2);
});
test('AIT-282: viewed storage contains opaque IDs only and private-mode read/write failures leave viewing usable', async t => {
  window.localStorage.clear();
  const { root } = setup(t); root.querySelector('.concept-preview').click(); await tick();
  assert.deepEqual(JSON.parse(window.localStorage.getItem('aithema-concept-viewed')), ['image1']);
  root.querySelector('.concept-close').click();
  t.mock.method(window, 'localStorage', () => { throw new Error('private mode'); }, { getter:true });
  const second = setup(t); second.root.querySelector('.concept-preview').click(); await tick();
  assert.equal(second.root.querySelector('.concept-viewer').open, true);
  assert.ok(second.root.querySelector('.concept-image').src.startsWith('blob:'));
});
test('AIT-282: unbound visuals show no access; reduced motion disables fades and pulsing', t => {
  const { root } = setup(t, { concepts: [], session: { visualsBound:false } });
  assert.equal(root.querySelector('.concept-access').dataset.state, 'none');
  assert.equal(root.querySelectorAll('.concept-backdrop img[src]').length, 0);
  const css = root.querySelector('style').textContent;
  assert.match(css, /:host\(\[motion="off"\]\) [^{]*concept-backdrop[^{]* img \{ transition:none/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\) \{ [^{]*concept-backdrop[^{]* img \{ transition:none/);
  assert.match(css, /animation:none !important/);
});
test('AIT-282: revoking an outgoing cross-fade layer removes it synchronously while the current concept stays', async t => {
  const { c, root, revoked } = setup(t); await tick();
  conceptState(c, {phase:'ready'}, item('current')); await tick();
  assert.equal(root.querySelectorAll('.concept-backdrop img[src]').length, 2);
  c.receive({seq:c.session.seq+1,type:'concept.archived',data:{artifactId:'image1'}});
  assert.equal(root.querySelectorAll('.concept-backdrop img[src]').length, 1);
  assert.equal(root.querySelectorAll('.concept-preview img[src]').length, 1);
  assert.equal(root.querySelector('.concept-backdrop img[data-on]').dataset.id, 'current');
  assert.ok(revoked.length > 0);
});
test('AIT-282: late source-dependent arrivals after withdrawal and URL-shaped artifact IDs cannot load bytes', async t => {
  const { c, root, calls } = setup(t, {concepts:[]});
  c.receive({seq:c.session.seq+1,type:'turn.withdrawn',data:{turnId:'first',at:new Date().toISOString()}});
  conceptState(c, {phase:'ready'}, item('late')); await tick();
  assert.equal(root.querySelectorAll('.concept-backdrop img[src],.concept-preview img[src]').length, 0);
  assert.equal(calls.filter(call=>call.url.endsWith('/image')).length,0);
  const second=setup(t,{concepts:[item('https://other.example/image')]});await tick();
  assert.equal(second.calls.filter(call=>call.url.endsWith('/image')).length,0);
});
test('AIT-282: an old conversation response cannot paint a new conversation, even with the same artifact ID', async t => {
  let resolve; const oldBytes = new Promise(r=>{resolve=r;});
  const png=()=>new Response(new Uint8Array([137,80,78,71]),{headers:{'content-type':'image/png'}});
  const {c,root:oldRoot,calls}=setup(t,{session:{id:'owner-one'},imageResponse:url=>url.includes('/owner-one/')?oldBytes:png()});
  const oldSurfaces=[...oldRoot.querySelectorAll('.concept-backdrop img,.concept-preview img')];
  const session={...c.session,id:'owner-two',concepts:[item('image1')]};
  c.configure({session,copy:en,sessionToken:'second-owner'});await tick();
  resolve(png());await tick();
  assert.ok(oldSurfaces.every(image=>!image.hasAttribute('src')));
  assert.equal(c.shadowRoot.querySelectorAll('.concept-backdrop img[src]').length,1);
  assert.equal(URL.createObjectURL.mock.callCount(),1);
  const read=calls.find(call=>call.url.includes('/owner-two/concepts/'));
  assert.equal(new Headers(read.options.headers).get('x-aithema-session-token'),'second-owner');
});
test('AIT-282: initially unbound hosts keep the existing layout, while an image conversation keeps its reservation through none', t => {
  let view; const update=ConceptView.prototype.update;
  t.mock.method(ConceptView.prototype,'update',function(session){view=this;return update.call(this,session);});
  const {c,root}=setup(t,{concepts:[],session:{visualsBound:false}});
  assert.equal(root.querySelector('.workspace').dataset.conceptLayout,'unbound');
  assert.equal(root.querySelector('.concept-bar').hasAttribute('data-no-drafts'),true);
  view.update({...c.session,visualsBound:true,conceptStatus:{phase:'pending',startedAt:Date.now(),estimateMs:40000}});
  assert.equal(root.querySelector('.workspace').dataset.conceptLayout,'image');
  view.update({...c.session,visualsBound:false,conceptStatus:{phase:'idle'}});
  assert.equal(root.querySelector('.workspace').dataset.conceptLayout,'image');
  assert.equal(root.querySelector('.concept-access').dataset.state,'none');
});

for (const copy of [de, en]) test(`AIT-286 ${copy.display.locale}: access failure reuses retry warning and keeps the priced button inline after its separator`, async t => {
  const { c, root, calls } = setup(t, { copy, concepts: [], session: { visualsBound: true, conceptCost: { maxMicro: 30000 } } });
  const button = root.querySelector('.concept-request');
  conceptState(c, { phase: 'failed' });
  const text = root.querySelector('.concept-activity-text');
  assert.equal(text.querySelector('.question-status.warning svg').outerHTML, warningFixture.firstChild.outerHTML);
  assert.equal(text.querySelector('.question-why').textContent, copy.conceptBackdropFailed);
  assert.equal(text.parentElement.nextElementSibling, button);
  assert.match(styles, /\.concept-access\[data-state="err"\] \.concept-rail \{ display:block;/u);
  assert.ok(styles.includes('.concept-activity-text::after { content:"\u00a0· ";'));
  assert.match(styles, /\.concept-access\[data-state="err"\] \.concept-request \{[^}]*display:inline-block[^}]*white-space:nowrap/u);
  assert.match(styles, /@media\(600px < width <= 64rem\)\s*\{[^}]*\.concept-activity::after \{ content:''; display:block/u);
  assert.equal(button.textContent, `${copy.conceptRetry}\u00a0· ${creditCost(30000, copy)}`);
  button.click(); await tick();
  assert.equal(calls.filter(call => call.options.body).length, 1, 'existing one-click priced request');
  assert.equal(root.querySelector('.concept-activity-text .warning'), null, 'pending clears warning');
});

test('AIT-286: an error with a consent verdict preserves its native consent opener', t => {
  const { c, root } = setup(t, { concepts: [], session: { visualsBound: true, featureMatrix: { best: {
    text: { available: true }, analysis: { available: true }, images: { available: false, reason: 'current processing consent required' },
  } } } });
  conceptState(c, { phase: 'failed', reason: 'current processing consent required' });
  assert.equal(root.querySelector('.concept-activity-text .consent-action').tagName, 'BUTTON');
  assert.ok(root.querySelector('.concept-activity-text .warning svg'));
});

test('AIT-299: detach and re-attach immediately enable controls while an old request is pending', async t => {
  const first = Promise.withResolvers(), second = Promise.withResolvers(); let requests = 0;
  const { c, root } = setup(t, { postResponse: () => ++requests === 1 ? first.promise : second.promise });
  t.after(() => { first.resolve(Response.json({})); second.resolve(Response.json({})); });
  document.body.append(c);
  root.querySelector('.concept-tab').click(); await tick();
  root.querySelector('.concept-request').click();
  assert.equal(root.querySelector('.concept-request').disabled, true);
  c.remove(); document.body.append(c);
  for (const selector of ['.concept-request', '.concept-regenerate', '.concept-up', '.concept-down', '.concept-reject'])
    assert.equal(root.querySelector(selector).disabled, false, `${selector} is enabled before any render or response`);
  root.querySelector('.concept-request').click();
  assert.equal(requests, 2);
  first.resolve(Response.json({ event: { seq: c.session.seq + 1, type: 'concept.state', data: { status: { phase: 'failed', error: 'restart' } } } }));
  await tick();
  assert.equal(root.querySelector('.concept-request').disabled, true, 'the old lifetime cannot clear the new request busy gate');
  assert.notEqual(c.session.conceptStatus?.phase, 'failed', 'the old lifetime cannot apply its response');
  second.resolve(Response.json({})); await tick();
  assert.equal(root.querySelector('.concept-request').disabled, false);
});

// AIT-364: scope loss must use the synchronous full-withdrawal redaction path.
for (const kind of ['html', 'image']) test(`AIT-364 ${kind}: partial consent removes every surface and cache, preserves the other kind`, { timeout: 10_000 }, async t => {
  let view;
  const update = ConceptView.prototype.update;
  t.mock.method(ConceptView.prototype, 'update', function (session) { view = this; return update.apply(this, arguments); });
  const removed = kind === 'html' ? draft('removed') : item('removed');
  const retained = kind === 'html' ? item('retained') : draft('retained');
  const { c, root, calls, revoked } = setup(t, { concepts: [retained, removed], session: { conceptVisualKind: kind, visualsBound: true } });
  t.mock.method(c, 'connectedCallback', () => {}); document.body.append(c);
  await tick();
  const cached = await view.load('removed'); assert.ok(cached); t.diagnostic('removed bytes cached');
  root.querySelector('.fold').click(); await view.paintCanvas(); t.diagnostic('canvas painted');
  const access = root.querySelector('.concept-preview'); access.focus(); access.click(); await tick();
  assert.equal(view.dialog.open, true);
  const feature = kind === 'html' ? 'html' : 'images';
  const snapshot = { ...c.session, consentRevision: c.session.consentRevision + 1,
    featureMatrix: { best: { ...c.session.featureMatrix.best, [feature]: { available: false, reason: 'current processing consent required' } } } };
  view.update(snapshot);
  assert.equal(view.dialog.open, false, 'viewer closes synchronously');
  assert.deepEqual(view.items.map(item => item.id), ['retained']);
  assert.equal(root.querySelector('.concept-html').artifact, null);
  assert.equal(root.querySelector('.canvas-html').dataset.id === 'removed', false);
  assert.equal(root.querySelector('.canvas-empty').hidden, false, 'withdrawn canvas returns to its empty slot even when another kind remains');
  assert.equal(root.querySelectorAll('img[data-id="removed"][src]').length, 0);
  assert.equal(root.activeElement, access, 'focus returns to the access control');
  if (kind === 'image') assert.ok(revoked.includes(cached), 'all removed object URLs are revoked in the update tick');
  const reads = calls.length;
  assert.equal(await view.load('removed'), null, 'cached removed bytes cannot be returned');
  assert.equal(calls.length, reads, 'removed scope is never fetched again');
  view.open('removed'); assert.equal(view.dialog.open, false, 'removed metadata cannot reopen a frame');
  view.open('retained'); assert.equal(view.dialog.open, true, 'other kind stays openable');
  assert.equal(root.querySelector('.concept-count').textContent, '1 of 1');
  assert.equal(snapshot.transcript[0].content, 'An API dashboard');
  const readsBeforeRegrant = calls.filter(call => /\/(html|image)$/u.test(call.url)).length;
  view.update({ ...c.session, consentRevision: snapshot.consentRevision + 1 });
  await view.load('removed'); t.diagnostic('regrant fetched fresh bytes');
  assert.ok(calls.filter(call => /\/(html|image)$/u.test(call.url)).length > readsBeforeRegrant, 'regrant reads fresh bytes: removed cache was dropped');
});

for (const kind of ['html', 'image']) for (const copy of [de, en]) test(`AIT-364 ${kind}/${copy.display.locale}: notice expires into consent, never idle`, async t => {
  let view;
  const update = ConceptView.prototype.update;
  t.mock.method(ConceptView.prototype, 'update', function (session) { view = this; return update.apply(this, arguments); });
  const { c, root } = setup(t, { copy, concepts: [kind === 'html' ? draft('only') : item('only')], session: { conceptVisualKind: kind, visualsBound: true } });
  const timers = t.mock.method(globalThis, 'setTimeout', () => ({ unref() {} }));
  const feature = kind === 'html' ? 'html' : 'images';
  const snapshot = { ...c.session, consentRevision: 1, featureMatrix: { best: { ...c.session.featureMatrix.best,
    [feature]: { available: false, reason: 'current processing consent required' } } } };
  root.querySelector('.concept-preview').focus(); root.querySelector('.concept-preview').click();
  view.update(snapshot);
  const expected = copy === de ? kind === 'html' ? 'Entwurf entfernt. Die Einwilligung für Entwürfe wurde widerrufen.' : 'Bild entfernt. Die Einwilligung für Bilder wurde widerrufen.'
    : kind === 'html' ? 'Draft removed. Consent for drafts was withdrawn.' : 'Image removed. Consent for images was withdrawn.';
  const notice = root.querySelector('.concept-withdrawn');
  assert.equal(notice.textContent, expected);
  assert.equal(notice.getAttribute('aria-live'), 'polite');
  const expiry = timers.mock.calls.find(call => call.arguments[1] === 4000); assert.ok(expiry);
  view.update(snapshot);
  assert.equal(timers.mock.calls.filter(call => call.arguments[1] === 4000).length, 1, 'refresh cannot reannounce or restart notice');
  expiry.arguments[0]();
  assert.equal(notice.textContent, '');
  assert.equal(root.querySelector('.concept-access').dataset.state, 'consent');
  assert.match(root.querySelector('.concept-activity-text').textContent, new RegExp(copy.featureConsent[feature]));
});

test('AIT-364: revision-matched document coverage wins over available features; stale documents cannot revoke', t => {
  let view;
  const update = ConceptView.prototype.update;
  t.mock.method(ConceptView.prototype, 'update', function (session) { view = this; return update.apply(this, arguments); });
  const { c } = setup(t, { concepts: [item('image'), draft('html')] });
  const doc = { consentRevision: c.session.consentRevision - 1, selected: ['models', 'images'], features: { html: ['drafts'], images: ['images'] } };
  view.update(c.session, doc); assert.deepEqual(view.items.map(i => i.id), ['image', 'html']);
  view.update(c.session, { ...doc, consentRevision: c.session.consentRevision });
  assert.deepEqual(view.items.map(i => i.id), ['image']);
});

test('AIT-364: a 403 preview refusal cannot be retried by reopen or Reload', async t => {
  let view;
  const update = ConceptView.prototype.update;
  t.mock.method(ConceptView.prototype, 'update', function (session) { view = this; return update.apply(this, arguments); });
  const { calls } = setup(t, { concepts: [draft('denied')], previewResponse: () => new Response(null, { status: 403 }) });
  const source = view.previewSource('denied');
  await assert.rejects(source.mint(), /Preview unavailable/);
  await assert.rejects(source.mint(), /Preview scope denied/);
  await assert.rejects(view.previewSource('denied').mint(), /Preview scope denied/);
  assert.equal(calls.filter(call => call.url.endsWith('/preview')).length, 1);
});

test('AIT-364: withdrawing images preserves an already open HTML frame and its mint scope', async t => {
  let view;
  const update = ConceptView.prototype.update;
  t.mock.method(ConceptView.prototype, 'update', function (session) { view = this; return update.apply(this, arguments); });
  const { c, root } = setup(t, { concepts: [draft('retained'), item('removed')], session: { conceptVisualKind: 'image', visualsBound: true } });
  view.open('retained');
  const source = root.querySelector('.concept-html').artifact;
  view.update({ ...c.session, consentRevision: 1, featureMatrix: { best: { ...c.session.featureMatrix.best, images: { available: false, reason: 'current processing consent required' } } } });
  assert.equal(view.dialog.open, true, 'a selected covered kind stays open');
  assert.equal(root.querySelector('.concept-html').artifact, source, 'covered frame is not replaced');
  assert.equal(root.querySelector('.concept-viewer-message').textContent, '', 'scope removal does not announce a new draft of the covered kind');
  assert.equal(root.querySelector('.concept-count').textContent, '1 of 1');
  assert.ok((await source.mint()).url, 'covered preview remains usable after the other scope is removed');
});

test('AIT-364: old scope work stays expired through a later regrant', async t => {
  let view;
  const update = ConceptView.prototype.update;
  t.mock.method(ConceptView.prototype, 'update', function (session) { view = this; return update.apply(this, arguments); });
  const { c } = setup(t, { concepts: [draft('scope')], session: { conceptVisualKind: 'html' } });
  const oldSource = view.previewSource('scope');
  view.update({ ...c.session, consentRevision: 1, featureMatrix: { best: { ...c.session.featureMatrix.best,
    html: { available: false, reason: 'current processing consent required' } } } });
  view.update({ ...c.session, consentRevision: 2 });
  await assert.rejects(oldSource.mint(), /Preview scope expired/);
  assert.ok((await view.previewSource('scope').mint()).url, 'new explicit coverage can use a fresh scope');
});
