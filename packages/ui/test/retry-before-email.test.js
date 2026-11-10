import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inputRevision } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { reasonSeparator } from '../src/consent-line.js';
import { voiceEvents } from '../../core/src/live-voice.js';
import { tick, locked, pending, setup, userTurn } from './host-surface-helpers.js';

const deferred = () => Promise.withResolvers();
const matrix = (text = { available: true }, analysis = { available: false, reason: 'verification required' }) => ({ best: { text, analysis, voice: { available: true } } });
function fail(c, extra = {}) {
  const f = { inputRevision: inputRevision(c.session), lane: 'reaction', error: 'reasoning-unavailable', retryable: true, ...extra };
  c.receive({ type: 'lane.failed', data: f }); status(c, [], [f]); return f;
}
function status(c, running = [], failures = c.session.operations.failures) {
  c.receive({ type: 'lane.status', data: { inputRevision: inputRevision(c.session), running, failures, lastFailure: failures.at(-1) ?? null } });
}
const retries = calls => calls.filter(call => call.method === 'POST' && call.path === '/retry').length;
async function fixture(t, options = {}) {
  const h = setup(t, { host: { verification: true }, routes: { 'POST /retry': () => Response.json({}, { status: 202 }), ...options.routes },
    ...options, session: { identity: locked(), featureMatrix: matrix(), ...options.session } });
  await tick(8); userTurn(h.c); return h;
}
function inline(root, copy, disabled = false) {
  const retry = root.querySelector('.retry');
  assert.equal(retry.parentNode, root.querySelector('.reaction-failure'));
  assert.equal(retry.hidden, false); assert.equal(retry.disabled, false);
  assert.equal(retry.getAttribute('aria-disabled'), String(disabled));
  assert.equal(retry.textContent, copy.retry);
  assert.equal(root.querySelector('.reaction-failure-text').textContent, copy.reasoningFailed + reasonSeparator);
  assert.equal(root.querySelector('.overview-retry').hidden, true);
}
for (const copy of [en, de]) for (const identity of [locked(), pending()]) {
  const label = `${copy.display.locale}/${identity.status}`;
  test(`AIT-466 U1/U4 ${label}: first failed reply is reachable, runs and clears without unlocking`, async t => {
    const { c, root, calls } = await fixture(t, { copy, session: { identity } }); fail(c);
    inline(root, copy); assert.equal(root.querySelector('.readiness').inert, true);
    const retry = root.querySelector('.retry'); retry.click(); await tick();
    status(c, ['reaction', 'understanding']); inline(root, copy, true);
    assert.equal(retry.getAttribute('aria-busy'), 'true');
    c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'reply', role: 'assistant', content: 'Done.', inputRevision: inputRevision(c.session) } });
    status(c, [], []);
    assert.equal(root.querySelector('.reaction-failure').hidden, true);
    assert.equal(retry.parentNode, root.querySelector('.understanding > .foot'));
    assert.equal(retry.hidden, true); assert.equal(retry.hasAttribute('aria-disabled'), false); assert.equal(retry.hasAttribute('aria-busy'), false);
    assert.equal(root.querySelector('.readiness').inert, true); assert.equal(retries(calls), 1);
  });
  for (const immediate of [false, true]) test(`AIT-466 U2${immediate ? 'b' : ''} ${label}: double activation and acknowledgement before status`, async t => {
    const held = deferred();
    const { c, root, calls } = await fixture(t, { copy, session: { identity }, routes: {
      'POST /retry': async () => { if (!immediate) await held.promise; return Response.json({}, { status: 202 }); },
    } }); fail(c);
    const retry = root.querySelector('.retry'); retry.click(); if (immediate) await tick(); retry.click();
    inline(root, copy, true); assert.equal(retry.getAttribute('aria-busy'), 'true'); assert.equal(retries(calls), 1);
    held.resolve(); await tick(); retry.click(); assert.equal(retries(calls), 1);
    status(c, ['reaction']); inline(root, copy, true);
    fail(c); inline(root, copy); retry.click(); await tick(); assert.equal(retries(calls), 2);
  });
  for (const state of ['consent', 'pause', 'reconciling', 'running', 'purpose', 'call']) test(`AIT-466 U3 ${label}: ${state} keeps Retry in place and inert`, async t => {
    const session = { identity };
    if (state === 'consent' || state === 'reconciling') session.featureMatrix = matrix({ available: false, reason: state === 'consent' ? 'current processing consent required' : 'budget reconciling' });
    if (state === 'pause' || state === 'purpose') Object.assign(session, { paused: true, pauseReason: state === 'purpose' ? 'purpose' : 'manual' });
    if (state === 'call') session.voiceLifecycle = { callId: 'call', providerSessionId: 'p', epoch: 1, state: 'active' };
    const { c, root, calls } = await fixture(t, { copy, session, ...(state === 'call' ? { voiceClient: {} } : {}) }); fail(c);
    if (state === 'running') status(c, ['reaction']);
    inline(root, copy, true); root.querySelector('.retry').click(); await tick(); assert.equal(retries(calls), 0);
    if (state === 'running') assert.equal(root.querySelector('.retry').getAttribute('aria-busy'), 'true');
    if (state === 'call') for (const state of ['waiting', 'ended']) {
      c.receive({ type: 'voice.state', data: { callId: 'call', providerSessionId: 'p', epoch: 1, state } }); await tick(); inline(root, copy);
    }
  });
}

