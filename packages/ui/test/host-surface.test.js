// AIT-104 B2: the host surface inside <aithema-session>, one panel at a time, against a fixture
// server that answers like the B1 host routes: the verification lock and entry, the conversation
// library, handover with Retry, credits, the host slots, and the start card's pinned footer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession, inputRevision, reduceUnderstanding } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { hostStyles } from '../src/host-styles.js';
const window = new Window({ url: 'http://localhost/' });
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const v = en.hostSurface.verify, l = en.hostSurface.library, h = en.hostSurface.handover, cr = en.hostSurface.credits;

const identity = (extra = {}) => ({ status: 'guest', role: 'visitor', roles: ['visitor'], address: null, verificationRevision: 0, delivery: 'idle',
  expired: false, verificationRequired: false, confirmationAttemptsRemaining: 5, resendAfterMs: 0, canResend: false, pollVerification: false,
  assessmentUnlocked: true, conceptsUnlocked: true, canRunAssessment: true, canRunConcepts: true, paused: false, manualPaused: false, demoBypass: false, ...extra });
const locked = (extra = {}) => identity({ verificationRequired: true, assessmentUnlocked: false, conceptsUnlocked: false, canRunAssessment: false, canRunConcepts: false, ...extra });
const pending = (extra = {}) => locked({ status: 'verification-pending', address: 'visitor@example.com', verificationRevision: 1, delivery: 'sent', resendAfterMs: 60_000, ...extra });
const entry = (id, title, updatedAt) => ({ id, title, revision: 1, createdAt: updatedAt, updatedAt });
const balance = { owner: { limitMicro: 5_000_000, committedMicro: 750_000, availableMicro: 4_250_000, overrunMicro: 0 } };

// A connected component; `routes` maps "METHOD path" (after /api/sessions/:id or /api) to a handler.
function setup(t, { copy = en, host = { library: true, verification: true, handover: true, credits: true }, routes = {}, session: extra = {}, voiceClient } = {}) {
  const c = document.createElement('aithema-session'), session = createSession({ demo: true, locale: copy === de ? 'de' : 'en' });
  session.featureMatrix = { best: { text: { available: true }, analysis: { available: true } } };
  Object.assign(session, extra);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const path = String(url).replace(`/api/sessions/${c.session.id}`, '').replace(/^\/api/u, ''), method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    if (path === '/events') return new Response(new ReadableStream({ start(controller) { options.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
    calls.push({ method, path, body });
    const key = `${method} ${path.split('?')[0]}`;
    if (routes[key]) return routes[key](body, path);
    if (key === 'GET /identity') return Response.json({ identity: c.session.identity ?? identity() });
    if (key === 'GET /handover') return Response.json({ handover: { status: 'idle', revision: null }, offer: { available: true } });
    if (key === 'GET /credits') return Response.json({ balance, limitSlot: null });
    if (key === 'GET /library') return Response.json({ items: [], total: 0, offset: 0, limit: 100 });
    return Response.json(c.session);
  });
  c.configure({ copy, session, host, voiceClient }); document.body.append(c); t.after(() => c.remove());
  return { c, root: c.shadowRoot, calls };
}
const userTurn = (c, id = 't1') => c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id, role: 'user', content: 'We need a preorder app.' } });

for (const copy of [de, en]) for (const covered of [true, false]) test(`AIT-173 round 3: ended reconciling call uses normal text admission (${copy === de ? 'de' : 'en'}, covered ${covered})`, async t => {
  const { voiceEvents } = await import('../../core/src/live-voice.js');
  const events = voiceEvents(); let ended = false, settled = false;
  const matrix = () => ({ best: { text: { available: ended && (covered || settled), reason: ended && (covered || settled) ? null : 'budget denied' },
    voice: { available: true }, analysis: { available: ended && (covered || settled), reason: ended && (covered || settled) ? null : 'budget denied' } } });
  const voiceClient = { async start({ callId }) { return { callId, providerSessionId: 'closing-provider', events,
    async setInput() {}, async setOutput() {}, async updateContext() {},
    async close() { events.end(); return { closureConfirmed: false, outcome: 'uncertain', usage: null }; } }; } };
  const { c, root, calls } = setup(t, { copy, voiceClient, host: { credits: true },
    session: { demo: false, featureMatrix: matrix(), settings: { origin: 'chosen', voice: 'off', visuals: 'off' } }, routes: {
      'GET ': () => Response.json({ ...c.session, featureMatrix: matrix() }),
      'GET /credits': () => Response.json({ balance, exhausted: false, reconciling: ended && !settled }),
      'POST /turns': body => Response.json({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'after-hangup', role: 'user', content: body.content } }),
    } });
  await tick(8); root.querySelector('.voice-start').click(); await tick(8);
  assert.equal(root.querySelector('.composer-reason').textContent, copy === de ? 'Schreiben geht nach dem Anruf wieder' : 'You can type again after the call', 'during-call copy remains scoped to a live call');
  ended = true; root.querySelector('.voice-close').click();
  assert.equal(root.querySelector('.composer-shell').hasAttribute('data-used-up'), false, 'hangup never synchronously shows used-up');
  assert.equal(root.querySelector('form.composer').inert, false, 'hangup keeps the composer slot');
  assert.notEqual(root.querySelector('.workspace').dataset.emailAsk, 'open', 'hangup never asks for email');
  await tick(12);
  assert.equal(root.querySelector('.audio-rail').dataset.call, 'none');
  assert.equal(root.querySelector('textarea').disabled, !covered);
  assert.equal(root.querySelector('.send').disabled, !covered);
  assert.equal(root.querySelector('.composer-shell').hasAttribute('data-used-up'), !covered);
  assert.equal(root.querySelector('form.composer').inert, !covered);
  assert.doesNotMatch(root.querySelector('.composer-reason').textContent, /nach dem Anruf|after the call/u);
  assert.doesNotMatch(root.querySelector('.features').textContent, /nach dem Anruf|after the call/u);
  assert.doesNotMatch(root.querySelector('.notice').textContent, /nach dem Anruf|after the call/u);
  if (covered) {
    const input = root.querySelector('textarea'); input.value = 'A typed follow-up'; input.dispatchEvent(new window.Event('input'));
    assert.equal(input.value, 'A typed follow-up');
    assert.equal(input.placeholder, copy.placeholder);
  } else {
    assert.equal(root.querySelector('.composer-reason').textContent, copy.voiceStates.usedUp);
    settled = true; c.receive({ type: 'voice.state', data: { state: 'ended', callId: 'ended-call', providerSessionId: 'closing-provider',
      terminal: { closureConfirmed: true, usage: { costEstimated: false } } } });
    await tick(12);
    assert.equal(root.querySelector('textarea').disabled, false, 'a provider settlement refreshes admission immediately');
  }
  const input = root.querySelector('textarea'); input.value = 'A typed follow-up';
  root.querySelector('.send').click(); await tick(12);
  const posted = calls.find(call => call.path === '/turns');
  assert.equal(posted?.body.content, 'A typed follow-up');
  assert.equal(posted.body.voiceCallId, undefined, 'after-call typing uses the normal text path');
});

test('AIT-173 round 3: a stale call snapshot cannot reopen a locally ended call during credit refresh', async t => {
  const { voiceEvents } = await import('../../core/src/live-voice.js');
  const events = voiceEvents(), closeAck = Promise.withResolvers(); let callId;
  const voiceClient = { async start(request) { callId = request.callId; return { callId, providerSessionId: 'stale-provider', events,
    async setInput() {}, async setOutput() {}, async updateContext() {},
    async close() { await closeAck.promise; events.end(); return { closureConfirmed: false }; } }; } };
  const { c, root } = setup(t, { voiceClient, host: { credits: true },
    session: { featureMatrix: { best: { text: { available: true }, analysis: { available: true }, voice: { available: true } } } },
    routes: { 'GET ': () => Response.json({ ...c.session, voiceLifecycle: { callId, providerSessionId: 'stale-provider', state: 'waiting' } }) } });
  t.after(() => closeAck.resolve());
  await tick(8); root.querySelector('.voice-start').click(); await tick(8);
  root.querySelector('.voice-close').click();
  assert.equal(root.querySelector('.audio-rail').dataset.call, 'none', 'local hangup paints idle synchronously');
  await tick(12);
  assert.equal(root.querySelector('.audio-rail').dataset.call, 'none', 'the admission snapshot cannot undo terminal intent');
  assert.equal(root.querySelector('.audio-rail').dataset.state, 'idle');
});

test('AIT-173 round 3: an old hangup credit read cannot deny Retry after a newer Start attempt', async t => {
  const { voiceEvents } = await import('../../core/src/live-voice.js');
  const events = voiceEvents(), readStarted = Promise.withResolvers(), readDone = Promise.withResolvers(); let starts = 0;
  const voiceClient = { async start({ callId }) {
    if (++starts > 1) throw Object.assign(new Error('fixture outage'), { code: 'unavailable' });
    return { callId, providerSessionId: 'retry-provider', events, async setInput() {}, async setOutput() {}, async updateContext() {},
      async close() { events.end(); return { closureConfirmed: false }; } };
  } };
  const { c, root } = setup(t, { voiceClient, host: { credits: true },
    session: { featureMatrix: { best: { text: { available: true }, analysis: { available: true }, voice: { available: true } } } },
    routes: { 'GET ': async () => { const before = c.session; readStarted.resolve(); await readDone.promise;
      return Response.json({ ...before, featureMatrix: { ...before.featureMatrix, best: { ...before.featureMatrix.best,
        voice: { available: false, reason: 'budget denied' } } } }); } } });
  t.after(() => readDone.resolve());
  await tick(8); root.querySelector('.voice-start').click(); await tick(8);
  root.querySelector('.voice-close').click(); await readStarted.promise;
  root.querySelector('.voice-start').click(); await tick(8);
  assert.equal(root.querySelector('.audio-rail').dataset.state, 'failed');
  assert.equal(root.querySelector('.voice-retry').disabled, false);
  readDone.resolve(); await tick(12);
  assert.equal(root.querySelector('.voice-retry').disabled, false, 'the ended-call read cannot replace a newer attempt verdict');
});

test('AIT-135 a host without an owner guard displays credits with a hidden, empty countdown', async t => {
  const { root } = setup(t, { host: { credits: true } }); await tick();
  assert.equal(root.querySelector('.host-credits').hidden, false);
  assert.equal(root.querySelector('.host-credits__deadline').hidden, true);
  assert.equal(root.querySelector('.host-credits__deadline').textContent, '');
  assert.notEqual(root.querySelector('.host-credits__amount').textContent, '…');
});

test('AIT-145: background voice settlement refreshes the displayed wallet without another spoken turn', async t => {
  let availableMicro = 4_000_000;
  const { c, root, calls } = setup(t, { host: { credits: { format: value => (value / 1_000_000).toFixed(2) } }, routes: {
    'GET /credits': () => Response.json({ balance: { owner: { limitMicro: 10_000_000, availableMicro } }, limitSlot: null }),
  } });
  await tick(); const before = calls.filter(call => call.path === '/credits').length;
  assert.match(root.querySelector('.host-credits__text').textContent, /4\.00/u);
  availableMicro = 8_480_000;
  c.receive({ type: 'voice.state', data: { callId: 'ended-call', providerSessionId: 'ended-provider', state: 'ended',
    terminal: { closureConfirmed: true, outcome: 'completed', usage: { upstreamMicro: 1_520_000, costEstimated: false } } } });
  await new Promise(resolve => setTimeout(resolve, 400)); await tick();
  assert.equal(calls.filter(call => call.path === '/credits').length, before + 1);
  assert.match(root.querySelector('.host-credits__text').textContent, /8\.48/u);
});

test('without a host option the component shows no host surface', t => {
  const { root } = setup(t, { host: null });
  assert.equal(root.querySelector('.host-bar').hidden, true);
  assert.equal(root.querySelector('.handover').hidden, true);
  assert.equal(root.querySelector('.verify-lock').hidden, true);
  assert.equal(root.querySelector('.workspace').hasAttribute('data-host'), false);
  assert.equal(root.querySelector('.host-verify').hidden, true);
});

