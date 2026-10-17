// AIT-298: focused unit workers keep cumulative DOM work within the unchanged
// three-minute file deadline under merge-group CPU contention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, inputRevision, reduceUnderstanding } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { hostStyles } from '../src/host-styles.js';
import { window, tick, v, l, h, cr, identity, locked, pending, entry, balance, setup, userTurn, a2Setup, a2Allowances } from './host-surface-helpers.js';

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
  // Normal overview preservation includes a reply; missing reply + idle lanes is AIT-198's stuck state.
  c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'overview-reply', role: 'assistant', content: 'Which orders?', inputRevision: inputRevision(c.session) } });
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
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { voiceEvents } = await import('../../core/src/live-voice.js');
  const read = Promise.withResolvers(), started = Promise.withResolvers();
  let reconciling = false, delay = false, callsStarted = 0, firstCallId;
  const voiceClient = { async start({ callId }) {
    callsStarted++; firstCallId ??= callId; const events = voiceEvents();
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
  t.mock.timers.tick(15_001); await tick(8);
  assert.equal(root.querySelector('.audio-rail').dataset.call, 'active');
  const callId = firstCallId;
  root.querySelector('.voice-close').click(); await tick(8);
  reconciling = true;
  c.receive({ type: 'voice.state', data: { callId, providerSessionId: 'outage-1', state: 'closing' } });
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

for (const copy of [de, en]) for (const assessed of [false, true]) test(`AIT-186 F6: session pause appears once and preserves overview and connection (${copy === de ? 'de' : 'en'}, assessed ${assessed})`, async t => {
  const { c, root } = setup(t, { copy, host: {}, voiceClient: {} }); await tick(8); userTurn(c);
  // Normal overview preservation includes a reply; missing reply + idle lanes is AIT-198's stuck state.
  c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'overview-reply', role: 'assistant', content: 'Which orders?', inputRevision: inputRevision(c.session) } });
  if (assessed) c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: reduceUnderstanding(c.session.understanding,
    { summary: copy === de ? 'Eine Vorbestell-App' : 'A preorder app', signals: ['Orders'], openQuestions: ['When?'], readinessAssessed: true },
    { transcript: c.session.transcript, inputRevision: inputRevision(c.session) }) });
  const before = { notice: root.querySelector('.notice').textContent, summary: root.querySelector('.summary-text').textContent,
    sections: [...root.querySelectorAll('.analysis-content section')].map(n => n.hidden), connection: root.querySelector('.status__label').textContent };
  c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true } }); await tick(8);
  assert.equal(root.querySelector('.composer-reason').textContent, copy.paused);
  assert.equal(root.querySelector('.notice').textContent, before.notice);
  assert.equal(root.querySelector('.summary-text').textContent, before.summary);
  assert.deepEqual([...root.querySelectorAll('.analysis-content section')].map(n => n.hidden), before.sections);
  assert.equal(root.querySelector('.status__label').textContent, before.connection);
  assert.equal(root.querySelector('.status').hasAttribute('data-message'), false);
  assert.equal(root.querySelector('.pause').title, copy.resume);
  assert.equal(root.querySelector('.pause').disabled, false);
});

