import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElevenLabsClient } from '../src/client.js';
import { fakeSdk, flush } from './fixtures.js';
import { Window } from 'happy-dom';
import { RecoveryNotices } from '../../../packages/ui/src/recovery-notices.js';
import { en } from '../../../packages/ui/src/i18n/en.js';

async function fixture(t, { persistEvent = async () => {}, withNotices = false, speakText, playAudio, holdSignal } = {}) {
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
    ...(speakText ? { control: { ...control, speakText } } : {}), playAudio,
    mediaDevices: sdk.mediaDevices, AudioContext: sdk.AudioContext,
    persistEvent: async event => { await persistEvent(event); persisted.push(event); },
  }).start({ callId: 'notice-call' }, { holdSignal });
  let root, notices;
  if (withNotices) {
    const window = new Window(); root = window.document.createElement('div'); window.document.body.append(root);
    notices = new RecoveryNotices({ root, copy: en, available: () => true, replay: () => session.replayLastReply() });
    t.after(async () => { await window.happyDOM.close(); });
  }
  const events = [], reader = (async () => {
    for await (const event of session.events) {
      events.push(event);
      if (event.type === 'recovered') notices?.recovered(event.recovery);
    }
  })();
  t.after(async () => { await session.close(); await reader; });
  const recovered = async () => {
    sdk.starts.at(-1).onDisconnect();
    for (let i = 0; i < 100 && !events.some(event => event.type === 'recovered'); i++) await flush();
    assert.ok(events.some(event => event.type === 'recovered'));
    return events.find(event => event.type === 'recovered').recovery;
  };
  const reply = (text, event_id = 2) => sdk.starts.at(-1).onMessage({ role: 'agent', message: text, event_id });
  return { sdk, session, events, persisted, calls, recovered, reply, root, notices };
}

test('AIT-138 c: tentative speech reports unconfirmed only after successful recovery', async t => {
  const f = await fixture(t);
  f.sdk.starts[0].onDebug({ type: 'tentative_user_transcript', tentative_user_transcription_event: { user_transcript: 'tentative' } });
  const recovery = await f.recovered();
  assert.equal(recovery.userUnconfirmed, true);
  assert.equal(recovery.deliveryUncertain, false);
  assert.equal(f.persisted.some(e => e.text === 'tentative'), false);
});

test('AIT-154: recovered replay synthesizes acknowledged bytes, plays audio and creates no turn', async t => {
  const requests = [], played = [];
  const f = await fixture(t, { speakText: async value => { requests.push(value); return { kind: 'audio', audio: { data: 'AAAA', format: 'pcm_16000' } }; },
    playAudio: async (audio, options) => { played.push({ audio, options }); return { stop() {}, finished: Promise.resolve() }; } });
  f.reply('Exact answer.'); await flush(); await f.recovered();
  const before = f.persisted.length;
  assert.equal((await f.session.replayLastReply()).kind, 'audio');
  assert.equal(requests[0].turnId, 'conv_1:assistant:2');
  assert.equal(played.length, 1);
  assert.equal(f.persisted.length, before);
  assert.equal(f.sdk.effects.some(([name]) => name === 'sendUserMessage'), false);
});

for (const stop of ['pause', 'hold', 'hangup', 'newer-reply', 'barge-in', 'Stop']) test(`AIT-154: ${stop} fences pending synthesis and active replay`, async t => {
  let release, stops = 0, plays = 0;
  const held = new AbortController();
  const f = await fixture(t, { holdSignal: held.signal,
    speakText: () => new Promise(resolve => { release = resolve; }),
    playAudio: async () => { plays++; return { stop() { stops++; }, finished: new Promise(() => {}) }; } });
  f.reply('Last answer.'); await flush();
  const replay = f.session.replayLastReply();
  const checked = assert.rejects(replay, e => ['cancelled', 'unavailable'].includes(e.code));
  await flush();
  if (stop === 'pause') await f.session.pause();
  if (stop === 'hold') held.abort();
  if (stop === 'hangup') await f.session.close();
  if (stop === 'newer-reply') { f.reply('Newer answer.', 3); await flush(); }
  if (stop === 'barge-in') f.sdk.interrupt(2);
  if (stop === 'Stop') { await f.session.stopReplay(); assert.deepEqual(f.sdk.effects.filter(([name]) => name === 'setVolume').at(-1), ['setVolume', 0]); }
  release?.({ kind: 'audio', audio: { data: 'AAAA', format: 'pcm_16000' } });
  await checked; assert.equal(plays, 0); assert.equal(stops, 0);
});

