import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { VoiceConversation } from '../../../node_modules/@elevenlabs/client/dist/VoiceConversation.js';
import { WebSocketConnection } from '../../../node_modules/@elevenlabs/client/dist/utils/WebSocketConnection.js';
import { WebRTCConnection } from '../../../node_modules/@elevenlabs/client/dist/utils/WebRTCConnection.js';
import { attachConnectionToOutput } from '../../../node_modules/@elevenlabs/client/dist/utils/attachConnectionToOutput.js';
import { MediaDeviceOutput } from '../../../node_modules/@elevenlabs/client/dist/platform/web/output.js';
import { WebAudioAdapter } from '../../../node_modules/@elevenlabs/client/dist/platform/web/webAudioAdapter.js';
import { voiceAsset } from '../../../demo/voice-assets.js';
import { createElevenLabsClient } from '../src/client.js';
import { fakeSdk, flush } from './fixtures.js';

// Replay the pinned SDK itself. Only devices, sockets, the provider and the
// AudioWorklet runtime are fakes; no provider request or browser is started.
async function playbackFixture(t, transport, { persistEvent = async () => {} } = {}) {
  const sdk = fakeSdk(), start = sdk.startSession.bind(sdk), element = { volume: 1, pause() {} };
  let conversation, connection, output, processor, gain, detach;
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
  }
  sdk.startSession = async options => {
    const device = await start({ ...options, onConversationCreated: undefined, onConnect() {}, onDisconnect() {} });
    const format = { sampleRate: 16_000, format: 'pcm' };
    if (transport === 'websocket') {
      const socket = new EventTarget(); socket.close = () => {}; socket.send = () => {};
      connection = new WebSocketConnection(socket, 'conv_replay', format, format);
      detach = attachConnectionToOutput(connection, output);
    } else {
      const room = { localParticipant: device.connection.room.localParticipant, on() {}, async disconnect() {} };
      connection = new WebRTCConnection(room, 'conv_replay', format, format);
      connection.audioAdapter = new WebAudioAdapter(); connection.audioAdapter.audioElements.push(element);
      output = connection.outputController;
    }
    conversation = new VoiceConversation(options, connection, device.input, output, null, async () => {
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
  const wire = event => connection.handleMessage(event);
  const agent = (id, text = 'Eine Antwort zum Hosting.') => wire({ type: 'agent_response',
    agent_response_event: { event_id: id, agent_response: text } });
  const audio = id => wire({ type: 'audio', audio_event: { event_id: id,
    audio_base_64: Buffer.from(new Int16Array(512).fill(16384).buffer).toString('base64') } });
  const interrupt = id => wire({ type: 'interruption', interruption_event: { event_id: id } });
  const volume = () => transport === 'websocket' ? gain.gain.value : element.volume;
  const samples = () => { const frame = new Float32Array(128); processor.process([], [[frame]]); return [...frame]; };
  return { session, sdk, agent, audio, interrupt, wire, volume, samples };
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
    interrupt(11); await session.pause(); agent(12); audio(12); assert.equal(volume(), 0);
    await session.resume(); assert.equal(volume(), 0, 'resume cannot revive an interrupted reply');
    agent(13); audio(13); assert.equal(volume(), 1);
  });
}

test('AIT-146: replay a German utterance with pauses and spelling as one complete final; corrections alone define heard text', async t => {
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
  for (const [atMs, text] of replay) {
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