for (const copy of [de, en]) for (const lostTerminal of [false, true]) test(`AIT-186 F2 r2: ${lostTerminal ? 'lost terminal fast settle' : 'first post-hangup read already false'} (${copy === de ? 'de' : 'en'})`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { voiceEvents } = await import('../../core/src/live-voice.js');
  let identity;
  const voiceClient = { async start({ callId }) {
    identity = { callId, providerSessionId: 'fast-settle' }; const events = voiceEvents();
    return { ...identity, events, async setInput() {}, async setOutput() {}, async updateContext() {},
      async close() { events.end(); if (lostTerminal) throw new Error('terminal lost');
        return { closureConfirmed: false, reconciliationPending: true }; } };
  } };
  const { c, root, calls } = setup(t, { copy, voiceClient, host: { credits: true },
    session: { featureMatrix: { best: { text: { available: true }, analysis: { available: true }, voice: { available: true } } } },
    routes: { 'GET /credits': () => Response.json({ balance, exhausted: false, reconciling: false }) } });
  await tick(8); root.querySelector('.voice-start').click(); await tick(8);
  t.mock.timers.tick(15_000); await tick(8);
  assert.equal(root.querySelector('.voice-state').textContent, copy.voiceStates.listening, 'a false live read changes nothing');
  root.querySelector('.voice-close').click(); await tick(8);
  const label = root.querySelector('.voice-state'); let endedAnnouncements = 0;
  const observer = new window.MutationObserver(() => { if (label.textContent === copy.voiceEnded) endedAnnouncements++; });
  observer.observe(label, { childList: true, characterData: true, subtree: true }); t.after(() => observer.disconnect());
  // Local hangup alone cannot qualify a receipt; the read must follow durable closing/ended.
  t.mock.timers.tick(15_000); await tick(8);
  assert.equal(label.textContent, copy.voiceClosureUncertain);
  c.receive({ type: 'voice.state', data: { ...identity, state: lostTerminal ? 'ended' : 'closing' } });
  t.mock.timers.tick(300); await tick(12);
  assert.equal(label.textContent, copy.voiceEnded);
  assert.equal(root.querySelector('.audio-rail').hasAttribute('data-call-reconciling'), false);
  assert.equal(endedAnnouncements, 1, 'Anruf beendet. is announced exactly once');
  c.receive({ type: 'voice.state', data: { ...identity, state: 'ended' } });
  t.mock.timers.tick(300); await tick(12);
  assert.equal(endedAnnouncements, 1, 'duplicate lifecycle and ledger receipts cannot reannounce');
  const reads = calls.filter(call => call.path === '/credits').length;
  t.mock.timers.tick(60_000); await tick(8);
  assert.equal(calls.filter(call => call.path === '/credits').length, reads, 'settlement stops polling');
});

for (const copy of [de, en]) test(`AIT-186 F2 r2: false read begun before durable closing is fenced (${copy === de ? 'de' : 'en'})`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { voiceEvents } = await import('../../core/src/live-voice.js');
  const read = Promise.withResolvers(); let identity, delay = false;
  const voiceClient = { async start({ callId }) {
    identity = { callId, providerSessionId: 'pre-closing' }; const events = voiceEvents();
    return { ...identity, events, async setInput() {}, async setOutput() {}, async updateContext() {},
      async close() { events.end(); throw new Error('terminal lost'); } };
  } };
  const { c, root, calls } = setup(t, { copy, voiceClient, host: { credits: true },
    session: { featureMatrix: { best: { text: { available: true }, analysis: { available: true }, voice: { available: true } } } },
    routes: { 'GET /credits': async () => { if (delay) await read.promise; return Response.json({ balance, exhausted: false, reconciling: false }); } } });
  t.after(() => read.resolve());
  await tick(8); root.querySelector('.voice-start').click(); await tick(8);
  root.querySelector('.voice-close').click(); await tick(8);
  delay = true; const before = calls.filter(call => call.path === '/credits').length;
  t.mock.timers.tick(15_000); await tick(8);
  assert.equal(calls.filter(call => call.path === '/credits').length, before + 1, 'an ended unsettled call keeps polling');
  c.receive({ type: 'voice.state', data: { ...identity, state: 'closing' } });
  read.resolve(); await tick(12);
  assert.equal(root.querySelector('.voice-state').textContent, copy.voiceClosureUncertain, 'pre-closing read cannot settle');
  delay = false; t.mock.timers.tick(300); await tick(12);
  assert.equal(root.querySelector('.voice-state').textContent, copy.voiceEnded);
});

for (const copy of [de, en]) test(`AIT-186 F6 r2: purpose pause before assessment keeps AIT-174 readiness hidden (${copy === de ? 'de' : 'en'})`, async t => {
  const { c, root } = setup(t, { copy, host: {} }); await tick(8); userTurn(c);
  assert.equal(c.session.understanding.inputRevision, null);
  c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true, reason: 'purpose' } }); await tick(8);
  assert.equal(root.querySelector('.readiness').style.visibility, 'hidden');
  assert.equal(root.querySelector('.purpose-pause-copy').hidden, false);
  assert.equal(root.querySelector('.status__label').textContent, copy.connected);
});