test('verification lock: the email form replaces the assessment in place, invalid refused locally, Send becomes Send link again with a cooldown (AIT-104 B2)', async t => {
  const { c, root, calls } = setup(t, { session: { identity: locked() }, routes: {
    'POST /identity/request': body => Response.json({ identity: pending({ address: body.address }) }),
    'POST /identity/resend': () => Response.json({ error: 'resend-rate-limit', identity: pending() }, { status: 429 }),
  } });
  await tick();
  const lock = root.querySelector('.verify-lock');
  assert.equal(lock.hidden, false);
  assert.equal(lock.querySelector('.verify-lock__title').textContent, v.lockTitle);
  assert.ok([...root.querySelectorAll('.analysis-content > section')].every(s => s.hidden), 'the assessment stays hidden');
  assert.equal(root.querySelector('.readiness').style.visibility, 'hidden');
  assert.equal(root.querySelector('.host-verify .verify-entry').textContent, v.entry);
  // Sending controls carry the AI notice (AIT-119).
  assert.deepEqual(lock.querySelector('.verify-send').getAttribute('aria-describedby').split(' '), ['verify-lock-message', 'ai-notice']);
  assert.match(lock.querySelector('.verify-resend').getAttribute('aria-describedby'), /\bai-notice\b/u);
  // Invalid: plain words, no request.
  lock.querySelector('#verify-lock-email').value = 'not-an-address';
  lock.querySelector('form').requestSubmit(); await tick();
  assert.equal(lock.querySelector('#verify-lock-message').textContent, v.invalid);
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
  // Valid: the request names only the address; the pending view shows it and a cooldown.
  lock.querySelector('#verify-lock-email').value = ' visitor@example.com ';
  lock.querySelector('form').requestSubmit(); await tick();
  assert.deepEqual(calls.find(call => call.method === 'POST'), { method: 'POST', path: '/identity/request', body: { address: 'visitor@example.com' } });
  assert.equal(lock.querySelector('form').dataset.mode, 'pending');
  assert.equal(lock.querySelector('.verify__address').textContent, 'visitor@example.com');
  assert.match(lock.querySelector('#verify-lock-note').textContent, /^You can send it again in \d+ s\.$/u);
  assert.equal(lock.querySelector('.verify-resend').getAttribute('aria-disabled'), 'true', 'cooling down, still focusable');
  assert.equal(lock.querySelector('.verify-send').style.visibility, 'hidden', 'Send and Send link again share one cell');
  assert.equal(lock.querySelector('#verify-lock-message').textContent, v.saved);
  assert.equal(root.querySelector('.host-verify .verify-entry').textContent, 'Resend or change');
  // During the cooldown Resend says so without a request.
  lock.querySelector('.verify-resend').click(); await tick();
  assert.equal(lock.querySelector('#verify-lock-message').textContent, v.rateLimited);
  assert.equal(calls.filter(call => call.path === '/identity/resend').length, 0);
  // A server 429 is plain words too.
  c.receive({ seq: c.session.seq + 1, type: 'identity.state', data: pending({ resendAfterMs: 0, canResend: true }) });
  lock.querySelector('.verify-resend').click(); await tick();
  assert.equal(calls.filter(call => call.path === '/identity/resend').length, 1);
  assert.equal(lock.querySelector('#verify-lock-message').textContent, v.rateLimited);
  assert.equal(lock.querySelector('#verify-lock-message').dataset.error, 'true');
  // Change: the capture field returns with the address, Cancel goes back.
  lock.querySelector('.verify-change').click();
  assert.equal(lock.querySelector('form').dataset.mode, 'capture');
  assert.equal(lock.querySelector('#verify-lock-email').value, 'visitor@example.com');
  lock.querySelector('.verify-cancel').click();
  assert.equal(lock.querySelector('form').dataset.mode, 'pending');
});

test('verification unlock over SSE keeps a manual pause and says so; Settings then shows a quiet verified line', async t => {
  const { c, root } = setup(t, { session: { identity: pending() } }); await tick();
  assert.equal(root.querySelector('.verify-lock').hidden, false);
  c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true } });
  c.receive({ seq: c.session.seq + 1, type: 'identity.state', data: identity({ status: 'verified', address: 'visitor@example.com', verificationRequired: true, manualPaused: true, paused: true }) });
  c.receive({ seq: c.session.seq + 1, type: 'identity.unlocked', data: { manualPaused: true } });
  assert.equal(root.querySelector('.verify-lock').hidden, true);
  assert.equal(root.querySelector('.notice').hidden, false);
  assert.equal(root.querySelector('.status__label').textContent, v.unlockedPaused);
  assert.equal(root.querySelector('.host-verify .verify-entry').hidden, true);
  assert.equal(root.querySelector('.host-verify .verify-done').hidden, false);
  assert.equal(root.querySelector('.host-verify .verify-done').textContent, 'Verified');
});

test('a keyboard unlock before the first input moves focus to the visible stage control: Continue at the entrance, Start at readiness', async t => {
  for (const [chosen, stage, selector] of [[false, 'entrance', '.chooser__continue'], [true, 'ready', '.ready__start']]) {
    const { c, root } = setup(t, { session: { identity: pending() } }); await tick();
    if (chosen) c.receive({ seq: c.session.seq + 1, type: 'settings.changed',
      data: { processingPreset: 'best', settings: { ...c.session.settings, revision: 1, origin: 'chosen', at: new Date().toISOString() } } });
    assert.equal(root.querySelector('.workspace').dataset.stage, stage);
    // The visitor works in the locked form, then the link is confirmed elsewhere.
    const inLock = root.querySelector('.verify-lock .verify-resend'); inLock.focus();
    assert.ok(root.activeElement === inLock, `${stage}: focus is in the locked form`);
    c.receive({ seq: c.session.seq + 1, type: 'identity.state', data: identity({ status: 'verified', address: 'visitor@example.com', verificationRequired: true }) });
    assert.equal(root.querySelector('.verify-lock').hidden, true);
    const target = root.querySelector(selector);
    assert.ok(target.closest('[hidden], [inert]') === null, `${stage}: the control is visible and operable`);
    assert.ok(root.activeElement === target, `${stage}: focus is on ${selector}`);
    assert.equal(root.querySelector('.workspace').dataset.stage, stage, 'unlocking starts nothing');
    // happy-dom's ShadowRoot.activeElement throws while focus rests in another component's shadow tree.
    target.blur();
  }
});

