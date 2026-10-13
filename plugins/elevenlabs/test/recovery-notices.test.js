import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElevenLabsClient } from '../src/client.js';
import { fakeSdk, flush } from './fixtures.js';

async function fixture(t, { persistEvent = async () => {} } = {}) {
  const sdk = fakeSdk(), calls = []; let generation = 0;
  const receipt = ({ callId }) => {
    const providerSessionId = `conv_${++generation}`;
    return { callId, providerSessionId,
      credential: { providerSessionId, connectionType: 'webrtc', conversationToken: `fixture-token-${providerSessionId}`, ttlMs: 60_000 },
      spendDeadlineAt: Date.now() + 60_000, browserLivenessDeadlineAt: Date.now() + 30_000 };
  };
  const control = Object.fromEntries(['start', 'recover', 'close', 'pause', 'resume', 'heartbeat'].map(name => [name, async value => {
    calls.push(name);
    if (['start', 'recover'].includes(name)) return receipt(value);
    return { acknowledged: true, paused: name === 'pause', closureConfirmed: true, browserLivenessDeadlineAt: Date.now() + 30_000 };
  }]));
  const persisted = [], session = await createElevenLabsClient({ sdk, control,
    mediaDevices: sdk.mediaDevices, AudioContext: sdk.AudioContext,
    persistEvent: async event => { await persistEvent(event); persisted.push(event); },
  }).start({ callId: 'notice-call' });
  const events = [], reader = (async () => { for await (const event of session.events) events.push(event); })();
  t.after(async () => { await session.close(); await reader; });
  const recovered = async () => {
    sdk.starts.at(-1).onDisconnect();
    for (let i = 0; i < 100 && !events.some(event => event.type === 'recovered'); i++) await flush();
    assert.ok(events.some(event => event.type === 'recovered'));
    return events.find(event => event.type === 'recovered').recovery;
  };
  const reply = (text, event_id = 2) => sdk.starts.at(-1).onMessage({ role: 'agent', message: text, event_id });
  return { sdk, session, events, persisted, calls, recovered, reply };
}

test('AIT-138 c: tentative speech reports unconfirmed only after successful recovery', async t => {
  const f = await fixture(t);
  f.sdk.starts[0].onDebug({ type: 'tentative_user_transcript', tentative_user_transcription_event: { user_transcript: 'tentative' } });
  const recovery = await f.recovered();
  assert.equal(recovery.userUnconfirmed, true);
  assert.equal(recovery.deliveryUncertain, false);
  assert.equal(f.persisted.some(e => e.text === 'tentative'), false);
});

test('AIT-138 c: final persistence racing a drop reconciles speech before the recovery notice', async t => {
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const f = await fixture(t, { persistEvent: event => event.role === 'user' ? pending : undefined });
  f.sdk.starts[0].onDebug({ type: 'tentative_user_transcript', tentative_user_transcription_event: { user_transcript: 'accepted' } });
  f.sdk.starts[0].onMessage({ role: 'user', message: 'accepted', event_id: 1 });
  const recovering = f.recovered(); await flush(); resolve();
  assert.equal((await recovering).userUnconfirmed, false);
  assert.equal(f.persisted.filter(e => e.role === 'user').length, 1);
});

test('AIT-138 c: unknown cut playback offers the exact last reply with no automatic replay', async t => {
  const f = await fixture(t);
  f.reply('Older answer', 1); await flush();
  f.sdk.starts[0].onModeChange({ mode: 'speaking' });
  f.reply('  Exact last answer.\nSecond paragraph.  '); await flush();
  const recovery = await f.recovered();
  assert.equal(recovery.deliveryUncertain, true);
  assert.equal(recovery.playbackPositionUnknown, true);
  assert.equal(recovery.lastReplyText, '  Exact last answer.\nSecond paragraph.  ');
  const before = { calls: [...f.calls], effects: [...f.sdk.effects], persisted: [...f.persisted] };
  assert.deepEqual(await f.session.replayLastReply(), { kind: 'text', text: recovery.lastReplyText });
  assert.deepEqual(f.calls, before.calls, 'replay has no new admission or control request');
  assert.deepEqual(f.sdk.effects, before.effects, 'no model-triggering SDK message or automatic audio');
  assert.deepEqual(f.persisted, before.persisted, 'replay never creates a turn or callback identity');
});

test('AIT-138 c: completed playback does not claim a cut reply', async t => {
  const f = await fixture(t);
  f.sdk.starts[0].onModeChange({ mode: 'speaking' }); f.reply('Complete'); await flush();
  f.sdk.starts[0].onModeChange({ mode: 'listening' }); await flush();
  assert.equal((await f.recovered()).deliveryUncertain, false);
});

test('AIT-138 c: heard-prefix evidence survives recovery and is never an unknown position', async t => {
  const f = await fixture(t);
  f.sdk.starts[0].onModeChange({ mode: 'speaking' }); f.reply('Known prefix and remainder'); await flush();
  f.sdk.starts[0].onAgentResponseCorrection({ event_id: 2, original_agent_response: 'Known prefix and remainder', corrected_agent_response: 'Known prefix' });
  const recovery = await f.recovered();
  assert.equal(recovery.playbackPositionUnknown, false);
  assert.equal(f.session.lifecycle.state.checkpoint.heardPrefix, 'Known prefix');
});

for (const stop of ['pause', 'hold', 'hangup']) test(`AIT-138 c: replay is fenced by ${stop}, including queued requests`, async t => {
  const f = await fixture(t); f.reply('Last reply'); await flush();
  const replay = f.session.replayLastReply();
  const rejection = assert.rejects(replay, e => ['unavailable', 'cancelled'].includes(e.code));
  if (stop === 'pause') await f.session.pause();
  if (stop === 'hold') {
    f.sdk.starts[0].onDisconnect(); await f.session.pause();
  }
  if (stop === 'hangup') await f.session.close();
  await rejection;
  assert.equal(f.sdk.effects.some(([name]) => name === 'sendUserMessage'), false);
});
