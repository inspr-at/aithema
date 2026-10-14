import { PluginError } from '../../../packages/core/src/invocation.js';
import { assertVoiceMediaGrant, assertVoiceSession, voiceEvents, voiceOperation } from '../../../packages/core/src/live-voice.js';
import { createVoiceLifecycleController } from '../../../packages/core/src/voice-lifecycle-controller.js';
import { manifest, fakeMediaGrant } from './manifest.js';
import { createReplyReplay } from '../../../packages/core/src/reply-replay.js';
import { playReplyAudio } from '../../../packages/ui/src/reply-audio.js';
import { createPageReplay } from '../../../packages/ui/src/page-replay.js';

/** Browser simulator: canonical events and host control, no SDK or physical media. */
export function createFakeVoice({ control, persistEvent, copy, document = globalThis.document, playAudio = playReplyAudio }) {
  if (!control?.start || !control.close || !control.pause || !control.resume || !control.heartbeat || typeof persistEvent !== 'function') throw new TypeError('Voice control and persistence required');
  const words = () => typeof copy === 'function' ? copy() : copy;
  let current;
  const pageReplay = createPageReplay({ control, document, playAudio });
  const client = { manifest, tabId: control.tabId,
    replayReply: (reply, opts) => pageReplay.replay(reply, opts), stopReplay: () => pageReplay.stop(),
    health: options => voiceOperation(options, async () => ({ available: true })),
    takeover: (identity, options) => voiceOperation(options, opts => control.takeover({ ...identity, explicit: true }, opts)),
    closeWaiting: (identity, options) => voiceOperation(options, opts => control.close({ ...identity, reason: options?.reason ?? 'closed' }, opts)),
    async start(request, options = {}, admittedGrant) {
      pageReplay.stop();
      const events = voiceEvents(), cancellation = new AbortController(), commandCancellation = new AbortController();
      const interruptionWaiters = new Set();
      let receipt, open = false, ended = false, paused = false, blocked = false, input = true, output = true, interrupted = false;
      let sequence = 0, ordinal = 0, pauseRevision = 0, lastAssistant, lastSpokenAssistant, closing, delivery = Promise.resolve(), commands = Promise.resolve(), recoveryIdentity;
      const identity = () => ({ callId: request.callId, providerSessionId: receipt?.providerSessionId,
        ...(receipt?.epoch === undefined ? {} : { epoch: receipt.epoch }) });
      const persist = async event => {
        for (let attempt = 0; ; attempt++) {
          cancellation.signal.throwIfAborted();
          try {
            await voiceOperation({ signal: cancellation.signal, deadlineAt: Date.now() + 2000 },
              opts => persistEvent(event, { providerSessionId: event.providerSessionId }, opts));
            return;
          } catch (error) {
            if (cancellation.signal.aborted || error.status === 403 || error.code === 'not-admitted' ||
              error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status) || attempt >= 2) throw error;
            await voiceOperation({ signal: cancellation.signal }, opts => new Promise((resolve, reject) => {
              const aborted = () => { clearTimeout(timer); reject(opts.signal.reason); };
              const timer = setTimeout(() => { opts.signal.removeEventListener('abort', aborted); resolve(); }, 100 * 2 ** attempt);
              opts.signal.addEventListener('abort', aborted, { once: true });
            }));
          }
        }
      };
      const emit = value => {
        const event = Object.freeze({ ...value, ...identity() });
        if (['listening', 'speaking'].includes(event.type)) lifecycle.dispatch({ type: 'playback', active: event.type === 'speaking' });
        delivery = delivery.then(async () => {
          if (cancellation.signal.aborted) return;
          if (['final', 'heard'].includes(event.type)) await persist(event);
          if (event.type === 'final' && event.role === 'user') lifecycle.dispatch({ type: 'accepted', turnId: event.turnId, sequence: ++sequence });
          if (event.type === 'final' && event.role === 'assistant') {
            lastAssistant = { turnId: event.turnId, text: event.text };
            lifecycle.dispatch({ type: 'reply', replyId: event.turnId });
          }
          if (event.type === 'heard') {
            if (event.turnId === lastAssistant?.turnId) lastAssistant = { ...lastAssistant, text: event.prefix };
            lifecycle.dispatch({ type: 'heard', prefix: event.prefix });
          }
          events.push(event);
        }).catch(error => {
          if (ended) return;
          if (error.code === 'voice-ownership-lost') lifecycle.ownershipLost();
          else void close('transcript-persistence-failed').catch(() => {});
        });
      };
      const say = (role, text) => {
        if (!open || ended || paused || blocked || role === 'user' && !input) return;
        const eventId = ++sequence, turnId = `${receipt.providerSessionId}:${role}:${eventId}`;
        emit({ type: role === 'assistant' ? 'speaking' : 'listening' });
        replay.stop();
        if (role === 'assistant') { interrupted = false; lastSpokenAssistant = { turnId, text }; lifecycle.dispatch({ type: 'heard', prefix: null }); }
        emit({ type: 'final', role, text, turnId, event_id: eventId, ...(role === 'user' ? { userTurnOrdinal: ++ordinal } : {}) });
      };
      const stopMedia = reason => {
        replay.stop();
        blocked = true; open = false;
        if (['sleep', 'wake', 'ownership-lost', 'server-restart', 'browser-liveness-deadline'].includes(reason)) { paused = true; pauseRevision++; }
      };
      const close = (reason = 'closed', commandOptions = {}, recoveryAttempts) => {
        if (closing) return closing;
        ended = true; stopMedia(); lifecycle.end(reason); commandCancellation.abort();
        if (['cancelled', 'turn-withdrawn', 'upload-withdrawn', 'session-erased', 'consent-revised',
          'call-authorization-lost', 'session-revoked', 'transcript-persistence-failed'].includes(reason)) cancellation.abort();
        options.signal?.removeEventListener('abort', cancel); options.holdSignal?.removeEventListener('abort', hold);
        document?.removeEventListener('freeze', freeze); document?.removeEventListener('resume', wake); document?.removeEventListener('visibilitychange', visible);
        closing = (async () => {
          try { await voiceOperation({ deadlineAt: Date.now() + 5000 }, () => delivery); } catch { /* Bounded persistence drain. */ }
          cancellation.abort();
          let result;
          try { if (receipt) result = await voiceOperation({ ...commandOptions, deadlineAt: Math.min(commandOptions.deadlineAt ?? Infinity, Date.now() + 45_000) },
            opts => control.close({ ...identity(), reason,
              ...(recoveryAttempts === undefined ? {} : { recoveryAttempts }) }, opts)); }
          finally { events.push({ type: 'ended', callId: request.callId, reason: result?.closureConfirmed ? reason : 'closure-uncertain' }); events.end(); }
          return result;
        })(); return closing;
      };
      const connect = grant => {
        assertVoiceMediaGrant(grant);
        const next = grant.opaque;
        if (!next?.simulated || next.callId !== request.callId || next.providerSessionId !== grant.providerSessionId ||
          ![next.spendDeadlineAt, next.browserLivenessDeadlineAt].every(Number.isFinite)) throw new PluginError('invalid-output', 'Invalid simulator grant');
        receipt = structuredClone(next); ordinal = 0; blocked = false; interrupted = false; open = true;
      };
      const lifecycle = createVoiceLifecycleController({ callId: request.callId, stopMedia,
        terminal: reason => { void close(reason).catch(() => {}); },
        onEvent: event => {
          const checkpoint = lifecycle.state.checkpoint;
          emit(event.type === 'recovered' ? { ...event, recovery: { userUnconfirmed: checkpoint.userUnconfirmed,
            deliveryUncertain: checkpoint.deliveryUncertain, playbackPositionUnknown: checkpoint.deliveryUncertain && checkpoint.heardPrefix === null,
            lastReplyText: lastAssistant?.text ?? null } } : event);
        },
        async renew(opts) {
          const previous = identity();
          const ack = await voiceOperation({ ...opts,
            signal: opts?.signal ? AbortSignal.any([opts.signal, commandCancellation.signal]) : commandCancellation.signal,
            deadlineAt: Math.min(opts?.deadlineAt ?? Infinity, receipt.spendDeadlineAt, receipt.browserLivenessDeadlineAt) },
          bounded => control.heartbeat(previous, bounded));
          if (!ended && !blocked && receipt.providerSessionId === previous.providerSessionId && Number.isFinite(ack?.browserLivenessDeadlineAt)) {
            receipt = { ...receipt, browserLivenessDeadlineAt: ack.browserLivenessDeadlineAt };
          }
          return ack;
        },
        async beforeRecovery() {
          recoveryIdentity = identity();
          await voiceOperation({ deadlineAt: Date.now() + 5000 }, () => delivery);
          try { await voiceOperation({ deadlineAt: Date.now() + 1000 }, opts => control.close({ ...recoveryIdentity, reason: 'transport-lost' }, opts)); } catch {}
        },
        async replace({ explicit }) {
          const next = await voiceOperation({ signal: commandCancellation.signal, deadlineAt: Math.min(receipt.spendDeadlineAt, Date.now() + 10_000) },
            opts => control.recover({ ...recoveryIdentity, explicit }, opts));
          if (ended) throw new PluginError('cancelled');
          if (next.epoch !== undefined && next.epoch !== lifecycle.state.epoch) throw Object.assign(new PluginError('unavailable'), { code: 'voice-ownership-lost' });
          connect(fakeMediaGrant(next)); return next;
        },
        failedReplacement: async () => stopMedia(),
        persistWaiting: ({ reason, attempts }) => voiceOperation({ deadlineAt: Date.now() + 5000 },
          opts => control.close({ ...identity(), reason, recoveryAttempts: attempts }, opts)),
      });
      const replay = createReplyReplay({ current: reply => open && !ended && !paused && !blocked && output && !lifecycle.state.holds.length &&
        reply.turnId === lastAssistant?.turnId && reply.text === lastAssistant?.text,
      synthesize: (reply, opts) => control.speakText?.({ ...identity(), turnId: reply.turnId }, opts),
      playAudio: (audio, opts) => { interrupted = false; return playAudio(audio, { ...opts, document }); },
      onState: playing => { if (!ended) emit({ type: playing ? 'speaking' : 'listening', replay: true }); } });
      const cancel = () => { void close(options.signal?.reason === 'ownership-lost' ? 'recovery-failed' : 'cancelled',
        { deadlineAt: Date.now() + 1000 }).catch(() => {}); };
      const hold = () => {
        if (ended) return;
        if (options.holdSignal?.reason === 'ownership-lost') lifecycle.ownershipLost();
        else { paused = true; pauseRevision++; lifecycle.pause('hide'); replay.stop(); }
      };
      const freeze = () => lifecycle.sleep(), wake = () => lifecycle.wake(), visible = () => { if (!document.hidden) wake(); };
      const command = (fn, duringRecovery = false) => opts => {
        const pending = commands.then(() => {
          if (ended || lifecycle.recovering && !duringRecovery) throw new PluginError('unavailable');
          return voiceOperation({ ...opts, signal: opts?.signal ? AbortSignal.any([opts.signal, commandCancellation.signal]) : commandCancellation.signal,
            deadlineAt: Math.min(opts?.deadlineAt ?? Infinity, receipt.spendDeadlineAt,
              lifecycle.state.needsRecovery ? Infinity : receipt.browserLivenessDeadlineAt) }, async bounded => {
            if (duringRecovery && lifecycle.recovering) await lifecycle.recovering;
            if (ended || lifecycle.recovering) throw new PluginError('unavailable');
            return fn(bounded);
          });
        }); commands = pending.catch(() => {}); return pending;
      };
      const pauseControl = (value, opts) => {
        const id = crypto.randomUUID();
        if (value) options.onPauseRequest?.(id); else (opts?.onResumeRequest ?? options.onResumeRequest)?.(id);
        return control[value ? 'pause' : 'resume']({ ...identity(), [value ? 'pauseRequestId' : 'resumeRequestId']: id }, opts);
      };
      try {
        options.signal?.addEventListener('abort', cancel, { once: true });
        options.holdSignal?.addEventListener('abort', hold, { once: true });
        document?.addEventListener('freeze', freeze); document?.addEventListener('resume', wake); document?.addEventListener('visibilitychange', visible);
        await voiceOperation(options, async opts => {
          lifecycle.dispatch({ type: 'start' });
          if (options.holdSignal?.aborted) hold();
          if (request.providerSessionId) { paused = true; lifecycle.pause('waiting'); }
          const grant = admittedGrant ?? fakeMediaGrant(request.providerSessionId
            ? await control.recover({ ...request, explicit: true }, opts) : await control.start(request, opts));
          connect(grant); lifecycle.connected(receipt);
          if (paused) {
            const ack = await pauseControl(true, opts);
            if (ack?.acknowledged !== true || ack.paused !== true) throw new PluginError('invalid-output');
          }
          if (request.providerSessionId && !options.holdSignal?.aborted) {
            const revision = pauseRevision, ack = await pauseControl(false, opts);
            if (ack?.acknowledged !== true || ack.paused !== false || revision !== pauseRevision) throw new PluginError('invalid-output');
            paused = false; lifecycle.resumed(); emit({ type: 'recovered' });
          }
          if (receipt.presentation !== 'continuation' && !request.providerSessionId) say('assistant', words().fakeVoiceGreeting);
          else emit({ type: 'listening' });
        });
        const session = { callId: request.callId, get providerSessionId() { return receipt.providerSessionId; },
          get epoch() { return receipt.epoch; }, tabId: control.tabId, events, lifecycle,
          audioLevels: () => ({ input: paused || blocked || !input ? 0 : .25, output: paused || blocked || !output || interrupted ? 0 : .6 }),
          close: opts => close(opts?.reason ?? 'closed', opts),
          pause(opts) {
            paused = true; pauseRevision++; lifecycle.pause();
            replay.stop();
            return command(async bounded => {
              const ack = await pauseControl(true, bounded);
              if (ack?.acknowledged !== true || ack.paused !== true) throw new PluginError('invalid-output'); return ack;
            }, true)(opts);
          },
          resume(opts) {
            lifecycle.checkClock(); const revision = pauseRevision;
            if (lifecycle.state.holds.includes('ownership-lost')) return Promise.reject(Object.assign(new PluginError('unavailable'), { code: 'voice-ownership-lost' }));
            return command(async bounded => {
              if (lifecycle.recovering) await lifecycle.recovering;
              if (lifecycle.state.needsRecovery && !await lifecycle.recover({ explicit: true })) throw new PluginError('unavailable');
              const ack = await pauseControl(false, bounded);
              bounded.signal.throwIfAborted();
              if (ack?.acknowledged !== true || ack.paused !== false || revision !== pauseRevision) throw new PluginError('invalid-output');
              paused = false; blocked = false; open = true; lifecycle.resumed(); return ack;
            }, true)(opts);
          },
          setInput: (on, opts) => command(() => { if (typeof on !== 'boolean') throw new TypeError('Input boolean required'); input = on; })(opts),
          setOutput: (on, opts) => { if (on === false) { output = false; replay.stop(); }
            return command(() => { if (typeof on !== 'boolean') throw new TypeError('Output boolean required'); output = on; })(opts); },
          sendText: (text, opts) => command(() => {
            if (paused || blocked) throw new PluginError('not-admitted');
            if (typeof text !== 'string' || !text.trim() || text.length > 16_384) throw new PluginError('limit');
            say('user', text); say('assistant', words().fakeVoiceReply);
          })(opts),
          updateContext: (context, opts) => command(() => {
            const text = typeof context === 'string' ? context : JSON.stringify(context);
            if (!text || text.length > 16_384) throw new PluginError('limit');
          })(opts),
          interrupt: opts => command(async bounded => {
            if (paused || blocked || !input) throw new PluginError('unavailable');
            let waiter, aborted;
            try {
              await new Promise((resolve, reject) => {
                waiter = resolve; interruptionWaiters.add(waiter);
                aborted = () => reject(new PluginError('cancelled'));
                bounded.signal.addEventListener('abort', aborted, { once: true });
                if (bounded.signal.aborted) aborted();
              });
            } finally { interruptionWaiters.delete(waiter); bounded.signal.removeEventListener('abort', aborted); }
          })(opts),
          get replaying() { return replay.active; },
          stopReplay() { if (replay.active) interrupted = true; replay.stop(); return Promise.resolve(); },
          replayLastReply: opts => {
            const reply = lastAssistant && { ...lastAssistant }, revision = replay.revision;
            return command(bounded => { if (revision !== replay.revision) throw new PluginError('cancelled'); return replay.replay(reply, bounded); })(opts);
          },
          heartbeat: opts => lifecycle.heartbeat(opts),
          receiveState(state) {
            if (state.callId !== request.callId || state.epoch < receipt.epoch) return;
            if (state.epoch > receipt.epoch || state.controllingTabId && state.controllingTabId !== control.tabId) lifecycle.ownershipLost();
            else if (state.reason === 'server-restart' && state.state === 'waiting' && state.needsRecovery !== false &&
              state.providerSessionId === receipt.providerSessionId && !lifecycle.state.holds.includes('server-restart')) lifecycle.restart();
          },
        };
        const bargeIn = (prefix = words().fakeVoiceHeard) => {
          if (!open || ended || paused || blocked || !input || !lastSpokenAssistant?.text.startsWith(prefix)) return;
          interrupted = true;
          replay.stop();
          for (const waiter of interruptionWaiters) waiter();
          emit({ type: 'heard', turnId: lastSpokenAssistant.turnId, prefix }); emit({ type: 'listening' });
        };
        current = { speak: text => { say('user', text ?? words().fakeVoiceStatement); say('assistant', words().fakeVoiceReply); }, bargeIn,
          disconnect: () => { if (open && !ended) void lifecycle.recover().catch(() => {}); },
          snapshot: () => ({ open: open && !ended, muted: paused || blocked || !input, volume: paused || blocked || !output || interrupted ? 0 : 1 }) };
        return assertVoiceSession(session);
      } catch (error) {
        const attempts = request.providerSessionId && receipt && !ended ? 3 : undefined;
        try { await close(request.providerSessionId ? 'recovery-failed' : 'start-failed', { deadlineAt: Date.now() + 1000 }, attempts); }
        catch { /* The server lease retains unresolved closure. */ }
        throw error;
      }
    },
  };
  client.ports = Object.freeze({ browserMedia: Object.freeze({
    connect: (grant, options) => client.start({ callId: grant.callId }, options, grant),
    capture: (session, on, options) => session.setInput(on, options),
    playback: (session, on, options) => session.setOutput(on, options),
    teardown: (session, options) => session.close(options),
  }) });
  return { client, speak: text => current?.speak(text), bargeIn: prefix => current?.bargeIn(prefix),
    disconnect: () => current?.disconnect(), snapshot: () => current?.snapshot() ?? { open: false, muted: false, volume: 1 } };
}
