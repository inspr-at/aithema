// AIT-298: focused unit workers keep cumulative DOM work within the unchanged
// three-minute file deadline under merge-group CPU contention.
// AIT-621: split from host-credits.test.js (with host-credits-tiers.test.js) so
// each half stays well inside that deadline on the CI runner. Voice admission,
// full-hold, top-up recovery and polling flows (AIT-155, AIT-135 A2 fix 1/2 and
// round 2, AIT-138, AIT-508).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { tick, balance, setup, a2Setup } from './host-surface-helpers.js';

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
  assert.equal(f.root.querySelector('.voice-state').textContent, copy.voiceCreditStatus.hostLimit);
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

test('AIT-508 B5: a settled ledger receipt refreshes a voice-only reconciling verdict after call end', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 });
  const { voiceEvents } = await import('../../core/src/live-voice.js');
  const events = voiceEvents(); let settled = false, closing = false, callId;
  const matrix = () => ({ best: { text: { available: true }, analysis: { available: true },
    voice: closing && !settled ? { available: false, reason: 'budget reconciling' } : { available: true } } });
  const f = setup(t, { host: { credits: true }, session: { featureMatrix: matrix() }, voiceClient: {
    async start(request) { callId = request.callId; return { callId, providerSessionId: 'settling-provider', events,
      async setInput() {}, async setOutput() {}, async updateContext() {},
      async close() { closing = true; events.end(); return { closureConfirmed: false }; } }; },
  }, routes: {
    'GET /credits': () => Response.json({ balance, exhausted: false, reconciling: closing && !settled, limitSlot: null }),
    'GET ': () => Response.json({ ...f.c.session, featureMatrix: matrix() }),
  } });
  await tick(8); f.root.querySelector('.voice-start').click(); await tick(8);
  assert.equal(f.root.querySelector('.audio-rail').dataset.state, 'listening');
  f.root.querySelector('.voice-close').click(); await tick(12);
  f.c.receive({ type: 'voice.state', data: { callId, providerSessionId: 'settling-provider', state: 'ended', reason: 'idle' } });
  t.mock.timers.tick(301); await tick(12);
  assert.equal(f.c.session.featureMatrix.best.voice.reason, 'budget reconciling');
  assert.equal(f.root.querySelector('.voice-start').disabled, true);
  const before = f.calls.filter(call => call.path === '').length;
  settled = true;
  f.c.receive({ seq: f.c.session.seq + 1, type: 'credits.state', data: { status: 'active', endReason: null } });
  t.mock.timers.tick(301); await tick(16);
  assert.ok(f.calls.filter(call => call.path === '').length > before, 'confirmed settlement re-reads availability without a tier change');
  assert.equal(f.c.session.featureMatrix.best.voice.available, true);
  assert.equal(f.root.querySelector('.voice-start').disabled, false);
});
