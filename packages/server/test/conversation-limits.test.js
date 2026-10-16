import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createHandlers, createPluginRuntime, mockPresets } from '../src/index.js';
import { createDemoHost } from '../../../demo/host-ports.js';
import { mockConsent, temporaryDb } from '../../../test/helpers.js';
import { request } from '../../../test/plugin-fixtures.js';

const HOUR = 60 * 60_000, epoch = 1_800_000_000_000, owner = 'deadline-owner';
function fixture(t, { path, at = epoch, ownerGuard = false } = {}) {
  let time = at;
  const storage = new SQLiteStorage(path), now = () => time;
  const host = createDemoHost({ storage, now, ownerGuard, demoBypass: true });
  const runtime = createPluginRuntime({ storage, now, consent: mockConsent, presets: mockPresets() });
  const handlers = createHandlers({ storage, host, pluginRuntime: runtime, consent: mockConsent, log() {} });
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
  return { storage, runtime, host, handlers, call, create, turn, close, advance };
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
