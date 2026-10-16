import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createHandlers, createPluginRuntime, mockPresets } from '../src/index.js';
import { createDemoHost } from '../../../demo/host-ports.js';
import { temporaryDb } from '../../../test/helpers.js';
import { request } from '../../../test/plugin-fixtures.js';

const HOUR = 60 * 60_000, epoch = 1_800_000_000_000, owner = 'deadline-owner';
function fixture(t, { path, at = epoch, ownerGuard = false } = {}) {
  let time = at;
  const storage = new SQLiteStorage(path), now = () => time;
  const host = createDemoHost({ storage, now, ownerGuard, demoBypass: true });
  const consent = { coverage: ({ scope, consentRevision }) => ({ covered: true, ...scope, scope, consentRevision, checkedAt: time, expiresAt: time + 60_000 }) };
  const runtime = createPluginRuntime({ storage, now, consent, presets: mockPresets() });
  const handlers = createHandlers({ storage, host, pluginRuntime: runtime, consent, log() {} });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await handlers.close(); storage.close(); } };
  t.after(close);
  const call = (path, body) => handlers.handle(new Request(`http://local${path}`, {
    headers: { 'x-aithema-session-token': owner }, method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const create = async () => (await call('/api/sessions', {})).json();
  const turn = (id, name = 'start') => call(`/api/sessions/${id}/turns`, { clientEventId: name, content: 'A requirements conversation.' });
  const advance = async ms => { time += ms; t.mock.timers.tick(ms); await new Promise(setImmediate); };
  return { storage, runtime, host, handlers, call, create, turn, close, advance, at: value => { time = value; } };
}
const terminal = (f, id) => f.storage.read(id).filter(e => ['credits.limit-reached', 'conversation.end-requested'].includes(e.type));
function assertEnded(f, id) {
  const events = terminal(f, id);
  assert.deepEqual(events.map(e => [e.type, e.data.reason]), [
    ['credits.limit-reached', 'one-hour'], ['conversation.end-requested', 'one-hour'],
  ]);
  assert.equal(events[1].data.preserveTranscript, true);
  assert.equal(events[1].data.settleOutstanding, true);
}

test('AIT-261 negative: text after the hour cannot admit another reply or understanding', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t), s = await f.create();
  await f.turn(s.id); await f.handlers.idle();
  const count = () => f.storage.db.prepare('SELECT COUNT(*) n FROM budget_attempts').get().n;
  const before = count();
  await f.advance(HOUR);
  await f.turn(s.id, 'too-late'); await f.handlers.idle();
  assert.equal(count(), before, 'the late text must not reserve another attempt');
  for (const lane of ['reaction', 'understanding']) await assert.rejects(f.runtime.admit({
    session: f.storage.get(s.id), lane, operation: lane === 'reaction' ? 'stream' : 'structured', request,
  }), { code: 'not-admitted', message: 'one-hour' });
  assertEnded(f, s.id);
});

test('AIT-261: idle deadline fires without any later credit/read/turn event, once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t), s = await f.create(); await f.turn(s.id); await f.handlers.idle();
  await f.advance(HOUR - 1); assert.equal(terminal(f, s.id).length, 0);
  await f.advance(1); assertEnded(f, s.id);
  await f.advance(HOUR); assertEnded(f, s.id);
});