test('verification polling asks the host to unlock while a link is pending, never while hidden from a disconnected page', async t => {
  const { root, calls } = setup(t, { host: { verification: true, pollMs: 5 }, session: { identity: pending({ pollVerification: true }) },
    routes: { 'POST /identity/unlock': () => Response.json({ identity: identity({ status: 'verified', address: 'visitor@example.com', verificationRequired: true }) }) } });
  for (let i = 0; i < 20 && root.querySelector('.verify-lock').hidden === false; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(calls.some(call => call.path === '/identity/unlock'));
  assert.equal(root.querySelector('.verify-lock').hidden, true);
});

test('without the lock, verification opens from Settings General and returns focus to the gear', async t => {
  const { root } = setup(t, { session: { identity: identity() } }); await tick();
  assert.equal(root.querySelector('.verify-lock').hidden, true);
  assert.equal(root.querySelector('.host-extras'), null);
  assert.equal(root.querySelector('.general').lastElementChild, root.querySelector('.host-verify'));
  const gear = root.querySelector('.settings-open'), settings = root.querySelector('dialog.settings');
  gear.click(); settings.querySelector('[data-tab="general"]').click();
  assert.equal(settings.open, true);
  const button = root.querySelector('.host-verify .verify-entry');
  assert.equal(button.hidden, false); assert.equal(button.getAttribute('aria-haspopup'), 'dialog');
  button.click(); await tick();
  const dialog = root.querySelector('dialog.verify-dialog');
  assert.equal(settings.open, false);
  assert.equal(dialog.open, true);
  assert.equal(root.activeElement?.id, 'verify-dialog-email');
  dialog.querySelector('.verify-dialog-close').click();
  await tick();
  assert.equal(dialog.open, false);
  assert.equal(root.activeElement, gear);
});

test('AIT-131 r3: Settings email states follow identity events in DE and EN without replacing the action', async t => {
  for (const [copy, words] of [[de, ['E-Mail', 'Nicht bestätigt', 'E-Mail-Adresse bestätigen', 'Link gesendet', 'Erneut senden oder ändern', 'Bestätigt']],
    [en, ['Email', 'Not verified', 'Confirm your email address', 'Link sent', 'Resend or change', 'Verified']]]) await t.test(copy.display.locale, async t => {
    const { c, root } = setup(t, { copy, session: { identity: identity() } }); await tick();
    c.openSettings(undefined, { tab: 'general' });
    const section = root.querySelector('.host-verify'), button = section.querySelector('.verify-entry');
    assert.equal(section.closest('[data-panel]').dataset.panel, 'general');
    assert.equal(section.hidden, false); assert.equal(section.querySelector('h3').textContent, words[0]);
    assert.equal(section.querySelector('.verify-entry-status').textContent, words[1]);
    assert.equal(button.textContent, words[2]); assert.equal(button.hidden, false);
    c.receive({ seq: c.session.seq + 1, type: 'identity.state', data: pending({ verificationRequired: false }) });
    assert.equal(section.querySelector('.verify-entry-address').textContent, 'visitor@example.com');
    assert.equal(section.querySelector('.verify-entry-status').textContent, words[3]);
    assert.equal(section.querySelector('.verify-entry'), button); assert.equal(button.textContent, words[4]);
    button.click(); await tick();
    assert.equal(root.querySelector('dialog.settings').open, false); assert.equal(root.querySelector('dialog.verify-dialog').open, true);
    assert.equal(root.activeElement, root.querySelector('dialog.verify-dialog .verify-resend'));
    root.querySelector('.verify-dialog-close').click(); await tick();
    assert.equal(root.activeElement, root.querySelector('.settings-open'));
    c.openSettings(undefined, { tab: 'general' });
    c.receive({ seq: c.session.seq + 1, type: 'identity.state', data: identity({ status: 'verified', address: 'visitor@example.com' }) });
    assert.equal(section.querySelector('.verify-entry-address').textContent, 'visitor@example.com');
    assert.equal(section.querySelector('.verify-done').hidden, false); assert.equal(section.querySelector('.verify-done').textContent, words[5]);
    assert.equal(button.hidden, true); assert.equal(section.querySelector('.verify-entry-status').hidden, true);
    c.receive({ seq: c.session.seq + 1, type: 'identity.state', data: { erased: true } });
    assert.equal(section.hidden, true, 'erased identity leaves no email entry');
  });
});

test('library: lists the owner conversations keyed, sorts by title and activity, renames in place, deletes with erasure wording (AIT-104 B2)', async t => {
  const items = [entry('a', 'Bakery preorders', '2026-10-01T10:00:00Z'), entry('b', '', '2026-10-09T10:00:00Z'), entry('c', 'Accounting export', '2026-10-05T10:00:00Z')];
  const { c, root, calls } = setup(t, { routes: {
    'GET /library': () => Response.json({ items, total: items.length, offset: 0, limit: 100 }),
    'POST /library/a/rename': body => Response.json({ ...items[0], title: body.title }),
    'POST /library/c/delete': () => { items.splice(2, 1); return Response.json({ id: 'c', erased: true, providerDeletion: 'not-confirmed' }); },
  } });
  const open = root.querySelector('.library-open-dialog');
  assert.equal(root.querySelector('.conversations-toggle').title, l.open); assert.equal(open.textContent, en.display.manageConversations);
  open.click(); await tick();
  const dialog = root.querySelector('dialog.library'), keys = () => [...dialog.querySelectorAll('tbody tr')].map(r => r.dataset.key);
  assert.equal(dialog.open, true); assert.equal(root.activeElement?.id, 'library-search');
  assert.match(calls.find(call => call.path.startsWith('/library')).path, /^\/library\?search=&offset=0&limit=100$/u);
  assert.deepEqual(keys(), ['b', 'c', 'a'], 'newest activity first');
  assert.equal(dialog.querySelector('tr[data-key="b"] .library__name').textContent, l.untitled);
  // Every open/new/reset control carries the AI notice.
  for (const selector of ['.library-open', '.library-new', '.library-reset']) assert.match(dialog.querySelector(selector).getAttribute('aria-describedby'), /\bai-notice\b/u);
  const nodes = new Map([...dialog.querySelectorAll('tbody tr')].map(r => [r.dataset.key, r]));
  dialog.querySelector('[data-sort="title"]').click();
  assert.deepEqual(keys(), ['c', 'a', 'b']); assert.equal(dialog.querySelector('.library__col-title').getAttribute('aria-sort'), 'ascending');
  assert.ok([...dialog.querySelectorAll('tbody tr')].every(r => nodes.get(r.dataset.key) === r), 'rows keep their nodes when sorted');
  dialog.querySelector('[data-sort="title"]').click();
  assert.deepEqual(keys(), ['b', 'a', 'c']); assert.equal(dialog.querySelector('.library__col-title').getAttribute('aria-sort'), 'descending');
  // Rename in place: the name and the row actions swap within their cells.
  dialog.querySelector('tr[data-key="a"] .library-rename').click();
  const input = dialog.querySelector('tr[data-key="a"] .library__rename input');
  assert.equal(root.activeElement, input); assert.equal(input.value, 'Bakery preorders');
  assert.equal(dialog.querySelector('tr[data-key="a"] .library-open').style.visibility, 'hidden');
  input.value = 'Bakery app';
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' })); await tick();
  assert.deepEqual(calls.find(call => call.path === '/library/a/rename').body, { title: 'Bakery app' });
  assert.equal(dialog.querySelector('tr[data-key="a"] .library__name').textContent, 'Bakery app');
  assert.equal(dialog.querySelector('.library__message').textContent, l.renamed);
  assert.equal(root.activeElement, dialog.querySelector('tr[data-key="a"] .library-rename'));
  // Delete: the confirmation takes the footer's place with the erasure wording; Cancel focuses back.
  dialog.querySelector('tr[data-key="c"] .library-delete').click();
  assert.equal(dialog.querySelector('.library__question').textContent, 'Delete “Accounting export”?');
  assert.equal(dialog.querySelector('#library-confirm-warning').textContent, l.deleteWarning);
  assert.equal(dialog.querySelector('.library__default').style.visibility, 'hidden');
  assert.equal(root.activeElement, dialog.querySelector('.library-confirm-cancel'));
  dialog.querySelector('.library-confirm').click(); await tick();
  assert.deepEqual(keys(), ['b', 'a']); assert.equal(dialog.querySelector('.library__message').textContent, l.deleted);
});

test('library: New and Reset hand the conversation to the host; without a handler the element adopts it', async t => {
  const replacement = createSession({ demo: true }), created = createSession({ demo: true });
  for (const s of [replacement, created]) s.featureMatrix = { best: { text: { available: true }, analysis: { available: true } } };
  const { c, root, calls } = setup(t, { routes: {
    'POST /library': () => Response.json({ ...entry(created.id, '', '2026-10-10T10:00:00Z'), session: created }, { status: 201 }),
  } });
  const first = c.session.id;
  const seen = [];
  c.addEventListener('aithema-open-conversation', event => seen.push([event.detail.reason, event.detail.session.id, event.detail.previousSessionId]));
  root.querySelector('.library-open-dialog').click(); await tick();
  root.querySelector('.library-new').click(); await tick();
  assert.deepEqual(seen, [['new', created.id, first]]);
  assert.equal(c.session.id, created.id, 'not prevented: the element switched itself');
  assert.equal(root.activeElement?.className, 'conversations-toggle', 'focus returns to the library button');
  assert.equal(calls.find(call => call.method === 'POST' && call.path === '/library').body.locale, 'en');
  // Reset asks first, with its own wording, then posts for the current conversation.
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (String(url).endsWith('/events')) return new Response(new ReadableStream({ start(controller) { options.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
    if (String(url) === `/api/library/${created.id}/reset`) return Response.json({ ...entry(replacement.id, '', '2026-10-10T11:00:00Z'), session: replacement }, { status: 201 });
    if (String(url).startsWith('/api/library')) return Response.json({ items: [], total: 0 });
    return Response.json({ balance, limitSlot: null, handover: null, offer: null });
  });
  c.addEventListener('aithema-open-conversation', event => event.preventDefault(), { once: true });
  root.querySelector('.library-open-dialog').click(); await tick();
  const dialog = root.querySelector('dialog.library');
  dialog.querySelector('.library-reset').click();
  assert.equal(dialog.querySelector('.library__question').textContent, l.resetQuestion);
  assert.equal(dialog.querySelector('#library-confirm-warning').textContent, l.resetWarning);
  dialog.querySelector('.library-confirm').click(); await tick();
  assert.deepEqual(seen.at(-1), ['reset', replacement.id, created.id]);
  assert.equal(c.session.id, created.id, 'prevented: the host switches');
});

test('handover: the host offer slot, a failed delivery offers Retry in the same place, then sent; the revision limit says so', async t => {
  let attempt = 0;
  const { c, root, calls } = setup(t, { routes: {
    'POST /handover': () => Response.json({ handover: { status: 'failed', revision: 'r', canRetry: true } }),
    'POST /handover/retry': () => { attempt += 1; return Response.json({ handover: { status: 'preparing', revision: 'r' } }); },
  } });
  await tick();
  const band = root.querySelector('.handover'), button = band.querySelector('.handover-request');
  assert.equal(band.hidden, false);
  assert.equal(band.querySelector('h3').textContent, h.title);
  assert.equal(band.querySelector('slot[name="handover-offer"]').textContent, h.offer, 'default offer copy until the host fills the slot');
  assert.equal(button.getAttribute('aria-disabled'), 'true'); assert.equal(band.querySelector('.handover__state').textContent, h.needsInput);
  userTurn(c);
  assert.equal(button.getAttribute('aria-disabled'), 'false');
  button.click(); await tick();
  assert.equal(calls.filter(call => call.path === '/handover' && call.method === 'POST').length, 1);
  assert.equal(band.querySelector('.handover__label').textContent, h.retry);
  assert.equal(band.querySelector('.handover__state').textContent, h.failed);
  // The button keeps the box of its longest label.
  assert.deepEqual([...button.querySelectorAll('.handover__sizer')].map(s => s.textContent), [h.request, h.update, h.retry]);
  button.click(); await tick();
  assert.equal(attempt, 1);
  assert.equal(band.querySelector('.handover__state').textContent, h.preparing);
  c.receive({ seq: c.session.seq + 1, type: 'handover.state', data: { status: 'sent', revision: inputRevision(c.session) } });
  assert.equal(band.querySelector('.handover__state').textContent, h.sent);
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  c.receive({ seq: c.session.seq + 1, type: 'handover.limit-reached', data: { reason: 'revision-limit' } });
  assert.equal(band.querySelector('.handover__state').textContent, h.limit);
});

test('handover stays away when the host offers none', async t => {
  const { root } = setup(t, { routes: { 'GET /handover': () => Response.json({ handover: null, offer: { available: false } }) } }); await tick();
  assert.equal(root.querySelector('.handover').hidden, true);
});

test('credits: only the monetary balance is shown, and host-limit uses the calm stacked state', async t => {
  const { c, root } = setup(t, { routes: {
    'GET /credits': () => Response.json({ balance, limitSlot: { status: 'active', remainingMs: 30 * 60_000, canStartPaidWork: true } }),
  } });
  await tick();
  const line = root.querySelector('.host-credits');
  assert.equal(line.hidden, false);
  assert.equal(line.querySelector('.host-credits__text').textContent, '425 of 500 Credits');
  assert.equal(line.querySelector('.host-credits__deadline').textContent, '');
  const statusBefore = root.querySelector('.status__label').textContent;
  c.receive({ seq: c.session.seq + 1, type: 'credits.limit-reached', data: { reason: 'host-limit' } });
  assert.equal(line.querySelector('.host-credits__used-up-full').textContent, cr.usedUp);
  assert.equal(line.querySelector('.host-credits__limit').hidden, false);
  assert.equal(root.querySelector('.status__label').textContent, statusBefore, 'the footer does not duplicate the live exhaustion announcement');
  assert.equal(root.querySelector('.credit-announcement').textContent, en.hostSurface.usedUp.announce);
});

test('host slots: account, credits limit, handover offer, legal and footer are named slots; the footer row shows only when filled', async t => {
  const { c, root } = setup(t);
  for (const name of ['account', 'credits-limit', 'handover-offer', 'legal', 'footer']) assert.ok(root.querySelector(`slot[name="${name}"]`), name);
  assert.equal(root.querySelector('.host-foot').hidden, true);
  const footer = document.createElement('p'); footer.slot = 'footer'; footer.textContent = 'Demo only'; c.append(footer); await tick();
  // happy-dom fires no slotchange; the browser suite covers the filled row.
  const slot = root.querySelector('slot[name="footer"]');
  if (slot.assignedNodes?.().length) { slot.dispatchEvent(new window.Event('slotchange')); assert.equal(root.querySelector('.host-foot').hidden, false); }
});

test('German copy on the host surface; every English host key has a German counterpart', async t => {
  const { root } = setup(t, { copy: de, session: { identity: locked() } }); await tick();
  assert.equal(root.querySelector('.conversations-toggle').textContent, de.hostSurface.library.open);
  assert.equal(root.querySelector('.library-open-dialog').textContent, de.display.manageConversations);
  assert.equal(root.querySelector('.verify-lock__title').textContent, de.hostSurface.verify.lockTitle);
  assert.equal(root.querySelector('.verify-lock .verify-send').textContent, de.hostSurface.verify.send);
  const keys = (value, prefix = '') => Object.entries(value).flatMap(([k, v]) => v && typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]);
  assert.deepEqual(keys(de.hostSurface).sort(), keys(en.hostSurface).sort());
  assert.deepEqual(keys(de.host.slots).sort(), keys(en.host.slots).sort());
  assert.deepEqual(keys(de.host.outbox).sort(), keys(en.host.outbox).sort());
});

test('start card: Continue keeps START\'s last column of the action row on the page, and the error line is reserved (AIT-104 B2, AIT-128)', t => {
  const { root } = setup(t, { host: null });
  const action = root.querySelector('.chooser__action');
  assert.ok(action?.querySelector('.chooser__continue') && action.nextElementSibling?.matches('.chooser__error'));
  // The entrance is the page itself, not a scrolling card: nothing can cut Continue off.
  const css = root.querySelector('style').textContent;
  assert.match(css, /\.chooser__continue \{ grid-column:-2\/-1;/u); assert.match(css, /\.chooser__error \{[^}]*min-height:1\.5em;/u);
  assert.doesNotMatch(css, /\.intro \{[^}]*overflow:auto/u);
  assert.match(hostStyles, /\.verify__primary > \* \{ grid-area:1\/1;/u, 'Send and Send again share one cell');
});

// Gate fix round 1 (PR #86): each test below would have caught one finding.
test('verification copy names what B1 sends: a confirmation link, not the assessment (en and de)', () => {
  assert.match(v.sentTo, /confirmation link/iu); assert.doesNotMatch(v.sentTo, /assessment/iu);
  assert.match(de.hostSurface.verify.sentTo, /Bestätigungslink/u); assert.doesNotMatch(de.hostSurface.verify.sentTo, /Auswertung|Einschätzung/u);
});

test('credits: pause and elapsed time never add a countdown to lifetime credit', async t => {
  const { c, root } = setup(t, { session: { paused: true }, routes: {
    'GET /credits': () => Response.json({ balance, limitSlot: { status: 'active', remainingMs: 30 * 60_000, canStartPaidWork: false } }),
  } });
  await tick();
  assert.equal(root.querySelector('.host-credits__text').textContent, '425 of 500 Credits');
  assert.equal(root.querySelector('.host-credits__deadline').textContent, '');
  c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: false } });
  assert.equal(root.querySelector('.host-credits__deadline').textContent, '');
  assert.equal(cr.remaining, undefined); assert.equal(cr.paused, undefined);
});

test('library: saving a rename keeps every row in place; a background reload too; the next load or search sorts afresh', async t => {
  const items = [entry('a', 'Bakery preorders', '2026-10-09T10:00:00Z'), entry('b', 'Accounting export', '2026-10-05T10:00:00Z'), entry('c', 'Clinic rota', '2026-10-01T10:00:00Z')];
  const { c, root } = setup(t, { routes: {
    'GET /library': (_, path) => {
      const search = new URLSearchParams(path.split('?')[1]).get('search') ?? '';
      const found = items.filter(item => item.title.toLowerCase().includes(search.toLowerCase())).sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt));
      return Response.json({ items: found, total: found.length, offset: 0, limit: 100 });
    },
    // Renaming makes the conversation the latest one, as in B1.
    'POST /library/c/rename': body => { Object.assign(items[2], { title: body.title, updatedAt: '2026-10-10T10:00:00Z' }); return Response.json(items[2]); },
  } });
  root.querySelector('.library-open-dialog').click(); await tick();
  const dialog = root.querySelector('dialog.library'), keys = () => [...dialog.querySelectorAll('tbody tr')].map(r => r.dataset.key);
  assert.deepEqual(keys(), ['a', 'b', 'c'], 'last activity first');
  const nodes = [...dialog.querySelectorAll('tbody tr')];
  dialog.querySelector('tr[data-key="c"] .library-rename').click();
  const input = dialog.querySelector('tr[data-key="c"] .library__rename input'); input.value = 'Clinic rota 2027';
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' })); await tick();
  assert.equal(dialog.querySelector('tr[data-key="c"] .library__name').textContent, 'Clinic rota 2027');
  assert.deepEqual(keys(), ['a', 'b', 'c'], 'the renamed row stays where the pointer is');
  // "Name saved." appears above the list: its line keeps the height it reserves (the browser suite measures it).
  assert.match(hostStyles, /\.library__message \{ min-height:1\.3em; line-height:1\.3; \}/u);
  assert.ok([...dialog.querySelectorAll('tbody tr')].every((row, i) => row === nodes[i]), 'same nodes, same places');
  assert.ok(root.activeElement === dialog.querySelector('tr[data-key="c"] .library-rename'), 'focus on Rename');
  // The rename's library.state event reloads the open list without moving a row.
  c.receive({ seq: c.session.seq + 1, type: 'library.state', data: { title: '', revision: 2 } }); await tick();
  assert.deepEqual(keys(), ['a', 'b', 'c']);
  // A search is a new load: sorted afresh.
  const search = dialog.querySelector('#library-search'); search.value = 'o';
  search.dispatchEvent(new window.Event('input')); await new Promise(r => setTimeout(r, 300)); await tick();
  assert.deepEqual(keys(), ['c', 'a', 'b']);
});

