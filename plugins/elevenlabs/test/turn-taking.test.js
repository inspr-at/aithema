import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { VoiceConversation } from '../../../node_modules/@elevenlabs/client/dist/VoiceConversation.js';
import { WebSocketConnection } from '../../../node_modules/@elevenlabs/client/dist/utils/WebSocketConnection.js';
import { WebRTCConnection } from '../../../node_modules/@elevenlabs/client/dist/utils/WebRTCConnection.js';
import { attachConnectionToOutput } from '../../../node_modules/@elevenlabs/client/dist/utils/attachConnectionToOutput.js';
import { MediaDeviceOutput } from '../../../node_modules/@elevenlabs/client/dist/platform/web/output.js';
import { WebAudioAdapter } from '../../../node_modules/@elevenlabs/client/dist/platform/web/webAudioAdapter.js';
import { RoomEvent } from 'livekit-client';
import { voiceAsset } from '../../../demo/voice-assets.js';
import { createElevenLabsClient } from '../src/client.js';
import { fakeSdk, flush } from './fixtures.js';

// Replay the pinned SDK itself. Only devices, sockets, the provider and the
// AudioWorklet runtime are fakes; no provider request or browser is started.
async function playbackFixture(t, transport, { persistEvent = async () => {} } = {}) {
  const sdk = fakeSdk(), start = sdk.startSession.bind(sdk), element = { volume: 1, pause() {} };
  let conversation, connection, output, processor, gain, detach;
  const roomEvents = new Map(), queuedVolumes = [], alignments = [];
  if (transport === 'websocket') {
    let Processor;
    runInNewContext(new TextDecoder().decode(await voiceAsset('audio-concat.js')), {
      sampleRate: 16_000, registerProcessor: (_name, value) => { Processor = value; },
      AudioWorkletProcessor: class { port = { postMessage() {} }; },
    });
    processor = new Processor();
    const param = { value: 1, cancelScheduledValues() {}, exponentialRampToValueAtTime() {} };
    gain = { gain: param };
    const port = { start() {}, addEventListener() {}, removeEventListener() {},
      postMessage: data => processor.port.onmessage({ data }) };
    output = new MediaDeviceOutput({ currentTime: 0, sampleRate: 16_000, async close() {} },
      { frequencyBinCount: 16, getByteFrequencyData: bytes => bytes.fill(128) }, gain, { port }, element);
    const playAudio = output.playAudio.bind(output);
    output.playAudio = chunk => { queuedVolumes.push(gain.gain.value); playAudio(chunk); };
  }
  sdk.startSession = async options => {
    const device = await start({ ...options, onConversationCreated: undefined, onConnect() {}, onDisconnect() {} });
    const format = { sampleRate: 16_000, format: 'pcm' };
    if (transport === 'websocket') {
      const socket = new EventTarget(); socket.close = () => {}; socket.send = () => {};
      connection = new WebSocketConnection(socket, 'conv_replay', format, format);
      detach = attachConnectionToOutput(connection, output);
    } else {
      const room = { localParticipant: device.connection.room.localParticipant,
        on(name, callback) { roomEvents.set(name, callback); }, async disconnect() {} };
      connection = new WebRTCConnection(room, 'conv_replay', format, format);
      connection.audioAdapter = new WebAudioAdapter(); connection.audioAdapter.audioElements.push(element);
      output = connection.output;
    }
    conversation = new VoiceConversation({ ...options, onAudioAlignment: value => alignments.push(value) }, connection, device.input, output, null, async () => {
      detach?.(); await device.endSession();
    });
    conversation.markConnected(); options.onConversationCreated(conversation);
    options.onConnect({ conversationId: 'conv_replay' }); return conversation;
  };
  const client = createElevenLabsClient({ sdk, mediaDevices: sdk.mediaDevices, AudioContext: sdk.AudioContext, persistEvent,
    control: {
      async start() { return { callId: 'call_replay', providerSessionId: 'conv_replay',
        credential: { connectionType: transport, providerSessionId: 'conv_replay', ttlMs: 30_000,
          ...(transport === 'websocket' ? { signedUrl: 'wss://socket.example.test/call?conversation_id=conv_replay' }
            : { conversationToken: 'fixture-token-conv_replay' }) },
        spendDeadlineAt: Date.now() + 30_000, browserLivenessDeadlineAt: Date.now() + 30_000 }; },
      async close() { return { closureConfirmed: true }; },
      async pause() { return { acknowledged: true, paused: true }; },
      async resume() { return { acknowledged: true, paused: false }; },
      async heartbeat() { return { acknowledged: true, browserLivenessDeadlineAt: Date.now() + 30_000 }; },
    },
  });
  const session = await client.start({ callId: 'call_replay' }); t.after(() => session.close());
  const wire = event => transport === 'websocket' ? connection.handleMessage(event)
    : roomEvents.get(RoomEvent.DataReceived)(new TextEncoder().encode(JSON.stringify(event)));
  const agent = (id, text = 'Eine Antwort zum Hosting.') => wire({ type: 'agent_response',
    agent_response_event: { event_id: id, agent_response: text } });
  const audio = (id, sample = 16384) => wire({ type: 'audio', audio_event: { event_id: id,
    ...(transport === 'websocket'
      ? { audio_base_64: Buffer.from(new Int16Array(512).fill(sample).buffer).toString('base64') }
      : { alignment: { chars: ['H'], char_start_times_ms: [0], char_durations_ms: [32] } }) } });
  // The SDK's WebRTC analyser synthesizes these IDs locally, after track audio.
  const analysedAudio = id => connection.handleMessage({ type: 'audio', audio_event: { event_id: id,
    audio_base_64: Buffer.from(new Int16Array(128).fill(16384).buffer).toString('base64') } });
  const part = (id, type = 'start', text = '') => wire({ type: 'agent_chat_response_part',
    text_response_part: { event_id: id, type, text } });
  const interrupt = id => wire({ type: 'interruption', interruption_event: { event_id: id } });
  const volume = () => transport === 'websocket' ? gain.gain.value : element.volume;
  const samples = () => {
    if (transport === 'webrtc') return Array(128).fill(0.5 * element.volume);
    const frame = new Float32Array(128); processor.process([], [[frame]]); return [...frame];
  };
  return { session, sdk, agent, audio, analysedAudio, part, interrupt, wire, volume, samples, queuedVolumes, alignments };
}

