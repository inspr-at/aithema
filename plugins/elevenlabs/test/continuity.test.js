import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { createElevenLabsClient } from '../src/client.js';
import { fixture, invocationOptions } from './fixtures.js';
const test = (name, fn) => nodeTest(name, { timeout: 10_000 }, fn);

test('AIT-138 d: a final refused at takeover keeps the old-tab notice without ending the successor', async t => {
  const local = fixture(), entered = Promise.withResolvers(), release = Promise.withResolvers(); let closes = 0;
  const control = { ...local.control, close: (...args) => { closes++; return local.control.close(...args); } };
  const client = createElevenLabsClient({ sdk: local.sdk, control, mediaDevices: local.sdk.mediaDevices, AudioContext: local.sdk.AudioContext,
    persistEvent: async () => { entered.resolve(); await release.promise; throw Object.assign(new Error('retired epoch'), { status: 409, code: 'voice-ownership-lost' }); } });
  const session = await client.start({ callId: 'late-final' }, invocationOptions());
  t.after(async () => { release.resolve(); await session.close(); });
  local.sdk.starts[0].onMessage({ role: 'user', message: 'in flight at takeover', event_id: 1 }); await entered.promise;
  release.resolve();
  const event = await session.events.next();
  assert.equal(event.value.type, 'waiting'); assert.equal(event.value.reason, 'ownership-lost');
  assert.equal(session.lifecycle.state.state, 'waiting'); assert.equal(closes, 0, 'publication refusal never sends terminal intent over the successor');
});

for (const transport of ['webrtc', 'websocket']) {
  for (const cause of ['ownership', 'sleep', 'lease']) test(`AIT-138 d: ${transport} ${cause} holds capture and playback synchronously`, async t => {
    const local = fixture(), document = new EventTarget(), persisted = [];
    const client = createElevenLabsClient({ sdk: local.sdk, control: local.control, document,
      mediaDevices: local.sdk.mediaDevices, AudioContext: local.sdk.AudioContext, persistEvent: async e => persisted.push(e) });
    const session = await client.start({ callId: `${transport}_${cause}`, transport }, invocationOptions());
    t.after(() => session.close());
    const old = local.sdk.starts[0];
    if (cause === 'ownership') session.receiveState({ callId: session.callId, epoch: 1, controllingTabId: 'another-tab' });
    if (cause === 'sleep') { document.dispatchEvent(new Event('freeze')); document.dispatchEvent(new Event('resume')); }
    if (cause === 'lease') session.lifecycle.wait();
    assert.equal(session.lifecycle.state.state, 'waiting');
    assert.ok(local.sdk.acquired.every(stream => stream.getTracks().every(track => track.readyState === 'ended')));
    assert.equal(local.sdk.effects.filter(([name]) => name === 'setVolume').at(-1)[1], 0);
    const sent = local.sdk.outgoing.length, acquired = local.sdk.acquired.length;
    local.sdk.sample({ buffered: true }); assert.equal(local.sdk.outgoing.length, sent);
    old.onMessage({ role: 'user', message: 'late speech', event_id: 10 });
    assert.equal(persisted.length, 0, 'retired SDK callbacks cannot publish');
    assert.equal(await session.lifecycle.recover(), false, 'holds never spend on automatic repair');
    assert.equal(local.sdk.acquired.length, acquired);
    if (cause === 'ownership') await assert.rejects(session.resume(), { code: 'voice-ownership-lost' });
  });
}

test('AIT-138 d: wake Resume replaces silently while held, then waits for authorization before capture', async t => {
  const local = fixture(), document = new EventTarget(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  local.control.recover = (identity, options) => local.control.start({ callId: identity.callId }, { ...invocationOptions(), ...options })
    .then(receipt => ({ ...receipt, overrides: { agent: { language: 'en', firstMessage: '' } } }));
  local.control.resume = async () => { entered.resolve(); await release.promise; return { acknowledged: true, paused: false }; };
  const client = createElevenLabsClient({ sdk: local.sdk, control: local.control, document,
    mediaDevices: local.sdk.mediaDevices, AudioContext: local.sdk.AudioContext, persistEvent: async () => {} });
  const session = await client.start({ callId: 'wake' }, invocationOptions());
  t.after(async () => { release.resolve(); await session.close(); });
  document.dispatchEvent(new Event('freeze')); document.dispatchEvent(new Event('resume'));
  const acquired = local.sdk.acquired.length, resuming = session.resume(); await entered.promise;
  assert.equal(local.sdk.acquired.length, acquired, 'replacement uses device-free silence before Resume acknowledgement');
  assert.equal(local.sdk.starts[1].overrides.agent.firstMessage, '');
  assert.equal(local.sdk.effects.filter(([name]) => name === 'setVolume').at(-1)[1], 0);
  release.resolve(); await resuming;
  assert.equal(session.lifecycle.state.state, 'active');
  assert.ok(local.sdk.acquired.length > acquired);
  assert.equal(local.sdk.effects.some(([name]) => name === 'sendUserMessage'), false, 'Rule C has no synthetic cross-generation input');
});

test('AIT-138 d: retained server restart hold on a connected replacement cannot fence its Resume', async t => {
  const local = fixture(), session = await local.client.start({ callId: 'restart-notification' }, invocationOptions());
  t.after(() => session.close());
  session.receiveState({ callId: session.callId, providerSessionId: session.providerSessionId, state: 'paused', needsRecovery: false, reason: 'server-restart' });
  assert.equal(session.lifecycle.state.state, 'active');
  session.receiveState({ callId: session.callId, providerSessionId: session.providerSessionId, state: 'waiting', needsRecovery: true, reason: 'server-restart' });
  assert.equal(session.lifecycle.state.state, 'waiting');
  const stopped = local.sdk.effects.filter(([name]) => name === 'setVolume').length;
  session.receiveState({ callId: session.callId, providerSessionId: session.providerSessionId, state: 'waiting', reason: 'server-restart' });
  assert.equal(local.sdk.effects.filter(([name]) => name === 'setVolume').length, stopped, 'repeat snapshot is already fenced');
});
