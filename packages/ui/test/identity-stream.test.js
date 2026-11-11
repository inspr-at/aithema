import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, inputRevision } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { createVoiceControl } from '../src/voice-control.js';
import { EmailAsk } from '../src/email-ask.js';
import { window, tick, identity, entry, setup, userTurn } from './host-surface-helpers.js';

for (const copy of [en, de]) test(`AIT-418: address change stays editable, blocks submit, then re-enables (${copy.display.locale})`, async t => {
  const verified = identity({ status: 'verified', address: 'before@example.test' });
  const { c, root, calls } = setup(t, { copy, host: { verification: true }, session: { identified: true, identity: verified },
    routes: { 'GET /identity': () => Response.json({ identity: verified, visitorEmail: { canSave: false } }), 'GET /visitor/email': () => Response.json({}, { status: 404 }) } });
  await tick(8);
  root.querySelector('.m-change-mail').click(); await tick();
  const form = root.querySelector('dialog.verify-dialog .verify-form'), input = form.querySelector('input'), submit = form.querySelector('.verify-send');
  userTurn(c);
  c.receive({ type: 'lane.status', data: { inputRevision: inputRevision(c.session), running: ['reaction'], failures: [], lastFailure: null } });
  input.value = 'after@example.test';
  assert.equal(submit.getAttribute('aria-disabled'), 'true');
  assert.equal(input.disabled, false); assert.equal(input.readOnly, false);
  assert.equal(form.querySelector('.verify__message').textContent, copy.hostSurface.verify.streamWait);
  form.dispatchEvent(new window.Event('submit', { cancelable: true })); await tick();
  assert.equal(calls.some(call => call.path === '/identity/change'), false);
  c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'reply', role: 'assistant', content: 'Done.', inputRevision: inputRevision(c.session) } });
  c.receive({ type: 'lane.status', data: { inputRevision: inputRevision(c.session), running: [], failures: [], lastFailure: null } });
  // A duplicate verified acknowledgement from a credit/identity refresh must
  // keep the open address edit and its reserved hint row through re-enable.
  c.receive({ seq: c.session.seq + 1, type: 'identity.state', data: { ...c.session.identity } });
  assert.equal(form.dataset.mode, 'capture');
  assert.equal(form.querySelector('.verify__note').textContent, copy.hostSurface.verify.hint);
  assert.equal(submit.getAttribute('aria-disabled'), 'false');
  assert.equal(input.value, 'after@example.test');
  assert.equal(form.querySelector('.verify__message').textContent, '');
  c.receive({ seq: c.session.seq + 1, type: 'identity.state', data: { ...verified, status: 'verification-pending', address: 'after@example.test' } });
  c.receive({ seq: c.session.seq + 1, type: 'identity.state', data: { ...verified, address: 'after@example.test' } });
  assert.equal(form.dataset.mode, 'verified', 'a newly verified address still completes the edit');
});

test('AIT-418: race failure renders existing failed reply with retry and permits address change', async t => {
  const verified = identity({ status: 'verified', address: 'before@example.test' });
  const { c, root, calls } = setup(t, { routes: { 'POST /retry': () => Response.json({}, { status: 202 }) }, host: { verification: true }, session: { identified: true, identity: verified, featureMatrix: { best: { text: { available: true }, analysis: { available: false, reason: 'not configured' } } } } });
  await tick(8); userTurn(c);
  c.receive({ seq: c.session.seq + 1, type: 'identity.state', data: { ...verified, status: 'verification-pending', identified: false } });
  const failure = { inputRevision: inputRevision(c.session), lane: 'reaction', error: 'reasoning-unavailable', reason: 'identity-changed', retryable: true };
  c.receive({ type: 'lane.failed', data: failure });
  c.receive({ type: 'lane.status', data: { inputRevision: inputRevision(c.session), running: [], failures: [failure], lastFailure: failure } });
  assert.equal(root.querySelector('.reaction-failure').hidden, false);
  assert.match(root.querySelector('.reaction-failure').textContent, /reply|response|reasoning|answer/i);
  assert.equal(root.querySelector('.retry').hidden, false);
  assert.equal(root.querySelector('.verify-send').getAttribute('aria-disabled'), 'false');
  root.querySelector('.retry').click(); await tick();
  assert.equal(calls.filter(call => call.path === '/retry').length, 1, 'AIT-466 U6: identity-race Retry reaches the reply lane');
});

test('AIT-418: an accepted turn with no running reply does not block address change', async t => {
  const verified = identity({ status: 'verified', address: 'before@example.test' });
  const { c, root } = setup(t, { host: { verification: true }, session: { identified: true, identity: verified } });
  await tick(8); userTurn(c);
  c.receive({ type: 'lane.status', data: { inputRevision: inputRevision(c.session), running: [], failures: [], lastFailure: null } });
  assert.equal(root.querySelector('.verify-send').getAttribute('aria-disabled'), 'false');
});

for (const state of ['waiting', 'failed']) test(`AIT-418: email-ask still treats an unanswered ${state} turn as streaming`, async t => {
  let ask;
  const update = EmailAsk.prototype.update;
  t.mock.method(EmailAsk.prototype, 'update', function (...args) { ask = this; return update.apply(this, args); });
  const { c, root } = setup(t, { host: { verification: true, credits: true } });
  await tick(8); assert.ok(ask);
  assert.equal(Boolean(ask.streaming()), false);
  userTurn(c);
  const failure = { inputRevision: inputRevision(c.session), lane: 'reaction', error: 'reasoning-unavailable', retryable: true };
  if (state === 'failed') c.receive({ type: 'lane.failed', data: failure });
  c.receive({ type: 'lane.status', data: { inputRevision: inputRevision(c.session), running: [], failures: state === 'failed' ? [failure] : [], lastFailure: state === 'failed' ? failure : null } });
  assert.equal(root.querySelector('.verify-send').getAttribute('aria-disabled'), 'false', 'O9 permits address changes once reply work stops');
  assert.equal(ask.streaming(), true, 'email-ask waits for a completed reply, including before dispatch and after failure');
  c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'reply', role: 'assistant', content: 'Done.', inputRevision: inputRevision(c.session) } });
  assert.equal(Boolean(ask.streaming()), false);
});

