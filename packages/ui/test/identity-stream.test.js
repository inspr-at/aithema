import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, inputRevision } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
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
test('AIT-464 U3: an erased consent window fails closed at its watchdog without reads or backoff reads', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = fixture464(t), held = Promise.withResolvers(); t.after(() => held.resolve()); await tick(8);
  const armed = new Map(), scheduledAfterWatchdog = [], firedAfterWatchdog = [];
  let watching = false;
  // Observe the public timer surface, including handles that never fire or re-arm.
  for (const kind of ['Timeout', 'Interval']) {
    const schedule = globalThis[`set${kind}`], clear = globalThis[`clear${kind}`];
    t.mock.method(globalThis, `set${kind}`, (callback, delay, ...args) => {
      const timer = { kind, delay };
      const handle = schedule(function (...values) {
        if (kind === 'Timeout') armed.delete(handle);
        if (watching) firedAfterWatchdog.push(timer);
        return callback.apply(this, values);
      }, delay, ...args);
      armed.set(handle, timer);
      if (watching) scheduledAfterWatchdog.push(timer);
      return handle;
    });
    t.mock.method(globalThis, `clear${kind}`, handle => { armed.delete(handle); return clear(handle); });
  }
  h.state.snapshot = () => { const response = Response.json(h.c.session); return held.promise.then(() => response); };
  event470(h.c, 'consent.revised', { granted: true, conversationUnchanged: true });
  assert.equal(h.calls.filter(call => call.method === 'GET' && call.path === '').length, 1, 'the pre-erasure consent read is in flight');
  h.erase(); await tick(8);
  assert.deepEqual([...armed.values()], [{ kind: 'Timeout', delay: 2000 }, { kind: 'Timeout', delay: 4000 }],
    'the original watchdog and withdrawal notice remain armed until the watchdog fails closed');
  watching = true;
  t.mock.timers.tick(2000); await tick(8);
  assert.equal(h.root.querySelector('.concept-access').hasAttribute('data-refresh-failed'), true);
  const expectedRetry = [{ kind: 'Timeout', delay: 2000 }];
  assert.deepEqual(scheduledAfterWatchdog, expectedRetry, 'the watchdog arms exactly one consent-failure retry');
  assert.deepEqual([...armed.values()], expectedRetry, 'only that one retry remains armed');
  const watchdogReads = { ...h.reads };
  for (const ms of [4000, 8000]) { t.mock.timers.tick(ms); await tick(8); }
  const assertQuiescent = () => {
    assert.deepEqual(scheduledAfterWatchdog, expectedRetry, 'no timeout or interval re-arms after the one retry');
    assert.equal(armed.size, 0, 'no timer stays armed for the erased consent window');
    assert.equal(h.root.querySelector('.concept-access').hasAttribute('data-refresh-failed'), true);
    noErasedReads464(t, h);
  };
  assertQuiescent();
  for (const ms of [16_000, 60_000]) { t.mock.timers.tick(ms); await tick(8); assertQuiescent(); }
  noErasedReads464(t, h);
  assert.deepEqual(watchdogReads, { snapshot: 0, consent: 0 }, 'the 2 s watchdog also sends no read');
  held.resolve(); await tick(8); noErasedReads464(t, h);
  assertQuiescent();
  journal470(h.c); await tick(8);
  assertQuiescent();
  assert.deepEqual(firedAfterWatchdog, [...expectedRetry, ...expectedRetry], 'only the original watchdog and its one retry fire');
  t.diagnostic('AIT-464 U3: post-watchdog timers scheduled=1, remaining=0; late read completion and journal event add no read or timer');
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
  assert.equal(streams, 4, 'one erased stream and three genuine reconnect 404s');
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
