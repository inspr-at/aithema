// AIT-104 B2: the host surface inside <aithema-session>, one panel at a time, against a fixture
// server that answers like the B1 host routes: the verification lock and entry, the conversation
// library, handover with Retry, credits, the host slots, and the start card's pinned footer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession, inputRevision } from '@inspr/aithema-core';
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
function setup(t, { copy = en, host = { library: true, verification: true, handover: true, credits: true }, routes = {}, session: extra = {} } = {}) {
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
  c.configure({ copy, session, host }); document.body.append(c); t.after(() => c.remove());
  return { c, root: c.shadowRoot, calls };
}
const userTurn = (c, id = 't1') => c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id, role: 'user', content: 'We need a preorder app.' } });

test('without a host option the component shows no host surface', t => {
  const { root } = setup(t, { host: null });
  assert.equal(root.querySelector('.host-bar').hidden, true);
  assert.equal(root.querySelector('.handover').hidden, true);
  assert.equal(root.querySelector('.verify-lock').hidden, true);
  assert.equal(root.querySelector('.workspace').hasAttribute('data-host'), false);
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
  assert.equal(root.querySelector('.host-verify .verify-entry').textContent, v.pending);
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

test('verification unlock over SSE keeps a manual pause and says so; the bar then shows a quiet verified line', async t => {
  const { c, root } = setup(t, { session: { identity: pending() } }); await tick();
  assert.equal(root.querySelector('.verify-lock').hidden, false);
  c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true } });
  c.receive({ seq: c.session.seq + 1, type: 'identity.state', data: identity({ status: 'verified', address: 'visitor@example.com', verificationRequired: true, manualPaused: true, paused: true }) });
  c.receive({ seq: c.session.seq + 1, type: 'identity.unlocked', data: { manualPaused: true } });
  assert.equal(root.querySelector('.verify-lock').hidden, true);
  assert.equal(root.querySelector('.notice').hidden, false);
  assert.equal(root.querySelector('.status').textContent, v.unlockedPaused);
  assert.equal(root.querySelector('.host-verify .verify-entry').hidden, true);
  assert.equal(root.querySelector('.host-verify .verify-done').hidden, false);
  assert.equal(root.querySelector('.host-verify .verify-done').textContent, v.verified);
});