test('AI notice: visible inside the verification dialog; the Reset confirmation (and deleting the open conversation) describe it, deleting another does not', async t => {
  const items = [entry('other', 'Other topic', '2026-10-01T10:00:00Z')];
  const { c, root } = setup(t, { session: { identity: identity() }, routes: {
    'GET /library': () => Response.json({ items: [entry(c.session.id, 'This one', '2026-10-09T10:00:00Z'), ...items], total: 2, offset: 0, limit: 100 }),
  } });
  await tick();
  const notice = root.querySelector('#ai-notice').textContent;
  assert.ok(notice.length > 0);
  root.querySelector('.host-verify .verify-entry').click(); await tick();
  const dialog = root.querySelector('dialog.verify-dialog'), line = dialog.querySelector('.verify-dialog__notice');
  assert.equal(dialog.open, true);
  assert.ok(line && dialog.contains(line), 'the notice is inside the modal, not behind it');
  assert.equal(line.textContent, notice); assert.equal(line.hidden, false); assert.notEqual(line.style.visibility, 'hidden');
  assert.match(dialog.querySelector('.verify-send').getAttribute('aria-describedby'), /\bai-notice\b/u);
  dialog.querySelector('.verify-dialog-close').click();
  root.querySelector('.library-open-dialog').click(); await tick();
  const library = root.querySelector('dialog.library'), confirm = library.querySelector('.library-confirm');
  library.querySelector('.library-reset').click();
  assert.deepEqual(confirm.getAttribute('aria-describedby').split(' '), ['library-confirm-warning', 'ai-notice']);
  library.querySelector('.library-confirm-cancel').click();
  library.querySelector(`tr[data-key="${c.session.id}"] .library-delete`).click();
  assert.deepEqual(confirm.getAttribute('aria-describedby').split(' '), ['library-confirm-warning', 'ai-notice'], 'deleting the open conversation begins a new one');
  library.querySelector('.library-confirm-cancel').click();
  library.querySelector('tr[data-key="other"] .library-delete').click();
  assert.deepEqual(confirm.getAttribute('aria-describedby').split(' '), ['library-confirm-warning']);
});

test('locked understanding pane: the verification controls sit under no aria-disabled or inert ancestor; only the locked content is inert', async t => {
  const { root } = setup(t, { session: { identity: locked(),
    featureMatrix: { best: { text: { available: true }, analysis: { available: false, reason: 'verification required' } } } } });
  await tick();
  const lock = root.querySelector('.verify-lock');
  assert.equal(lock.hidden, false);
  for (const control of [lock, lock.querySelector('#verify-lock-email'), lock.querySelector('.verify-send')]) {
    // Compared as a label: a failing assertion never prints a whole DOM node.
    const blocker = control.closest('[aria-disabled="true"], [inert]');
    assert.equal(blocker && `${blocker.tagName.toLowerCase()}.${blocker.className}`, null, `${control.className || control.id} is usable`);
  }
  assert.notEqual(root.querySelector('.understanding').getAttribute('aria-disabled'), 'true');
  assert.equal(root.querySelector('.readiness').hasAttribute('inert'), true, 'the locked readiness scale is unavailable');
  assert.ok([...root.querySelectorAll('.analysis-content > section')].every(s => s.hidden));
});


// AIT-135 A2: all amounts are acknowledged host values (USD millionths).
const a2Allowances = { anonymous: 12_000_000, emailGiven: 18_000_000, emailConfirmed: 24_000_000 };
function a2Setup(t, { copy = en, address = null, spent = 3_450_000, reserved = 0, delivery = false, privacy = true, handover = false, save, link, visitorRead, question, blocked = false, voiceClient, waitingCall } = {}) {
  let saved = address, raised = false;
  const allowances = () => ({ ...a2Allowances, anonymous: raised ? 18_000_000 : 12_000_000 });
  const tiers = () => ({ allowancesMicro: allowances(), current: saved ? 'emailGiven' : 'anonymous',
    next: privacy ? saved ? delivery ? 'emailConfirmed' : null : 'emailGiven' : null,
    delta: privacy ? saved ? delivery ? 6_000_000 : 0 : 6_000_000 : 0, canConfirm: delivery && privacy });
  const visitor = () => ({ address: saved, tier: saved ? 'emailGiven' : 'anonymous', limitMicro: saved ? 18_000_000 : allowances().anonymous });
  const features = () => ({ best: Object.fromEntries(['text', 'analysis', 'voice'].map(key => [key, {
    available: visitor().limitMicro > spent + reserved, reason: visitor().limitMicro > spent + reserved ? null : 'budget denied',
  }])) });
  const h = setup(t, { copy, voiceClient, host: { verification: { delivery, privacyDocumentConfigured: privacy }, credits: true, handover },
    session: { demo: false, ...(blocked || voiceClient ? { featureMatrix: features() } : {}), ...(waitingCall ? { voiceLifecycle: waitingCall } : {}), identity: identity({ address: saved }), settings: { origin: 'chosen', voice: 'off', visuals: 'off' } }, routes: {
      'GET ': () => Response.json({ ...h.c.session, featureMatrix: features() }),
      'GET /identity': () => Response.json({ identity: identity({ address: saved }), delivery, privacyDocumentConfigured: privacy }),
      'GET /visitor/email': () => { const read = () => Response.json({ visitor: visitor(), notice: { version: 'ait-135-v1', deliveryEnabled: delivery }, privacyDocumentConfigured: privacy }); return visitorRead ? visitorRead(read) : read(); },
      'GET /credits': () => { const limitMicro = visitor().limitMicro; return Response.json({ balance: { owner: { limitMicro, committedMicro: spent + reserved,
        confirmedSpendMicro: spent, reservedMicro: reserved, uncertainSpendMicro: 0, availableMicro: Math.max(0, limitMicro - spent - reserved) } }, exhausted: spent >= limitMicro, limitSlot: null, tiers: tiers() }); },
      'PUT /visitor/email': async body => { await save?.(body); saved = body.address; return Response.json({ visitor: visitor() }); },
      ...(link ? { 'POST /identity/request': body => link(body), 'POST /identity/change': body => link(body) } : {}),
      'DELETE /visitor/email': () => { saved = null; return Response.json({ visitor: visitor() }); },
    } });
  if (question) h.c.receive({ seq: h.c.session.seq + 1, type: 'turn.final', data: { id: 'a2-question', role: 'assistant',
    content: question.question_short, inputRevision: inputRevision(h.c.session), ...question } });
  if (privacy) {
    const legal = document.createElement('nav'); legal.slot = 'legal';
    const link = document.createElement('a'); link.href = '/privacy?locale=' + (copy === de ? 'de' : 'en'); link.setAttribute('data-aithema-privacy', ''); legal.append(link); h.c.append(legal);
    h.root.querySelector('slot[name="legal"]').dispatchEvent(new window.Event('slotchange'));
  }
  return { ...h, setSpent: value => { spent = value; }, setReserved: value => { reserved = value; }, topUp: () => { raised = true; } };
}

test('AIT-164: mail Settings saves and raises the tier before the confirmation request finishes', async t => {
  let finish, requested;
  const waiting = new Promise(resolve => { finish = resolve; });
  const { root, c, calls } = a2Setup(t, { delivery: true, link: async body => { requested = body; await waiting; return Response.json({ identity: identity({ status: 'verification-pending', address: body.address, delivery: 'sent' }) }); } });
  await tick(10); c.openSettings(undefined, { tab: 'general', anchor: '#email' }); await tick();
  root.querySelector('.verify-entry').click(); await tick();
  const form = root.querySelector('.verify-dialog .verify-form'); form.querySelector('input').value = 'mail-reader@example.test'; form.requestSubmit();
  await tick(12);
  assert.deepEqual(requested, { address: 'mail-reader@example.test' });
  assert.ok(calls.findIndex(call => call.method === 'PUT') < calls.findIndex(call => call.path === '/identity/request' && call.method === 'POST'));
  assert.match(root.querySelector('.host-credits__total').textContent, /1,800/u);
  assert.equal(form.querySelector('.verify-send').textContent, en.hostSurface.email.save);
  finish(); await tick(12); assert.equal(root.querySelector('.host-verify').dataset.emailState, 'pending');
});

