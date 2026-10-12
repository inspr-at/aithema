import { PluginError } from '../../../packages/core/src/invocation.js';
import { voiceEvents, voiceOperation, assertVoiceSession } from '../../../packages/core/src/live-voice.js';
import { manifest } from './manifest.js';
import { voiceOverrides } from './options.js';
export { manifest } from './manifest.js';

/** Browser ESM; inject Conversation, or resolve @elevenlabs/client with a host import map. */
export function createElevenLabsClient({ sdk, control, persistEvent, workletPaths, closeTimeoutMs = 45_000,
  persistenceTimeoutMs = 2000, persistenceRetries = 2, persistenceBackoffMs = 100, drainTimeoutMs = 5000 } = {}) {
  if (!control?.start || !control?.close || !control?.pause || !control?.resume || !control?.heartbeat ||
    typeof persistEvent !== 'function' || ![closeTimeoutMs, persistenceTimeoutMs, drainTimeoutMs].every(value => Number.isFinite(value) && value > 0) ||
    !Number.isSafeInteger(persistenceRetries) || persistenceRetries < 0 || persistenceRetries > 5 ||
    !Number.isFinite(persistenceBackoffMs) || persistenceBackoffMs < 0) throw new TypeError('Voice control, durable persistence and valid timeouts required');
  const getSdk = async () => sdk ?? (await import('@elevenlabs/client')).Conversation;
  return {
    manifest,
    async health(options) { return voiceOperation(options, async () => ({ available: typeof (await getSdk())?.startSession === 'function' })); },
    async start(request, options = {}) {
      const events = voiceEvents();
      let conversation, grant, generation = 0, ended = false, closing, recovering, delivery = Promise.resolve(), commands = Promise.resolve(), leaseTimer;
      let inputOn = true, outputOn = true, paused = false, recoveryPending = false, sequence = 0, pauseRevision = 0, persistenceFailed = false;
      const commandCancellation = new AbortController(), interruptionWaiters = new Set();
      const persistenceCancellation = new AbortController();
      const seen = new Set(), assistants = new Map();
      const identity = () => ({ callId: request.callId, providerSessionId: grant?.providerSessionId });
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
      const emit = event => {
        const value = Object.freeze({ ...event, ...identity() });
        delivery = delivery.then(async () => {
          if (persistenceCancellation.signal.aborted) return;
          if (['final', 'heard'].includes(value.type)) await persist(value);
          if (!persistenceCancellation.signal.aborted) events.push(value);
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
      const channels = async () => {
        try {
          // Invoke mute synchronously; SDK 1.17.0 also reports asynchronous failure via onError.
          const muted = conversation?.setMicMuted(paused || !inputOn);
          conversation?.setVolume({ volume: paused || !outputOn ? 0 : 1 });
          await muted;
          if (ended) throw new PluginError('unavailable', 'Live voice capture ended');
        } catch (error) { void close('pause-failed').catch(() => {}); throw error; }
      };
      const scheduleLease = () => {
        clearTimeout(leaseTimer);
        const deadline = Math.min(grant.spendDeadlineAt, grant.browserLivenessDeadlineAt);
        if (!Number.isFinite(deadline)) throw new PluginError('invalid-output', 'Missing server voice deadlines');
        leaseTimer = setTimeout(() => { void close(grant.spendDeadlineAt <= grant.browserLivenessDeadlineAt
          ? 'spend-deadline' : 'browser-liveness-deadline').catch(() => {}); }, Math.max(0, deadline - Date.now()));
      };
      const close = (reason = 'closed', commandOptions = {}) => {
        if (['cancelled', 'turn-withdrawn', 'upload-withdrawn', 'session-erased', 'consent-revised',
          'call-authorization-lost', 'session-revoked', 'transcript-persistence-failed'].includes(reason)) stopPersistence();
        if (closing) return closing;
        const closeOptions = { ...commandOptions, deadlineAt: Math.min(commandOptions.deadlineAt ?? Infinity, Date.now() + closeTimeoutMs) };
        ended = true; generation++; clearTimeout(leaseTimer); options.signal?.removeEventListener('abort', cancel);
        commandCancellation.abort();
        closing = (async () => {
          try { await voiceOperation({ ...closeOptions, deadlineAt: Math.min(closeOptions.deadlineAt, Date.now() + 1000) }, () => conversation?.endSession()); }
          catch { /* Server closure remains authoritative. */ }
          // Leave closure time after a bounded drain; never revoke accepted events first.
          const remaining = Math.max(0, closeOptions.deadlineAt - Date.now());
          if (!persistenceCancellation.signal.aborted) await drain(closeOptions.deadlineAt - Math.min(1000, remaining / 2));
          stopPersistence();
          if (persistenceFailed) reason = 'transcript-persistence-failed';
          let terminal;
          try { if (grant) terminal = await voiceOperation(closeOptions, opts => control.close({ ...identity(), reason }, opts)); }
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
        if (receipt?.callId !== request.callId || !receipt.providerSessionId || !receipt.credential ||
          !Number.isFinite(receipt.credential.ttlMs) || receipt.credential.ttlMs <= 0 || receipt.credential.ttlMs > 60_000 ||
          receipt.credential.providerSessionId !== receipt.providerSessionId) throw new PluginError('invalid-output', 'Invalid voice credential receipt');
        const credentialDeadlineAt = Date.now() + receipt.credential.ttlMs;
        const { connectionType, signedUrl, conversationToken } = receipt.credential;
        if (connectionType === 'websocket' ? typeof signedUrl !== 'string' || !signedUrl || conversationToken !== undefined
          : connectionType !== 'webrtc' || typeof conversationToken !== 'string' || !conversationToken || signedUrl !== undefined) throw new PluginError('invalid-output', 'Invalid voice credential transport');
        grant = receipt; scheduleLease();
        const active = () => generation === current && !ended;
        const callbacks = {
          onConversationCreated(created) {
            if (!active()) { void Promise.resolve(created.endSession()).catch(() => {}); return; }
            conversation = created;
            // Earliest public SDK hook: retained pause is applied before onConnect.
            void channels().catch(() => {});
          },
          onConnect({ conversationId }) {
            if (active() && conversationId !== receipt.providerSessionId) void close('provider-identity-mismatch').catch(() => {});
          },
          onModeChange({ mode }) { if (active() && ['listening', 'speaking'].includes(mode)) emit({ type: mode }); },
          onMessage({ role, message, event_id: eventId }) {
            if (!active() || paused || !['user', 'agent'].includes(role) || typeof message !== 'string' || !message.trim()) return;
            const speaker = role === 'agent' ? 'assistant' : 'user';
            const turnId = `${receipt.providerSessionId}:${speaker}:${eventId ?? `callback-${++sequence}`}`;
            if (seen.has(turnId)) return;
            if (seen.size >= 4096) { void close('transcript-limit').catch(() => {}); return; }
            seen.add(turnId);
            if (speaker === 'assistant') {
              assistants.set(turnId, { text: message, eventId });
              if (assistants.size > 256) assistants.delete(assistants.keys().next().value);
            }
            emit({ type: 'final', turnId, role: speaker, text: message });
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
            const text = event?.tentative_user_transcription_event?.user_transcript;
            if (active() && !paused && event.type === 'tentative_user_transcript' && typeof text === 'string') {
              emit({ type: 'partial', turnId: `${receipt.providerSessionId}:user:pending`, role: 'user', text });
            }
          },
          onInterruption({ event_id: eventId }) {
            if (active() && Number.isSafeInteger(eventId)) {
              for (const waiter of interruptionWaiters) waiter();
            }
            // Only the correction callback supplies heard text; interruption never invents it.
          },
          onDisconnect() { if (active()) void recover().catch(() => {}); },
          onError(message, context) {
            if (active() && message === 'Failed to set input muted state') {
              void close('pause-failed').catch(() => {}); return;
            }
            // SDK 1.17.0 emits tool/server/end-session contexts here; recovery relies on onDisconnect.
            if (active() && (context?.name === 'SessionConnectionError' ||
              ['connection_state_changed', 'socket_error', 'websocket_error', 'transport_error'].includes(context?.type))) void recover().catch(() => {});
          },
        };
        const implementation = await getSdk();
        const pending = implementation.startSession({
          ...(receipt.credential.connectionType === 'websocket'
            ? { signedUrl: receipt.credential.signedUrl, connectionType: 'websocket' }
            : { conversationToken: receipt.credential.conversationToken, connectionType: 'webrtc' }),
          customLlmExtraBody: { aithema_call: receipt.facadeCallId ?? request.callId },
          ...(receipt.overrides ? { overrides: voiceOverrides(receipt.overrides) } : {}),
          ...(workletPaths ? { workletPaths } : {}), ...callbacks,
        });
        // A late successful SDK connection after a deadline must still be torn down.
        Promise.resolve(pending).then(late => { if (!active()) void late.endSession().catch(() => {}); }, () => {});
        conversation = await voiceOperation({ ...connectOptions,
          deadlineAt: Math.min(connectOptions?.deadlineAt ?? Infinity, credentialDeadlineAt) }, () => pending);
        if (!active()) throw new PluginError('cancelled');
        if (conversation.getId() !== receipt.providerSessionId) throw new PluginError('invalid-output', 'Provider identity mismatch');
        await channels();
        if (paused) {
          const ack = await voiceOperation(connectOptions, opts => control.pause(identity(), opts));
          if (ack?.acknowledged !== true || ack.paused !== true) throw new PluginError('invalid-output', 'Pause not acknowledged');
        }
      };
      const recover = () => {
        if (recovering || ended) return recovering;
        if (paused) { recoveryPending = true; return Promise.resolve(); }
        recoveryPending = false;
        generation++; emit({ type: 'recovering' });
        recovering = (async () => {
          const previous = identity();
          try { await voiceOperation({ deadlineAt: Date.now() + 1000 }, () => conversation?.endSession()); } catch {}
          await drain(Math.min(grant.spendDeadlineAt, Date.now() + drainTimeoutMs));
          if (ended) return;
          if (persistenceFailed) { await close('transcript-persistence-failed'); return; }
          try { await voiceOperation({ deadlineAt: Date.now() + 1000 }, opts => control.close({ ...previous, reason: 'transport-lost' }, opts)); } catch {}
          for (let attempt = 0; attempt < 3 && !ended && control.recover; attempt++) {
            try {
              // The server admits a fresh claim for each recovery; never reuse start's authority.
              const opts = { signal: options.signal, deadlineAt: Math.min(grant.spendDeadlineAt, Date.now() + 10_000) };
              const receipt = await voiceOperation(opts, bounded => control.recover(previous, bounded));
              await connect(receipt, opts);
              return true;
            } catch {
              generation++;
              try { await voiceOperation({ deadlineAt: Date.now() + 1000 }, () => conversation?.endSession()); } catch {}
              if (grant.providerSessionId !== previous.providerSessionId) {
                try { await voiceOperation({ deadlineAt: Date.now() + 1000 }, opts => control.close({ ...identity(), reason: 'recovery-failed' }, opts)); } catch {}
              }
            }
          }
          await close('recovery-failed', { deadlineAt: Date.now() + 1000 });
        })().then(recovered => { recovering = null; if (recovered && !ended) emit({ type: 'recovered' }); })
          .finally(() => { recovering = null; });
        return recovering;
      };
      const command = (name, fn, duringRecovery = false) => commandOptions => {
        const run = commands.then(() => {
          if (ended || recovering && !duringRecovery) throw new PluginError('unavailable', `Live voice ${name} unavailable while ended or recovering`);
          return voiceOperation({ ...commandOptions,
          signal: commandOptions?.signal ? AbortSignal.any([commandOptions.signal, commandCancellation.signal]) : commandCancellation.signal,
          deadlineAt: Math.min(commandOptions?.deadlineAt ?? Infinity, grant.spendDeadlineAt, grant.browserLivenessDeadlineAt),
        }, async opts => {
          if (duringRecovery && recovering) await recovering;
          if (ended || recovering) throw new PluginError('unavailable', `Live voice ${name} unavailable while ended or recovering`);
          return fn(opts);
        }); }); commands = run.catch(() => {}); return run;
      };
      try {
        await voiceOperation(options, async opts => {
          const receipt = await control.start(request, opts); await connect(receipt, opts);
        });
        options.signal?.addEventListener('abort', cancel, { once: true });
        if (options.signal?.aborted) { cancel(); throw new PluginError('cancelled'); }
        const session = {
          audioLevels: () => ({ input: paused || !inputOn ? 0 : conversation?.getInputVolume?.() ?? 0,
            output: paused || !outputOn ? 0 : conversation?.getOutputVolume?.() ?? 0 }),
          callId: request.callId, get providerSessionId() { return grant.providerSessionId; }, events,
          close: commandOptions => close(commandOptions?.reason ?? 'closed', commandOptions),
          pause(commandOptions) {
            if (ended) return Promise.reject(new PluginError('unavailable'));
            paused = true; pauseRevision++;
            const muted = channels(); muted.catch(() => {});
            return command('pause', async opts => {
              await muted;
              const ack = await control.pause(identity(), opts);
              if (ack?.acknowledged !== true || ack.paused !== true) throw new PluginError('invalid-output', 'Pause not acknowledged');
              return ack;
            }, true)(commandOptions);
          },
          resume(commandOptions) {
            const revision = pauseRevision;
            return command('resume', async opts => {
              const ack = await control.resume(identity(), opts);
              if (ack?.acknowledged !== true || ack.paused !== false) throw new PluginError('invalid-output', 'Resume not acknowledged');
              if (revision !== pauseRevision) throw new PluginError('unavailable', 'New pause requested while resuming');
              paused = false; await channels();
              if (recoveryPending) queueMicrotask(() => { void recover().catch(() => {}); });
              return ack;
            })(commandOptions);
          },
          setInput(on, opts) { return command('setInput', () => { if (typeof on !== 'boolean') throw new TypeError('Input boolean required'); inputOn = on; return channels(); })(opts); },
          setOutput(on, opts) { return command('setOutput', () => { if (typeof on !== 'boolean') throw new TypeError('Output boolean required'); outputOn = on; return channels(); })(opts); },
          sendText(text, opts) { return command('sendText', () => {
            if (paused) throw new PluginError('not-admitted', 'Voice session paused');
            if (typeof text !== 'string' || !text.trim() || text.length > 16_384) throw new PluginError('limit', 'Invalid voice text');
            conversation.sendUserMessage(text);
          })(opts); },
          updateContext(context, opts) { return command('updateContext', () => {
            const text = typeof context === 'string' ? context : JSON.stringify(context);
            if (!text || text.length > 16_384) throw new PluginError('limit', 'Invalid voice context');
            conversation.sendContextualUpdate(text);
          })(opts); },
          interrupt: command('interrupt', async opts => {
            if (paused || !inputOn) throw new PluginError('unavailable', 'Live voice interrupt requires active microphone input');
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
          heartbeat: command('heartbeat', async opts => {
            const ack = await control.heartbeat(identity(), opts);
            if (ack?.acknowledged !== true || !Number.isFinite(ack.browserLivenessDeadlineAt)) throw new PluginError('invalid-output');
            grant = { ...grant, browserLivenessDeadlineAt: ack.browserLivenessDeadlineAt }; scheduleLease(); return ack;
          }),
        };
        return assertVoiceSession(session);
      } catch (error) { await close('start-failed', { deadlineAt: Date.now() + 1000 }); throw error; }
    },
  };
}