for (const expired of [false, true]) test(`AIT-261: durable restart ${expired ? 'after expiry fires immediately' : 'before expiry keeps the original deadline'}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const path = await temporaryDb(t), f = fixture(t, { path }), s = await f.create();
  await f.turn(s.id); await f.handlers.idle(); await f.close();
  const restarted = fixture(t, { path, at: epoch + (expired ? HOUR + 1 : HOUR - 100) });
  await restarted.handlers.resume(); await restarted.handlers.idle();
  if (!expired) {
    assert.equal(terminal(restarted, s.id).length, 0);
    await restarted.advance(99); assert.equal(terminal(restarted, s.id).length, 0);
    await restarted.advance(1);
  }
  assertEnded(restarted, s.id);
  assert.equal(restarted.storage.get(s.id).credits.remainingMs, 0);
  await restarted.handlers.resume(); assertEnded(restarted, s.id);
});

test('AIT-261: admitted text retains its reservation through expiry and settles actual or unknown usage', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t), s = await f.create(); await f.turn(s.id); await f.handlers.idle();
  const admitted = [];
  for (const suffix of ['actual', 'unknown']) {
    const { attemptId } = f.runtime.budget.admit({ sessionId: s.id, lane: 'reaction', maxMicro: 123,
      requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
    const claim = f.runtime.budget.claim(attemptId); claim.consume(); admitted.push({ suffix, attemptId, claim });
  }
  await f.advance(HOUR); assertEnded(f, s.id);
  for (const a of admitted) assert.equal(f.runtime.budget.get(a.attemptId).state, 'dispatched');
  assert.equal(f.runtime.budget.breakdown(s.id).reservedMicro, 246);
  for (const a of admitted) f.runtime.budget.settle(a.claim.claimId, { attemptId: a.attemptId,
    outcome: a.suffix === 'actual' ? 'completed' : 'uncertain',
    ...(a.suffix === 'actual' ? { usage: { inputTokens: 5, outputTokens: 6 } } : {}),
  }, { inputMicro: 1, outputMicro: 1 });
  assert.equal(f.runtime.budget.get(admitted[0].attemptId).settled_micro, 11);
  assert.equal(f.runtime.budget.get(admitted[1].attemptId).settled_micro, 123);
});

test('AIT-261: New/reset have independent deadlines; reconnect and another conversation do not rebind them', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t), first = await f.create(); await f.turn(first.id); await f.handlers.idle();
  await f.advance(HOUR - 100);
  const second = await f.create(); await f.turn(second.id); await f.handlers.idle();
  await f.call(`/api/sessions/${first.id}`); await f.handlers.resume(); await f.handlers.idle();
  await f.advance(100); assertEnded(f, first.id); assert.equal(terminal(f, second.id).length, 0);
  const reset = await (await f.call(`/api/library/${first.id}/reset`, {})).json();
  await f.turn(reset.id); await f.handlers.idle();
  assert.equal(f.storage.get(reset.id).credits.remainingMs, HOUR);
  await f.advance(HOUR - 100); assertEnded(f, second.id); assert.equal(terminal(f, reset.id).length, 0);
  await f.advance(100); assertEnded(f, reset.id);
});

// Do not tick the timer: these exercise the synchronous admission gate even
// when the event loop has not delivered the scheduled callback yet.
test('AIT-261: delayed timer still refuses text and concept admission before wallet or ledger', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t), s = await f.create(); await f.turn(s.id); await f.handlers.idle();
  const wallet = t.mock.fn(() => { throw new Error('must not consult wallet'); });
  f.runtime.setOwnerWallet(wallet); f.at(epoch + HOUR);
  for (const lane of ['reaction', 'understanding', 'concept']) await assert.rejects(f.runtime.admit({
    session: f.storage.get(s.id), lane, operation: lane === 'reaction' ? 'stream' : lane === 'concept' ? 'generate' : 'structured', request,
  }), { code: 'not-admitted', message: 'one-hour' });
  assert.equal(wallet.mock.callCount(), 0); assertEnded(f, s.id);
});

test('AIT-261: expiry during wallet admission refuses the ledger reservation and keeps the owner hold', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t), s = await f.create(); await f.turn(s.id); await f.handlers.idle();
  const wallet = f.host.wallet(owner), admitted = wallet.admit, release = t.mock.fn(wallet.release);
  const holds = [];
  f.runtime.setOwnerWallet(() => ({ ...wallet, release, async admit(value) {
    holds.push(value); const result = await admitted(value); f.at(epoch + HOUR); return result;
  } }));
  const count = f.storage.db.prepare('SELECT COUNT(*) n FROM budget_attempts').get().n;
  await assert.rejects(f.runtime.admit({ session: f.storage.get(s.id), lane: 'reaction', operation: 'stream', request }),
    { code: 'not-admitted', message: 'one-hour' });
  assert.equal(holds.length, 1); assert.equal(release.mock.callCount(), 0);
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) n FROM budget_attempts').get().n, count);
  assert.equal(f.storage.db.prepare('SELECT released FROM owner_wallet_reservations WHERE attempt_id=?').get(holds[0].attemptId).released, 0);
  assertEnded(f, s.id);
});

test('AIT-261: an admitted but undispatched operation cannot spend after expiry or zero its held maximum', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t), s = await f.create(); await f.turn(s.id); await f.handlers.idle();
  const admitted = await f.runtime.admit({ session: f.storage.get(s.id), lane: 'reaction', operation: 'stream', request });
  const id = admitted.options.attempt.attemptId;
  await f.advance(HOUR);
  await assert.rejects(async () => admitted.options.attempt.consume(), { code: 'not-admitted', message: 'one-hour' });
  assert.equal(f.runtime.budget.get(id).state, 'claimed');
  admitted.options.report({ attemptId: id, outcome: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } });
  admitted.finish({ failed: true });
  assert.equal(f.runtime.budget.get(id).outcome, 'uncertain');
});

test('AIT-261: legacy owner guard recovery keeps the exact deadline on its original conversation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { createCredits, reduceCredits } = await import('@inspr/aithema-core');
  const path = await temporaryDb(), f = fixture(t, { path }), original = await f.create(), other = await f.create();
  const guard = reduceCredits(createCredits({ sessionId: original.id }), { type: 'start', now: epoch }).state;
  f.storage.db.prepare('INSERT INTO owner_credit_guards VALUES (?,?)').run(f.storage.get(original.id).ownerHash, JSON.stringify(guard));
  await f.close();
  const restored = fixture(t, { path, at: epoch + HOUR });
  await restored.handlers.resume(); await restored.handlers.idle();
  assert.equal(restored.storage.creditState(original.id).endsAt, epoch + HOUR);
  assertEnded(restored, original.id);
  assert.equal(restored.storage.creditState(other.id), null, 'another conversation cannot inherit the legacy timer');
});

test('AIT-261: inherited voice deadline also refuses separately admitted STT/TTS components', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { createComposedVoiceCoordinator } = await import('../src/composed-voice.js');
  const f = fixture(t), session = await f.create(); await f.turn(session.id); await f.handlers.idle();
  let time = epoch + HOUR - 10_000;
  f.at(time); t.mock.method(Date, 'now', () => time);
  const roles = [], terminals = [], maximum = 17;
  const component = role => ({ async *[role === 'stt' ? 'stream' : 'speak'](request, options) {
    await options.attempt.consume();
    if (role === 'stt') { for await (const _ of request.audio) { /* consume fixture audio */ } }
    await options.report({ attemptId: options.attempt.attemptId, outcome: 'completed', usage: {
      attemptId: options.attempt.attemptId, role, unit: role === 'stt' ? 'seconds' : 'characters', quantity: 1,
      upstreamMicro: maximum, source: 'offline-fixture', estimated: false,
    } });
    yield role === 'stt' ? { text: 'A requirement', final: true } : new Uint8Array([1, 2]);
  } });
  const coordinator = createComposedVoiceCoordinator({ sessionId: session.id, callId: 'component-deadline',
    providerSessionId: 'component-provider', now: () => time,
    spendDeadlineAt: f.runtime.conversationLimits.deadline(session.id), browserLivenessDeadlineAt: time + 30_000,
    authorize: async () => true, commitUtterance: async () => {}, stt: component('stt'), tts: component('tts'),
    replyExecutor: { async *execute() {
      yield { type: 'operation', replyId: 'component-reply' }; yield { type: 'delta', text: 'Understood.' };
      yield { type: 'completion', replyId: 'component-reply', text: 'Understood.' };
    } },
    async admitComponent({ role }) {
      roles.push(role);
      return { attempt: { attemptId: `${role}-claim`, claimId: `${role}-authority`, maxMicro: maximum, consume() {} },
        report: receipt => terminals.push(receipt) };
    },
    relay: { audio() {}, silence() {}, event() {} },
  });
  t.after(() => coordinator.close());
  const speech = Buffer.alloc(100 * 32); for (let i = 0; i < speech.length; i += 2) speech.writeInt16LE(8000, i);
  await coordinator.receiveAudio(speech); await coordinator.receiveAudio(Buffer.alloc(500 * 32)); await coordinator.idle();
  assert.deepEqual(roles, ['stt', 'tts']); assert.equal(terminals.length, 2);
  time += 10_000; f.at(time);
  await assert.rejects(coordinator.receiveAudio(speech), { code: 'not-admitted' });
  assert.deepEqual(roles, ['stt', 'tts'], 'no component reservation after the inherited deadline, even before timers run');
  t.mock.timers.tick(HOUR); await coordinator.idle();
  assert.equal(coordinator.signal.aborted, true); assertEnded(f, session.id);
});
