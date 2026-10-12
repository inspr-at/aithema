import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { applyEvent, createSession } from '@inspr/aithema-core';
import { voiceEvents } from '../../core/src/live-voice.js';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { manifest } from '../../../plugins/elevenlabs/src/manifest.js';

const window = new Window({ url: 'http://localhost/' });
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, { startGate, startError, host } = {}) {
  const events = voiceEvents(), calls = [], session = createSession({ demo: true });
  session.featureMatrix = { best: Object.fromEntries(['text', 'analysis', 'voice'].map(key => [key, { available: true }])) };
  const call = { callId: 'call', providerSessionId: 'provider', events,
    async close() { calls.push('close'); events.end(); return { closureConfirmed: true }; },
    async heartbeat() {}, async updateContext() {}, async setInput() {}, async setOutput() {},
    async pause() { return { acknowledged: true, paused: true }; } };
  const c = document.createElement('aithema-session');
  c.configure({ session, copy: en, copyForLocale: locale => ({ en, de })[locale], host,
    voiceClient: { manifest, async start() { calls.push('start'); if (startGate) await startGate.promise; if (startError) throw startError; return call; } } });
  const posts = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (String(url).startsWith('/api/library')) return Response.json({ items: [
      { id: 'cached', title: 'Saved conversation', updatedAt: '2026-10-12T10:00:00Z' },
    ], total: 1 });
    if (init.method === 'POST') {
      posts.push({ url, body: JSON.parse(init.body) });
      const event = { sessionId: session.id, seq: c.session.seq + 1, type: 'session.locale-changed', data: { locale: JSON.parse(init.body).locale } };
      return Response.json({ event, session: { ...c.session, locale: event.data.locale, seq: event.seq } });
    }
    return new Response(new ReadableStream({ start(controller) { init.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
  });
  document.body.append(c); t.after(() => c.remove());
  return { c, root: c.shadowRoot, calls, posts, session, call };
}

test('AIT-127: locale repaints the same conversation, composer, focus and control nodes', async t => {
  const { c, root, posts, session } = fixture(t);
  const input = root.querySelector('textarea'), settings = root.querySelector('.settings-open'), rail = root.querySelector('.voice-start'), orb = root.querySelector('.band-orb .orb');
  input.value = 'Unsent draft'; input.focus(); input.setSelectionRange(2, 6);
  assert.equal(await c.changeLocale('de'), true);
  assert.equal(c.session.id, session.id); assert.equal(c.session.locale, 'de');
  assert.equal(c.session.understanding.locale, 'de');
  assert.equal(root.querySelector('textarea'), input); assert.equal(input.value, 'Unsent draft');
  assert.equal(root.activeElement, input); assert.deepEqual([input.selectionStart, input.selectionEnd], [2, 6]);
  assert.equal(root.querySelector('.settings-open'), settings); assert.equal(root.querySelector('.voice-start'), rail);
  assert.equal(settings.textContent.trim(), de.settings.open); assert.equal(input.placeholder, de.placeholder);
  assert.equal(root.querySelector('.promise__lead').textContent, de.entrance.lead);
  assert.equal(root.querySelector('#ai-notice').textContent, `${de.aiNotice.text} ${de.aiNotice.voice}`);
  assert.equal(root.querySelector('.band-orb .orb'), orb);
  assert.equal(orb.getAttribute('aria-label'), de.reveal.label);
  assert.equal(root.querySelector('.aithema-reveal__row').getAttribute('aria-label'), de.reveal.label);
  assert.deepEqual([...root.querySelectorAll('.aithema-reveal__link')].map(n => n.title), de.reveal.links.map(link => link.subtitle));
  assert.deepEqual(posts.map(p => p.url), [`/api/sessions/${session.id}/locale`]);
});

for (const state of ['connecting', 'active']) test(`AIT-127: switching with an empty transcript and a ${state} call keeps the call`, async t => {
  const startGate = state === 'connecting' ? Promise.withResolvers() : undefined;
  const { c, root, calls, posts } = fixture(t, { startGate });
  // Exercise the locale path before the call; the old next-conversation-only behavior is insufficient.
  assert.equal(await c.changeLocale('de'), true);
  root.querySelector('.voice-start').click(); await tick();
  assert.equal(c.session.transcript.length, 0);
  const input = root.querySelector('textarea'); input.value = 'Still here'; input.focus();
  assert.equal(await c.changeLocale('en'), false);
  assert.equal(c.session.locale, 'de'); assert.deepEqual(calls, ['start']); assert.equal(posts.length, 1);
  assert.equal(root.querySelector('textarea'), input); assert.equal(input.value, 'Still here'); assert.equal(root.activeElement, input);
  startGate?.resolve(); await tick();
  assert.deepEqual(calls, ['start']); assert.equal(root.querySelector('.audio-rail').dataset.call, 'active');
});

test('AIT-127: a first turn overtaking the locale response and newer composer text survive', async t => {
  const { c, root, session } = fixture(t), reply = Promise.withResolvers(), requested = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', async () => { requested.resolve(); return reply.promise; });
  const changing = c.changeLocale('de'); await requested.promise;
  const event = { sessionId: session.id, seq: session.seq + 1, type: 'session.locale-changed', data: { locale: 'de' } };
  const oldSnapshot = { ...session, locale: 'de', seq: event.seq };
  c.receive(event);
  c.receive({ sessionId: session.id, seq: event.seq + 1, type: 'turn.final', data: { id: 'first', role: 'user', content: 'First turn' } });
  const input = root.querySelector('textarea'); input.value = 'A newer unsent message'; input.focus();
  reply.resolve(Response.json({ event, session: oldSnapshot })); await changing;
  assert.equal(c.session.id, session.id); assert.equal(c.session.locale, 'de');
  assert.equal(c.session.transcript[0].content, 'First turn'); assert.equal(c.session.seq, event.seq + 1);
  assert.equal(root.querySelector('textarea'), input); assert.equal(input.value, 'A newer unsent message'); assert.equal(root.activeElement, input);
});

test('AIT-127: a first turn before locale commit leaves the running language and draft intact', async t => {
  const { c, root, session } = fixture(t), reply = Promise.withResolvers(), requested = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', async () => { requested.resolve(); return reply.promise; });
  const changing = c.changeLocale('de'); await requested.promise;
  c.receive({ sessionId: session.id, seq: session.seq + 1, type: 'turn.final', data: { id: 'first', role: 'user', content: 'First turn' } });
  const input = root.querySelector('textarea'); input.value = 'Keep this'; input.focus();
  reply.resolve(Response.json({ error: 'locale-conflict' }, { status: 409 }));
  assert.equal(await changing, false); assert.equal(c.session.locale, 'en'); assert.equal(c.session.transcript[0].id, 'first');
  assert.equal(root.querySelector('textarea'), input); assert.equal(input.value, 'Keep this'); assert.equal(root.activeElement, input);
});

test('AIT-127: a call started during a pending locale acknowledgement is kept', async t => {
  const { c, root, session, calls } = fixture(t), reply = Promise.withResolvers(), requested = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', async () => { requested.resolve(); return reply.promise; });
  const changing = c.changeLocale('de'); await requested.promise;
  root.querySelector('.voice-start').click(); await tick();
  assert.equal(root.querySelector('.audio-rail').dataset.call, 'active');
  reply.resolve(Response.json({ event: { sessionId: session.id, seq: session.seq + 1, type: 'session.locale-changed', data: { locale: 'de' } } }));
  await changing;
  assert.deepEqual(calls, ['start']); assert.equal(root.querySelector('.audio-rail').dataset.call, 'active');
});

test('AIT-127: rapid choices are serialized and a queued choice never changes a different conversation', async t => {
  const { c, session, posts } = fixture(t);
  await Promise.all([c.changeLocale('de'), c.changeLocale('en'), c.changeLocale('de')]);
  assert.equal(c.session.locale, 'de'); assert.deepEqual(posts.map(p => p.body.locale), ['de', 'en', 'de']);
  const next = c.changeLocale('en');
  const other = createSession(); other.featureMatrix = session.featureMatrix;
  c.configure({ session: other, copy: en, copyForLocale: locale => ({ en, de })[locale] });
  assert.equal(await next, false); assert.equal(c.session.id, other.id); assert.equal(posts.length, 3);
});

test('AIT-127: device locale uses server metadata and never reconnects the device or replaces its draft', async t => {
  const { c, root, session, posts } = fixture(t);
  c.configure({ session: { ...session, processingPreset: 'device' }, copy: en, copyForLocale: locale => ({ en, de })[locale] });
  const input = root.querySelector('textarea'); input.value = 'Device draft';
  assert.equal(await c.changeLocale('de'), true); assert.equal(posts.length, 1);
  assert.equal(c.session.locale, 'de'); assert.equal(root.querySelector('textarea'), input); assert.equal(input.value, 'Device draft');
});

test('AIT-127: changing device locale does not consume a server settings acknowledgement on exit', async t => {
  const { c, session } = fixture(t);
  c.configure({ session: { ...session, processingPreset: 'device' }, copy: en, copyForLocale: locale => ({ en, de })[locale] });
  c.remove(); let serverSeq = session.seq;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, `/api/sessions/${session.id}/locale`);
    const event = { sessionId: session.id, seq: ++serverSeq, type: 'session.locale-changed', data: { locale: JSON.parse(init.body).locale } };
    return Response.json({ event });
  });
  await c.changeLocale('de');
  c.receive({ sessionId: session.id, seq: ++serverSeq, type: 'settings.changed', data: { processingPreset: 'best',
    settings: { ...session.settings, revision: 1, origin: 'chosen' } } });
  assert.equal(c.session.processingPreset, 'best'); assert.equal(c.session.settings.revision, 1);
  assert.equal(c.session.seq, serverSeq); assert.equal(c.session.locale, 'de');
});