test('AIT-164: mail Settings cannot bypass saving while its first privacy-notice read is still pending', async t => {
  let release, reads = 0;
  const first = new Promise(resolve => { release = resolve; });
  const { root, c, calls } = a2Setup(t, { delivery: true,
    visitorRead: read => ++reads === 1 ? first.then(read) : read(),
    link: body => Response.json({ identity: identity({ status: 'verification-pending', address: body.address, delivery: 'sent' }) }),
  });
  await tick(8); c.openSettings(undefined, { tab: 'general', anchor: '#email' }); await tick();
  root.querySelector('.verify-entry').click(); await tick();
  const form = root.querySelector('.verify-dialog .verify-form'); form.querySelector('input').value = 'mail-reader@example.test'; form.requestSubmit(); await tick(12);
  const put = calls.findIndex(call => call.method === 'PUT'), link = calls.findIndex(call => call.method === 'POST' && call.path === '/identity/request');
  assert.ok(put >= 0 && link > put, 'the saved-tier acknowledgement must precede C1');
  assert.deepEqual(calls[put].body, { address: 'mail-reader@example.test', noticeVersion: 'ait-135-v1' });
  assert.match(root.querySelector('.host-credits__total').textContent, /1,800/u);
  release(); await tick(8);
});

for (const copy of [de, en]) test(`AIT-135 A2 B: server tiers in a group, one unit line, no countdown (${copy === de ? 'de' : 'en'})`, async t => {
  const { c, root } = a2Setup(t, { copy }); await tick(8);
  const popup = root.querySelector('.host-credits .footer-popup');
  assert.equal(popup.getAttribute('role'), 'group');
  assert.equal(popup.querySelector('.host-credits__current').hidden, true, 'the anonymous balance already names its tier');
  assert.match(popup.querySelector('.host-credits__next').textContent, copy === de ? /1\.800 Credits/u : /1,800 Credits/u);
  assert.equal(popup.querySelector('.credits-email').textContent, copy === de ? 'E-Mail-Adresse angeben' : 'Add your email address');
  assert.equal(popup.querySelector('.host-credits__equivalence').textContent, copy === de ? '1 Credit = 1 US-Cent' : '1 Credit = 1 US cent');
  assert.equal(root.querySelector('.host-credits__deadline')?.textContent ?? '', '');
  popup.querySelector('.credits-email').click(); await tick(6);
  assert.equal(root.querySelector('dialog.settings').open, true);
  assert.equal(root.querySelector('[data-tab="general"]').getAttribute('aria-selected'), 'true');
  assert.equal(root.activeElement?.id, 'email-input');
  c.remove();
});

test('AIT-135 A2 B: used-up composer preserves the form, offers the actual delta and disables new work', async t => {
  const { root } = a2Setup(t, { spent: 12_000_000 }); await tick(8);
  assert.equal(root.querySelector('.composer-out').getAttribute('aria-hidden'), 'false');
  assert.equal(root.querySelector('form.composer').inert, true);
  assert.match(root.querySelector('.composer-out__give').textContent, /600 more Credits/u);
  assert.equal(root.querySelector('.voice-state').textContent, 'Credits used up');
  assert.equal(root.querySelector('.voice-state').getAttribute('aria-live'), 'off', 'one region announces exhaustion');
  assert.equal(root.querySelector('.voice-start').disabled, true);
  assert.equal(root.querySelector('.host-credits__amount').textContent, '0');
  assert.equal(root.querySelector('.host-credits__used-up').getAttribute('aria-hidden'), 'false');
});

test('AIT-135 A2 B: no next tier offers export, including the privacy release gate', async t => {
  for (const options of [{ address: 'reader@example.test', spent: 18_000_000 }, { privacy: false, spent: 12_000_000 }]) {
    const { c, root } = a2Setup(t, options); await tick(8);
    assert.equal(root.querySelector('.composer-out').dataset.next, 'none');
    assert.equal(root.querySelector('.composer-out__export').getAttribute('aria-hidden'), 'false');
    assert.equal(root.querySelector('.credits-email').hidden, true);
    c.remove();
  }
});

test('AIT-135 A2 B: Escape dismisses a pinned credits group and returns focus to the credits button', async t => {
  const { root } = a2Setup(t); await tick(8);
  const line = root.querySelector('.host-credits'), button = root.querySelector('.host-credits__button');
  button.click(); root.querySelector('.credits-email').focus();
  root.querySelector('.credits-email').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(line.hasAttribute('data-dismissed'), true);
  assert.equal(root.activeElement, button);
});

for (const copy of [de, en]) test(`AIT-135 A2 C: inline save, edit and normal delete use acknowledged tiers (${copy === de ? 'de' : 'en'})`, async t => {
  const { c, root, calls } = a2Setup(t, { copy }); await tick(8);
  c.openSettings(undefined, { tab: 'general' }); await tick();
  const section = root.querySelector('.host-verify'), input = section.querySelector('#email-input');
  assert.match(section.querySelector('.m-lead').textContent, copy === de ? /1\.200.*1\.800/u : /1,200.*1,800/u);
  assert.equal(section.querySelector('.m-pp').getAttribute('href'), '/privacy?locale=' + (copy === de ? 'de' : 'en'));
  input.value = 'reader@example.test'; section.querySelector('.m-form').requestSubmit(); await tick(10);
  const savedReads = calls.filter(call => call.path === '').length;
  assert.ok(savedReads > 0, 'saving a higher tier refreshes features below the ceiling');
  assert.deepEqual(calls.find(call => call.method === 'PUT').body, { address: 'reader@example.test', noticeVersion: 'ait-135-v1' });
  assert.equal(section.dataset.emailState, 'saved');
  assert.match(section.querySelector('.m-tier').textContent, copy === de ? /Guthaben: 1\.800 Credits/u : /Credit: 1,800 Credits/u);
  assert.doesNotMatch(section.querySelector('.m-tier').textContent, /1[.,]455/u, 'Settings shows the tier only');
  assert.equal(root.activeElement, section.querySelector('.m-change'));
  const select = t.mock.method(input, 'select'); section.querySelector('.m-change').click();
  assert.equal(input.value, 'reader@example.test'); assert.equal(root.activeElement, input); assert.equal(select.mock.callCount(), 1);
  section.querySelector('.m-cancel').click(); section.querySelector('.m-delete').click();
  assert.equal(root.activeElement, section.querySelector('.m-keep'));
  assert.match(section.querySelector('.m-delete-normal').textContent, copy === de ? /1\.200.*855/u : /1,200.*855/u);
  section.querySelector('.m-del').click(); await tick(10);
  assert.ok(calls.filter(call => call.path === '').length > savedReads, 'deleting a tier refreshes features below the ceiling');
  assert.equal(section.dataset.emailState, 'capture'); assert.equal(root.activeElement, input);
  assert.equal(input.value, '', 'acknowledged deletion clears the cancelled edit');
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 1);
});

test('AIT-135 A2 C: validation is calm, clears while typing, and saving keeps the button label', async t => {
  let finish; const saving = new Promise(resolve => { finish = resolve; });
  const { root, calls } = a2Setup(t, { save: () => saving }); await tick(8);
  const input = root.querySelector('#email-input'), form = root.querySelector('.host-verify .m-form'), button = root.querySelector('.host-verify .m-save');
  input.value = 'reader'; form.requestSubmit(); await tick();
  assert.equal(input.getAttribute('aria-invalid'), 'true'); assert.equal(calls.filter(c => c.method === 'PUT').length, 0);
  input.value = 'reader@example.test'; input.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(input.getAttribute('aria-invalid'), 'false'); form.requestSubmit(); await tick();
  assert.equal(button.textContent, 'Save'); assert.match(root.querySelector('.host-verify .m-msg').textContent, /Saving/u);
  finish(); await tick(10);
});

test('AIT-135 A2 C: deleting an over-spent address works and restores the used-up state', async t => {
  const { root, calls } = a2Setup(t, { address: 'reader@example.test', spent: 15_000_000 }); await tick(8);
  root.querySelector('.host-verify .m-delete').click();
  assert.match(root.querySelector('.host-verify .m-delete-over').textContent, /1,500 Credits.*used up/u);
  root.querySelector('.host-verify .m-del').click(); await tick(10);
  assert.equal(calls.filter(c => c.method === 'DELETE').length, 1);
  assert.match(root.querySelector('.host-verify .m-msg').textContent, /deleted.*used up/u);
  assert.equal(root.querySelector('.composer-out').getAttribute('aria-hidden'), 'false');
});

test('AIT-135 A2 C: no privacy document offers no collection input or confirmation dialog', async t => {
  const { root, calls } = a2Setup(t, { privacy: false }); await tick(8);
  assert.equal(root.querySelector('.host-verify').dataset.emailState, 'unavailable');
  assert.equal(root.querySelector('.host-verify .m-form').inert, true);
  assert.equal(root.querySelector('.verify-entry').hidden, true);
  assert.equal(root.querySelector('dialog.verify-dialog').open, false);
  assert.equal(calls.filter(c => ['POST', 'PUT'].includes(c.method)).length, 0);
});

test('AIT-135 A2 C: handover purpose and the short 90-day notice accompany the host privacy link', async t => {
  const { root } = a2Setup(t, { handover: true }); await tick(8);
  assert.match(root.querySelector('.host-verify .m-notice').textContent, /For a personal follow-up we ask you separately\./u);
  assert.match(root.querySelector('.host-verify .m-notice').textContent, /After 90 days without use, we delete it automatically\./u);
  assert.doesNotMatch(root.querySelector('.host-verify .m-notice').textContent, /Use means|cookie/u);
  assert.equal(root.querySelector('.host-verify .m-pp').getAttribute('href'), '/privacy?locale=en');
});


test('AIT-135 A2 B: the supplied open question stays readable and its answers rest when credit runs out', async t => {
  const { root } = a2Setup(t, { spent: 12_000_000, question: { question_short: 'What would help next?', options: [{ text: 'Discuss the goals', likely: true }, { text: 'Discuss resources' }] } }); await tick(8);
  const card = root.querySelector('.question-card');
  assert.equal(card.hidden, false); assert.equal(card.inert, true);
  assert.equal(card.querySelector('.qtext').textContent, 'What would help next?');
  assert.ok([...card.querySelectorAll('button')].every(button => button.disabled));
  assert.equal(root.querySelector('.pause').disabled, true);
});

test('AIT-135 A2 C: an address saved before the privacy gate closes remains deletable', async t => {
  const { root, calls } = a2Setup(t, { privacy: false, address: 'reader@example.test', spent: 18_000_000 }); await tick(8);
  root.querySelector('.host-verify .m-change').click();
  assert.equal(root.querySelector('.host-verify').dataset.emailState, 'saved');
  root.querySelector('.host-verify .m-delete').click(); root.querySelector('.host-verify .m-del').click(); await tick(10);
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 1);
  assert.equal(root.querySelector('.host-verify').dataset.emailState, 'unavailable');
});


for (const copy of [de, en]) test(`AIT-135 A2 C: delivery saves the given tier before AIT-131 sends the confirmation (${copy.display.locale})`, async t => {
  let address = null, status = 'guest';
  const h = setup(t, { copy, session: { identity: identity(), demo: true }, host: { verification: true, credits: true }, routes: {
    'GET /visitor/email': () => Response.json({ visitor: { address }, notice: { version: 'ait-135-v1', deliveryEnabled: true } }),
    'GET /identity': () => Response.json({ identity: identity({ address, status }), delivery: true }),
    'GET /credits': () => Response.json({ balance, limitSlot: null, tiers: { allowancesMicro: a2Allowances, current: address ? 'emailGiven' : 'anonymous', next: 'emailConfirmed', delta: 6_000_000, canConfirm: true } }),
    'PUT /visitor/email': body => { address = body.address; return Response.json({ visitor: { address } }); },
    'POST /identity/request': body => { address = body.address; status = 'verification-pending'; return Response.json({ identity: identity({ address, status }) }); },
  } }); await tick(10);
  h.root.querySelector('.verify-entry').click(); await tick(6);
  const dialog = h.root.querySelector('dialog.verify-dialog');
  assert.match(dialog.querySelector('.verify__lead').textContent, copy === de ? /1\.800.*2\.400/u : /1,800.*2,400/u);
  assert.match(dialog.querySelector('.m-notice').textContent, /90/u);
  dialog.querySelector('input').value = 'reader@example.test'; dialog.querySelector('form').requestSubmit(); await tick(12);
  const writes = h.calls.filter(call => ['PUT', 'POST'].includes(call.method) && ['/visitor/email', '/identity/request'].includes(call.path));
  assert.deepEqual(writes.map(call => [call.method, call.path]), [['PUT', '/visitor/email'], ['POST', '/identity/request']]);
  assert.equal(h.root.querySelector('.host-verify').dataset.emailState, 'pending');
});