for (const transport of ['webrtc', 'websocket']) {
  test(`AIT-146: ${transport} interruption silences pinned SDK playback within 300 ms, before persistence`, async t => {
    let release;
    const saved = [], local = await playbackFixture(t, transport, { persistEvent: event => {
      saved.push(event); return new Promise(resolve => { release = resolve; });
    } });
    const { session, sdk, agent, audio, interrupt, volume } = local;
    agent(10); audio(10); assert.equal(volume(), 1);
    await flush(); assert.equal(saved.length, 1);
    const pending = session.interrupt(); await flush();
    const at = performance.now(); interrupt(10);
    try {
      assert.equal(volume(), 0, 'the output path must be silent as the callback returns');
      assert.ok(performance.now() - at < 300);
      await pending;
      if (transport === 'websocket') assert.ok(local.samples().every(sample => sample === 0), 'queued PCM must be discarded');
      audio(10); sdk.starts[0].onModeChange({ mode: 'speaking' });
      assert.equal(volume(), 0, 'late audio and modes cannot revive the interrupted reply');
      await session.setInput(true); await session.setOutput(true);
      assert.equal(volume(), 0, 'channel commands cannot revive the interrupted reply');
      agent(11); audio(11); assert.equal(volume(), 1, 'a fresh provider reply restores playback');
      if (transport === 'websocket') assert.ok(local.samples().some(sample => sample !== 0));
      interrupt(10); assert.equal(volume(), 1, 'a duplicate old interruption cannot mute a newer reply');
    } finally {
      release(); await flush(); release(); await flush(); await session.close();
    }
  });

  test(`AIT-146: ${transport} a fresh reply preserves output mute and pause after interruption`, async t => {
    const { session, agent, audio, interrupt, volume } = await playbackFixture(t, transport);
    agent(10); audio(10); interrupt(10); await session.setOutput(false);
    agent(11); audio(11); assert.equal(volume(), 0);
    await session.setOutput(true); assert.equal(volume(), 1);
    interrupt(11); await session.pause(); agent(11); audio(11); assert.equal(volume(), 0);
    await session.resume(); assert.equal(volume(), 0, 'resume cannot revive an interrupted reply');
    agent(13); audio(13); assert.equal(volume(), 1);
  });

  test(`AIT-146: ${transport} first fresh audio unlocks before the complete agent response`, async t => {
    const local = await playbackFixture(t, transport);
    local.agent(10); local.audio(10, -16384); local.interrupt(10);
    local.audio(10, -16384); assert.equal(local.volume(), 0, 'stale audio stays muted');
    assert.ok(local.samples().every(sample => sample === 0));
    local.audio(11);
    assert.equal(local.volume(), 1, 'fresh audio must unlock synchronously before agent_response');
    if (transport === 'websocket') assert.equal(local.queuedVolumes.at(-1), 1, 'gain is restored before enqueueing the first fresh chunk');
    assert.ok(local.samples().every(sample => sample > 0), 'the first fresh frame is audible with no interrupted samples');
    local.agent(11); assert.equal(local.volume(), 1);
  });

  test(`AIT-146: ${transport} fresh audio during pause restores playback on resume before agent response`, async t => {
    const local = await playbackFixture(t, transport);
    local.agent(10); local.audio(10); local.interrupt(10); await local.session.pause();
    local.audio(11); assert.equal(local.volume(), 0, 'pause remains dominant over the fresh audio signal');
    await local.session.resume();
    assert.equal(local.volume(), 1, 'resume must not retain the interruption mute after a fresh audio id');
    local.audio(11); assert.ok(local.samples().some(sample => sample > 0));
  });

  test(`AIT-146: ${transport} fresh final during pause records the id without persisting a paused turn`, async t => {
    const saved = [], local = await playbackFixture(t, transport, { persistEvent: async event => { saved.push(event); } });
    local.agent(10); local.interrupt(10); await local.session.pause();
    local.agent(11); assert.equal(local.volume(), 0);
    await local.session.resume();
    assert.equal(local.volume(), 1, 'a final received during pause must clear the interruption state');
    local.interrupt(10); assert.equal(local.volume(), 1, 'the paused fresh id also fences stale interruptions');
    await flush(); assert.deepEqual(saved.map(event => event.turnId), ['conv_replay:assistant:10']);
  });

  test(`AIT-146: ${transport} fresh audio respects output-off through pause and resume`, async t => {
    const local = await playbackFixture(t, transport);
    local.agent(10); local.interrupt(10); await local.session.setOutput(false); await local.session.pause();
    local.audio(11); await local.session.resume(); assert.equal(local.volume(), 0);
    await local.session.setOutput(true); assert.equal(local.volume(), 1, 'output-on exposes the fresh reply without a stuck interruption mute');
  });

  test(`AIT-146: ${transport} stale events after an audio unlock cannot re-mute or forward old audio`, async t => {
    const local = await playbackFixture(t, transport);
    local.agent(10); local.audio(10, -16384); local.interrupt(10); local.audio(12);
    const queued = local.queuedVolumes.length, aligned = local.alignments.length;
    local.interrupt(10); local.interrupt(11); local.agent(10); local.part(10);
    for (const id of [9, 10, 11, undefined, -1, 10.5]) local.audio(id, -16384);
    assert.equal(local.volume(), 1, 'even a delayed interruption newer than the previous interruption cannot mute a newer audio reply');
    assert.equal(local.queuedVolumes.length, queued, 'no old WebSocket chunk reaches output');
    assert.equal(local.alignments.length, aligned, 'no old WebRTC provider audio reaches the SDK');
    assert.ok(local.samples().every(sample => sample > 0));
    local.audio(12); assert.equal(local.volume(), 1, 'another chunk of the fresh reply remains audible');
    local.interrupt(12); assert.equal(local.volume(), 0, 'a real interruption of the fresh reply still mutes');
    local.audio(10); local.part(10); local.agent(10); assert.equal(local.volume(), 0, 'old signals cannot unlock a subsequent interruption');
  });
}