test('AIT-127: a restore fetched before locale and first-turn events cannot roll them back', async t => {
  const { c, root, session } = fixture(t), reply = Promise.withResolvers(), requested = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (String(url).includes('/events')) return new Response(new ReadableStream({ start(controller) {
      init.signal?.addEventListener('abort', () => controller.close(), { once: true });
    } }));
    requested.resolve(); return reply.promise;
  });
  const first = { sessionId: session.id, seq: session.seq + 2, type: 'turn.final', data: { id: 'first', role: 'user', content: 'First turn' } };
  // A gap starts a snapshot fetch, then the missing locale event and the first turn arrive.
  c.receive(first); await requested.promise;
  c.receive({ sessionId: session.id, seq: session.seq + 1, type: 'session.locale-changed', data: { locale: 'de' } });
  c.receive(first);
  const input = root.querySelector('textarea'); input.value = 'New draft'; input.focus();
  reply.resolve(Response.json(session)); await tick();
  assert.equal(c.session.locale, 'de'); assert.equal(c.session.transcript[0].id, 'first'); assert.equal(c.session.seq, first.seq);
  assert.equal(root.querySelector('textarea'), input); assert.equal(input.value, 'New draft'); assert.equal(root.activeElement, input);
});

test('AIT-127 gate: two gap restores returning out of order keep the newer snapshot, locale and first turn', async t => {
  const { c, root, session } = fixture(t), replies = [Promise.withResolvers(), Promise.withResolvers()], cursors = [];
  let snapshots = 0;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (String(url).endsWith('/events')) {
      cursors.push(init.headers['Last-Event-ID']);
      return new Response(new ReadableStream({ start(controller) {
        init.signal?.addEventListener('abort', () => controller.close(), { once: true });
      } }));
    }
    assert.ok(snapshots < replies.length, 'only the two gap restores fetch snapshots');
    return replies[snapshots++].promise;
  });
  const locale = { sessionId: session.id, seq: session.seq + 2, type: 'session.locale-changed', data: { locale: 'de' } };
  const first = { sessionId: session.id, seq: session.seq + 3, type: 'turn.final', data: { id: 'first', role: 'user', content: 'First turn' } };
  const older = { ...session, seq: session.seq + 1 }, newer = [locale, first].reduce(applyEvent, older);
  c.receive(locale); c.receive(first);
  assert.equal(snapshots, 2);
  const input = root.querySelector('textarea'); input.value = 'Unsent draft'; input.focus(); input.setSelectionRange(1, 4);
  replies[1].resolve(Response.json(newer)); await tick();
  assert.equal(c.session.seq, newer.seq); assert.equal(c.session.transcript[0].id, 'first');
  assert.equal(c.session.locale, 'de'); assert.equal(input.placeholder, de.placeholder);
  replies[0].resolve(Response.json(older)); await tick();
  assert.equal(c.session.seq, newer.seq, 'the accepted snapshot advances the stale-response bound');
  assert.equal(c.session.locale, 'de'); assert.equal(c.session.transcript[0].id, 'first');
  assert.equal(root.querySelector('.turn').dataset.id, 'first'); assert.equal(input.placeholder, de.placeholder);
  assert.equal(root.querySelector('textarea'), input); assert.equal(input.value, 'Unsent draft');
  assert.equal(root.activeElement, input); assert.deepEqual([input.selectionStart, input.selectionEnd], [1, 4]);
  assert.ok(cursors.length > 0); assert.ok(cursors.every(cursor => cursor === String(newer.seq)));
});