test('AIT-135 A2 C: equal allowances and disabled confirmation never promise an increase', async t => {
  const { root } = setup(t, { session: { demo: true, identity: identity() }, host: { verification: true, credits: true }, routes: {
    'GET /credits': () => Response.json({ balance, limitSlot: null, tiers: { current: 'anonymous', next: null, delta: 0, canConfirm: false,
      allowancesMicro: { anonymous: 5_000_000, emailGiven: 5_000_000, emailConfirmed: 8_000_000 } } }),
  } }); await tick(8);
  assert.equal(root.querySelector('.host-verify .m-lead-mail').textContent, 'Credit: 500 Credits');
  assert.equal(root.querySelector('.credits-email').hidden, true);
  root.querySelector('.verify-entry').click(); await tick();
  assert.equal(root.querySelector('.verify__lead-mail').textContent, 'Credit: 500 Credits');
});


test('AIT-135 A2 B: saving after exhaustion refreshes the authoritative verdict instead of keeping budget denied', async t => {
  const { root, calls } = a2Setup(t, { spent: 12_000_000, blocked: true }); await tick(8);
  assert.equal(root.querySelector('textarea').disabled, true);
  root.querySelector('#email-input').value = 'reader@example.test'; root.querySelector('.host-verify .m-form').requestSubmit(); await tick(16);
  assert.ok(calls.some(call => call.path === ''), 'the host snapshot is read after the allowance rises');
  assert.equal(root.querySelector('.composer-out').getAttribute('aria-hidden'), 'true');
  assert.equal(root.querySelector('textarea').disabled, false);
});

test('AIT-135 A2 B: an exhausted visible app notices a CLI allowance increase without an SSE event', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let raised = false;
  const { c, root, calls } = setup(t, { host: { credits: true }, routes: {
    'GET /credits': () => Response.json({ balance: { owner: { limitMicro: raised ? 18_000_000 : 12_000_000, committedMicro: 12_000_000, availableMicro: raised ? 6_000_000 : 0 } }, exhausted: !raised, limitSlot: null }),
  } }); await tick(8);
  assert.equal(root.querySelector('.composer-out').getAttribute('aria-hidden'), 'false');
  raised = true; t.mock.timers.tick(15_001); await tick(12);
  assert.equal(calls.filter(call => call.path === '/credits').length, 2);
  assert.equal(root.querySelector('.composer-out').getAttribute('aria-hidden'), 'true');
  c.remove(); const reads = calls.length; t.mock.timers.tick(15_001); await tick(); assert.equal(calls.length, reads, 'detached apps stop polling');
});

for (const copy of [de, en]) test(`AIT-155 / AIT-135 A2: full hold keeps the call running and switches the placeholder back (${copy === de ? 'de' : 'en'})`, async t => {
  const { voiceEvents } = await import('../../core/src/live-voice.js');
  const events = voiceEvents(); let closes = 0;
  const voiceClient = { async start({ callId }) { return { callId, providerSessionId: 'held-provider', events,
    async setInput() {}, async setOutput() {}, async updateContext() {},
    async close() { closes++; events.end(); return { closureConfirmed: true }; } }; } };
  const f = a2Setup(t, { copy, spent: 0, voiceClient }); await tick(8);
  f.root.querySelector('.voice-start').click(); await tick(8);
  assert.equal(f.root.querySelector('.audio-rail').dataset.state, 'listening');
  const input = f.root.querySelector('textarea');
  assert.equal(input.placeholder, copy.placeholderVoice);
  f.setReserved(12_000_000);
  f.c.receive({ seq: f.c.session.seq + 1, type: 'credits.state', data: { status: 'active', endReason: null } });
  f.c.receive({ seq: f.c.session.seq + 1, type: 'session.paused', data: { paused: false } });
  await new Promise(resolve => setTimeout(resolve, 350)); await tick(8);
  assert.equal(f.c.session.featureMatrix.best.voice.available, false, 'server preview denies another reservation');
  assert.equal(closes, 0, 'a full reservation must not close the admitted segment');
  assert.equal(f.root.querySelector('.host-credits__amount').textContent, '0', 'the fully reserved wallet read was applied');
  assert.equal(f.root.querySelector('.audio-rail').hasAttribute('data-used-up'), false);
  assert.equal(f.root.querySelector('.voice-state').textContent, copy.voiceStates.listening);
  assert.equal(input.placeholder, copy === de ? 'Sprechen Sie einfach weiter.' : 'Just keep talking.');
  assert.equal(input.disabled, true);
  assert.equal(f.root.querySelector('.voice-close').disabled, false);
  assert.equal(f.root.querySelector('.host-credits').dataset.ended, 'false');
  assert.equal(f.root.querySelector('.composer-out').getAttribute('aria-hidden'), 'true');
  assert.equal(f.root.querySelector('.credit-announcement').textContent, '');
  f.setReserved(0);
  f.c.receive({ seq: f.c.session.seq + 1, type: 'credits.state', data: { status: 'active', endReason: null } });
  f.c.receive({ seq: f.c.session.seq + 1, type: 'session.paused', data: { paused: false } });
  await new Promise(resolve => setTimeout(resolve, 350)); await tick(8);
  assert.equal(input.placeholder, copy.placeholderVoice, 'released credit restores the ordinary listening placeholder');
  assert.equal(input.disabled, false);
  f.root.querySelector('.voice-close').click(); await tick(8);
  assert.equal(input.placeholder, copy.placeholder, 'ending the call restores the typing placeholder');
});

test('AIT-135 A2 fix 1: a zero available balance without an exhaustion verdict keeps the normal state', async t => {
  const { root } = setup(t, { host: { credits: true }, routes: {
    'GET /credits': () => Response.json({ balance: { owner: { limitMicro: 12_000_000, committedMicro: 12_000_000, availableMicro: 0 } }, limitSlot: null }),
  } }); await tick(8);
  assert.equal(root.querySelector('.host-credits').dataset.ended, 'false');
  assert.equal(root.querySelector('.composer-out').getAttribute('aria-hidden'), 'true');
});

test('AIT-135 A2 fix 1: an admission refusal stays authoritative through a full-hold read and clears after recovery', async t => {
  const f = a2Setup(t, { spent: 0, reserved: 12_000_000 }); await tick(8);
  f.c.receive({ seq: f.c.session.seq + 1, type: 'credits.limit-reached', data: { reason: 'host-limit' } });
  await new Promise(resolve => setTimeout(resolve, 350)); await tick(8);
  assert.equal(f.root.querySelector('.host-credits').dataset.ended, 'true', 'a balance refresh cannot erase a retained admission refusal while the hold remains');
  f.topUp(); f.c.receive({ seq: f.c.session.seq + 1, type: 'credits.state', data: { status: 'active', endReason: null } });
  await new Promise(resolve => setTimeout(resolve, 350)); await tick(8);
  assert.equal(f.root.querySelector('.host-credits').dataset.ended, 'false');
});

for (const recovery of ['email', 'CLI']) for (const waiting of [false, true]) test(`AIT-135 A2 fix 2: ${waiting ? 'waiting-call Resume' : 'Retry'} after a ${recovery} top-up clears the retained host-limit denial`, async t => {
  if (recovery === 'CLI') t.mock.timers.enable({ apis: ['setInterval'] });
  const { voiceEvents } = await import('../../core/src/live-voice.js');
  const events = voiceEvents(), requests = []; let recovered = false;
  const waitingCall = waiting ? { callId: 'waiting-call', providerSessionId: 'waiting-provider', state: 'waiting' } : undefined;
  const voiceClient = { async start(request) {
    requests.push(request);
    if (!recovered) throw Object.assign(new Error('host allowance refused admission'), { code: 'not-admitted', reason: 'host-limit' });
    return { callId: request.callId, providerSessionId: 'recovered-provider', events,
      async setInput() {}, async setOutput() {}, async updateContext() {},
      async close() { events.end(); return { closureConfirmed: true }; } };
  } };
  const f = a2Setup(t, { spent: 11_990_000, voiceClient, waitingCall }); await tick(8);
  f.root.querySelector(waiting ? '.pause' : '.voice-start').click(); await tick(8);
  assert.equal(requests.length, 1);
  assert.equal(f.root.querySelector('.audio-rail').dataset.state, waiting ? 'waiting' : 'failed');
  f.setSpent(12_000_000);
  f.c.receive({ seq: f.c.session.seq + 1, type: 'credits.limit-reached', data: { reason: 'host-limit' } });
  await new Promise(resolve => setTimeout(resolve, 350)); await tick(8);
  assert.equal(f.root.querySelector('.audio-rail').hasAttribute('data-used-up'), true);
  recovered = true;
  if (recovery === 'email') {
    f.root.querySelector('#email-input').value = 'reader@example.test'; f.root.querySelector('.host-verify .m-form').requestSubmit();
  } else { f.topUp(); t.mock.timers.tick(15_001); }
  await tick(16);
  assert.equal(f.c.session.featureMatrix.best.voice.available, true, 'the server confirms new voice admission');
  assert.equal(f.root.querySelector('.composer-out').getAttribute('aria-hidden'), 'true');
  assert.equal(f.root.querySelector('.audio-rail').hasAttribute('data-used-up'), false, 'the old refusal cannot override the recovered verdict');
  assert.notEqual(f.root.querySelector('.voice-state').textContent, en.voiceStates.usedUp);
  assert.equal(f.root.querySelector(waiting ? '.voice-pause' : '.voice-retry').disabled, false);
  f.root.querySelector(waiting ? '.pause' : '.voice-retry').click(); await tick(8);
  assert.equal(requests.length, 2); assert.equal(f.root.querySelector('.audio-rail').dataset.state, 'listening');
  if (waiting) assert.deepEqual(requests[1], { callId: waitingCall.callId, providerSessionId: waitingCall.providerSessionId }, 'Resume retains the logical call');
  for (const selector of ['.voice-input', '.voice-output', '.voice-close']) assert.equal(f.root.querySelector(selector).disabled, false);
});