test('AIT-146: WebRTC streamed reply start and delta unlock before track audio and complete response', async t => {
  const local = await playbackFixture(t, 'webrtc');
  local.agent(10); local.interrupt(10);
  local.part(10); local.part(11, 'stop'); local.part(undefined); assert.equal(local.volume(), 0);
  local.part(11); assert.equal(local.volume(), 1, 'a newer streamed start precedes TTS track audio');
  assert.ok(local.samples().every(sample => sample > 0));
  local.interrupt(11); await local.session.pause(); local.part(12, 'delta', 'Hosting'); assert.equal(local.volume(), 0);
  await local.session.resume(); assert.equal(local.volume(), 1, 'streamed deltas during pause also record the fresh reply');
});

test('AIT-146: WebRTC local analyser ids and speaking modes cannot unlock an interrupted reply', async t => {
  const local = await playbackFixture(t, 'webrtc');
  local.agent(10); local.interrupt(10);
  local.analysedAudio(500); local.sdk.starts[0].onModeChange({ mode: 'speaking' });
  assert.equal(local.volume(), 0, 'capture counters and mode notifications have no provider turn identity');
  local.audio(11); assert.equal(local.volume(), 1, 'provider alignment carries a trustworthy fresh turn id');
});

test('AIT-146: WebSocket interruption clears queued PCM immediately in the pinned worklet', async t => {
  const local = await playbackFixture(t, 'websocket');
  local.agent(10); local.audio(10); local.interrupt(10);
  assert.ok(local.samples().every(sample => sample === 0), 'interrupt must discard every queued sample');
});

