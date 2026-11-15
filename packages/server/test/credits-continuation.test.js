import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCredits, reduceCredits, creditsView } from '@inspr/aithema-core';
import { SQLiteStorage } from '../src/storage.js';
import { createVoiceCap } from '../src/voice-cap.js';
import { createComposedVoice } from '../src/composed/server.js';
import { temporaryDb } from '../../../test/helpers.js';
import { createDemoHost } from '../../../demo/host-ports.js';
import { createHandlers, createPluginRuntime, mockPresets, SQLiteBudgetLedger } from '../src/index.js';
import { createConversationLimits } from '../src/conversation-limits.js';

const HOUR = 3_600_000, epoch = 1_800_000_000_000;
const step = (s, type, now, extra = {}) => reduceCredits(s, { type, now, ...extra });
test('AIT-508: untimed core guard survives elapsed hours, with pause and authoritative limits intact', () => {
  let s = step(createCredits({ sessionId: 'credits', conversationLimit: 'credits' }), 'start', epoch).state;
  assert.equal(s.timed, false); assert.equal(s.endsAt, null);
  s = step(s, 'tick', epoch + 2 * HOUR).state;
  assert.equal(s.status, 'active'); assert.equal(creditsView(s, epoch + 2 * HOUR).remainingMs, null);
  assert.equal(creditsView(s, epoch + 2 * HOUR).canStartPaidWork, true);
  s = step(s, 'pause', epoch + 2 * HOUR, { paused: true }).state;
  assert.equal(creditsView(s, s.lastNow).canStartPaidWork, false);
  s = step(s, 'limit', s.lastNow, { reason: 'session' }).state;
  assert.equal(s.status, 'ending'); assert.equal(s.endReason, 'session');
});
function fixture(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: epoch });
  const storage = new SQLiteStorage(), events = [];
  const limits = createConversationLimits({ storage, now: Date.now, publish: (id, e) => events.push({ id, ...e }) });
  t.after(() => { limits.close(); storage.close(); });
  const create = () => storage.create({ ownerToken: 'fixture-owner' }).id;
  return { storage, limits, events, create };
}
test('AIT-508: startup migrates ready and active guards before expiry, once; terminal guards stay export-only', t => {
  const f = fixture(t), ids = Object.fromEntries(['ready', 'active', 'ending', 'ended'].map(s => [s, f.create()]));
  for (const [status, id] of Object.entries(ids)) {
    f.storage.transitionCredits(id, undefined, { type: status === 'ready' ? 'tick' : 'start', now: epoch });
    if (['ending', 'ended'].includes(status)) f.storage.transitionCredits(id, undefined, { type: 'limit', reason: 'session', now: epoch });
    if (status === 'ended') f.storage.transitionCredits(id, undefined, { type: 'closed', now: epoch });
  }
  const terminals = ['ending', 'ended'].map(s => f.storage.creditState(ids[s]));
  t.mock.timers.tick(2 * HOUR);
  f.limits.configure({ conversationLimit: 'credits' }); f.limits.resume(); f.limits.resume();
  for (const status of ['ready', 'active']) {
    const id = ids[status], s = f.storage.creditState(id);
    assert.equal(s.status, status); assert.equal(s.timed, false); assert.equal(s.endsAt, null);
    assert.equal(f.storage.read(id).filter(e => e.type === 'credits.guard-migrated').length, 1);
    assert.equal(f.limits.reason(id), null); assert.doesNotThrow(() => f.limits.assertOpen(id));
  }
  assert.deepEqual(['ending', 'ended'].map(s => f.storage.creditState(ids[s])), terminals);
  for (const status of ['ending', 'ended']) assert.throws(() => f.limits.assertOpen(ids[status]), { code: 'not-admitted' });
  f.limits.configure({ conversationLimit: 'time' }); f.limits.resume();
  assert.equal(f.limits.start(ids.ready).endsAt, null);
  const fresh = f.create(); assert.equal(f.limits.start(fresh).endsAt, Date.now() + HOUR);
});
test('AIT-508: credits policy admits a new untimed guard and never arms an elapsed deadline', t => {
  const f = fixture(t), id = f.create(); f.limits.configure({ conversationLimit: 'credits' });
  f.limits.start(id); t.mock.timers.tick(2 * HOUR); f.limits.resume();
  assert.equal(f.storage.creditState(id).status, 'active'); assert.equal(f.limits.deadline(id), Infinity);
  assert.equal(f.limits.reason(id), null); assert.doesNotThrow(() => f.limits.assertOpen(id));
  assert.equal(f.storage.get(id).credits.remainingMs, null);
  assert.equal(f.events.some(e => e.type === 'conversation.end-requested'), false);
});
test('AIT-508: unknown conversation policy fails closed', t => {
  const f = fixture(t);
  assert.throws(() => f.limits.configure({ conversationLimit: 'forever' }), TypeError);
  assert.throws(() => createCredits({ sessionId: 's', conversationLimit: 'forever' }), TypeError);
});