test('verification polling asks the host to unlock while a link is pending, never while hidden from a disconnected page', async t => {
  const { root, calls } = setup(t, { host: { verification: true, pollMs: 5 }, session: { identity: pending({ pollVerification: true }) },
    routes: { 'POST /identity/unlock': () => Response.json({ identity: identity({ status: 'verified', address: 'visitor@example.com', verificationRequired: true }) }) } });
  for (let i = 0; i < 20 && root.querySelector('.verify-lock').hidden === false; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(calls.some(call => call.path === '/identity/unlock'));
  assert.equal(root.querySelector('.verify-lock').hidden, true);
});

test('without the lock, verification is a quiet bar entry that opens a small dialog and returns focus', async t => {
  const { root } = setup(t, { session: { identity: identity() } }); await tick();
  assert.equal(root.querySelector('.verify-lock').hidden, true);
  const button = root.querySelector('.host-verify .verify-entry');
  assert.equal(button.hidden, false); assert.equal(button.getAttribute('aria-haspopup'), 'dialog');
  button.click();
  const dialog = root.querySelector('dialog.verify-dialog');
  assert.equal(dialog.open, true);
  assert.equal(root.activeElement?.id, 'verify-dialog-email');
  dialog.querySelector('.verify-dialog-close').click();
  assert.equal(dialog.open, false);
});

test('library: lists the owner conversations keyed, sorts by title and activity, renames in place, deletes with erasure wording (AIT-104 B2)', async t => {
  const items = [entry('a', 'Bakery preorders', '2026-10-01T10:00:00Z'), entry('b', '', '2026-10-09T10:00:00Z'), entry('c', 'Accounting export', '2026-10-05T10:00:00Z')];
  const { c, root, calls } = setup(t, { routes: {
    'GET /library': () => Response.json({ items, total: items.length, offset: 0, limit: 100 }),
    'POST /library/a/rename': body => Response.json({ ...items[0], title: body.title }),
    'POST /library/c/delete': () => { items.splice(2, 1); return Response.json({ id: 'c', erased: true, providerDeletion: 'not-confirmed' }); },
  } });
  const open = root.querySelector('.library-open-dialog');
  assert.equal(open.hidden, false); assert.equal(open.textContent, l.open);
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
  assert.equal(root.activeElement?.className, 'library-open-dialog', 'focus returns to the library button');
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

test('credits: the owner balance and time slot from the server; limit-reached shows the host slot and plain words', async t => {
  const { c, root } = setup(t, { routes: {
    'GET /credits': () => Response.json({ balance, limitSlot: { status: 'active', remainingMs: 30 * 60_000, canStartPaidWork: true } }),
  } });
  await tick();
  const line = root.querySelector('.host-credits');
  assert.equal(line.hidden, false);
  assert.equal(line.querySelector('.host-credits__text').textContent, 'Credits: 4.25 of 5 · 30 min left in this conversation');
  assert.equal(line.querySelector('.host-credits__limit').hidden, true);
  c.receive({ seq: c.session.seq + 1, type: 'credits.limit-reached', data: { reason: 'one-hour' } });
  assert.equal(line.querySelector('.host-credits__text').textContent, cr.ended['one-hour']);
  assert.equal(line.querySelector('.host-credits__limit').hidden, false);
  assert.equal(root.querySelector('.status').textContent, cr.ended['one-hour']);
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
  assert.equal(root.querySelector('.library-open-dialog').textContent, de.hostSurface.library.open);
  assert.equal(root.querySelector('.verify-lock__title').textContent, de.hostSurface.verify.lockTitle);
  assert.equal(root.querySelector('.verify-lock .verify-send').textContent, de.hostSurface.verify.send);
  const keys = (value, prefix = '') => Object.entries(value).flatMap(([k, v]) => v && typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]);
  assert.deepEqual(keys(de.hostSurface).sort(), keys(en.hostSurface).sort());
  assert.deepEqual(keys(de.host.slots).sort(), keys(en.host.slots).sort());
  assert.deepEqual(keys(de.host.outbox).sort(), keys(en.host.outbox).sort());
});

test('start card: the action row sits in a sticky footer so Continue is never cut off (AIT-104 B2 fix)', t => {
  const { root } = setup(t, { host: null });
  const footer = root.querySelector('.chooser__footer');
  assert.ok(footer, 'the chooser has a footer');
  assert.ok(footer.querySelector('.chooser__continue') && footer.querySelector('.chooser__error'));
  assert.match(root.querySelector('style').textContent, /\.chooser__footer \{ position:sticky; bottom:0;/u);
  assert.match(hostStyles, /\.verify__primary > \* \{ grid-area:1\/1;/u, 'Send and Send again share one cell');
});

// Gate fix round 1 (PR #86): each test below would have caught one finding.
test('verification copy names what B1 sends: a confirmation link, not the assessment (en and de)', () => {
  assert.match(v.sentTo, /confirmation link/iu); assert.doesNotMatch(v.sentTo, /assessment/iu);
  assert.match(de.hostSurface.verify.sentTo, /Bestätigungslink/u); assert.doesNotMatch(de.hostSurface.verify.sentTo, /Auswertung|Einschätzung/u);
});

test('credits: a pause never freezes the countdown (the host deadline keeps running) and says what pausing does', async t => {
  const { c, root } = setup(t, { session: { paused: true }, routes: {
    'GET /credits': () => Response.json({ balance, limitSlot: { status: 'active', remainingMs: 30 * 60_000, canStartPaidWork: false } }),
  } });
  await tick();
  const text = () => root.querySelector('.host-credits__text').textContent;
  assert.equal(text(), `Credits: 4.25 of 5 · 30 min left in this conversation · ${cr.paused}`);
  assert.match(cr.paused, /time keeps running/u); assert.match(de.hostSurface.credits.paused, /Zeit läuft aber weiter/u);
  // Ten minutes later, still paused: the line counts down like the server's deadline.
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 10 * 60_000);
  c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true } });
  assert.equal(text(), `Credits: 4.25 of 5 · 20 min left in this conversation · ${cr.paused}`);
  c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: false } });
  assert.equal(text(), 'Credits: 4.25 of 5 · 20 min left in this conversation');
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
  root.querySelector('.host-verify .verify-entry').click();
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