test('AIT-146: late WebSocket audio cannot queue an interrupted reply ahead of a fresh reply', async t => {
  const local = await playbackFixture(t, 'websocket');
  local.agent(10); local.audio(10); local.interrupt(10);
  for (let frame = 0; frame < 5; frame++) local.samples();
  local.audio(10);
  assert.ok(local.samples().every(sample => sample === 0), 'late interrupted PCM must not enter the worklet');
});

test('AIT-146: replay a German utterance with pauses and spelling as one complete final; corrections alone define heard text', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const saved = [], local = await playbackFixture(t, 'webrtc', { persistEvent: async event => { saved.push(event); } });
  const events = []; const reader = (async () => { for await (const event of local.session.events) events.push(event); })();
  // Virtual timestamps include two thinking pauses and a spelled domain. The
  // fake supplies provider boundaries; this does not simulate ElevenLabs' model.
  const replay = [
    [0, 'Ich hab noch kei-'],
    [1500, 'Ich hab noch keinen Hosting-Anbieter ausgewählt,'],
    [5300, 'Ich hab noch keinen Hosting-Anbieter ausgewählt, weil ich zuerst den Webshop'],
    [9700, 'Ich hab noch keinen Hosting-Anbieter ausgewählt, weil ich zuerst den Webshop und die Domain klären möchte.'],
    [11200, 'Die Domain lautet m e i n w u n s c h p o l s t e r Punkt a t.'],
  ];
  let previousMs = 0;
  for (const [atMs, text] of replay) {
    t.mock.timers.tick(atMs - previousMs); previousMs = atMs;
    local.sdk.starts[0].onDebug({ type: 'tentative_user_transcript', tentative_user_transcription_event: { user_transcript: text } });
    await flush(); assert.deepEqual(saved, [], `no final during the utterance at ${atMs} ms`);
  }
  const text = `${replay[3][1]} ${replay[4][1]}`;
  local.wire({ type: 'user_transcript', user_transcription_event: { event_id: 14, user_transcript: text } });
  local.agent(15, 'Ich kann einen Anbieter vorschlagen.'); local.audio(15); local.interrupt(15);
  local.wire({ type: 'agent_response_correction', agent_response_correction_event: { event_id: 15,
    original_agent_response: 'Ich kann einen Anbieter vorschlagen.', corrected_agent_response: 'Ich kann' } });
  await local.session.close(); await reader;
  assert.equal(saved.filter(event => event.type === 'final' && event.role === 'user').length, 1);
  assert.equal(saved.find(event => event.role === 'user').text, text);
  assert.deepEqual(saved.filter(event => event.type === 'heard').map(event => event.prefix), ['Ich kann']);
  assert.equal(events.filter(event => event.type === 'partial').length, replay.length);
});