for (const hold of ['paused', 'waiting']) test(`AIT-508: composed idle ${hold} settles its parent and releases the duration hold`, async t => {
  let call; t.after(() => call?.close());
  const f = fixture(t), id = f.create(), reports = [];
  const cap = createVoiceCap({ storage: f.storage, now: Date.now });
  const reservation = cap.reserve({ sessionId: id, callId: 'idle-call', attemptId: 'idle-parent', maxMilliseconds: 900_000 });
  const plugin = createComposedVoice({ enabled: true, storage: f.storage, now: Date.now,
    stt: { stream() {} }, tts: { speak() {} }, replyExecutor: { execute() {} },
    authorize: async () => true, commitUtterance: async () => {}, admitComponent: async () => {} });
  call = await plugin.start({ sessionId: id, callId: 'idle-call', ownerToken: 'fixture-owner' }, {
    conversationLimit: 'credits', now: Date.now, deadlineAt: Date.now() + 5000, spendDeadlineAt: Date.now() + 900_000,
    browserLivenessDeadlineAt: Date.now() + (hold === 'waiting' ? 30_000 : 900_000),
    attempt: { attemptId: 'idle-parent', claimId: 'idle-claim', maxMicro: 0, consume() {} },
    report(terminal) { reports.push(terminal); if (terminal.closureConfirmed) cap.settle(reservation, terminal.usage.providerSeconds); },
  });
  if (hold === 'paused') await call.pause();
  assert.equal(cap.snapshot().reservedMilliseconds, 900_000);
  t.mock.timers.tick(120_000);
  for (let i = 0; i < 12; i++) await new Promise(setImmediate);
  assert.equal(call.state.state, 'ended'); assert.equal(call.snapshot().reason, 'idle');
  assert.equal(reports.length, 1); assert.equal(reports[0].closureConfirmed, true);
  assert.equal(cap.snapshot().reservedMilliseconds, 0); assert.equal(cap.snapshot().spentMilliseconds, 120_000);
  await call.close(); assert.equal(reports.length, 1);
});

