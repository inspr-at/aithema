import { PluginError } from '../../../packages/core/src/invocation.js';
import { voiceEvents, voiceOperation, assertVoiceSession } from '../../../packages/core/src/live-voice.js';
import { createVoiceLifecycleController } from '../../../packages/core/src/voice-lifecycle-controller.js';
import { manifest } from './manifest.js';
import { voiceOverrides } from './options.js';
export { manifest } from './manifest.js';

const microphoneOwners = new WeakSet();
const stopStream = stream => { for (const track of stream?.getTracks() ?? []) { track.enabled = false; track.stop(); } };

// SDK 1.17.0 requests a preliminary stream and publishes/attaches input before
// onConversationCreated. Guard acquisition for the entire call, including SDK
// device resets. A paused setup receives silence made without a physical device.
function microphoneCapture(mediaDevices, AudioContext) {
  let enabled = true, ended = false, released = false, operations = 0, acquisitionEpoch = 0, context, destination;
  const streams = new Set(), silentStreams = new Set();
  const original = mediaDevices?.getUserMedia, descriptor = mediaDevices && Object.getOwnPropertyDescriptor(mediaDevices, 'getUserMedia');
  if (original && microphoneOwners.has(mediaDevices)) throw new PluginError('unavailable', 'Microphone already owned by a live voice call');
  const silence = () => {
    if (!AudioContext) throw new PluginError('unavailable', 'Device-free voice input unavailable');
    context ??= new AudioContext(); destination ??= context.createMediaStreamDestination();
    const stream = destination.stream.clone(); silentStreams.add(stream); return stream;
  };
  const guarded = async constraints => {
    if (!constraints?.audio) return original.call(mediaDevices, constraints);
    if (ended) throw new PluginError('unavailable', 'Live voice capture ended');
    if (!enabled) return silence();
    const epoch = acquisitionEpoch, stream = await original.call(mediaDevices, constraints);
    // Pause/close can race the permission prompt or native device acquisition.
    if (!enabled || ended || epoch !== acquisitionEpoch) {
      stopStream(stream);
      if (ended) throw new PluginError('unavailable', 'Live voice capture ended');
      return silence();
    }
    streams.add(stream); return stream;
  };
  const restore = () => {
    if (!released || operations) return;
    if (original && mediaDevices.getUserMedia === guarded) {
      if (descriptor) Object.defineProperty(mediaDevices, 'getUserMedia', descriptor);
      else delete mediaDevices.getUserMedia;
      microphoneOwners.delete(mediaDevices);
    }
  };
  if (original) { mediaDevices.getUserMedia = guarded; microphoneOwners.add(mediaDevices); }
  return {
    setEnabled(value) {
      const next = value && !ended;
      if (enabled && !next) acquisitionEpoch++;
      enabled = next;
      for (const stream of streams) {
        if (!enabled) stopStream(stream);
        if (stream.getTracks().every(track => track.readyState === 'ended')) streams.delete(stream);
      }
    },
    async run(operation) {
      operations++;
      try { return await operation(); } finally { operations--; restore(); }
    },
    end() {
      ended = true; this.setEnabled(false);
      for (const stream of silentStreams) stopStream(stream);
      stopStream(destination?.stream); void context?.close().catch(() => {});
    },
    release() { released = true; restore(); },
  };
}

