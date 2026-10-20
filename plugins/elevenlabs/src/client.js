import { PluginError } from '../../../packages/core/src/invocation.js';
import { voiceEvents, voiceOperation, assertVoiceSession } from '../../../packages/core/src/live-voice.js';
import { createVoiceLifecycleController } from '../../../packages/core/src/voice-lifecycle-controller.js';
import { manifest } from './manifest.js';
import { watchVoicePlayback } from './playback.js';
import { createReplyReplay } from '../../../packages/core/src/reply-replay.js';
import { playReplyAudio } from '../../../packages/ui/src/reply-audio.js';
import { createPageReplay } from '../../../packages/ui/src/page-replay.js';
import { voiceOverrides, createElevenLabsBrowserMedia, elevenLabsComponents } from './options.js';
export { elevenLabsMediaGrant } from './options.js';
export { manifest } from './manifest.js';

const microphoneOwners = new WeakSet();
const stopStream = stream => { for (const track of stream?.getTracks() ?? []) { track.enabled = false; track.stop(); } };

// SDK 1.17.0 requests a preliminary stream and publishes/attaches input before
// onConversationCreated. Guard acquisition for the entire call, including SDK
// device resets. A paused setup receives silence made without a physical device.
function microphoneCapture(mediaDevices, AudioContext, onMicrophoneState, permissions) {
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
    const epoch = acquisitionEpoch;
    let stream;
    try {
      let permission;
      try { permission = await permissions?.query({ name: 'microphone' }); } catch { /* Some browsers omit this permission query. */ }
      if (ended) throw new PluginError('cancelled');
      if (!enabled || epoch !== acquisitionEpoch) return silence();
      if (!permission || permission.state === 'prompt') onMicrophoneState?.('requesting');
      stream = await original.call(mediaDevices, constraints);
    } catch (error) { error.phase = 'microphone'; throw error; }
    // Pause/close can race the permission prompt or native device acquisition.
    if (!enabled || ended || epoch !== acquisitionEpoch) {
      stopStream(stream);
      if (ended) throw new PluginError('unavailable', 'Live voice capture ended');
      return silence();
    }
    onMicrophoneState?.('granted');
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
export function createElevenLabsClient(ports = {}) {
  const { sdk, control, persistEvent, workletPaths, closeTimeoutMs = 45_000,
  mediaDevices = globalThis.navigator?.mediaDevices, AudioContext = globalThis.AudioContext,
  document = globalThis.document, permissions = globalThis.navigator?.permissions,
  persistenceTimeoutMs = 2000, persistenceRetries = 2, persistenceBackoffMs = 100, drainTimeoutMs = 5000 } = ports;
  if (!control?.start || !control?.close || !control?.pause || !control?.resume || !control?.heartbeat ||
    typeof persistEvent !== 'function' || ![closeTimeoutMs, persistenceTimeoutMs, drainTimeoutMs].every(value => Number.isFinite(value) && value > 0) ||
    !Number.isSafeInteger(persistenceRetries) || persistenceRetries < 0 || persistenceRetries > 5 ||
    !Number.isFinite(persistenceBackoffMs) || persistenceBackoffMs < 0) throw new TypeError('Voice control, durable persistence and valid timeouts required');
  const getSdk = async () => sdk ?? (await import('@elevenlabs/client')).Conversation;
  const pageReplay = createPageReplay({ control, document, playAudio: ports.playAudio ?? playReplyAudio });
  const client = {
    manifest,
    replayReply: (reply, opts) => pageReplay.replay(reply, opts),
    stopReplay: () => pageReplay.stop(),
    tabId: control.tabId,
    takeover: (identity, options) => voiceOperation(options, opts => control.takeover({ ...identity, explicit: true }, opts)),
    async health(options) { return voiceOperation(options, async () => ({ available: typeof (await getSdk())?.startSession === 'function' })); },
    closeWaiting: (identity, options) => voiceOperation(options, opts => control.close({ ...identity, reason: options?.reason ?? 'closed' }, opts)),
    async start(request, options = {}) {
      pageReplay.stop();
      // The capable host owns preparation/S3 guards. A permission decision has
      // no clock deadline, including voiceOperation's default 30-second scope.
      const startupOperation = async (opts, operation) => {
        if (!options.onMicrophoneState || opts?.deadlineAt !== undefined) return voiceOperation(opts, operation);
        const signal = opts?.signal ?? new AbortController().signal;
        let abort;
        try {
          signal.throwIfAborted();
          return await Promise.race([Promise.resolve().then(() => operation({ ...opts, signal })), new Promise((_, reject) => {
            abort = () => reject(new PluginError(signal.reason?.name === 'TimeoutError' ? 'deadline' : 'cancelled'));
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          })]);
        } finally { signal.removeEventListener('abort', abort); }
      };
      const events = voiceEvents();
      const playback = document?.defaultView?.MutationObserver && document.body
        ? watchVoicePlayback(document, () => options.onPlaybackBlocked?.(() => playback.retry())) : undefined;
      let conversation, capture, grant, generation = 0, ended = false, closing, delivery = Promise.resolve(), persistence = Promise.resolve(), commands = Promise.resolve();
      let inputOn = true, outputOn = true, paused = false, transportBlocked = false, playbackInterrupted = false, sequence = 0, checkpointSequence = 0, pauseRevision = 0, persistenceFailed = false;
      const commandCancellation = new AbortController(), interruptionWaiters = new Set();
      const persistenceCancellation = new AbortController();
      const seen = new Set(), assistants = new Map(), stoppedInputs = new WeakSet();
      let lastReply, lastPlaybackTurnId, lastActivity, capturePhase;
      let silenceReply = () => {};
      const identity = () => ({ callId: request.callId, providerSessionId: grant?.providerSessionId,
        ...(grant?.epoch !== undefined ? { epoch: grant.epoch } : {}) });
      const pauseControl = opts => {
        const pauseRequestId = crypto.randomUUID();
        options.onPauseRequest?.(pauseRequestId);
        return control.pause({ ...identity(), pauseRequestId }, opts);
      };
      const resumeControl = opts => {
        const resumeRequestId = crypto.randomUUID();
        (opts?.onResumeRequest ?? options.onResumeRequest)?.(resumeRequestId);
        return control.resume({ ...identity(), resumeRequestId }, opts);
      };
      const outputVolume = () => ended || paused || transportBlocked || !outputOn || playbackInterrupted ? 0 : 1;
      const replay = createReplyReplay({
        current: reply => !ended && !paused && !transportBlocked && outputOn && !lifecycle.state.holds.length &&
          reply.turnId === lastReply?.turnId && reply.text === lastReply?.text && (!lastPlaybackTurnId || lastPlaybackTurnId === reply.turnId),
        synthesize: (reply, opts) => control.speakText?.({ ...identity(), turnId: reply.turnId, replayId: opts.replayId }, opts),
        release: replayId => control.stopReplyReplay?.({ ...identity(), replayId }),
        playAudio: (audio, opts) => {
          conversation?.output?.interrupt?.(0);
          playbackInterrupted = false; conversation?.setVolume({ volume: outputVolume() });
          return (ports.playAudio ?? playReplyAudio)(audio, { ...opts, conversation, document, AudioContext });
        },
        onState: (playing, detail) => { if (!ended) emit({ type: playing ? 'speaking' : 'listening', replay: true, completed: Boolean(detail?.completed) }); },
      });
      const stopReplayForInput = () => { if (replay.active) { silenceReply(); replay.stop(); } };
      const stopPersistence = () => persistenceCancellation.abort();
      const persist = async (value, write = persistEvent) => {
        const signal = persistenceCancellation.signal;
        for (let attempt = 0; ; attempt++) {
          signal.throwIfAborted();
          try {
            await voiceOperation({ signal, deadlineAt: Date.now() + persistenceTimeoutMs }, opts => write(value, opts));
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
        const activityChanged = ['speaking', 'listening'].includes(value.type) && value.type !== lastActivity;
        if (activityChanged) {
          lastActivity = value.type;
          lifecycle.dispatch({ type: 'playback', active: value.type === 'speaking' });
        }
        if (value.type === 'partial') lifecycle.dispatch({ type: 'partial', sequence: captured });
        // Playback acknowledgements must not hold captured finals behind a
        // network round trip: Pause can reach the server while they wait.
        const saved = ['final', 'heard', 'reply'].includes(value.type)
          ? (persistence = persistence.then(() => persist(value)))
          : value.type === 'interrupted' && control.reportActivity
            ? (persistence = persistence.then(() => persist(value, (value, opts) => control.reportActivity(value, opts)))) : null;
        saved?.catch(() => {}); // Delivery owns failure handling below.
        delivery = delivery.then(async () => {
          if (persistenceCancellation.signal.aborted) return;
          if (activityChanged && control.reportActivity) {
            await voiceOperation({ signal: persistenceCancellation.signal, deadlineAt: Date.now() + persistenceTimeoutMs }, opts => control.reportActivity(value, opts));
            // A mode can enable Pause immediately. Persist finals already
            // captured by this point before exposing that mode to the host.
            await persistence;
          }
          if (saved) await saved;
          if (value.type === 'final' && value.role === 'user') lifecycle.dispatch({ type: 'accepted', turnId: value.turnId, sequence: captured });
          if (value.type === 'final' && value.role === 'assistant') {
            lastReply = { turnId: value.turnId, text: value.text };
            lifecycle.dispatch({ type: 'reply', replyId: value.turnId });
          }
          if (value.type === 'heard' && value.turnId === lastReply?.turnId) lastReply = { ...lastReply, text: value.prefix };
          // Corrections remain durable transcript evidence for their own turn.
          // A queued/late correction for A cannot establish B's playback position.
          if (value.type === 'heard' && value.turnId === lastPlaybackTurnId) lifecycle.dispatch({ type: 'heard', prefix: value.prefix });
          if (expose && !persistenceCancellation.signal.aborted) {
            const checkpoint = lifecycle.state.checkpoint;
            events.push(value.type === 'recovered' ? { ...value, recovery: {
              userUnconfirmed: checkpoint.userUnconfirmed, deliveryUncertain: checkpoint.deliveryUncertain,
              playbackPositionUnknown: checkpoint.deliveryUncertain && checkpoint.heardPrefix === null,
              lastReplyTurnId: lastReply?.turnId ?? null,
              lastReplyText: lastReply && (!lastPlaybackTurnId || lastPlaybackTurnId === lastReply.turnId) ? lastReply.text : null,
            } } : value);
          }
        }).catch(error => {
          if (persistenceCancellation.signal.aborted) return;
          if (error.code === 'voice-ownership-lost') { lifecycle.ownershipLost(); return; }
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
        playback?.destroy();
        ended = true; replay.stop(); generation++; lifecycle.end(reason); options.signal?.removeEventListener('abort', cancel);
        options.holdSignal?.removeEventListener('abort', retainHold);
        document?.removeEventListener('freeze', freeze); document?.removeEventListener('resume', wake);
        document?.removeEventListener('visibilitychange', visible);
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
      const cancel = () => { void close(options.signal?.reason === 'ownership-lost' ? 'recovery-failed' : 'cancelled',
        { deadlineAt: Date.now() + 1000 }).catch(() => {}); };
      const connect = async (receipt, connectOptions) => {
        const current = ++generation;
        playbackInterrupted = false;
        let lastInterruptionId = -1, latestAssistantId = -1, userTurnOrdinal = 0;
        let tentativeOpen = true, tentativeSequence = 1, providerMode = 'listening';
        lastActivity = undefined;
        silenceReply = () => {
          lastInterruptionId = Math.max(lastInterruptionId, latestAssistantId);
          playbackInterrupted = true; conversation?.setVolume({ volume: outputVolume() });
        };
        const audioTexts = new Map(), replyTexts = new Map(), qualifiedAudio = new Set();
        const nonFiller = text => {
          const value = text?.trim();
          return Boolean(value) && !['Einen Moment, bitte.', 'One moment, please.'].some(line => line.startsWith(value));
        };
        const reportAudio = (eventId, text) => {
          if (!active() || paused || transportBlocked || outputVolume() === 0 || !Number.isSafeInteger(eventId) || eventId < 0 || eventId < latestAssistantId || qualifiedAudio.has(eventId)) return;
          if (text) audioTexts.set(eventId, ((audioTexts.get(eventId) ?? '') + text).slice(0, 512));
          const knownText = audioTexts.get(eventId) || replyTexts.get(eventId);
          // Unaligned PCM can still be the holding prefix while text generation
          // runs ahead. Only aligned non-filler words can qualify that stream.
          const holdingPrefix = !audioTexts.has(eventId) && ['Einen Moment, bitte.', 'One moment, please.'].some(line => knownText?.trim().startsWith(line));
          const filler = holdingPrefix || !nonFiller(knownText);
          if (audioTexts.size > 256) audioTexts.delete(audioTexts.keys().next().value);
          // SDK mode owns activity for unqualified/holding PCM. Such chunks
          // can arrive after listening and must never reopen playback.
          if (filler) return;
          emit({ type: 'speaking', audio: true, filler: false });
          qualifiedAudio.add(eventId);
        };
        const replyIds = new Map(), confirmedInterruptions = new Set();
        if (receipt?.callId !== request.callId || !receipt.providerSessionId || !receipt.credential ||
          !Number.isFinite(receipt.credential.ttlMs) || receipt.credential.ttlMs <= 0 || receipt.credential.ttlMs > 60_000 ||
          receipt.credential.providerSessionId !== receipt.providerSessionId) throw new PluginError('invalid-output', 'Invalid voice credential receipt');
        const credentialDeadlineAt = Date.now() + receipt.credential.ttlMs;
        const { connectionType, signedUrl, conversationToken } = receipt.credential;
        if (connectionType === 'websocket' ? typeof signedUrl !== 'string' || !signedUrl || conversationToken !== undefined
          : connectionType !== 'webrtc' || typeof conversationToken !== 'string' || !conversationToken || signedUrl !== undefined) throw new PluginError('invalid-output', 'Invalid voice credential transport');
        if (![receipt.spendDeadlineAt, receipt.browserLivenessDeadlineAt].every(Number.isFinite)) throw new PluginError('invalid-output', 'Missing server voice deadlines');
        grant = receipt; transportBlocked = false;
        // The server lease begins at control.start, before the SDK opens the
        // permission prompt. Renew throughout startup and retain those renewals
        // when the provider finally connects.
        if (current === 1) { lifecycle.connected(grant); lifecycle.startHeartbeat(); }
        const active = () => generation === current && !ended;
        const observeAssistant = eventId => {
          if (!active() || !Number.isSafeInteger(eventId) || eventId < 0) return;
          latestAssistantId = Math.max(latestAssistantId, eventId);
          const turnId = `${receipt.providerSessionId}:assistant:${latestAssistantId}`;
          if (turnId !== lastReply?.turnId) replay.stop();
          // Stream/audio identity arrives before the complete final callback.
          // Invalidate the previous turn's prefix as soon as the new turn starts.
          if (turnId !== lastPlaybackTurnId) lifecycle.dispatch({ type: 'heard', prefix: null });
          lastPlaybackTurnId = turnId;
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
                  // Alignment belongs to provider audio. WebRTC analyser ticks
                  // and mode callbacks carry no reply-start authority.
                  reportAudio(audioId, message.audio_event?.alignment?.chars?.join(''));
                }
                return handleMessage.call(this, message);
              };
            }
            creationChannels = capture.run(() => channels(created)); creationChannels.catch(() => {});
          },
          onConnect({ conversationId }) {
            if (active() && conversationId !== receipt.providerSessionId) void close('provider-identity-mismatch').catch(() => {});
          },
          onModeChange({ mode }) {
            if (!active() || !['listening', 'speaking'].includes(mode) || replay.active) return;
            // Tentative events have no provider turn id. After completion, only
            // the next speaking -> listening boundary admits a new hypothesis.
            if (mode === 'speaking') tentativeOpen = false;
            else if (providerMode === 'speaking') { tentativeOpen = true; tentativeSequence++; }
            providerMode = mode; emit({ type: mode });
          },
          onAgentChatResponsePart({ event_id: eventId, type, text }) {
            if (active() && Number.isSafeInteger(eventId) && ['start', 'delta'].includes(type) && typeof text === 'string') {
              replyTexts.set(eventId, ((type === 'start' ? '' : replyTexts.get(eventId) ?? '') + text).slice(0, 512));
              if (replyTexts.size > 256) replyTexts.delete(replyTexts.keys().next().value);
            }
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
            seen.add(turnId); tentativeOpen = false;
            // Capture order belongs to this provider generation, before async
            // persistence. Paused finals leave a gap instead of shifting IDs.
            const ordinal = speaker === 'user' ? ++userTurnOrdinal : undefined;
            if (paused) return;
            if (speaker === 'user') stopReplayForInput();
            if (speaker === 'assistant') {
              replyTexts.set(eventId, message);
              if (replyTexts.size > 256) replyTexts.delete(replyTexts.keys().next().value);
              assistants.set(turnId, { text: message, eventId, replyId: replyIds.get(eventId) });
              if (assistants.size > 256) assistants.delete(assistants.keys().next().value);
            }
            emit({ type: 'final', turnId, role: speaker, text: message,
              ...(ordinal !== undefined ? { userTurnOrdinal: ordinal } : {}),
              ...(speaker === 'assistant' && replyIds.get(eventId) ? { replyId: replyIds.get(eventId) } : {}),
              ...(eventId !== undefined ? { event_id: eventId } : {}) });
            if (speaker === 'assistant' && confirmedInterruptions.delete(eventId)) {
              emit({ type: 'interrupted', turnId, heardLength: 'unknown' }, false);
            }
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
              if (text.trim()) stopReplayForInput();
              if (!tentativeOpen) return;
              emit({ type: 'partial', turnId: `${receipt.providerSessionId}:user:pending:${tentativeSequence}`, role: 'user', text,
                userTurnOrdinal: userTurnOrdinal + 1 });
            }
          },
          onInterruption({ event_id: eventId }) {
            if (active() && Number.isSafeInteger(eventId) && eventId >= 0 && eventId > lastInterruptionId && eventId >= latestAssistantId) {
              lastInterruptionId = eventId; playbackInterrupted = true;
              replay.stop();
              // WebRTC's native interrupt is a no-op. Mute its actual audio
              // elements (and WebSocket gain) synchronously, outside persistence
              // and the command queue. Only a newer agent reply lifts this gate.
              conversation?.setVolume({ volume: outputVolume() });
              const turnId = `${receipt.providerSessionId}:assistant:${eventId}`;
              // Keep metadata off the public transcript/heard event stream. If
              // confirmation precedes the final, onMessage persists it afterward.
              if (!paused) {
                if (assistants.has(turnId)) emit({ type: 'interrupted', turnId, heardLength: 'unknown' }, false);
                else {
                  confirmedInterruptions.add(eventId);
                  if (confirmedInterruptions.size > 256) confirmedInterruptions.delete(confirmedInterruptions.values().next().value);
                }
              }
              for (const waiter of interruptionWaiters) waiter();
            }
            // Only the correction callback supplies heard text; interruption never invents it.
          },
          onAgentToolResponse(response) {
            // SDK 1.17.0 forwards native end_call before asynchronous disconnect cleanup finishes.
            if (active() && response?.tool_name === 'end_call') void close('provider-end').catch(() => {});
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
        // Verified agent provisioning supplies the default spoken AI opener.
        // Capable fresh-call startup cannot override that guarantee with a silent
        // greeting. Legacy starts and trusted continuations retain their contract.
        if (options.onMicrophoneState && current === 1 && !request.providerSessionId &&
          receipt.presentation !== 'continuation' && receipt.overrides?.agent?.firstMessage === '')
          throw new PluginError('invalid-output', 'Fresh voice connection requires its spoken opener');
        // Credential work remains bounded. Only an actual visitor permission
        // decision suspends its clock; SDK preparation and post-grant setup
        // still spend the remaining credential budget, even without a rail.
        const credentialCancellation = new AbortController();
        const suspendForPrompt = options.onMicrophoneState && connectOptions?.deadlineAt === undefined;
        let credentialRemainingMs = credentialDeadlineAt - Date.now(), credentialTimer, credentialRunningAt;
        const credentialClock = running => {
          clearTimeout(credentialTimer);
          if (credentialRunningAt !== undefined) credentialRemainingMs -= Date.now() - credentialRunningAt;
          credentialRunningAt = running ? Date.now() : undefined;
          if (running) credentialTimer = setTimeout(() => credentialCancellation.abort(new DOMException('Voice credential expired', 'TimeoutError')),
            Math.max(0, credentialRemainingMs));
        };
        capturePhase = phase => {
          if (!active() || paused || !inputOn) return;
          if (suspendForPrompt) credentialClock(phase !== 'requesting');
          options.onMicrophoneState?.(phase);
        };
        credentialClock(true);
        try {
          conversation = await startupOperation({ ...connectOptions,
            signal: AbortSignal.any([connectOptions?.signal, commandCancellation.signal, credentialCancellation.signal].filter(Boolean)),
            ...(suspendForPrompt ? {} : { deadlineAt: Math.min(connectOptions?.deadlineAt ?? Infinity, credentialDeadlineAt) }),
          }, async () => {
            const implementation = await getSdk();
            if (!active()) throw new PluginError('cancelled');
            capture ??= microphoneCapture(mediaDevices, AudioContext, phase => capturePhase?.(phase), permissions);
            capture.setEnabled(!paused && inputOn);
            const pending = capture.run(() => implementation.startSession({
              ...(receipt.credential.connectionType === 'websocket'
                ? { signedUrl: receipt.credential.signedUrl, connectionType: 'websocket' }
                : { conversationToken: receipt.credential.conversationToken, connectionType: 'webrtc' }),
              customLlmExtraBody: { aithema_call: receipt.facadeCallId ?? request.callId },
              ...(receipt.overrides ? { overrides: voiceOverrides(receipt.overrides) } : {}),
              ...(workletPaths ? { workletPaths } : {}), ...callbacks,
            }));
            // A late successful SDK connection after cancellation is torn down.
            Promise.resolve(pending).then(late => { if (!active()) void capture.run(() => late.endSession()).catch(() => {}); }, () => {});
            return pending;
          });
        } finally {
          clearTimeout(credentialTimer);
          capturePhase = phase => { if (active() && !paused && inputOn) options.onMicrophoneState?.(phase); };
        }
        if (!active()) throw new PluginError('cancelled');
        if (conversation.getId() !== receipt.providerSessionId) throw new PluginError('invalid-output', 'Provider identity mismatch');
        await (creationChannels ?? capture.run(() => channels()));
        if (paused) {
          const ack = await voiceOperation(connectOptions, pauseControl);
          if (ack?.acknowledged !== true || ack.paused !== true) throw new PluginError('invalid-output', 'Pause not acknowledged');
        }
      };
      let recoveryIdentity;
      const stopMedia = reason => {
        replay.stop();
        if (reason === 'ownership-lost') playback?.destroy();
        if (['sleep', 'wake', 'ownership-lost', 'server-restart', 'browser-liveness-deadline'].includes(reason)) {
          paused = true; pauseRevision++;
        }
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
          const renewalOptions = { ...opts,
            signal: opts?.signal ? AbortSignal.any([opts.signal, commandCancellation.signal]) : commandCancellation.signal,
            deadlineAt: Math.min(opts?.deadlineAt ?? Infinity, grant.spendDeadlineAt, grant.browserLivenessDeadlineAt),
          };
          let ack;
          for (let attempt = 0; attempt < 3; attempt++) {
            try { ack = await voiceOperation(renewalOptions, bounded => control.heartbeat(previous, bounded)); break; }
            catch (error) {
              const transient = error?.status >= 500 || error?.code === 'deadline' || !error?.code && !error?.status;
              if (conversation || generation !== 1 || ended || transportBlocked || renewalOptions.signal.aborted || !transient) throw error;
              // No provider connection exists yet (possibly still in S1).
              // Retry only this renewal within its original deadline/lease;
              // replacing a nonexistent transport would cancel the prompt.
              // Exhaustion defers to the next beat and the real lease expiry.
              if (attempt === 2) return { acknowledged: true, deferred: true };
            }
          }
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
        async replace({ explicit }) {
          if (ended || !control.recover) throw new PluginError('unavailable');
          // Every replacement is server-admitted, in its own callback key space.
          const opts = { signal: commandCancellation.signal, deadlineAt: Math.min(grant.spendDeadlineAt, Date.now() + 10_000) };
          const receipt = await voiceOperation(opts, bounded => control.recover({ ...recoveryIdentity, explicit }, bounded));
          if (ended) throw new PluginError('cancelled');
          if (lifecycle.state.holds.includes('ownership-lost') || receipt.epoch !== undefined && receipt.epoch !== lifecycle.state.epoch) {
            throw Object.assign(new PluginError('unavailable'), { code: 'voice-ownership-lost' });
          }
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
      const freeze = () => lifecycle.sleep(), wake = () => lifecycle.wake();
      const visible = () => { if (!document.hidden) wake(); };
      const retainHold = () => {
        if (ended) return;
        if (options.holdSignal?.reason === 'ownership-lost') { lifecycle.ownershipLost(); return; }
        paused = true; pauseRevision++; lifecycle.pause('hide');
        replay.stop();
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
        document?.addEventListener('freeze', freeze); document?.addEventListener('resume', wake);
        document?.addEventListener('visibilitychange', visible);
        await startupOperation(options, async opts => {
          const revision = pauseRevision;
          lifecycle.dispatch({ type: 'start' });
          if (options.holdSignal?.aborted) retainHold();
          if (request.providerSessionId) { paused = true; lifecycle.pause('waiting'); }
          const receipt = request.providerSessionId
            ? await control.recover({ callId: request.callId, providerSessionId: request.providerSessionId,
              ...(request.epoch !== undefined ? { epoch: request.epoch } : {}), explicit: true }, opts) : await control.start(request, opts);
          await connect(receipt, opts); lifecycle.connected(grant);
          if (lifecycle.state.holds.includes('ownership-lost')) throw Object.assign(new PluginError('not-admitted'), { code: 'voice-ownership-lost' });
          if (request.providerSessionId && !options.holdSignal?.aborted) {
            const ack = await resumeControl(opts);
            if (ended || opts.signal.aborted) throw new PluginError('cancelled');
            if (ack?.acknowledged !== true || ack.paused !== false) throw new PluginError('invalid-output', 'Resume not acknowledged');
            if (revision !== pauseRevision) throw new PluginError('unavailable', 'New pause requested while resuming');
            emit({ type: 'recovered' });
            paused = false; lifecycle.resumed(); await capture.run(() => channels());
            if (revision !== pauseRevision) throw new PluginError('unavailable', 'New pause requested while resuming');
          }
        });
        if (options.signal?.aborted) { cancel(); throw new PluginError('cancelled'); }
        const session = {
          retryPlayback: opts => voiceOperation(opts, () => playback?.retry()),
          audioLevels: () => ({ input: paused || transportBlocked || !inputOn ? 0 : conversation?.getInputVolume?.() ?? 0,
            output: outputVolume() === 0 ? 0 : conversation?.getOutputVolume?.() ?? 0 }),
          callId: request.callId, get providerSessionId() { return grant.providerSessionId; }, events, lifecycle,
          get epoch() { return grant.epoch; }, get tabId() { return control.tabId; },
          receiveState(state) {
            if (state.callId !== request.callId) return;
            if (state.epoch < grant.epoch) return;
            if (state.epoch > grant.epoch || state.controllingTabId && state.controllingTabId !== control.tabId) lifecycle.ownershipLost();
            else if (state.reason === 'server-restart' && state.state === 'waiting' && state.needsRecovery !== false &&
              state.providerSessionId === grant.providerSessionId && !lifecycle.state.holds.includes('server-restart')) lifecycle.restart();
          },
          close: commandOptions => close(commandOptions?.reason ?? 'closed', commandOptions),
          pause(commandOptions) {
            if (ended) return Promise.reject(new PluginError('unavailable'));
            paused = true; pauseRevision++; lifecycle.pause();
            replay.stop();
            const muted = capture.run(() => channels()); muted.catch(() => {});
            return command('pause', async opts => {
              await muted;
              const ack = await pauseControl(opts);
              if (ack?.acknowledged !== true || ack.paused !== true) throw new PluginError('invalid-output', 'Pause not acknowledged');
              return ack;
            }, true)(commandOptions);
          },
          resume(commandOptions) {
            lifecycle.checkClock();
            if (lifecycle.state.holds.includes('ownership-lost')) return Promise.reject(Object.assign(new PluginError('unavailable'), { code: 'voice-ownership-lost' }));
            const revision = pauseRevision;
            return command('resume', async opts => {
              if (lifecycle.state.needsRecovery) {
                // Replace while still muted; only the following server Resume unlocks media.
                paused = true;
                if (!await lifecycle.recover({ explicit: true })) throw new PluginError('unavailable');
              }
              const ack = await resumeControl(opts);
              if (ended || opts.signal.aborted) throw new PluginError('cancelled');
              if (ack?.acknowledged !== true || ack.paused !== false) throw new PluginError('invalid-output', 'Resume not acknowledged');
              if (revision !== pauseRevision) throw new PluginError('unavailable', 'New pause requested while resuming');
              paused = false; lifecycle.resumed(); await capture.run(() => channels());
              if (revision !== pauseRevision) throw new PluginError('unavailable', 'New pause requested while resuming');
              return ack;
            }, true)(commandOptions);
          },
          setInput(on, opts) { return command('setInput', () => { if (typeof on !== 'boolean') throw new TypeError('Input boolean required'); inputOn = on; return capture.run(() => channels()); })(opts); },
          setOutput(on, opts) {
            if (on === false) { outputOn = false; replay.stop(); }
            return command('setOutput', () => { if (typeof on !== 'boolean') throw new TypeError('Output boolean required'); outputOn = on; return capture.run(() => channels()); })(opts);
          },
          get replaying() { return replay.active; },
          stopReplay() { if (replay.active) silenceReply(); return replay.stop() ?? Promise.resolve(); },
          // Server finals already exist in the transcript. Speak them through
          // replay admission, without sendText or another provider conversation turn.
          speakReply(reply, opts) {
            return command('speakReply', bounded => {
              if (!reply?.turnId || typeof reply.text !== 'string') throw new TypeError('Reply required');
              lastReply = { turnId: reply.turnId, text: reply.text };
              lastPlaybackTurnId = reply.turnId;
              return replay.replay(lastReply, bounded);
            })(opts);
          },
          replayLastReply(opts) {
            const reply = lastReply && { ...lastReply }, revision = replay.revision;
            return command('replayLastReply', bounded => {
              if (revision !== replay.revision) throw new PluginError('cancelled');
              return replay.replay(reply, bounded);
            })(opts);
          },
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
  client.ports = Object.freeze({ browserMedia: createElevenLabsBrowserMedia(receipt => createElevenLabsClient({ ...ports,
    control: { ...control, start: () => receipt } })), components: elevenLabsComponents });
  return client;
}