for (const recovery of ['email', 'CLI']) for (const waiting of [false, true]) test(`AIT-135 A2 round 2: denial-only ${waiting ? 'Resume' : 'Retry'} recovers after a ${recovery} top-up below the ceiling`, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { voiceEvents } = await import('../../core/src/live-voice.js');
  const events = voiceEvents(), requests = []; let recovered = false;
  const waitingCall = waiting ? { callId: 'waiting-call', providerSessionId: 'waiting-provider', state: 'waiting' } : undefined;
  const voiceClient = { async start(request) {
    requests.push(request);
    if (!recovered) throw Object.assign(new Error('host allowance refused admission'), { code: 'not-admitted', reason: 'host-limit' });
    return { callId: request.callId, providerSessionId: 'recovered-provider', events,
      async setInput() {}, async setOutput() {}, async updateContext() {},
      async close() { events.end(); return { closureConfirmed: true }; } };
  } };
  const f = a2Setup(t, { spent: 11_990_000, voiceClient, waitingCall }); await tick(8);
  const idleReads = f.calls.length;
  t.mock.timers.tick(45_001); await tick(8);
  assert.equal(f.calls.length, idleReads, 'healthy apps do not poll');
  f.root.querySelector(waiting ? '.pause' : '.voice-start').click(); await tick(8);
  assert.equal(requests.length, 1);
  assert.equal(f.root.querySelector('.audio-rail').dataset.state, waiting ? 'waiting' : 'failed');
  assert.equal(f.root.querySelector('.audio-rail').hasAttribute('data-used-up'), true);
  assert.equal(f.root.querySelector(waiting ? '.voice-pause' : '.voice-retry').disabled, true);
  assert.equal(f.root.querySelector('.host-credits').dataset.ended, 'false', 'confirmed spend stays below the ceiling');
  assert.equal(f.root.querySelector('.composer-out').getAttribute('aria-hidden'), 'true');
  const before = f.calls.filter(call => call.path === '').length;
  recovered = true;
  if (recovery === 'email') {
    f.root.querySelector('#email-input').value = 'reader@example.test'; f.root.querySelector('.host-verify .m-form').requestSubmit();
  } else { f.topUp(); t.mock.timers.tick(15_001); }
  await tick(16);
  assert.ok(f.calls.filter(call => call.path === '').length > before, 'recovery reads a fresh server verdict without a limit event');
  assert.equal(f.c.session.featureMatrix.best.voice.available, true);
  assert.equal(f.root.querySelector('.audio-rail').hasAttribute('data-used-up'), false, 'the fresh verdict clears the refusal');
  assert.equal(f.root.querySelector(waiting ? '.voice-pause' : '.voice-retry').disabled, false);
  const recoveredReads = f.calls.length;
  t.mock.timers.tick(45_001); await tick(8);
  assert.equal(f.calls.length, recoveredReads, 'recovered apps stop polling');
  f.root.querySelector(waiting ? '.pause' : '.voice-retry').click(); await tick(8);
  assert.equal(requests.length, 2); assert.equal(f.root.querySelector('.audio-rail').dataset.state, 'listening');
  if (waiting) assert.deepEqual(requests[1], { callId: waitingCall.callId, providerSessionId: waitingCall.providerSessionId }, 'Resume retains the logical call');
  for (const selector of ['.voice-input', '.voice-output', '.voice-close']) assert.equal(f.root.querySelector(selector).disabled, false);
});

test('AIT-135 A2 round 2: denial-only polling skips hidden pages, bounds wallet and feature reads, and stops on detach', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const voiceClient = { async start() { throw Object.assign(new Error('not admitted'), { code: 'not-admitted', reason: 'host-limit' }); } };
  const f = a2Setup(t, { spent: 11_990_000, voiceClient }); await tick(8);
  f.root.querySelector('.voice-start').click(); await tick(8);
  f.setReserved(10_000); // The server keeps admission unavailable without exhausting confirmed spend.
  let finishCredits, finishFeatures, creditReads = 0, featureReads = 0, visible = false;
  const credits = new Promise(resolve => { finishCredits = resolve; }), features = new Promise(resolve => { finishFeatures = resolve; });
  t.after(() => { finishCredits(); finishFeatures(); });
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).endsWith('/credits')) { creditReads++; await credits; }
    if (String(url) === `/api/sessions/${f.c.session.id}`) { featureReads++; await features; }
    return fetch(url, options);
  });
  t.mock.getter(document, 'visibilityState', () => visible ? 'visible' : 'hidden');
  t.mock.timers.tick(45_001); await tick(8);
  assert.equal(creditReads, 0, 'hidden pages do not poll');
  visible = true; t.mock.timers.tick(15_001); await tick(8);
  assert.equal(creditReads, 1); assert.equal(featureReads, 0);
  t.mock.timers.tick(45_001); await tick(8);
  assert.equal(creditReads, 1, 'a pending wallet read cannot pile up more requests');
  finishCredits(); await tick(8);
  assert.equal(featureReads, 1, 'an unchanged wallet still refreshes a retained refusal');
  t.mock.timers.tick(45_001); await tick(8);
  assert.equal(creditReads, 1); assert.equal(featureReads, 1, 'a pending verdict read also bounds recovery polling');
  finishFeatures(); await tick(8);
  assert.equal(f.root.querySelector('.audio-rail').hasAttribute('data-used-up'), true, 'an unavailable fresh verdict retains the refusal');
  t.mock.timers.tick(15_001); await tick(8);
  assert.equal(creditReads, 2); assert.equal(featureReads, 2, 'pending recovery can poll again after the previous cycle finishes');
  f.c.remove(); t.mock.timers.tick(45_001); await tick(8);
  assert.equal(creditReads, 2); assert.equal(featureReads, 2, 'detached pages stop polling');
});

test('AIT-135 A2 round 2: a tier-only credits event refreshes features without exhaustion or an admission refusal', async t => {
  let current = 'anonymous';
  const { c, calls } = setup(t, { host: { credits: true }, session: { featureMatrix: { best: { voice: { available: false } } } }, routes: {
    'GET /credits': () => Response.json({ balance, exhausted: false, limitSlot: null, tiers: { current } }),
    'GET ': () => Response.json({ ...c.session, featureMatrix: { best: { voice: { available: current === 'emailGiven' } } } }),
  } }); await tick(8);
  assert.equal(c.session.featureMatrix.best.voice.available, false);
  const before = calls.filter(call => call.path === '').length;
  current = 'emailGiven'; c.receive({ seq: c.session.seq + 1, type: 'credits.state', data: { status: 'active', endReason: null } });
  await new Promise(resolve => setTimeout(resolve, 350)); await tick(8);
  assert.ok(calls.filter(call => call.path === '').length > before, 'a changed tier refreshes even when its ceiling stays the same');
  assert.equal(c.session.featureMatrix.best.voice.available, true);
});

for (const copy of [de, en]) test(`AIT-138 d merge: ${copy.display.locale} exhausted old tab keeps ownership until an explicit take-back after top-up`, async t => {
  const { voiceEvents } = await import('../../core/src/live-voice.js');
  const requests = []; let closes = 0, takeovers = 0;
  const voiceClient = { tabId: 'old-tab', async start(request) {
    requests.push(request); const events = voiceEvents();
    return { callId: request.callId, providerSessionId: 'provider-' + requests.length, epoch: request.epoch ?? 1, tabId: 'old-tab', events,
      async setInput() {}, async setOutput() {}, async updateContext() {},
      async pause() { return { acknowledged: true, paused: true }; }, async resume() { return { acknowledged: true, paused: false }; },
      async close() { closes++; events.end(); return { closureConfirmed: true }; } };
  }, async takeover(identity) {
    takeovers++; assert.equal(identity.epoch, 2);
    return { ...identity, epoch: 3, controllingTabId: 'old-tab', state: 'waiting' };
  } };
  const f = a2Setup(t, { copy, spent: 0, voiceClient }); await tick(8);
  f.root.querySelector('.voice-start').click(); await tick(8);
  const callId = requests[0].callId;
  f.c.receive({ type: 'voice.state', data: {
    callId, providerSessionId: 'other-provider', epoch: 2, controllingTabId: 'other-tab', state: 'active', reason: 'tab-takeover' } });
  assert.equal(f.root.querySelector('.pause').disabled, false);
  f.setSpent(12_000_000);
  f.c.receive({ seq: f.c.session.seq + 1, type: 'credits.limit-reached', data: { reason: 'host-limit' } });
  await new Promise(resolve => setTimeout(resolve, 350)); await tick(8);
  assert.equal(f.root.querySelector('.voice-state').textContent, copy.voiceStates.usedUp);
  assert.equal(f.root.querySelector('.pause').disabled, true);
  assert.equal(f.root.querySelector('.audio-rail').hasAttribute('data-moved'), true);
  assert.equal(closes, 0, 'the old tab must not close or forget the foreign logical call');
  f.root.querySelector('.pause').click(); await tick(8); assert.equal(takeovers, 0); assert.equal(requests.length, 1);
  f.topUp(); f.c.receive({ seq: f.c.session.seq + 1, type: 'credits.state', data: { status: 'active', endReason: null } });
  await new Promise(resolve => setTimeout(resolve, 350)); await tick(8);
  assert.equal(f.root.querySelector('.voice-state').textContent, copy.voiceMoved);
  assert.equal(f.root.querySelector('.pause').disabled, false);
  assert.equal(takeovers, 0, 'top-up alone never takes ownership');
  f.root.querySelector('.pause').click(); await tick(16);
  assert.equal(takeovers, 1); assert.equal(requests.length, 2);
  assert.equal(requests[1].callId, callId); assert.equal(requests[1].epoch, 3);
  assert.equal(f.root.querySelector('.audio-rail').dataset.state, 'listening');
});


for (const copy of [de, en]) for (const delivery of [true, false]) for (const result of ['loaded', 'http-failed', 'transport-failed']) {
  test(`AIT-171 status: ${copy.display.locale}/${delivery ? 'mail' : 'save'}/${result} replaces pending copy without repeated announcements`, async t => {
    let finish;
    const response = new Promise(resolve => { finish = resolve; });
    const { c, root, calls } = setup(t, { copy, session: { identity: identity() }, host: { verification: { delivery }, credits: true }, routes: {
      'GET /credits': async () => { await response; if (result === 'transport-failed') throw new Error('fixture unavailable');
        return result === 'http-failed' ? Response.json({}, { status: 503 }) : Response.json({ balance, limitSlot: null,
          tiers: { canConfirm: delivery, allowancesMicro: a2Allowances, current: 'anonymous' } }); },
    } });
    await tick(); c.openSettings(undefined, { tab: 'general', anchor: '#email' }); await tick();
    const lead = root.querySelector(delivery ? '.m-lead-mail' : '.m-lead-save');
    const loading = copy === de ? 'Guthaben wird geladen …' : 'Loading credit …';
    const failed = copy === de ? 'Guthaben gerade nicht verfügbar.' : "Credit isn't available right now.";
    const mailHint = copy === de ? ' Sie können die Adresse trotzdem bestätigen.' : ' You can still confirm your address.';
    const saveHint = copy === de ? ' Sie können die Adresse trotzdem speichern.' : ' You can still save your address.';
    assert.equal(lead.textContent, loading);
    assert.equal(lead.getAttribute('role'), 'status'); assert.equal(lead.getAttribute('aria-live'), 'polite');
    assert.ok(lead.classList.contains('m-credit-status'));
    const repaint = () => { for (let i = 0; i < 2; i++) root.querySelector('#email-input').dispatchEvent(new window.Event('input')); };
    let mutations = 0; const observer = new window.MutationObserver(() => { mutations++; });
    observer.observe(lead, { childList: true, characterData: true, subtree: true }); t.after(() => observer.disconnect());
    repaint(); await tick(); assert.equal(mutations, 0, 'pending paints do not rewrite the live region');
    finish(); await tick(12);
    if (result === 'loaded') {
      assert.match(lead.textContent, copy === de ? /Mit Ihrer E-Mail-Adresse/u : /With your email address/u);
      assert.equal(lead.hasAttribute('role'), false); assert.equal(lead.classList.contains('m-credit-status'), false);
    } else {
      assert.equal(lead.textContent, failed + (delivery ? mailHint : saveHint));
      assert.equal(lead.getAttribute('aria-live'), 'polite'); assert.ok(lead.classList.contains('m-credit-status'));
    }
    mutations = 0; repaint(); await tick(); assert.equal(mutations, 0, 'settled paints do not reannounce');
    assert.equal(calls.filter(call => call.path === '/credits').length, 1, 'status adds no credit requests');
  });
}


for (const copy of [de, en]) test(`AIT-173 round 2: footer reconciliation tooltip only, and settlement clears it (${copy === de ? 'de' : 'en'})`, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let reconciling = true;
  const { root } = setup(t, { copy, host: { credits: true }, routes: {
    'GET /credits': () => Response.json({ balance, limitSlot: null, exhausted: false, reconciling }),
  } });
  await tick(8);
  const button = root.querySelector('.host-credits__button');
  const message = copy === de ? 'Kosten werden noch abgeglichen' : 'Costs are still being reconciled';
  assert.equal(button.title, message);
  assert.equal(button.getAttribute('aria-description'), message);
  assert.doesNotMatch(root.querySelector('.host-credits').textContent, /Kosten werden noch abgeglichen|Costs are still being reconciled/u);
  reconciling = false;
  t.mock.timers.tick(15_001); await tick(8);
  assert.equal(button.hasAttribute('title'), false);
  assert.equal(button.hasAttribute('aria-description'), false);
});