// AIT-470: only fake HTTP/voice ports; snapshots share the journal's clock/seq.
const locked470 = { best: Object.fromEntries(['text', 'uploads', 'voice', 'analysis', 'images', 'html'].map(key =>
  [key, { available: ['text', 'uploads', 'voice'].includes(key), reason: ['text', 'uploads', 'voice'].includes(key) ? null : 'verification required' }])) };
const unlocked470 = { best: Object.fromEntries(Object.keys(locked470.best).map(key => [key, { available: true, reason: null }])) };
const verified470 = () => identity({ status: 'verified', address: 'visitor@example.test', verificationRequired: true });
const event470 = (c, type, data) => c.receive({ seq: c.session.seq + 1, type, data });
const journal470 = c => event470(c, 'turn.final', { id: 'reply-' + c.session.seq, role: 'assistant', content: 'More detail.', inputRevision: inputRevision(c.session) });
function fixture470(t, options = {}) {
  let reads = 0;
  const state = { snapshot: () => Response.json({ ...h.c.session, featureMatrix: options.session?.featureMatrix ?? unlocked470 }) };
  const h = setup(t, { ...options, host: options.host ?? { verification: true }, session: {
    identity: pending470(), visualsBound: true, conceptCost: { maxMicro: 0 }, conceptVisualKind: 'images', featureMatrix: structuredClone(locked470), ...options.session },
    routes: { 'GET ': () => { reads++; return state.snapshot(); },
      'GET /consent': () => Response.json({ consentRevision: h.c.session.consentRevision, selected: [], features: {} }), ...options.routes } });
  return { ...h, state, get reads() { return reads; } };
}
function pending470(extra = {}) { return identity({ verificationRequired: true, assessmentUnlocked: false, conceptsUnlocked: false,
  status: 'verification-pending', address: 'visitor@example.test', verificationRevision: 1, ...extra }); }