test('AIT-466 U3: this tab running call dims reply Retry', async t => {
  const events = voiceEvents();
  const voiceClient = { async start({ callId }) { return { callId, providerSessionId: 'local', events,
    async setInput() {}, async setOutput() {}, async updateContext() {}, async close() { events.end(); return { closureConfirmed: true }; } }; } };
  const { c, root, calls } = await fixture(t, { voiceClient, session: { settings: { origin: 'chosen', voice: 'off', visuals: 'off' } } });
  fail(c); inline(root, en);
  root.querySelector('.voice-start').click(); await tick(8);
  inline(root, en, true); root.querySelector('.retry').click(); await tick(); assert.equal(retries(calls), 0);
  root.querySelector('.voice-close').click(); await tick(8); inline(root, en);
});

test('AIT-466 U3 guards: non-retryable and used-up failures offer no activation', async t => {
  const { c, root, calls } = await fixture(t, { host: { verification: true, credits: true } });
  fail(c, { retryable: false }); assert.equal(root.querySelector('.retry').hidden, true); assert.equal(root.querySelector('.retry').hasAttribute('aria-disabled'), false);
  fail(c);
  c.receive({ seq: c.session.seq + 1, type: 'credits.limit-reached', data: { reason: 'session' } });
  const retry = root.querySelector('.retry'); assert.equal(retry.style.visibility, 'hidden'); assert.equal(retry.inert, true);
  assert.equal(root.querySelector('.reaction-failure-text').textContent, en.reasoningFailed); retry.click(); await tick(); assert.equal(retries(calls), 0);
});
test('AIT-466 U3 guard: already ended session never shows Retry', async t => {
  const { c, root } = await fixture(t, { host: { verification: true, credits: true }, session: { credits: { status: 'ended', endReason: 'session' } } });
  fail(c); assert.equal(root.querySelector('.retry').hidden, true);
});
test('AIT-466 U5: locked reconciliation polls admission but never automatically retries', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] }); let settled = false;
  const { c, root, calls } = await fixture(t, { session: { featureMatrix: matrix({ available: false, reason: 'budget reconciling' }) }, routes: {
    'GET ': () => Response.json({ ...c.session, featureMatrix: matrix({ available: settled, reason: settled ? null : 'budget reconciling' }) }),
    'POST /retry': () => Response.json({}, { status: 202 }),
  } }); fail(c, { reason: 'budget reconciling' }); inline(root, en, true); assert.equal(retries(calls), 0);
  settled = true; t.mock.timers.tick(15_001); await tick(12); inline(root, en); assert.equal(retries(calls), 0);
  root.querySelector('.retry').click(); await tick(); assert.equal(retries(calls), 1);
});
for (const reason of ['verification required', 'not configured']) test(`AIT-466 U7/U8: server verdict ${reason} without host surface`, async t => {
  const { c, root, calls } = await fixture(t, { host: {}, session: { identity: undefined, featureMatrix: matrix({ available: true }, { available: false, reason }) } });
  fail(c); inline(root, en); root.querySelector('.retry').click(); await tick(); assert.equal(retries(calls), 1);
});
test('AIT-466 N2: assessment becoming available keeps the reply slot and uses the live gate', async t => {
  let available = false;
  const { c, root, calls } = await fixture(t, { host: {}, session: { identity: undefined, featureMatrix: matrix({ available: true }, { available: false, reason: 'not configured' }) }, routes: {
    'GET ': () => Response.json({ ...c.session, featureMatrix: matrix({ available: true }, { available, reason: available ? null : 'not configured' }) }),
    'POST /retry': () => Response.json({}, { status: 202 }),
  } });
  fail(c); const retry = root.querySelector('.retry'); inline(root, en);
  available = true; c.receive({ type: 'voice.state', data: { state: 'ended' } }); await tick(8);
  assert.equal(c.session.featureMatrix.best.analysis.available, true);
  inline(root, en); assert.equal(root.querySelector('.reaction-failure > .retry'), retry);
  root.querySelector('.retry').click(); await tick(); assert.equal(retries(calls), 1);
});
test('AIT-466 N2 guard: unlocked reconciliation retains automatic recovery', async t => {
  const { c, root } = await fixture(t, { host: {}, session: { identity: undefined, featureMatrix: matrix({ available: false, reason: 'budget reconciling' }, { available: false, reason: 'budget reconciling' }) } });
  fail(c, { reason: 'budget reconciling' }); assert.equal(root.querySelector('.retry').hidden, true);
});
test('AIT-466 U9: newer shared failure survives the older acknowledgement', async t => {
  const held = deferred();
  const { c, root } = await fixture(t, { host: {}, session: { identity: undefined, featureMatrix: matrix({ available: true }, { available: true }) }, routes: {
    'POST /retry': async () => { await held.promise; return Response.json({}, { status: 202 }); },
  } });
  c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'reply', role: 'assistant', content: 'Done.', inputRevision: inputRevision(c.session) } });
  fail(c, { lane: 'understanding' }); root.querySelector('.overview-retry').click();
  fail(c, { lane: 'understanding' }); held.resolve(); await tick();
  assert.equal(root.querySelector('.notice').textContent, en.understandingFailed + reasonSeparator + en.understandingRetry);
});
test('AIT-466 U10 guard: available assessment keeps shared footer Retry', async t => {
  const { c, root, calls } = await fixture(t, { host: {}, session: { identity: undefined, featureMatrix: matrix({ available: true }, { available: true }) } });
  fail(c); const retry = root.querySelector('.retry');
  assert.equal(retry.parentNode, root.querySelector('.understanding > .foot')); assert.equal(retry.hasAttribute('aria-disabled'), false);
  retry.click(); await tick(); assert.equal(retries(calls), 1);
});

for (const state of ['active', 'waiting']) test(`AIT-466 U6: identity race Retry during ${state} call`, async t => {
  const { c, root, calls } = await fixture(t, { voiceClient: {}, session: { voiceLifecycle: { callId: 'race-call', providerSessionId: 'p', epoch: 1, state } } });
  fail(c, { reason: 'identity-changed' }); inline(root, en, state === 'active');
  root.querySelector('.retry').click(); await tick(); assert.equal(retries(calls), state === 'active' ? 0 : 1);
});
