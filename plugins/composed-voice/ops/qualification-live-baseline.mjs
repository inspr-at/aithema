import { randomUUID } from 'node:crypto';
import { mintConversationCredential } from '@inspr/aithema-plugin-elevenlabs';
import { voiceOverrides } from '../../elevenlabs/src/options.js';
import { PluginError } from '@inspr/aithema-core/invocation';
import { voiceOperation } from '@inspr/aithema-core/live-voice';
import { createComposedRelay } from '../src/relay.js';
import { createComposedRelayRoute } from '../src/network-relay.js';

// Only the media transport is bridged. Credential minting is the production
// primitive; the selected agent, its reasoning, VAD, STT and TTS are unchanged.
// Wire source (2026-10-16):
// https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket
// InitiationClientData, InitiationMetadata, UserTranscript, AudioResponse, Ping.
// No agent management API, settings writes, prompts, model or voice overrides.
export async function startBaselineSample(p) {
  const { binding, sessionId, owner, storage, signal, deadlineAt, authorize, admission } = p;
  const callId = `qualification-${randomUUID()}`, base = binding.baseline;
  // Production callbacks.js uses this silent continuation with locale. The
  // corpus is the first user utterance, so an opener must not contaminate timing.
  const overrides = voiceOverrides({ agent: { language: storage.get(sessionId).locale, firstMessage: '' } });
  const request = { transport: 'websocket', agentId: base.agentId, overrides, maxDurationSeconds: binding.maxDurationSeconds };
  const admitted = await admission('baseline', request, Math.ceil(base.microPerMinute * binding.maxDurationSeconds / 60));
  let socket, relay, networkRelay, stopped = false, input = true, output = true, revision = 0, closing, onClose, format, firstAudio = false;
  const metadata = Promise.withResolvers(); metadata.promise.catch(() => {});
  const options = { signal, deadlineAt };
  let record;
  const save = () => storage.saveVoiceCall(sessionId, record, { guard: { ownerToken: owner } });
  async function close() {
    if (closing) return closing;
    const done = Promise.withResolvers(); closing = done.promise;
    stopped = true; input = false; output = false;
    relay?.close(); networkRelay?.revoke(record?.providerSessionId);
    void (async () => {
      await socket?.close();
      if (record) {
        record = { ...record, endedAt: Date.now(), terminal: { outcome: 'uncertain', closureConfirmed: false,
          providerSessionId: record.providerSessionId, chargedMicro: admitted.attempt.maxMicro } };
        save();
      }
      await admitted.report({});
    })().then(done.resolve, done.reject);
    return closing;
  }
  try {
    // Same durable admission covers mint + its single conversation connection;
    // neither transport may start before the consume acknowledgement.
    await admitted.attempt.consume(); await authorize();
    const credential = await mintConversationCredential({ agentId: base.agentId, secretRef: base.secretRef,
      apiBaseUrl: base.endpoint, upstreamMicroPerMinute: base.microPerMinute, visitorMicroPerMinute: 0 }, request, options,
    { resolveSecret: p.resolveSecret, fetchImpl: p.fetchImpl });
    await authorize();
    record = { sessionId, callId, providerSessionId: credential.providerSessionId, startedAt: Date.now(),
      spendDeadlineAt: deadlineAt, browserLivenessDeadlineAt: deadlineAt,
      attemptId: admitted.attempt.attemptId, claimId: admitted.attempt.claimId, maxMicro: admitted.attempt.maxMicro,
      exposureMicro: admitted.attempt.maxMicro, paused: false, pauses: [] };
    save();
    const opening = Promise.resolve().then(() => p.connect({ url: credential.signedUrl, signal })).then(async value => {
      if (signal.aborted) { await value.close(); throw new PluginError('cancelled'); }
      return value;
    });
    socket = await voiceOperation(options, () => opening);
    signal.throwIfAborted();
    relay = createComposedRelay({ callId, providerSessionId: record.providerSessionId, expiresAt: deadlineAt,
      spendDeadlineAt: deadlineAt, browserLivenessDeadlineAt: deadlineAt });
    const stamp = () => ({ callId, providerSessionId: record.providerSessionId, epoch: 0, generation: 1, playbackRevision: revision });
    const interrupt = () => { revision++; output = false; relay.silence({ ...stamp(), reason: 'interrupted' }); return Promise.resolve(); };
    const api = {
      async receiveAudio(bytes) {
        await authorize();
        if (stopped || !input || !(bytes instanceof Uint8Array) || bytes.byteLength % 2 || bytes.byteLength > 64_000) throw new PluginError('not-admitted');
        await voiceOperation(options, () => socket.send(JSON.stringify({ user_audio_chunk: Buffer.from(bytes).toString('base64') })));
      },
      interrupt,
      async setInput(on) { if (on !== false) throw new PluginError('not-admitted'); input = false; return { acknowledged: true }; },
      async setOutput(on) { if (on !== false) throw new PluginError('not-admitted'); await interrupt(); return { acknowledged: true }; },
      async pause() { await interrupt(); input = false; await (onClose?.() ?? close()); return { acknowledged: true, paused: true }; },
      resume() { throw new PluginError('not-admitted'); },
      heartbeat() { return { acknowledged: true, browserLivenessDeadlineAt: deadlineAt }; },
      close: () => onClose?.() ?? close(),
    };
    relay.attach(api);
    const owned = async (_grant, token) => {
      try { return token === owner && !stopped && await authorize(); } catch { return false; }
    };
    networkRelay = createComposedRelayRoute({ authenticate: p.authenticateRelay, origin: p.relayOrigin, authorize: owned,
      async connect(grant, token) { if (!await owned(grant, token)) throw new PluginError('not-admitted'); return relay.connect(grant); } });
    await voiceOperation(options, () => socket.send(JSON.stringify({ type: 'conversation_initiation_client_data',
      conversation_config_override: { agent: { language: overrides.agent.language, first_message: overrides.agent.firstMessage } } })));
    const pump = (async () => {
      for await (const wire of socket.events) {
        await authorize();
        if (typeof wire !== 'string' || wire.length > 256_000) throw new PluginError('invalid-output');
        let event;
        try { event = JSON.parse(wire); } catch { throw new PluginError('invalid-output'); }
        if (event.type === 'conversation_initiation_metadata') {
          const value = event.conversation_initiation_metadata_event;
          if (format || value?.conversation_id !== record.providerSessionId || value.user_input_audio_format !== 'pcm_16000' ||
            !/^pcm_(16000|22050|24000|44100|48000)$/u.test(value.agent_output_audio_format)) throw new PluginError('invalid-output');
          format = { encoding: 'pcm_s16le', channels: 1, sampleRateHz: Number(value.agent_output_audio_format.slice(4)) };
          metadata.resolve();
        } else if (event.type === 'user_transcript') {
          const text = event.user_transcription_event?.user_transcript;
          if (!format || typeof text !== 'string' || !text.trim() || text.length > 32_768) throw new PluginError('invalid-output');
          if (!firstAudio) p.transcript(text);
        } else if (event.type === 'audio') {
          const value = event.audio_event?.audio_base_64;
          if (!format || typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw new PluginError('invalid-output');
          const bytes = Buffer.from(value, 'base64');
          if (!bytes.byteLength || bytes.byteLength % 2 || bytes.byteLength > 64_000) throw new PluginError('limit');
          firstAudio = true;
          if (output) { p.capture(bytes); relay.audio({ ...stamp(), replyId: `baseline-${event.audio_event.event_id}`,
            format: format.encoding, sampleRateHz: format.sampleRateHz, channels: 1, bytes }); }
        } else if (event.type === 'interruption') await interrupt();
        else if (event.type === 'ping') await voiceOperation(options, () => socket.send(JSON.stringify({ type: 'pong', event_id: event.ping_event?.event_id })));
        else if (event.type === 'client_tool_call' || event.type === 'client_error' || event.error) throw new PluginError('invalid-output');
        // Agent text/metadata/VAD are not authoritative corpus or timing data.
      }
      if (!stopped) throw new PluginError('provider');
    })();
    p.track(pump).catch(() => {
      metadata.reject(new PluginError('provider'));
      if (!stopped) { relay.event({ type: 'waiting', reason: 'provider' }); void (onClose?.() ?? close()).catch(() => {}); }
    });
    await voiceOperation(options, () => metadata.promise);
    return { grant: relay.grant, networkRelay, get format() { return format; }, onClose(fn) { onClose = fn; }, close };
  } catch { await close(); throw new PluginError('provider', 'Baseline setup failed'); }
}