function clear470(h, copy = en) {
  for (const [selector, attribute] of [['.notice-text'], ['.concept-activity-text'], ['#attach-limits'], ['.attach', 'title']]) {
    const node = h.root.querySelector(selector), text = attribute ? node.getAttribute(attribute) : node.textContent;
    assert.ok(!text.includes(copy.reasons['verification required']), `${selector}: ${text}`);
  }
  assert.equal(h.root.querySelector('.verify-lock').hidden, true);
}
for (const copy of [en, de]) test(`AIT-470 U1 ${copy.display.locale}: overtaken unlock reads clear overview, concept and attach`, async t => {
  const h = fixture470(t, { copy }), held = Promise.withResolvers(); t.after(() => held.resolve());
  await tick(8); userTurn(h.c);
  let snapshot;
  h.state.snapshot = () => held.promise.then(() => Response.json(snapshot));
  event470(h.c, 'identity.unlocked', {}); event470(h.c, 'identity.state', verified470());
  snapshot = { ...h.c.session, featureMatrix: unlocked470 };
  journal470(h.c); h.state.snapshot = () => Response.json({ ...h.c.session, featureMatrix: unlocked470 });
  held.resolve(); await tick(8);
  assert.equal(h.reads, 3); clear470(h, copy); await tick(20); assert.equal(h.reads, 3);
});
test('AIT-470 U2: an ahead read repeats when the journal catches up', async t => {
  const h = fixture470(t); await tick(8);
  h.state.snapshot = () => Response.json({ ...h.c.session, seq: h.c.session.seq + 1, featureMatrix: unlocked470 });
  event470(h.c, 'identity.state', verified470()); await tick(8); assert.equal(h.reads, 1);
  h.state.snapshot = () => Response.json({ ...h.c.session, featureMatrix: unlocked470 });
  journal470(h.c); await tick(8); assert.equal(h.reads, 2); clear470(h);
  journal470(h.c); await tick(8); assert.equal(h.reads, 2);
});
for (const status of [409, 503]) test(`AIT-470 U3 ${status}: conflict repeats on journal movement; failure has no timer read`, async t => {
  const h = fixture470(t); await tick(8);
  h.state.snapshot = () => new Response(null, { status });
  event470(h.c, 'identity.state', verified470()); await tick(20); assert.equal(h.reads, 1);
  if (status === 409) {
    h.state.snapshot = () => Response.json({ ...h.c.session, featureMatrix: unlocked470 });
    journal470(h.c); await tick(8); assert.equal(h.reads, 2); clear470(h);
  }
});
test('AIT-470 U4: a frozen snapshot costs exactly 1 + REPEAT_LIMIT reads', async t => {
  const h = fixture470(t); await tick(8);
  const frozen = { ...h.c.session, featureMatrix: unlocked470 };
  h.state.snapshot = () => Response.json(frozen);
  event470(h.c, 'identity.state', verified470()); await tick(8);
  for (let i = 0; i < 10; i++) { journal470(h.c); await tick(8); }
  await tick(20); assert.equal(h.reads, 1 + 5);
});
test('AIT-470 U5: a live consent window keeps its own retries', async t => {
  const h = fixture470(t), held = Promise.withResolvers(); t.after(() => held.resolve()); await tick(8);
  h.state.snapshot = () => { const response = Response.json(h.c.session); return held.promise.then(() => response); };
  event470(h.c, 'consent.revised', { granted: true, conversationUnchanged: true });
  journal470(h.c); h.state.snapshot = () => Response.json(h.c.session); held.resolve(); await tick(8);
  assert.equal(h.reads, 2); journal470(h.c); await tick(8); assert.equal(h.reads, 2);
});
test('AIT-470 U6: an exhausted consent window permits repeating an overtaken read', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = fixture470(t); await tick(8); h.state.snapshot = () => new Response(null, { status: 503 });
  event470(h.c, 'consent.revised', { granted: true, conversationUnchanged: true }); await tick(8);
  for (const ms of [2000, 4000, 8000]) { t.mock.timers.tick(ms); await tick(8); }
  assert.equal(h.reads, 4);
  const held = Promise.withResolvers(); t.after(() => held.resolve());
  h.state.snapshot = () => { const response = Response.json({ ...h.c.session, featureMatrix: unlocked470 }); return held.promise.then(() => response); };
  event470(h.c, 'identity.state', verified470()); journal470(h.c);
  h.state.snapshot = () => Response.json({ ...h.c.session, featureMatrix: unlocked470 }); held.resolve(); await tick(8);
  assert.equal(h.reads, 6); clear470(h);
});
test('AIT-470 U7: a pending repeat cannot cross a conversation switch', async t => {
  const h = fixture470(t); await tick(8);
  h.state.snapshot = () => Response.json({ ...h.c.session, seq: h.c.session.seq + 1, featureMatrix: unlocked470 });
  event470(h.c, 'identity.state', verified470()); await tick(8); assert.equal(h.reads, 1);
  const { createSession } = await import('@inspr/aithema-core');
  const next = createSession({ demo: true }); next.seq = 50; next.featureMatrix = unlocked470;
  h.c.configure({ copy: en, session: next, host: { verification: true } }); journal470(h.c); await tick(8);
  assert.equal(h.reads, 1);
});
test('AIT-470 U8: a repeat due while detached runs once on attach', async t => {
  const h = fixture470(t), held = Promise.withResolvers(); t.after(() => held.resolve()); await tick(8);
  h.state.snapshot = () => { const response = Response.json({ ...h.c.session, featureMatrix: unlocked470 }); return held.promise.then(() => response); };
  event470(h.c, 'identity.state', verified470()); journal470(h.c); h.c.remove();
  h.state.snapshot = () => Response.json({ ...h.c.session, featureMatrix: unlocked470 }); held.resolve(); await tick(8); assert.equal(h.reads, 1);
  document.body.append(h.c); await tick(8); assert.equal(h.reads, 2); clear470(h);
});
for (const conflict of [false, true]) test(`AIT-470 U9 ${conflict ? '409' : 'ahead'}: poll-only unlock reads and reconnects once`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = fixture470(t, { session: { identity: pending470({ pollVerification: true }) }, routes: {
    'POST /identity/unlock': () => Response.json({ identity: verified470() }) } }); await tick(8);
  h.state.snapshot = () => conflict ? new Response(null, { status: 409 }) : Response.json({ ...h.c.session, seq: h.c.session.seq + 1, identity: verified470(), featureMatrix: unlocked470 });
  const original = globalThis.fetch; let streams = 0;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (String(url).endsWith('/events')) {
      streams++; h.state.snapshot = () => Response.json({ ...h.c.session, featureMatrix: unlocked470 });
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        const event = { seq: h.c.session.seq + 1, type: 'identity.state', data: verified470() };
        controller.enqueue(new TextEncoder().encode(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`));
        options.signal.addEventListener('abort', () => controller.close(), { once: true });
      } })));
    }
    return original(url, options);
  });
  t.mock.timers.tick(4000); await tick(8);
  assert.equal(streams, 1); assert.equal(h.reads, 2); clear470(h);
  t.mock.timers.tick(60_000); await tick(8); assert.equal(streams, 1); assert.equal(h.reads, 2);
});
test('AIT-470 U10: stream unlock adds no edge read or reconnect', async t => {
  const h = fixture470(t); await tick(8); const original = globalThis.fetch; let streams = 0;
  t.mock.method(globalThis, 'fetch', (url, options) => { if (String(url).endsWith('/events')) streams++; return original(url, options); });
  event470(h.c, 'identity.state', verified470()); await tick(8); assert.equal(h.reads, 1); assert.equal(streams, 0); clear470(h);
});
test('AIT-470 U11: equal matrices do not repeat after a seq drop', async t => {
  const h = fixture470(t); await tick(8);
  h.state.snapshot = () => Response.json({ ...h.c.session, seq: h.c.session.seq + 1 });
  event470(h.c, 'identity.state', pending470()); await tick(8);
  journal470(h.c); await tick(8); journal470(h.c); await tick(8); assert.equal(h.reads, 1);
});
test('AIT-470 U12: credit denial costs one read per journal event', async t => {
  // Exercise journal-driven reads alone, independently of the 300 ms receipt debounce.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const matrix = structuredClone(locked470); matrix.best.text = { available: false, reason: 'budget denied' };
  const h = fixture470(t, { host: { credits: true }, session: { featureMatrix: matrix } }); await tick(8);
  const before = h.reads, frozen = { ...h.c.session, featureMatrix: unlocked470 };
  h.state.snapshot = () => Response.json(frozen);
  for (let i = 0; i < 5; i++) { journal470(h.c); await tick(8); }
  assert.equal(h.reads - before, 5);
});
async function voice470(t) {
  const { voiceEvents } = await import('../../core/src/live-voice.js');
  const events = voiceEvents();
  return { async start({ callId }) { return { callId, providerSessionId: 'fixture-provider', events,
    async setInput() {}, async setOutput() {}, async updateContext() {},
    async pause() { return { acknowledged: true, paused: true }; }, async resume() { return { acknowledged: true, paused: false }; },
    async close() { events.end(); return { closureConfirmed: true }; } }; } };
}
// AIT-464: count only A's snapshot and consent GETs after the server erases A.
function fixture464(t, options = {}) {
  const h = fixture470(t, { ...options, session: { ...options.session, id: 'conversation-a' } });
  const original = globalThis.fetch, reads = { snapshot: 0, consent: 0 };
  let erased = false;
  t.mock.method(globalThis, 'fetch', (url, options = {}) => {
    const path = String(url), get = (options.method ?? 'GET') === 'GET';
    const resource = path === '/api/sessions/conversation-a' ? 'snapshot'
      : path === '/api/sessions/conversation-a/consent' ? 'consent' : null;
    if (erased && get && resource) {
      reads[resource]++;
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    return original(url, options);
  });
  return { ...h, reads, markErased() { erased = true; }, erase() {
    erased = true;
    event470(h.c, 'session.erased', { at: new Date().toISOString() });
  } };
}
// Raw URLs are recorded outside setup's current-id-stripping mock.
function fixture484(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const h = fixture470(t, { ...options, session: { ...options.session, id: 'conversation-a' } });
  const original = globalThis.fetch, raw = [], erasedEvents = [], newEvents = [], openEvents = [];
  let erased = false, stream, streamClosed = false;
  const state = { snapshot: null, body: { error: 'session-not-found' } };
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const path = String(url), isA = /^\/api\/sessions\/conversation-a(?:[/?]|$)/u.test(path);
    if (erased && isA) {
      raw.push({ path, init });
      if (path === '/api/sessions/conversation-a' && state.snapshot) return state.snapshot();
      return Response.json(state.body, { status: 404 });
    }
    if (path === '/api/sessions/conversation-a/events') return new Response(new ReadableStream({ start(controller) {
      stream = controller; streamClosed = false;
      init.signal?.addEventListener('abort', () => { if (!streamClosed) { streamClosed = true; controller.close(); } }, { once: true });
    } }));
    return original(url, init);
  });
  for (const [name, target] of [['erased', erasedEvents], ['new-conversation', newEvents], ['open-conversation', openEvents]])
    h.c.addEventListener(`aithema-${name}`, e => target.push(e.detail));
  return { ...h, raw, state, erasedEvents, newEvents, openEvents,
    serverErase() { erased = true; },
    streamErase() {
      erased = true;
      const event = { seq: h.c.session.seq + 1, type: 'session.erased', data: { at: new Date().toISOString() } };
      stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    },
    dropStream() { if (!streamClosed) { streamClosed = true; stream.close(); } },
    async reconnect() { h.c.remove(); await tick(8); document.body.append(h.c); await tick(8); },
  };
}
async function quiet484(t, h, max = 0) {
  const before = h.raw.length; assert.ok(before <= max, `A requests ${before} > ${max}: ${h.raw.map(r => r.path)}`);
  for (const ms of [1000, 3000, 4000, 8000, 16000, 16000]) { t.mock.timers.tick(ms); await tick(12); }
  assert.equal(h.raw.length, before, 'no further request for erased A after 48 seconds');
}
for (const copy of [en, de]) test(`AIT-484 journal: one end state, silent host, local call teardown (${copy.display.locale})`, async t => {
  const client = await voice470(t); let closes = 0, reason;
  const start = client.start; client.start = async (...args) => { const call = await start(...args), close = call.close; call.close = async options => { closes++; reason = options?.reason; return close(options); }; return call; };
  const h = fixture484(t, { copy, voiceClient: client, host: { library: true, verification: true, credits: true },
    session: { identity: pending470({ pollVerification: true }), featureMatrix: unlocked470 } });
  await h.reconnect(); userTurn(h.c); h.root.querySelector('.voice-start').click(); await tick(8);
  h.root.querySelector('textarea').focus();
  const stage = h.root.querySelector('.workspace').dataset.stage, preset = h.c.session.processingPreset;
  h.streamErase(); await tick(12);
  assert.ok(h.c.hasAttribute('data-aithema-erased')); assert.ok(h.c.session.tombstone);
  assert.equal(h.root.querySelector('.workspace').dataset.stage, stage);
  assert.equal(h.root.querySelectorAll('ol > li.erased-end').length, 1);
  assert.equal(h.root.querySelector('[data-copy="conversationUnavailable"]').textContent,
    copy === en ? 'This conversation is no longer available.' : 'Dieses Gespräch ist nicht mehr verfügbar.');
  assert.equal(h.root.querySelector('.erased-end__new').textContent, copy.hostSurface.library.new);
  assert.equal(h.root.activeElement, h.root.querySelector('.erased-end__new'));
  assert.equal(h.root.querySelector('form.composer').inert, true);
  assert.equal(h.root.querySelector('.transcript-shell').inert, false);
  assert.equal(h.root.querySelector('.composer-out').inert, true);
  assert.equal(h.root.querySelector('.export').getAttribute('aria-disabled'), 'true');
  assert.equal(h.root.querySelector('.audio-rail').hasAttribute('data-call-reconciling'), false);
  assert.equal(h.root.querySelector('.voice-state').textContent, '');
  assert.equal(closes, 1); assert.equal(reason, 'session-erased'); assert.equal(h.c.session.processingPreset, preset);
  assert.deepEqual(h.erasedEvents, [{ sessionId: 'conversation-a', via: 'journal' }]);
  for (const n of h.root.querySelectorAll('[aria-live]')) if (!n.closest('.erased-end')) assert.equal(n.getAttribute('aria-live'), 'off');
  h.c.receive({ type: 'session.erased', data: {} }); h.c.openSettings(); await tick(8);
  assert.equal(h.root.querySelector('dialog.settings').open, false);
  await quiet484(t, h); await h.reconnect(); await quiet484(t, h);
  assert.equal(closes, 1); assert.equal(h.erasedEvents.length, 1);
});
for (const route of ['events', 'credits', 'identity/unlock', 'restore', 'voice-close']) test(`AIT-484 exact not-found: ${route} confirms once then stops`, async t => {
  const client = await voice470(t); let control;
  const start = client.start; client.start = async (...args) => { const call = await start(...args), close = call.close; call.close = async options => { try { return await control.close(call, options); } finally { await close(options); } }; return call; };
  const h = fixture484(t, { voiceClient: client, host: { verification: { delivery: true }, credits: true },
    session: { identity: pending470({ pollVerification: true }), featureMatrix: unlocked470 } });
  control = createVoiceControl({ sessionId: 'conversation-a', receive: event => h.c.receive(event) }).control;
  await h.reconnect();
  if (route === 'voice-close') { h.root.querySelector('.voice-start').click(); await tick(8); }
  h.serverErase();
  if (route === 'events') { h.dropStream(); await tick(8); }
  if (route === 'credits') { h.c.receive({ type: 'voice.state', data: { state: 'closing' } }); t.mock.timers.tick(300); }
  if (route === 'identity/unlock') t.mock.timers.tick(4000);
  if (route === 'restore') h.c.receive({ seq: h.c.session.seq + 2, type: 'turn.final', data: { id: 'gap', role: 'assistant', content: 'gap' } });
  if (route === 'voice-close') h.root.querySelector('.voice-close').click();
  t.mock.timers.tick(1000); await tick(16);
  assert.ok(h.c.hasAttribute('data-aithema-erased'));
  assert.equal(h.raw.filter(r => r.path === '/api/sessions/conversation-a').length, 1);
  assert.equal(h.raw.find(r => r.path === '/api/sessions/conversation-a')?.init.cache, 'no-store');
  assert.deepEqual(h.erasedEvents, [{ sessionId: 'conversation-a', via: 'not-found' }]);
  await quiet484(t, h, route === 'restore' ? 1 : 2);
});
for (const result of ['200', 'network', '503']) test(`AIT-484 confirmation ${result} changes nothing; one read per 15 seconds`, async t => {
  const h = fixture484(t, { host: {} }); await h.reconnect(); h.serverErase();
  h.state.snapshot = () => { if (result === 'network') throw new TypeError('fixture offline'); return Response.json(h.c.session, { status: Number(result) }); };
  h.dropStream();
  for (let i = 0; i < 14; i++) { t.mock.timers.tick(1000); await tick(8); }
  assert.equal(h.c.hasAttribute('data-aithema-erased'), false);
  assert.equal(h.raw.filter(r => r.path === '/api/sessions/conversation-a').length, 1);
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(1000); await tick(8); }
  assert.equal(h.raw.filter(r => r.path === '/api/sessions/conversation-a').length, 2);
});
for (const body of [{ error: 'not-found' }, {}, { error: 'session-not-found', extra: true }]) test(`AIT-484 ignores unrelated 404 ${JSON.stringify(body)}`, async t => {
  const h = fixture484(t, { host: {} }); await h.reconnect(); h.serverErase(); h.state.body = body; h.dropStream();
  for (let i = 0; i < 4; i++) { t.mock.timers.tick(1000); await tick(8); }
  assert.equal(h.c.hasAttribute('data-aithema-erased'), false);
  assert.equal(h.raw.filter(r => r.path === '/api/sessions/conversation-a').length, 0);
});
for (const stage of ['entrance', 'ready', 'live', 'folded']) test(`AIT-484 placement and frozen stage: ${stage}`, async t => {
  const h = fixture484(t, { host: {}, session: { settings: { origin: stage === 'ready' ? 'chosen' : 'default' } } }); await h.reconnect();
  if (['live', 'folded'].includes(stage)) userTurn(h.c);
  if (stage === 'folded') h.root.querySelector('.fold').click();
  const previous = h.root.querySelector('.workspace').dataset.stage;
  h.streamErase(); await tick(8);
  assert.equal(h.root.querySelector('.workspace').dataset.stage, previous);
  const container = stage === 'folded' ? '.canvas-empty' : stage === 'live' ? 'ol' : '.intro__card';
  assert.ok(h.root.querySelector(`${container} .erased-end__new`));
  assert.equal(h.root.querySelector('textarea').disabled, true);
  await quiet484(t, h);
});
for (const library of [false, true]) test(`AIT-484 new action: ${library ? 'library creates once and self-switches' : 'event uses server last choice'}`, async t => {
  const next = createSession({ id: 'conversation-b', demo: true }); next.featureMatrix = unlocked470;
  const h = fixture484(t, { host: { library }, routes: { 'POST /library': () => Response.json({ session: next }, { status: 201 }) } }); await h.reconnect();
  h.streamErase(); await tick(8); const action = h.root.querySelector('.erased-end__new'); assert.ok(action);
  action.click(); action.click(); await tick(16);
  if (library) {
    assert.equal(h.calls.filter(c => c.method === 'POST' && c.path === '/library').length, 1);
    assert.equal(h.openEvents[0].reason, 'deleted'); assert.equal(h.c.session.id, next.id);
    assert.equal(h.c.hasAttribute('data-aithema-erased'), false);
  } else assert.deepEqual(h.newEvents[0], { previousSessionId: 'conversation-a', reason: 'deleted', confirm: false });
});
test('AIT-484 late snapshot cannot undo erasure; configure B works and A stays remembered', async t => {
  const h = fixture484(t, { host: {} }); await h.reconnect(); const held = Promise.withResolvers(); t.after(() => held.resolve());
  const before = h.c.session; h.state.snapshot = () => held.promise.then(() => Response.json(before)); h.serverErase();
  h.c.receive({ seq: before.seq + 2, type: 'turn.final', data: { id: 'gap', role: 'assistant', content: 'gap' } });
  event470(h.c, 'session.erased', { at: new Date().toISOString() }); held.resolve(); await tick(12);
  assert.ok(h.c.session.tombstone); assert.equal(h.erasedEvents.length, 1);
  const b = createSession({ id: 'conversation-b', demo: true }); b.featureMatrix = unlocked470;
  h.c.configure({ session: b, copy: en, host: {} }); await tick(8);
  assert.equal(h.c.hasAttribute('data-aithema-erased'), false); userTurn(h.c); assert.equal(h.c.session.transcript.length, 1);
  h.c.configure({ session: before, copy: en, host: {} }); await tick(8);
  assert.ok(h.c.hasAttribute('data-aithema-erased')); assert.equal(h.erasedEvents.length, 1);
});

test('AIT-484 a burst shares one held confirmation and late success changes nothing', async t => {
  const h = fixture484(t, { host: { credits: true, verification: { delivery: true } }, session: { identity: pending470({ pollVerification: true }) } });
  await h.reconnect(); const held = Promise.withResolvers(); t.after(() => held.resolve());
  h.serverErase(); h.state.snapshot = () => held.promise.then(() => Response.json(h.c.session));
  h.dropStream(); await tick(8); t.mock.timers.tick(1000); await tick(8);
  // The verification timer provides the second suspect route without a journal
  // event that also owns an independent natural feature snapshot read.
  t.mock.timers.tick(4000); await tick(12);
  assert.ok(h.raw.length >= 3, 'several routes saw the refusal');
  assert.equal(h.raw.filter(r => r.path === '/api/sessions/conversation-a').length, 1);
  held.resolve(); await tick(12);
  assert.equal(h.c.hasAttribute('data-aithema-erased'), false);
});
for (const provider of ['elevenlabs', 'grok']) test(`AIT-484 ${provider}: real client and voice control tear down once without voice POSTs`, async t => {
  const { voiceEvents } = await import('../../core/src/live-voice.js');
  const { createElevenLabsClient } = await import('../../../plugins/elevenlabs/src/client.js');
  const { createGrokVoiceClient } = await import('../../../plugins/grok-voice/src/client.js');
  const { fakeSdk } = await import('../../../plugins/elevenlabs/test/fixtures.js');
  let h, sdk = fakeSdk(), disconnected = 0;
  const ports = createVoiceControl({ sessionId: 'conversation-a', receive: event => h.c.receive(event) }), { control } = ports;
  const client = provider === 'elevenlabs' ? createElevenLabsClient({ control, sdk, mediaDevices: sdk.mediaDevices,
    AudioContext: sdk.AudioContext, persistEvent: async () => {} }) : createGrokVoiceClient({ control, now: () => Date.now(),
    async openRelay() { const frames = voiceEvents(); return { frames, async disconnect() { disconnected++; frames.end(); }, async sendAudio() {}, async command() { return { acknowledged: true }; } }; },
    capture: async () => ({ stop() {} }), player: { play() {}, stop() {} } });
  h = fixture484(t, { voiceClient: client, host: {}, session: { featureMatrix: unlocked470 }, routes: {
    'POST /voice': request => {
      const providerSessionId = 'fixture-provider', until = Date.now() + 180000;
      return Response.json({ callId: request.callId, providerSessionId, epoch: 1,
        spendDeadlineAt: until, browserLivenessDeadlineAt: until,
        credential: { providerSessionId, ttlMs: 60000, connectionType: 'webrtc', conversationToken: 'fixture-token-fixture-provider' },
        mediaGrant: { callId: request.callId, providerSessionId, expiresAt: until, opaque: { epoch: 1, spendDeadlineAt: until, browserLivenessDeadlineAt: until } } });
    } } });
  await h.reconnect(); userTurn(h.c); h.root.querySelector('.voice-start').click(); await tick(24);
  assert.equal(h.root.querySelector('.audio-rail').dataset.call, 'active');
  h.streamErase(); await tick(24); event470(h.c, 'session.erased', {}); await tick(12);
  assert.equal(h.raw.filter(r => r.path.includes('/voice')).length, 0);
  assert.equal(h.root.querySelector('.audio-rail').hasAttribute('data-call-reconciling'), false);
  assert.equal(h.root.querySelector('.voice-state').textContent, '');
  if (provider === 'elevenlabs') assert.equal(sdk.effects.filter(e => e[0] === 'endSession').length, 1);
  else assert.equal(disconnected, 1);
  await quiet484(t, h);
});

test('AIT-484 actor account and device choice stay mounted; all id dialogs close', async t => {
  const labels = { en: { private: 'Private', company: 'Company', representative: 'Representative', agency: 'Agency' } };
  const roleChoice = { available: true, roles: Object.keys(labels.en), role: 'company', source: 'chosen', revision: 1 };
  const h = fixture484(t, { host: { actorRole: { labels }, verification: true }, session: { processingPreset: 'device', roleChoice, identity: identity() } }); await tick(8);
  const actor = h.root.querySelector('.actor-role'), account = h.root.querySelector('slot[name="account"]'), parent = account.parentNode;
  const dialogs = ['dialog.settings', 'dialog.verify-dialog', 'dialog.actor-sheet'];
  for (const selector of dialogs) h.root.querySelector(selector).showModal();
  event470(h.c, 'session.erased', { at: new Date().toISOString() }); await tick(8);
  assert.equal(h.root.querySelector('.actor-role'), actor); assert.equal(account.parentNode, parent);
  for (const selector of dialogs) assert.equal(h.root.querySelector(selector).open, false);
  assert.equal(h.root.querySelector('.workspace').dataset.stage, 'entrance');
  assert.match(h.root.querySelector('.erased-end').textContent, /no longer available/u);
  h.c.openSettings(); await tick(8); assert.equal(h.root.querySelector('dialog.settings').open, false);
  assert.equal(h.root.querySelector('.actor-role'), actor);
});
test('AIT-484 freezes the used-up composer and empties the question card in its held box', async t => {
  const h = fixture484(t, { host: { credits: true, usedUp: { newConversation: { enabled: true } } }, routes: {
    'GET /credits': () => Response.json({ exhausted: true, balance: { owner: { availableMicro: 0 } } }),
  } }); await h.reconnect();
  event470(h.c, 'turn.final', { id: 'question', role: 'assistant', content: 'Choose?', question_short: 'Choose?',
    inputRevision: inputRevision(h.c.session), options: [{ text: 'One' }, { text: 'Two' }] });
  const shell = h.root.querySelector('.composer-shell'), card = h.root.querySelector('.qcard');
  const panel = shell.hasAttribute('data-used-up'), hidden = card.hidden;
  h.streamErase(); await tick(8);
  assert.equal(shell.hasAttribute('data-used-up'), panel); assert.equal(card.hidden, hidden);
  assert.equal(card.textContent, ''); assert.equal(card.inert, true);
  assert.equal(h.root.querySelector('.composer-out').inert, true);
  assert.equal(h.root.querySelector('.composer-out__export').getAttribute('aria-disabled'), 'true');
  await quiet484(t, h);
});
for (const source of ['.purpose-new', '.composer-out__new']) test(`AIT-484 ${source} routes to the deleted action`, async t => {
  const h = fixture484(t, { host: { credits: true, usedUp: { newConversation: { enabled: true } } }, session: { credits: { status: 'ended', endReason: 'session' } } });
  await h.reconnect(); h.streamErase(); await tick(8);
  const button = h.root.querySelector(source); assert.ok(button); button.click(); await tick(8);
  assert.deepEqual(h.newEvents[0], { previousSessionId: 'conversation-a', reason: 'deleted', confirm: false });
});

test('AIT-484 configuring the current erased id preserves its mounted frozen view and repaints copy', async t => {
  const h = fixture484(t, { host: {}, session: { processingPreset: 'device', settings: { origin: 'chosen' } } }); await tick(8);
  h.serverErase(); event470(h.c, 'session.erased', { at: new Date().toISOString() }); await tick(8);
  const row = h.root.querySelector('.erased-end'), form = h.root.querySelector('form.composer'), stage = h.root.querySelector('.workspace').dataset.stage;
  h.c.configure({ session: h.c.session, copy: de, host: {} }); await tick(8);
  assert.equal(h.root.querySelector('.erased-end'), row, 'the erased row stays mounted for the same id');
  assert.equal(h.root.querySelector('form.composer'), form, 'the composer stays mounted for the same id');
  assert.equal(h.root.querySelector('.workspace').dataset.stage, stage);
  assert.equal(row.querySelector('[data-copy="conversationUnavailable"]').textContent, 'Dieses Gespräch ist nicht mehr verfügbar.');
  assert.equal(h.erasedEvents.length, 1); await quiet484(t, h);
});

function noErasedReads464(t, h) {
  const counts = `snapshot=${h.reads.snapshot}, consent=${h.reads.consent}`;
  t.diagnostic(`AIT-464 erased A reads: ${counts}`);
  assert.equal(h.reads.snapshot, 0, `erased A reads: ${counts}`);
  assert.equal(h.reads.consent, 0, `erased A consent reads: ${counts}`);
}
async function library464(t, kind, acknowledgementFirst = false) {
  const create = Promise.withResolvers(); t.after(() => create.resolve());
  const now = new Date().toISOString(), next = createSession({ id: 'conversation-b', demo: true }); next.featureMatrix = structuredClone(unlocked470);
  // Construct responses before holding them, just as a server would serialize them.
  const replacement = Response.json({ ...entry(next.id, '', now), session: next }, { status: 201 });
  const acknowledgement = Response.json({ id: 'conversation-a', erased: true });
  const h = fixture464(t, { host: { library: true }, routes: {
    'GET /library': () => Response.json({ items: [entry('conversation-a', 'Conversation A', now)], total: 1, offset: 0, limit: 100 }),
    'POST /library/conversation-a/delete': () => {
      if (!acknowledgementFirst) h.erase();
      return acknowledgement;
    },
    'POST /library/conversation-a/reset': () => { h.erase(); return create.promise.then(() => replacement); },
    'POST /library': () => create.promise.then(() => replacement),
  } });
  await tick(8);
  h.root.querySelector('.library-open-dialog').click(); await tick(8);
  h.root.querySelector(kind === 'reset' ? '.library-reset' : 'tr[data-key="conversation-a"] .library-delete').click();
  h.root.querySelector('.library-confirm').click(); await tick(8);
  if (acknowledgementFirst) { assert.ok(h.calls.some(call => call.method === 'POST' && call.path === '/library')); h.erase(); await tick(8); }
  assert.equal(h.c.session.id, 'conversation-a'); assert.ok(h.c.session.tombstone);
  const beforeReplacement = { ...h.reads };
  create.resolve(); await tick(8);
  assert.equal(h.c.session.id, 'conversation-b');
  const original = globalThis.fetch; let replacementReads = 0;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (String(url) === '/api/sessions/conversation-b' && (options?.method ?? 'GET') === 'GET') replacementReads++;
    return original(url, options);
  });
  event470(h.c, 'identity.state', verified470()); await tick(8);
  assert.equal(replacementReads, 1, 'B still reads its own snapshot after adoption');
  assert.deepEqual(h.reads, beforeReplacement, 'adoption and B activity never read A');
  noErasedReads464(t, h);
}
for (const kind of ['delete', 'reset']) test(`AIT-464 U1 ${kind}: library erasure never reads A and replacement B still refreshes`, async t => {
  await library464(t, kind);
});
test('AIT-464 U2: erasure and credit-denied callbacks never read A', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const matrix = structuredClone(locked470); matrix.best.text = { available: false, reason: 'budget denied' };
  const h = fixture464(t, { host: { credits: true }, session: { featureMatrix: matrix } }); await tick(8);
  h.erase(); await tick(8);
  assert.ok(h.c.session.tombstone); noErasedReads464(t, h);
});
test('AIT-464 U3: erasure silently cancels the consent window and every concept timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const h = fixture464(t), held = Promise.withResolvers(); t.after(() => held.resolve()); await tick(8);
  const armed = new Set();
  for (const kind of ['Timeout', 'Interval']) {
    const schedule = globalThis[`set${kind}`], clear = globalThis[`clear${kind}`];
    t.mock.method(globalThis, `set${kind}`, (fn, ms, ...args) => {
      const handle = schedule(() => { if (kind === 'Timeout') armed.delete(handle); fn(...args); }, ms);
      armed.add(handle); return handle;
    });
    t.mock.method(globalThis, `clear${kind}`, handle => { armed.delete(handle); return clear(handle); });
  }
  h.state.snapshot = () => { const response = Response.json(h.c.session); return held.promise.then(() => response); };
  event470(h.c, 'consent.revised', { granted: true, conversationUnchanged: true });
  assert.equal(h.calls.filter(call => call.method === 'GET' && call.path === '').length, 1, 'the pre-erasure consent read is in flight');
  h.erase(); await tick(8);
  assert.equal(armed.size, 0, 'no erased consent watchdog, retry or withdrawn notice remains armed');
  held.resolve(); await tick(8);
  for (const ms of [2000, 4000, 8000, 16000, 60000]) {
    t.mock.timers.tick(ms); await tick(8);
    assert.equal(armed.size, 0); noErasedReads464(t, h);
    assert.equal(h.root.querySelector('.concept-access').hasAttribute('data-refresh-failed'), false);
    assert.equal(h.root.querySelector('.concept-withdrawn').textContent, '');
  }
});
test('AIT-464 U4: live-call erasure and the closing voice state never read A', async t => {
  const h = fixture464(t, { voiceClient: await voice470(t) }); await tick(8);
  h.root.querySelector('.voice-start').click(); await tick(8);
  assert.equal(h.root.querySelector('.audio-rail').dataset.state, 'listening');
  h.erase();
  h.c.receive({ type: 'voice.state', data: { state: 'closing', callId: h.c.session.voiceLifecycle?.callId, providerSessionId: 'fixture-provider' } });
  await tick(8); noErasedReads464(t, h);
});
test('AIT-464 U5: delete acknowledgement before the erasure event never reads A', async t => {
  await library464(t, 'delete', true);
});
test('AIT-464 U6: erased stream reconnect 404s never read A through rail onEnd', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = fixture464(t, { voiceClient: await voice470(t) }); await tick(8);
  h.c.remove(); await tick(8);
  const original = globalThis.fetch; let streams = 0;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (String(url) === '/api/sessions/conversation-a/events') {
      if (++streams > 1) return Promise.resolve(new Response(null, { status: 404 }));
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        // The server refuses reads before its erasure event reaches the client.
        h.markErased();
        const event = { seq: h.c.session.seq + 1, type: 'session.erased', data: { at: new Date().toISOString() } };
        controller.enqueue(new TextEncoder().encode(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`));
        controller.close();
      } })));
    }
    return original(url, options);
  });
  document.body.append(h.c); await tick(8);
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(1000); await tick(8); }
  assert.equal(streams, 1, 'the erased stream is terminal and never reconnects');
  noErasedReads464(t, h);
});
test('AIT-464 positive U3: a non-erased 404 issues one read with no timer retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = fixture470(t); await tick(8); h.state.snapshot = () => new Response(null, { status: 404 });
  event470(h.c, 'identity.state', verified470()); await tick(8); assert.equal(h.reads, 1);
  t.mock.timers.tick(60_000); await tick(8); assert.equal(h.reads, 1); assert.equal(Boolean(h.c.session.tombstone), false);
});
test('AIT-464 positive U6: a non-erased 404 keeps the consent backoff and later repeats', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = fixture470(t); await tick(8); h.state.snapshot = () => new Response(null, { status: 404 });
  event470(h.c, 'consent.revised', { granted: true, conversationUnchanged: true }); await tick(8);
  for (const ms of [2000, 4000, 8000]) { t.mock.timers.tick(ms); await tick(8); }
  assert.equal(h.reads, 4); assert.equal(h.root.querySelector('.concept-access').hasAttribute('data-refresh-failed'), true);
  const held = Promise.withResolvers(); t.after(() => held.resolve());
  h.state.snapshot = () => { const response = Response.json({ ...h.c.session, featureMatrix: unlocked470 }); return held.promise.then(() => response); };
  event470(h.c, 'identity.state', verified470()); journal470(h.c);
  h.state.snapshot = () => Response.json({ ...h.c.session, featureMatrix: unlocked470 }); held.resolve(); await tick(8);
  assert.equal(h.reads, 6); clear470(h);
});
test('AIT-470 U13: generation drop repeats at the first call turn', async t => {
  const h = fixture470(t, { voiceClient: await voice470(t) }), held = Promise.withResolvers(); t.after(() => held.resolve()); await tick(8); userTurn(h.c);
  h.state.snapshot = () => { const response = Response.json({ ...h.c.session, featureMatrix: unlocked470 }); return held.promise.then(() => response); };
  event470(h.c, 'identity.state', verified470()); h.root.querySelector('.voice-start').click(); await tick(8);
  assert.equal(h.root.querySelector('.audio-rail').dataset.state, 'listening');
  held.resolve(); await tick(8); assert.equal(h.reads, 1);
  h.state.snapshot = () => Response.json({ ...h.c.session, featureMatrix: unlocked470 });
  userTurn(h.c, 'call-turn'); await tick(8); assert.equal(h.reads, 2); clear470(h);
});
test('AIT-470 U15: lifting verification repaints a paused draft line with actions still paused', async t => {
  const h = fixture470(t, { session: { paused: true } }); await tick(8);
  assert.ok(h.root.querySelector('.concept-activity-text').textContent.includes(en.reasons['verification required']));
  const matrix = structuredClone(unlocked470); matrix.best.images = { available: false, reason: 'session paused', unpaused: { available: true, reason: null } };
  h.state.snapshot = () => Response.json({ ...h.c.session, featureMatrix: matrix });
  event470(h.c, 'identity.state', verified470()); await tick(8); clear470(h); assert.equal(h.c.session.paused, true);
  assert.equal(h.root.querySelector('.concept-request').disabled, true);
});
test('AIT-470 U16: a 409 preserves an acknowledged voice Resume', async t => {
  const h = fixture470(t, { voiceClient: await voice470(t), session: { identity: verified470(), featureMatrix: structuredClone(unlocked470) } }); await tick(8);
  h.root.querySelector('.voice-start').click(); await tick(8);
  h.root.querySelector('.pause').click(); await tick(8); assert.equal(h.c.session.paused, true);
  h.state.snapshot = () => new Response(null, { status: 409 });
  h.root.querySelector('.pause').click(); await tick(8);
  assert.equal(h.c.session.paused, false); assert.equal(h.root.querySelector('.audio-rail').dataset.state, 'listening');
});