/** Browser ESM; inject Conversation, or resolve @elevenlabs/client with a host import map. */
export function createElevenLabsClient({ sdk, control, persistEvent, workletPaths, closeTimeoutMs = 45_000,
  mediaDevices = globalThis.navigator?.mediaDevices, AudioContext = globalThis.AudioContext,
  persistenceTimeoutMs = 2000, persistenceRetries = 2, persistenceBackoffMs = 100, drainTimeoutMs = 5000 } = {}) {
  if (!control?.start || !control?.close || !control?.pause || !control?.resume || !control?.heartbeat ||
    typeof persistEvent !== 'function' || ![closeTimeoutMs, persistenceTimeoutMs, drainTimeoutMs].every(value => Number.isFinite(value) && value > 0) ||
    !Number.isSafeInteger(persistenceRetries) || persistenceRetries < 0 || persistenceRetries > 5 ||
    !Number.isFinite(persistenceBackoffMs) || persistenceBackoffMs < 0) throw new TypeError('Voice control, durable persistence and valid timeouts required');
  const getSdk = async () => sdk ?? (await import('@elevenlabs/client')).Conversation;
  return {
    manifest,
    async health(options) { return voiceOperation(options, async () => ({ available: typeof (await getSdk())?.startSession === 'function' })); },
    closeWaiting: (identity, options) => voiceOperation(options, opts => control.close({ ...identity, reason: options?.reason ?? 'closed' }, opts)),
    async start(request, options = {}) {
      const events = voiceEvents();
      let conversation, capture, grant, generation = 0, ended = false, closing, delivery = Promise.resolve(), commands = Promise.resolve();
      let inputOn = true, outputOn = true, paused = false, transportBlocked = false, playbackInterrupted = false, sequence = 0, checkpointSequence = 0, pauseRevision = 0, persistenceFailed = false;
      const commandCancellation = new AbortController(), interruptionWaiters = new Set();
      const persistenceCancellation = new AbortController();
      const seen = new Set(), assistants = new Map(), stoppedInputs = new WeakSet();
      const identity = () => ({ callId: request.callId, providerSessionId: grant?.providerSessionId });
      const pauseControl = opts => {
        const pauseRequestId = crypto.randomUUID();
        options.onPauseRequest?.(pauseRequestId);
        return control.pause({ ...identity(), pauseRequestId }, opts);
      };
      const outputVolume = () => ended || paused || transportBlocked || !outputOn || playbackInterrupted ? 0 : 1;
      const stopPersistence = () => persistenceCancellation.abort();
      const persist = async value => {
        const signal = persistenceCancellation.signal;
        for (let attempt = 0; ; attempt++) {
          signal.throwIfAborted();
          try {
            await voiceOperation({ signal, deadlineAt: Date.now() + persistenceTimeoutMs }, opts => persistEvent(value, opts));
            return;
          } catch (error) {
            // Refused authority must never be retried. Network errors, timeouts and 5xx may recover.
            if (signal.aborted || error.status === 403 || error.code === 'not-admitted' ||
              error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status) || attempt >= persistenceRetries) throw error;
            await voiceOperation({ signal }, opts => new Promise((resolve, reject) => {
              const aborted = () => { clearTimeout(timer); reject(opts.signal.reason); };
              const timer = setTimeout(() => { opts.signal.removeEventListener('abort', aborted); resolve(); },
                Math.min(1000, persistenceBackoffMs * 2 ** attempt));
              opts.signal.addEventListener('abort', aborted, { once: true });
            }));
          }
        }
      };
      const emit = (event, expose = true) => {
        const value = Object.freeze({ ...event, ...identity() });
        const captured = ++checkpointSequence;
        if (value.type === 'partial') lifecycle.dispatch({ type: 'partial', sequence: captured });
        delivery = delivery.then(async () => {
          if (persistenceCancellation.signal.aborted) return;
          if (['final', 'heard', 'reply'].includes(value.type)) await persist(value);
          if (value.type === 'final' && value.role === 'user') lifecycle.dispatch({ type: 'accepted', turnId: value.turnId, sequence: captured });
          if (value.type === 'final' && value.role === 'assistant') lifecycle.dispatch({ type: 'reply', replyId: value.turnId });
          if (value.type === 'heard') lifecycle.dispatch({ type: 'heard', prefix: value.prefix });
          if (expose && !persistenceCancellation.signal.aborted) events.push(value);
        }).catch(() => {
          if (persistenceCancellation.signal.aborted) return;
          persistenceFailed = true; stopPersistence();
          void close('transcript-persistence-failed').catch(() => {});
        });
      };
      const drain = async deadlineAt => {
        try { await voiceOperation({ deadlineAt: Math.min(deadlineAt, Date.now() + drainTimeoutMs) }, () => delivery); }
        catch { persistenceFailed = true; stopPersistence(); }
      };
      const stopCapture = target => {
        const participant = target?.connection?.room?.localParticipant, removals = [];
        for (const publication of participant?.audioTrackPublications.values() ?? []) {
          if (!publication.track) continue;
          publication.track.mediaStreamTrack.enabled = false; publication.track.stop();
          removals.push(participant.unpublishTrack(publication.track, true));
        }
        if (target?.input?.inputStream) {
          stopStream(target.input.inputStream);
          target.input.mediaStreamSource?.disconnect(); stoppedInputs.add(target);
        }
        return Promise.all(removals);
      };
      const channels = async (target = conversation) => {
        try {
          const retired = () => target && target !== conversation;
          const blocked = () => ended || paused || transportBlocked || !inputOn || retired();
          capture?.setEnabled(!blocked());
          if (!target) return;
          if (typeof target.input?.setMuted !== 'function') throw new PluginError('unavailable', 'Awaitable voice input controller required');
          if (blocked()) {
            const stopped = stopCapture(target), muted = target.input.setMuted(true);
            target.setVolume({ volume: retired() ? 0 : outputVolume() });
            await Promise.all([stopped, muted]);
          } else {
            if (stoppedInputs.has(target)) {
              // WebSocket input retains its AudioContext/worklet; reconnect a
              // newly acquired stream only after an acknowledged resume.
              await target.input.setDevice({}); stoppedInputs.delete(target);
            }
            await target.input.setMuted(blocked());
            // A newer pause can arrive while unmute/device acquisition is pending.
            if (blocked()) { await stopCapture(target); await target.input.setMuted(true); }
            target.setVolume({ volume: retired() ? 0 : outputVolume() });
          }
          if (ended) throw new PluginError('unavailable', 'Live voice capture ended');
        } catch (error) { if (!target || target === conversation) void close('pause-failed').catch(() => {}); throw error; }
      };
      const close = (reason = 'closed', commandOptions = {}, recoveryAttempts) => {
        if (['cancelled', 'turn-withdrawn', 'upload-withdrawn', 'session-erased', 'consent-revised',
          'call-authorization-lost', 'session-revoked', 'transcript-persistence-failed'].includes(reason)) stopPersistence();
        if (closing) return closing;
        const closeOptions = { ...commandOptions, deadlineAt: Math.min(commandOptions.deadlineAt ?? Infinity, Date.now() + closeTimeoutMs) };
        ended = true; generation++; lifecycle.end(reason); options.signal?.removeEventListener('abort', cancel);
        options.holdSignal?.removeEventListener('abort', retainHold);
        commandCancellation.abort();
        // Privacy does not depend on asynchronous SDK cleanup or provider settlement.
        capture?.end();
        try { void Promise.resolve(conversation?.setVolume({ volume: outputVolume() })).catch(() => {}); } catch {}
        try { void stopCapture(conversation).catch(() => {}); } catch {}
        try { void Promise.resolve(conversation?.connection?.close?.()).catch(() => {}); } catch {}
        closing = (async () => {
          try { await voiceOperation({ ...closeOptions, deadlineAt: Math.min(closeOptions.deadlineAt, Date.now() + 1000) },
            () => capture ? capture.run(() => conversation?.endSession()) : conversation?.endSession()); }
          catch { /* Server closure remains authoritative. */ }
          capture?.release();
          // Leave closure time after a bounded drain; never revoke accepted events first.
          const remaining = Math.max(0, closeOptions.deadlineAt - Date.now());
          if (!persistenceCancellation.signal.aborted) await drain(closeOptions.deadlineAt - Math.min(1000, remaining / 2));
          stopPersistence();
          if (persistenceFailed) reason = 'transcript-persistence-failed';
          let terminal;
          try { if (grant) terminal = await voiceOperation(closeOptions, opts => control.close({ ...identity(), reason,
            ...(recoveryAttempts !== undefined ? { recoveryAttempts } : {}) }, opts)); }
          finally {
            events.push({ type: 'ended', callId: request.callId,
              reason: terminal?.closureConfirmed ? reason : 'closure-uncertain' }); events.end();
          }
          return terminal;
        })();
        return closing;
      };
      const cancel = () => { void close('cancelled', { deadlineAt: Date.now() + 1000 }).catch(() => {}); };
      const connect = async (receipt, connectOptions) => {
        const current = ++generation;
        playbackInterrupted = false;
        let lastInterruptionId = -1, latestAssistantId = -1, userTurnOrdinal = 0;
        const replyIds = new Map();
        if (receipt?.callId !== request.callId || !receipt.providerSessionId || !receipt.credential ||
          !Number.isFinite(receipt.credential.ttlMs) || receipt.credential.ttlMs <= 0 || receipt.credential.ttlMs > 60_000 ||
          receipt.credential.providerSessionId !== receipt.providerSessionId) throw new PluginError('invalid-output', 'Invalid voice credential receipt');
        const credentialDeadlineAt = Date.now() + receipt.credential.ttlMs;
        const { connectionType, signedUrl, conversationToken } = receipt.credential;
        if (connectionType === 'websocket' ? typeof signedUrl !== 'string' || !signedUrl || conversationToken !== undefined
          : connectionType !== 'webrtc' || typeof conversationToken !== 'string' || !conversationToken || signedUrl !== undefined) throw new PluginError('invalid-output', 'Invalid voice credential transport');
        if (![receipt.spendDeadlineAt, receipt.browserLivenessDeadlineAt].every(Number.isFinite)) throw new PluginError('invalid-output', 'Missing server voice deadlines');
        grant = receipt; transportBlocked = false;
        const active = () => generation === current && !ended;
        const observeAssistant = eventId => {
          if (!active() || !Number.isSafeInteger(eventId) || eventId < 0) return;
          latestAssistantId = Math.max(latestAssistantId, eventId);
          if (playbackInterrupted && eventId > lastInterruptionId) {
            playbackInterrupted = false;
            conversation?.setVolume({ volume: outputVolume() });
          }
        };
        let creationChannels;
        const callbacks = {
          onConversationCreated(created) {
            if (!active()) { void capture.run(() => created.endSession()).catch(() => {}); return; }
            conversation = created;
            const participant = created.connection?.room?.localParticipant;
            if (typeof participant?.setMicrophoneEnabled === 'function') {
              const setMicrophoneEnabled = participant.setMicrophoneEnabled;
              participant.setMicrophoneEnabled = (enabled, ...args) => {
                // An SDK unmute can reach this native port after its transport retired.
                if (enabled && (!active() || paused || transportBlocked || !inputOn)) return Promise.resolve();
                return setMicrophoneEnabled.call(participant, enabled, ...args);
              };
            }
            if (created.input?.setDevice) {
              const setDevice = created.input.setDevice;
              created.input.setDevice = (...args) => {
                // WebSocket permission changes also call this method. An old
                // generation may never reacquire after its acquisition guard retires.
                if (!active() || paused || transportBlocked || !inputOn) return Promise.resolve();
                return capture.run(() => setDevice.apply(created.input, args));
              };
            }
            if (connectionType === 'websocket' && created.connection) {
              const send = created.connection.sendMessage;
              created.connection.sendMessage = function (message) {
                // Worklet messages already queued before pause must not escape.
                if ('user_audio_chunk' in message && (!active() || paused || transportBlocked || !inputOn)) return;
                return send.call(this, message);
              };
              // SDK 1.17.0 keeps rendering queued PCM until clearInterrupted;
              // its default interrupt schedules that clear after a two-second
              // fade. Flush in the native hook, before another buffer arrives.
              const interrupt = created.output?.interrupt;
              if (interrupt && created.output.worklet?.port) {
                created.output.interrupt = function () {
                  interrupt.call(this, 0);
                  this.worklet.port.postMessage({ type: 'clearInterrupted' });
                  this.gain.gain.cancelScheduledValues(this.context.currentTime);
                  this.setVolume(outputVolume());
                };
              }
            }
            if (typeof created.connection?.handleMessage === 'function') {
              const handleMessage = created.connection.handleMessage;
              created.connection.handleMessage = function (message) {
                if (!active()) return;
                const interruptedId = message?.interruption_event?.event_id;
                // Fence the SDK as well as our callback: a duplicate native
                // interruption would otherwise flush a newer reply's queue.
                if (message?.type === 'interruption' && Number.isSafeInteger(interruptedId) &&
                  (interruptedId <= lastInterruptionId || interruptedId < latestAssistantId)) return;
                const audioId = message?.audio_event?.event_id;
                // WebSocketConnection forwards audio to output listeners even
                // when VoiceConversation rejects it as stale. Unlock before
                // both paths enqueue the first fresh chunk. WebRTC data-channel
                // audio carries alignment; its local analyser events do not
                // (SDK WebRTCConnection.js:292-310,435-449).
                if (message?.type === 'audio' &&
                  (connectionType === 'websocket' || message.audio_event?.alignment)) {
                  if (lastInterruptionId >= 0 && (!Number.isSafeInteger(audioId) ||
                    audioId <= lastInterruptionId || audioId < latestAssistantId)) return;
                  observeAssistant(audioId);
                }
                return handleMessage.call(this, message);
              };
            }
            creationChannels = capture.run(() => channels(created)); creationChannels.catch(() => {});
          },
          onConnect({ conversationId }) {
            if (active() && conversationId !== receipt.providerSessionId) void close('provider-identity-mismatch').catch(() => {});
          },
          onModeChange({ mode }) { if (active() && ['listening', 'speaking'].includes(mode)) emit({ type: mode }); },
          onAgentChatResponsePart({ event_id: eventId, type, text }) {
            // Provider stream starts/deltas precede the final response and
            // identify the reply, unlike speaking mode or analyser counters.
            if (connectionType === 'webrtc' && typeof text === 'string' &&
              (type === 'start' || type === 'delta' && text.trim())) observeAssistant(eventId);
          },
          onMessage({ role, message, event_id: eventId }) {
            if (!active() || !['user', 'agent'].includes(role) || typeof message !== 'string' || !message.trim()) return;
            if (role === 'agent') observeAssistant(eventId);
            const speaker = role === 'agent' ? 'assistant' : 'user';
            const turnId = `${receipt.providerSessionId}:${speaker}:${eventId ?? `callback-${++sequence}`}`;
            if (seen.has(turnId)) return;
            if (seen.size >= 4096) { void close('transcript-limit').catch(() => {}); return; }
            seen.add(turnId);
            // Capture order belongs to this provider generation, before async
            // persistence. Paused finals leave a gap instead of shifting IDs.
            const ordinal = speaker === 'user' ? ++userTurnOrdinal : undefined;
            if (paused) return;
            if (speaker === 'assistant') {
              assistants.set(turnId, { text: message, eventId, replyId: replyIds.get(eventId) });
              if (assistants.size > 256) assistants.delete(assistants.keys().next().value);
            }
            emit({ type: 'final', turnId, role: speaker, text: message,
              ...(ordinal !== undefined ? { userTurnOrdinal: ordinal } : {}),
              ...(speaker === 'assistant' && replyIds.get(eventId) ? { replyId: replyIds.get(eventId) } : {}),
              ...(eventId !== undefined ? { event_id: eventId } : {}) });
          },
          onAgentResponseCorrection({ event_id: eventId, original_agent_response: original, corrected_agent_response: prefix }) {
            if (!active() || typeof original !== 'string' || typeof prefix !== 'string' || !original.startsWith(prefix)) return;
            const turnId = `${receipt.providerSessionId}:assistant:${eventId}`;
            const turn = assistants.get(turnId);
            // A callback for a different/unknown turn cannot manufacture a heard prefix.
            if (turn?.text !== original) return;
            emit({ type: 'heard', turnId, prefix });
          },
          onDebug(event) {
            // SDK 1.17.0 forwards this documented custom-LLM client event
            // through onDebug. The provider event ID ties metadata to its final,
            // even when identical replies finish or persist in another order.
            if (!active()) return;
            const metadata = event?.agent_response_metadata_event;
            const replyId = metadata?.metadata?.aithema_reply_id, eventId = metadata?.event_id;
            if (event?.type === 'agent_response_metadata' && Number.isSafeInteger(eventId) && eventId >= 0 &&
              typeof replyId === 'string' && /^chatcmpl-[a-zA-Z0-9_-]{1,100}$/u.test(replyId)) {
              replyIds.set(eventId, replyIds.has(eventId) && replyIds.get(eventId) !== replyId ? null : replyId);
              if (replyIds.size > 256) replyIds.delete(replyIds.keys().next().value);
              const turnId = `${receipt.providerSessionId}:assistant:${eventId}`, prior = assistants.get(turnId);
              if (replyIds.get(eventId) && prior && prior.replyId !== replyId) {
                prior.replyId = replyId;
                emit({ type: 'reply', turnId, replyId }, false);
              }
            }
            const text = event?.tentative_user_transcription_event?.user_transcript;
            if (active() && !paused && event.type === 'tentative_user_transcript' && typeof text === 'string') {
              emit({ type: 'partial', turnId: `${receipt.providerSessionId}:user:pending`, role: 'user', text });
            }
          },
          onInterruption({ event_id: eventId }) {
            if (active() && Number.isSafeInteger(eventId) && eventId >= 0 && eventId > lastInterruptionId && eventId >= latestAssistantId) {
              lastInterruptionId = eventId; playbackInterrupted = true;
              // WebRTC's native interrupt is a no-op. Mute its actual audio
              // elements (and WebSocket gain) synchronously, outside persistence
              // and the command queue. Only a newer agent reply lifts this gate.
              conversation?.setVolume({ volume: outputVolume() });
              for (const waiter of interruptionWaiters) waiter();
            }
            // Only the correction callback supplies heard text; interruption never invents it.
          },
          onDisconnect(details) {
            if (!active()) return;
            // Only the SDK's explicit end_call context establishes provider intent;
            // close codes and other diagnostic reasons remain recovery cases.
            if (details?.reason === 'agent' && details.context?.type === 'end_call') void close('provider-end').catch(() => {});
            else void lifecycle.recover().catch(() => {});
          },
          onError(message, context) {
            if (active() && message === 'Failed to set input muted state') {
              void close('pause-failed').catch(() => {}); return;
            }
            // SDK 1.17.0 emits tool/server/end-session contexts here; recovery relies on onDisconnect.
            if (active() && (context?.name === 'SessionConnectionError' ||
              ['connection_state_changed', 'socket_error', 'websocket_error', 'transport_error'].includes(context?.type))) void lifecycle.recover().catch(() => {});
          },
        };
        const implementation = await getSdk();
        if (!active()) throw new PluginError('cancelled');
        capture ??= microphoneCapture(mediaDevices, AudioContext);
        capture.setEnabled(!paused && inputOn);
        const pending = capture.run(() => implementation.startSession({
          ...(receipt.credential.connectionType === 'websocket'
            ? { signedUrl: receipt.credential.signedUrl, connectionType: 'websocket' }
            : { conversationToken: receipt.credential.conversationToken, connectionType: 'webrtc' }),
          customLlmExtraBody: { aithema_call: receipt.facadeCallId ?? request.callId },
          ...(receipt.overrides ? { overrides: voiceOverrides(receipt.overrides) } : {}),
          ...(workletPaths ? { workletPaths } : {}), ...callbacks,
        }));
        // A late successful SDK connection after a deadline must still be torn down.
        Promise.resolve(pending).then(late => { if (!active()) void capture.run(() => late.endSession()).catch(() => {}); }, () => {});
        conversation = await voiceOperation({ ...connectOptions,
          deadlineAt: Math.min(connectOptions?.deadlineAt ?? Infinity, credentialDeadlineAt) }, () => pending);
        if (!active()) throw new PluginError('cancelled');
        if (conversation.getId() !== receipt.providerSessionId) throw new PluginError('invalid-output', 'Provider identity mismatch');
        await (creationChannels ?? capture.run(() => channels()));
        if (paused) {
          const ack = await voiceOperation(connectOptions, pauseControl);
          if (ack?.acknowledged !== true || ack.paused !== true) throw new PluginError('invalid-output', 'Pause not acknowledged');
        }
      };
      let recoveryIdentity;
      const stopMedia = () => {
        transportBlocked = true; generation++;
        capture?.setEnabled(false);
        try { conversation?.setVolume({ volume: outputVolume() }); } catch {}
        try { void stopCapture(conversation).catch(() => {}); } catch {}
        try { void Promise.resolve(conversation?.connection?.close?.()).catch(() => {}); } catch {}
      };
      const lifecycle = createVoiceLifecycleController({ callId: request.callId, stopMedia,
        terminal: reason => { void close(reason).catch(() => {}); }, onEvent: event => emit(event),
        async renew(opts) {
          const previous = identity();
          const ack = await voiceOperation({ ...opts,
            signal: opts?.signal ? AbortSignal.any([opts.signal, commandCancellation.signal]) : commandCancellation.signal,
            deadlineAt: Math.min(opts?.deadlineAt ?? Infinity, grant.spendDeadlineAt, grant.browserLivenessDeadlineAt),
          }, bounded => control.heartbeat(previous, bounded));
          if (!ended && !transportBlocked && grant.providerSessionId === previous.providerSessionId && Number.isFinite(ack?.browserLivenessDeadlineAt)) {
            grant = { ...grant, browserLivenessDeadlineAt: ack.browserLivenessDeadlineAt };
          }
          return ack;
        },
        async beforeRecovery() {
          recoveryIdentity = identity();
          try { await voiceOperation({ deadlineAt: Date.now() + 1000 }, () => conversation?.endSession()); } catch {}
          await drain(Math.min(grant.spendDeadlineAt, Date.now() + drainTimeoutMs));
          if (ended) return;
          if (persistenceFailed) { await close('transcript-persistence-failed'); return; }
          try { await voiceOperation({ deadlineAt: Date.now() + 1000 }, opts => control.close({ ...recoveryIdentity, reason: 'transport-lost' }, opts)); } catch {}
        },
        async replace() {
          if (ended || !control.recover) throw new PluginError('unavailable');
          // Every replacement is server-admitted, in its own callback key space.
          const opts = { signal: commandCancellation.signal, deadlineAt: Math.min(grant.spendDeadlineAt, Date.now() + 10_000) };
          const receipt = await voiceOperation(opts, bounded => control.recover(recoveryIdentity, bounded));
          if (ended) throw new PluginError('cancelled');
          await connect(receipt, opts); return receipt;
        },
        async failedReplacement() {
          stopMedia();
          try { await voiceOperation({ deadlineAt: Date.now() + 1000 }, () => conversation?.endSession()); } catch {}
          if (grant.providerSessionId !== recoveryIdentity.providerSessionId) {
            try { await voiceOperation({ deadlineAt: Date.now() + 1000 }, opts => control.close({ ...identity(), reason: 'recovery-failed' }, opts)); } catch {}
          }
        },
        async persistWaiting({ reason, attempts }) {
          await voiceOperation({ deadlineAt: Date.now() + 5000 }, opts => control.close({ ...identity(), reason, recoveryAttempts: attempts }, opts));
        },
      });
      const retainHold = () => {
        if (ended) return;
        paused = true; pauseRevision++; lifecycle.pause('hide');
        capture?.setEnabled(false);
        if (conversation) void capture.run(() => channels()).catch(() => {});
      };
      const command = (name, fn, duringRecovery = false) => commandOptions => {
        const run = commands.then(() => {
          if (ended || lifecycle.recovering && !duringRecovery) throw new PluginError('unavailable', `Live voice ${name} unavailable while ended or recovering`);
          return voiceOperation({ ...commandOptions,
          signal: commandOptions?.signal ? AbortSignal.any([commandOptions.signal, commandCancellation.signal]) : commandCancellation.signal,
          deadlineAt: Math.min(commandOptions?.deadlineAt ?? Infinity, grant.spendDeadlineAt,
            lifecycle.state.needsRecovery ? Infinity : grant.browserLivenessDeadlineAt),
        }, async opts => {
          if (duringRecovery && lifecycle.recovering) await lifecycle.recovering;
          if (ended || lifecycle.recovering) throw new PluginError('unavailable', `Live voice ${name} unavailable while ended or recovering`);
          return fn(opts);
        }); }); commands = run.catch(() => {}); return run;
      };
      try {
        // Cancellation owns media teardown throughout startup, including the
        // restored call's pending server Resume acknowledgement.
        options.signal?.addEventListener('abort', cancel, { once: true });
        if (options.signal?.aborted) { cancel(); throw new PluginError('cancelled'); }
        options.holdSignal?.addEventListener('abort', retainHold, { once: true });
        await voiceOperation(options, async opts => {
          const revision = pauseRevision;
          lifecycle.dispatch({ type: 'start' });
          if (options.holdSignal?.aborted) retainHold();
          if (request.providerSessionId) { paused = true; lifecycle.pause('waiting'); }
          const receipt = request.providerSessionId
            ? await control.recover({ callId: request.callId, providerSessionId: request.providerSessionId }, opts) : await control.start(request, opts);
          await connect(receipt, opts); lifecycle.connected(receipt);
          if (request.providerSessionId && !options.holdSignal?.aborted) {
            const ack = await control.resume(identity(), opts);
            if (ended || opts.signal.aborted) throw new PluginError('cancelled');
            if (ack?.acknowledged !== true || ack.paused !== false) throw new PluginError('invalid-output', 'Resume not acknowledged');
            if (revision !== pauseRevision) throw new PluginError('unavailable', 'New pause requested while resuming');
            paused = false; lifecycle.resumed(); await capture.run(() => channels());
            if (revision !== pauseRevision) throw new PluginError('unavailable', 'New pause requested while resuming');
          }
        });
        if (options.signal?.aborted) { cancel(); throw new PluginError('cancelled'); }
        const session = {
          audioLevels: () => ({ input: paused || transportBlocked || !inputOn ? 0 : conversation?.getInputVolume?.() ?? 0,
            output: outputVolume() === 0 ? 0 : conversation?.getOutputVolume?.() ?? 0 }),
          callId: request.callId, get providerSessionId() { return grant.providerSessionId; }, events, lifecycle,
          close: commandOptions => close(commandOptions?.reason ?? 'closed', commandOptions),
          pause(commandOptions) {
            if (ended) return Promise.reject(new PluginError('unavailable'));
            paused = true; pauseRevision++; lifecycle.pause();
            const muted = capture.run(() => channels()); muted.catch(() => {});
            return command('pause', async opts => {
              await muted;
              const ack = await pauseControl(opts);
              if (ack?.acknowledged !== true || ack.paused !== true) throw new PluginError('invalid-output', 'Pause not acknowledged');
              return ack;
            }, true)(commandOptions);
          },
          resume(commandOptions) {
            const revision = pauseRevision;
            return command('resume', async opts => {
              if (lifecycle.state.needsRecovery) {
                // Replace while still muted; only the following server Resume unlocks media.
                paused = true;
                if (!await lifecycle.recover({ explicit: true })) throw new PluginError('unavailable');
              }
              const ack = await control.resume(identity(), opts);
              if (ended || opts.signal.aborted) throw new PluginError('cancelled');
              if (ack?.acknowledged !== true || ack.paused !== false) throw new PluginError('invalid-output', 'Resume not acknowledged');
              if (revision !== pauseRevision) throw new PluginError('unavailable', 'New pause requested while resuming');
              paused = false; lifecycle.resumed(); await capture.run(() => channels());
              if (revision !== pauseRevision) throw new PluginError('unavailable', 'New pause requested while resuming');
              return ack;
            }, true)(commandOptions);
          },
          setInput(on, opts) { return command('setInput', () => { if (typeof on !== 'boolean') throw new TypeError('Input boolean required'); inputOn = on; return capture.run(() => channels()); })(opts); },
          setOutput(on, opts) { return command('setOutput', () => { if (typeof on !== 'boolean') throw new TypeError('Output boolean required'); outputOn = on; return capture.run(() => channels()); })(opts); },
          sendText(text, opts) { return command('sendText', () => {
            if (paused || transportBlocked) throw new PluginError('not-admitted', 'Voice session paused');
            if (typeof text !== 'string' || !text.trim() || text.length > 16_384) throw new PluginError('limit', 'Invalid voice text');
            conversation.sendUserMessage(text);
          })(opts); },
          updateContext(context, opts) { return command('updateContext', () => {
            const text = typeof context === 'string' ? context : JSON.stringify(context);
            if (!text || text.length > 16_384) throw new PluginError('limit', 'Invalid voice context');
            conversation.sendContextualUpdate(text);
          })(opts); },
          interrupt: command('interrupt', async opts => {
            if (paused || transportBlocked || !inputOn) throw new PluginError('unavailable', 'Live voice interrupt requires active microphone input');
            let waiter, aborted;
            try {
              // SDK 1.17.0 exposes native barge-in callbacks, not an imperative force-interrupt API.
              // Acknowledge actual provider interruption; user_activity cannot prove interruption.
              await new Promise((resolve, reject) => {
                waiter = resolve; interruptionWaiters.add(waiter);
                aborted = () => reject(new PluginError('cancelled'));
                opts.signal.addEventListener('abort', aborted, { once: true });
                if (opts.signal.aborted) aborted();
              });
            } finally { interruptionWaiters.delete(waiter); opts.signal.removeEventListener('abort', aborted); }
          }),
          heartbeat: opts => lifecycle.heartbeat(opts),
        };
        return assertVoiceSession(session);
      } catch (error) {
        // Stop media before any failed-start/exhaustion POST. Preserve durable
        // waiting on restored startup failure; explicit cancellation is terminal.
        const attempts = request.providerSessionId && grant && !ended ? 3 : undefined;
        try { await close(request.providerSessionId ? 'recovery-failed' : 'start-failed', { deadlineAt: Date.now() + 1000 }, attempts); }
        catch { /* The server lease and reconciliation retain unresolved closure. */ }
        throw error;
      }
    },
  };
}