test('AIT-127 gate: cached library row actions and rename labels repaint in place on reopening and while editing', async t => {
  const { c, root } = fixture(t, { host: { library: true } });
  const open = root.querySelector('.library-open-dialog'), dialog = root.querySelector('dialog.library');
  open.click(); await tick();
  const row = dialog.querySelector('tbody tr'), input = row.querySelector('.library__rename input');
  const selectors = ['.library-rename', '.library-delete', '.library-save', '.library-cancel', '.library__rename label'];
  const controls = selectors.map(selector => row.querySelector(selector));
  const labels = copy => ['rename', 'delete', 'save', 'cancel', 'renameLabel'].map(key => copy.hostSurface.library[key]);
  assert.deepEqual(controls.map(control => control.textContent), labels(en));
  dialog.querySelector('.library-close').click();
  assert.equal(await c.changeLocale('de'), true);
  open.click(); await tick();
  assert.equal(dialog.querySelector('tbody tr'), row);
  assert.deepEqual(controls.map(control => control.textContent), labels(de));
  row.querySelector('.library-rename').click(); input.value = 'Unsaved rename'; input.setSelectionRange(2, 5);
  assert.equal(root.activeElement, input);
  assert.equal(await c.changeLocale('en'), true);
  assert.equal(dialog.querySelector('tbody tr'), row);
  assert.deepEqual(selectors.map(selector => row.querySelector(selector)), controls);
  assert.deepEqual(controls.map(control => control.textContent), labels(en));
  assert.equal(row.querySelector('.library__rename input'), input); assert.equal(input.value, 'Unsaved rename');
  assert.equal(root.activeElement, input); assert.deepEqual([input.selectionStart, input.selectionEnd], [2, 5]);
  assert.equal(row.querySelector('.library__rename label').htmlFor, input.id);
});