for (const copy of [de, en]) test(`AIT-173 round 4: stale hangup denial waits for fresh admission and polling keeps the draft (${copy === de ? 'de' : 'en'})`, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { voiceEvents } = await import('../../core/src/live-voice.js');
  const events = voiceEvents(), refresh = Promise.withResolvers();
  let ended = false, settled = false, spent = false;
  const waiting = copy === de ? 'Einen Moment, die Kosten des Anrufs werden noch abgeglichen.' : "One moment, the call's costs are still being reconciled.";
  const matrix = () => ({ best: { text: { available: settled && !spent, reason: spent ? 'budget denied' : settled ? null : ended ? 'budget reconciling' : 'budget denied' },
    analysis: { available: settled && !spent, reason: spent ? 'budget denied' : settled ? null : ended ? 'budget reconciling' : 'budget denied' }, voice: { available: true } } });
  const voiceClient = { async start({ callId }) { return { callId, providerSessionId: 'round4-provider', events,
    async setInput() {}, async setOutput() {}, async updateContext() {},
    async close() { events.end(); return { closureConfirmed: false, outcome: 'uncertain', usage: null }; } }; } };
  const { c, root } = setup(t, { copy, voiceClient, host: { credits: true },
    session: { demo: false, featureMatrix: matrix(), settings: { origin: 'chosen', voice: 'off', visuals: 'off' } }, routes: {
      'GET ': async () => { if (ended) await refresh.promise; return Response.json({ ...c.session, featureMatrix: matrix() }); },
      'GET /credits': () => Response.json({ balance, exhausted: false, reconciling: ended && !settled }),
    } });
  await tick(8); root.querySelector('.voice-start').click(); await tick(8);
  const input = root.querySelector('textarea'); input.value = 'Keep this draft';
  ended = true; root.querySelector('.voice-close').click();
  const assertWaiting = () => {
    assert.equal(root.querySelector('.composer-shell').hasAttribute('data-used-up'), false);
    assert.equal(root.querySelector('form.composer').inert, false);
    assert.notEqual(root.querySelector('.workspace').dataset.emailAsk, 'open');
    assert.equal(input.value, 'Keep this draft');
    assert.equal(input.disabled, false);
    assert.equal(root.querySelector('.send').disabled, true);
    assert.equal(root.querySelector('.composer-reason').textContent, waiting);
    assert.doesNotMatch(root.querySelector('.features').textContent + root.querySelector('.notice').textContent, /aufgebraucht|used up/iu);
  };
  assertWaiting(); // No tick: the local hangup must already be safe.
  await tick(8); assertWaiting(); // Still safe while the admission response is delayed.
  refresh.resolve(); await tick(8); assertWaiting();
  settled = true; t.mock.timers.tick(15_001); await tick(12);
  assert.equal(root.querySelector('.send').disabled, false, 'credit polling restores send without an event');
  assert.equal(input.value, 'Keep this draft');
  spent = true; c.receive({ type: 'voice.state', data: { state: 'ended' } }); await tick(12);
  assert.equal(root.querySelector('.composer-shell').hasAttribute('data-used-up'), true, 'fresh genuine denial uses normal used-up path');
});


for (const copy of [de, en]) test(`AIT-173 round 5: blocked overview keeps content and slider (${copy === de ? 'de' : 'en'})`, async t => {
  let blocked = false;
  const { c, root } = setup(t, { copy, host: {}, routes: {
    'GET ': () => Response.json({ ...c.session, featureMatrix: { best: {
      text: { available: !blocked, reason: blocked ? 'budget reconciling' : null },
      analysis: { available: !blocked, reason: blocked ? 'budget reconciling' : null } } } }),
  } });
  userTurn(c);
  c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: reduceUnderstanding(c.session.understanding,
    { summary: 'A preorder app', signals: ['Orders'], openQuestions: ['When?'], readinessAssessed: true },
    { transcript: c.session.transcript, inputRevision: inputRevision(c.session) }) });
  const before = root.querySelector('.notice').textContent, summary = root.querySelector('.summary-text').textContent;
  blocked = true; c.receive({ type: 'voice.state', data: { state: 'ended' } }); await tick(8);
  c.receive({ type: 'lane.failed', data: { inputRevision: inputRevision(c.session), lane: 'understanding', error: 'reasoning-unavailable', reason: 'budget reconciling' } });
  assert.equal(root.querySelector('.notice').textContent, before);
  assert.equal(root.querySelector('.summary-text').textContent, summary);
  assert.equal(root.querySelector('.readiness').style.visibility, '');
  assert.equal(root.querySelector('.summary-text').closest('section').hidden, false);
  assert.equal(root.querySelector('.retry').hidden, true);
});

for (const copy of [de, en]) test(`AIT-173 round 5: no-credit host polls settlement, retries analysis and keeps long-wait draft (${copy === de ? 'de' : 'en'})`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let settled = false;
  const { c, root, calls } = setup(t, { copy, host: {}, session: { featureMatrix: { best: {
    text: { available: false, reason: 'budget reconciling' }, analysis: { available: false, reason: 'budget reconciling' } } } }, routes: {
    'GET ': () => Response.json({ ...c.session, featureMatrix: { best: {
      text: { available: settled, reason: settled ? null : 'budget reconciling' },
      analysis: { available: settled, reason: settled ? null : 'budget reconciling' } } } }),
    'POST /retry': () => Response.json({ accepted: true }, { status: 202 }),
  } });
  await tick(8);
  const input = root.querySelector('textarea'); input.value = 'Keep this draft';
  c.receive({ type: 'lane.failed', data: { inputRevision: inputRevision(c.session), lane: 'understanding', error: 'reasoning-unavailable', reason: 'budget reconciling' } });
  t.mock.timers.tick(59_999); await tick(8);
  assert.equal(root.querySelector('.composer-reason').textContent, copy.reasons['budget reconciling']);
  t.mock.timers.tick(1); await tick(8);
  assert.equal(root.querySelector('.composer-reason').textContent, copy === de ? 'Die Anrufkosten sind noch nicht bestätigt. Ihr Text bleibt erhalten.' : "The call's costs aren't confirmed yet. Your text is kept.");
  settled = true; t.mock.timers.tick(15_000); await tick(12);
  assert.equal(root.querySelector('.send').disabled, false);
  assert.equal(input.value, 'Keep this draft');
  assert.equal(calls.filter(call => call.path === '/credits').length, 0);
  assert.equal(calls.filter(call => call.path === '/retry').length, 1);
  assert.notEqual(root.querySelector('.notice').textContent, copy.reasoningFailed);
  assert.equal(root.querySelector('.retry').hidden, true);
  const reads = calls.length; t.mock.timers.tick(60_000); await tick(8);
  assert.equal(calls.filter(call => call.path === '/retry').length, 1, 'settlement retries once');
  assert.equal(calls.length, reads, 'settled hosts stop the admission re-check timer');
});

for (const copy of [de, en]) test(`AIT-184: genuine denial stops polling but a later refresh resumes deferred analysis once (${copy === de ? 'de' : 'en'})`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let reason = 'budget reconciling';
  const matrix = () => ({ best: {
    text: { available: reason === null, reason }, analysis: { available: reason === null, reason } } });
  const { c, root, calls } = setup(t, { copy, host: {}, session: { featureMatrix: matrix() }, routes: {
    'GET ': () => Response.json({ ...c.session, featureMatrix: matrix() }),
    'POST /retry': () => Response.json({ accepted: true }, { status: 202 }),
  } });
  await tick(8);
  const input = root.querySelector('textarea'); input.value = 'Keep this draft';
  userTurn(c);
  c.receive({ type: 'lane.failed', data: { inputRevision: inputRevision(c.session), lane: 'understanding', error: 'reasoning-unavailable', reason } });
  const reads = () => calls.filter(call => call.method === 'GET' && call.path === '').length;
  const retries = () => calls.filter(call => call.path === '/retry').length;
  const before = reads();
  t.mock.timers.tick(14_999); await tick(8);
  assert.equal(reads(), before, 'reconciliation waits for the 15 second cadence');
  t.mock.timers.tick(1); await tick(8);
  assert.equal(reads(), before + 1, 'reconciliation keeps polling');
  reason = 'budget denied';
  t.mock.timers.tick(15_000); await tick(8);
  assert.equal(c.session.featureMatrix.best.analysis.reason, 'budget denied');
  assert.equal(retries(), 0, 'genuine denial cannot retry analysis');
  const deniedReads = reads();
  for (let i = 0; i < 4; i++) { t.mock.timers.tick(15_000); await tick(8); }
  assert.equal(reads(), deniedReads, 'genuine denial stops the admission poll');
  assert.equal(input.value, 'Keep this draft');
  reason = null;
  c.receive({ type: 'voice.state', data: { state: 'ended' } }); await tick(12);
  assert.equal(retries(), 1, 'a later admission refresh resumes the retained deferral');
  assert.equal(root.querySelector('.send').disabled, false);
  assert.equal(input.value, 'Keep this draft');
  c.receive({ type: 'voice.state', data: { state: 'ended' } }); await tick(12);
  assert.equal(retries(), 1, 'another refresh cannot resume the same deferral twice');
  const recoveredReads = reads();
  t.mock.timers.tick(60_000); await tick(8);
  assert.equal(reads(), recoveredReads, 'successful recovery also leaves polling stopped');
});

for (const copy of [de, en]) for (const restart of [false, true]) test(`AIT-186 F2: ledger-only settlement survives voice outage; newer call fenced (${copy === de ? 'de' : 'en'}, restart ${restart})`, { timeout: 10_000 }, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { voiceEvents } = await import('../../core/src/live-voice.js');
  const read = Promise.withResolvers(), started = Promise.withResolvers();
  let reconciling = false, delay = false, callsStarted = 0;
  const voiceClient = { async start({ callId }) {
    callsStarted++; const events = voiceEvents();
    return { callId, providerSessionId: `outage-${callsStarted}`, events,
      async setInput() {}, async setOutput() {}, async updateContext() {},
      async close() { events.end(); throw new Error('voice terminal unavailable'); } };
  } };
  const { c, root } = setup(t, { copy, voiceClient, host: { credits: true },
    session: { featureMatrix: { best: { text: { available: true }, analysis: { available: true }, voice: { available: true } } } },
    routes: { 'GET /credits': async () => {
      const value = reconciling;
      if (delay) { started.resolve(); await read.promise; }
      return Response.json({ balance, exhausted: false, reconciling: value });
    } } });
  t.after(() => read.resolve());
  await tick(8); root.querySelector('.voice-start').click(); await tick(8);
  reconciling = true; t.mock.timers.tick(15_001); await tick(8);
  root.querySelector('.voice-close').click(); await tick(8);
  t.mock.timers.tick(15_001); await tick(8);
  assert.equal(root.querySelector('.voice-state').textContent, copy.voiceClosureUncertain);
  reconciling = false; delay = true; t.mock.timers.tick(15_001); await started.promise;
  if (restart) { root.querySelector('.voice-start').click(); await tick(8); }
  read.resolve(); await tick(12);
  assert.equal(root.querySelector('.audio-rail').dataset.call, restart ? 'active' : 'none');
  assert.equal(root.querySelector('.voice-state').textContent, restart ? copy.voiceStates.listening : copy.voiceEnded);
  assert.equal(root.querySelector('.audio-rail').hasAttribute('data-call-reconciling'), false);
  assert.equal(root.querySelector('textarea').disabled, false);
  if (!restart) assert.equal(root.querySelector('.pause').disabled, false, 'settled idle session pause returns');
  // Duplicate ledger reads and late uncertain voice closure cannot restore reconciliation.
  t.mock.timers.tick(30_001); await tick(8);
  assert.equal(root.querySelector('.voice-state').textContent, restart ? copy.voiceStates.listening : copy.voiceEnded);
  assert.equal(callsStarted, restart ? 2 : 1);
});