test('AIT-154: active replay is stopped synchronously and provider failures fall back quietly', async t => {
  let stops = 0, unavailable = false;
  const f = await fixture(t, { speakText: async () => { if (unavailable) throw Object.assign(new Error(), { code: 'provider' });
    return { kind: 'audio', audio: { data: 'AAAA', format: 'pcm_16000' } }; },
  playAudio: async () => ({ stop() { stops++; }, finished: new Promise(() => {}) }) });
  f.reply('Last answer.'); await flush();
  assert.equal((await f.session.replayLastReply()).kind, 'audio');
  f.sdk.interrupt(2); assert.equal(stops, 1);
  unavailable = true;
  assert.deepEqual(await f.session.replayLastReply(), { kind: 'text', text: 'Last answer.' });
});

for (const stop of ['pause', 'hold', 'hangup', 'newer-reply', 'Stop']) test(`AIT-154: active playback stops for ${stop}`, async t => {
  let stops = 0; const held = new AbortController();
  const f = await fixture(t, { holdSignal: held.signal,
    speakText: async () => ({ kind: 'audio', audio: { data: 'AAAA', format: 'pcm_16000' } }),
    playAudio: async () => ({ stop() { stops++; }, finished: new Promise(() => {}) }) });
  f.reply('Last answer.'); await flush(); await f.session.replayLastReply();
  if (stop === 'pause') { const pending = f.session.pause(); assert.equal(stops, 1); await pending; }
  if (stop === 'hold') { held.abort(); assert.equal(stops, 1); }
  if (stop === 'hangup') { const pending = f.session.close(); assert.equal(stops, 1); await pending; }
  if (stop === 'newer-reply') { f.reply('Newer answer.', 3); assert.equal(stops, 1); await flush(); }
  if (stop === 'Stop') await f.session.stopReplay();
  assert.equal(stops, 1); assert.equal(f.session.replaying, false);
});

test('AIT-154: heard correction updates replay to the acknowledged transcript bytes', async t => {
  const f = await fixture(t); f.reply('Known prefix and remainder'); await flush();
  f.sdk.starts[0].onAgentResponseCorrection({ event_id: 2, original_agent_response: 'Known prefix and remainder', corrected_agent_response: 'Known prefix' });
  await flush(); assert.deepEqual(await f.session.replayLastReply(), { kind: 'text', text: 'Known prefix' });
});