test('AIT-508: persisted active guard migrates after downtime and stays untimed after downgrade restart', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: epoch });
  const path = await temporaryDb(); let storage, limits;
  t.after(() => { limits?.close(); storage?.close(); });
  storage = new SQLiteStorage(path); limits = createConversationLimits({ storage, now: Date.now });
  const id = storage.create({ ownerToken: 'fixture-owner' }).id; limits.start(id);
  limits.close(); storage.close(); t.mock.timers.tick(2 * HOUR);
  storage = new SQLiteStorage(path); limits = createConversationLimits({ storage, now: Date.now });
  limits.configure({ conversationLimit: 'credits' }); limits.resume();
  assert.equal(storage.creditState(id).timed, false); assert.equal(storage.creditState(id).status, 'active');
  limits.close(); storage.close(); t.mock.timers.tick(HOUR);
  storage = new SQLiteStorage(path); limits = createConversationLimits({ storage, now: Date.now }); limits.resume();
  assert.doesNotThrow(() => limits.assertOpen(id)); assert.equal(limits.deadline(id), Infinity);
  assert.equal(storage.read(id).filter(e => e.type === 'credits.guard-migrated').length, 1);
});
test('AIT-508: opted-in host accepts text after two hours with the same conversation and credits', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: epoch });
  const storage = new SQLiteStorage(), now = Date.now;
  const host = { ...createDemoHost({ storage, now, ownerGuard: false }), conversationLimit: 'credits' };
  const consent = { coverage: ({ scope, consentRevision }) => ({ covered: true, ...scope, scope, consentRevision, checkedAt: now(), expiresAt: now() + 60_000 }) };
  const runtime = createPluginRuntime({ storage, now, consent, presets: mockPresets() });
  const handlers = createHandlers({ storage, host, consent, pluginRuntime: runtime, log() {} });
  t.after(async () => { await handlers.close(); storage.close(); });
  const call = (path, body) => handlers.handle(new Request(`http://local${path}`, { method: 'POST',
    headers: { 'x-aithema-session-token': 'fixture-owner' }, body: JSON.stringify(body) }));
  const session = await (await call('/api/sessions', {})).json();
  for (const [index, content] of ['Initial requirements', 'Continue after the idle tab'].entries()) {
    if (index) t.mock.timers.tick(2 * HOUR);
    assert.equal((await call(`/api/sessions/${session.id}/turns`, { clientEventId: `turn-${index}`, content })).status, 200);
    await handlers.idle();
  }
  const current = storage.get(session.id);
  assert.equal(current.credits.status, 'active'); assert.equal(current.credits.remainingMs, null);
  assert.equal(current.transcript.filter(t => t.role === 'user').length, 2);
  assert.equal(storage.read(session.id).some(e => e.type === 'conversation.end-requested'), false);
});

for (const voiceIdleSeconds of [59, 3601, 120.5, null, '120']) test(`AIT-508: host idle option rejects ${voiceIdleSeconds} at startup`, t => {
  let handlers; t.after(() => handlers?.close());
  const f = fixture(t), consent = { coverage: () => ({ covered: false }) };
  const runtime = createPluginRuntime({ storage: f.storage, now: Date.now, consent, presets: mockPresets() });
  assert.throws(() => { handlers = createHandlers({ storage: f.storage, pluginRuntime: runtime,
    host: { voiceIdleSeconds }, consent, log() {} }); }, TypeError);
});


test('AIT-508: ledger admission excludes another unresolved logical call while allowing same-call recovery', t => {
  const f = fixture(t), sessionId = f.create();
  f.storage.transitionCredits(sessionId, undefined, { type: 'start', now: Date.now() }, { conversationLimit: 'credits' });
  const budget = new SQLiteBudgetLedger(f.storage, { now: Date.now });
  const reserve = (attemptId, callId) => budget.admit({ attemptId, sessionId, lane: 'voice', maxMicro: 1,
    requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64),
    voiceEstimate: { upstreamMicroPerMinute: 1, visitorMicroPerMinute: 0, callId } });
  const first = reserve('first-segment', 'first-call');
  const repair = reserve('repair-segment', 'first-call');
  assert.throws(() => reserve('next-segment', 'next-call'), { code: 'not-admitted', message: 'budget reconciling' });
  for (const admission of [first, repair]) {
    const claim = budget.claim(admission.attemptId);
    budget.settleVoice(claim.claimId, { attemptId: admission.attemptId, outcome: 'cancelled', closureConfirmed: true, chargedMicro: 0,
      usage: { providerSeconds: 0, providerMinutes: 0, pausedSeconds: 0, visitorSeconds: 0, upstreamMicro: 0, visitorMicro: 0 } });
  }
  assert.doesNotThrow(() => reserve('settled-next-segment', 'next-call'));
});