for (const [reason, error, key] of [
  ['microphone denied', { name: 'NotAllowedError' }, 'voiceMicDenied'],
  ['microphone missing', { name: 'NotFoundError' }, 'voiceMicMissing'],
  ['connection failed', new Error('fixture'), 'voiceConnectionFailed'],
  ['conflicting call', { code: 'voice-conflict' }, 'voiceConflict'],
  ['deadline', { code: 'deadline' }, 'voiceDeadline'],
  ['deployment cap', { code: 'not-admitted', reason: 'Voice minute cap reached for this deployment' }],
  ['daily cap', { code: 'not-admitted', reason: 'Voice minute cap reached for this UTC day' }],
  ['unknown admission reason', { code: 'not-admitted', reason: 'unknown-fixture-reason' }, 'voiceAdmissionDenied'],
]) test(`AIT-127 gate: locale switching after a failed voice start retranslates ${reason}`, async t => {
  const { c, root, calls } = fixture(t, { startError: error });
  root.querySelector('.voice-start').click(); await tick();
  const rail = root.querySelector('.audio-rail'), status = rail.querySelector('.voice-state'), retry = rail.querySelector('.voice-retry');
  const message = copy => key ? copy[key] : copy.reasons[error.reason];
  assert.equal(rail.dataset.state, 'failed'); assert.equal(rail.dataset.call, 'none');
  assert.equal(status.textContent, message(en)); assert.equal(retry.disabled, false);
  for (const locale of ['de', 'en']) {
    assert.equal(await c.changeLocale(locale), true);
    assert.equal(root.querySelector('.audio-rail'), rail); assert.equal(rail.querySelector('.voice-state'), status);
    assert.equal(rail.querySelector('.voice-retry'), retry); assert.equal(retry.disabled, false);
    assert.equal(status.textContent, message({ en, de }[locale])); assert.equal(rail.hasAttribute('data-message'), true);
  }
  assert.deepEqual(calls, ['start'], 'repainting neither retries nor closes the failed call');
});