test('AIT-154: user speech interrupts standalone replay even when the agent is not speaking', async t => {
  let stops = 0;
  const f = await fixture(t, { speakText: async () => ({ kind: 'audio', audio: { data: 'AAAA', format: 'pcm_16000' } }),
    playAudio: async () => ({ stop() { stops++; }, finished: new Promise(() => {}) }) });
  f.reply('Last answer.'); await flush(); await f.session.replayLastReply();
  const before = f.persisted.length;
  f.sdk.starts[0].onDebug({ type: 'tentative_user_transcript', tentative_user_transcription_event: { user_transcript: 'One moment' } });
  assert.equal(stops, 1);
  assert.deepEqual(f.sdk.effects.filter(([name]) => name === 'setVolume').at(-1), ['setVolume', 0]);
  await flush(); assert.equal(f.persisted.length, before, 'barge-in itself creates no turn or heard evidence');
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

test('AIT-138 c: cut before the new final never substitutes the previous answer', async t => {
  const f = await fixture(t); f.reply('Previous complete reply', 1); await flush();
  f.sdk.starts[0].onModeChange({ mode: 'speaking' });
  f.sdk.starts[0].onAgentChatResponsePart({ event_id: 2, type: 'start', text: '' });
  const recovery = await f.recovered();
  assert.equal(recovery.deliveryUncertain, true);
  assert.equal(recovery.lastReplyText, null);
});

test('AIT-138 c: heard-prefix evidence survives recovery and is never an unknown position', async t => {
  const f = await fixture(t);
  f.sdk.starts[0].onModeChange({ mode: 'speaking' }); f.reply('Known prefix and remainder'); await flush();
  f.sdk.starts[0].onAgentResponseCorrection({ event_id: 2, original_agent_response: 'Known prefix and remainder', corrected_agent_response: 'Known prefix' });
  const recovery = await f.recovered();
  assert.equal(recovery.playbackPositionUnknown, false);
  assert.equal(f.session.lifecycle.state.checkpoint.heardPrefix, 'Known prefix');
});

for (const acknowledged of [false, true]) for (const correctionTiming of ['persisted', 'queued', 'late']) {
  test(`AIT-138 c fix1: A heard (${correctionTiming}), B streaming (${acknowledged ? 'acknowledged' : 'unacknowledged'}), drop offers only B`, async t => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const f = await fixture(t, { withNotices: true,
      persistEvent: event => event.type === 'heard' && correctionTiming === 'queued' ? pending : undefined });
    const callbacks = f.sdk.starts[0];
    callbacks.onModeChange({ mode: 'speaking' }); f.reply('Reply A with remainder', 1); await flush();
    const correction = () => callbacks.onAgentResponseCorrection({ event_id: 1,
      original_agent_response: 'Reply A with remainder', corrected_agent_response: 'Reply A' });
    correction();
    if (correctionTiming !== 'queued') {
      await flush();
      assert.equal(f.session.lifecycle.state.checkpoint.heardPrefix, 'Reply A');
    }
    callbacks.onModeChange({ mode: 'listening' }); callbacks.onModeChange({ mode: 'speaking' });
    callbacks.onAgentChatResponsePart({ event_id: 2, type: 'start', text: '' });
    callbacks.onAgentChatResponsePart({ event_id: 2, type: 'delta', text: 'Reply B' });
    if (acknowledged) f.reply('  Reply B.\nComplete remainder.  ', 2);
    if (correctionTiming === 'late') correction();
    const recovering = f.recovered(); release();
    const recovery = await recovering;
    assert.equal(recovery.deliveryUncertain, true);
    assert.equal(recovery.playbackPositionUnknown, true, 'A cannot establish the position of B');
    assert.equal(f.session.lifecycle.state.checkpoint.heardPrefix, null, 'stale A evidence is invalidated');
    assert.equal(f.persisted.some(event => event.type === 'heard' && event.turnId === 'conv_1:assistant:1' && event.prefix === 'Reply A'), true,
      'the genuine AIT-146 heard prefix remains in the transcript');
    assert.equal(f.root.querySelector('.voice-notice--reply span').textContent, en.voiceReplyIncomplete);
    assert.ok(f.root.querySelector('.voice-notice-live').textContent.includes(en.voiceReplyIncomplete));
    const button = f.root.querySelector('.voice-repeat');
    assert.equal(button.hidden, !acknowledged);
    assert.equal(button.disabled, !acknowledged);
    assert.equal(recovery.lastReplyText, acknowledged ? '  Reply B.\nComplete remainder.  ' : null);
    if (acknowledged) {
      await f.notices.repeat();
      assert.equal(f.root.querySelector('dialog').open, true);
      assert.equal(f.root.querySelector('.voice-reply-text').textContent, recovery.lastReplyText);
    } else {
      assert.equal(button.title, en.voiceReplyUnavailable);
      button.click(); await flush();
      assert.equal(f.root.querySelector('dialog').open, false, 'an unacknowledged B never substitutes A');
    }
  });
}

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