test('AIT-470 U16 waiting-call: a 409 cannot roll back the acknowledged Resume projection', async t => {
  const h = fixture470(t, { voiceClient: await voice470(t), session: {
    paused: true, identity: verified470(), featureMatrix: structuredClone(unlocked470),
    voiceLifecycle: { state: 'waiting', callId: 'held-call', providerSessionId: 'fixture-provider' },
  } });
  await tick(8); assert.equal(h.root.querySelector('.audio-rail').dataset.state, 'waiting');
  h.state.snapshot = () => new Response(null, { status: 409 });
  h.root.querySelector('.pause').click(); await tick(8);
  assert.equal(h.reads, 1, 'the acknowledged waiting-call Resume starts its confirming read');
  assert.equal(h.c.session.paused, false);
  assert.equal(h.root.querySelector('.audio-rail').dataset.state, 'listening');
});

test('AIT-470 U9 live consent: a poll-edge 409 reconnects while the consent window is live', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const held = Promise.withResolvers(); t.after(() => held.resolve()); let polls = 0, conflicts = 0;
  const h = fixture470(t, { session: { identity: pending470({ pollVerification: true }) }, routes: {
    'POST /identity/unlock': () => {
      polls++;
      // Start consent after the poll was sent, so its rescheduling cannot move the edge.
      h.state.snapshot = () => held.promise.then(() => Response.json(h.c.session));
      event470(h.c, 'consent.revised', { granted: true, conversationUnchanged: true });
      assert.equal(h.reads, 1, 'the live consent window owns an unfinished read');
      h.state.snapshot = () => { conflicts++; return new Response(null, { status: 409 }); };
      return Response.json({ identity: verified470() });
    } } });
  await tick(8);
  const original = globalThis.fetch; let streams = 0;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (String(url).endsWith('/events')) {
      streams++; h.state.snapshot = () => Response.json({ ...h.c.session, featureMatrix: unlocked470 });
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        const event = { seq: h.c.session.seq + 1, type: 'identity.state', data: verified470() };
        controller.enqueue(new TextEncoder().encode(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`));
        options.signal.addEventListener('abort', () => controller.close(), { once: true });
      } })));
    }
    return original(url, options);
  });
  t.mock.timers.tick(4000); await tick(8);
  assert.equal(polls, 1, 'the poll response reaches the live-window unlock edge');
  assert.equal(conflicts, 1, 'the edge read receives the injected conflict');
  assert.equal(streams, 1, 'the unlock-edge conflict reconnects even inside live consent');
  assert.equal(h.reads, 3); clear470(h);
  held.resolve(); await tick(8); t.mock.timers.tick(60_000); await tick(8);
  assert.equal(streams, 1); assert.equal(h.reads, 3);
});
