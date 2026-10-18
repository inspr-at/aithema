import { randomUUID } from 'node:crypto';
import { PluginError } from '@inspr/aithema-core/invocation';
import { deepFreeze } from '@inspr/aithema-core/plugins';
import { createVoiceLifecycle, reduceVoiceLifecycle } from '@inspr/aithema-core/voice-lifecycle';
import { recoverableVoiceEnd } from '@inspr/aithema-core/voice-lifecycle';
import { voiceOperation, voiceLifetime } from '@inspr/aithema-core/live-voice';
import { audioQueue, boundedEvents, TTS_SPEAK_BYTES } from '@inspr/aithema-core/voice-components';

const REPLY_AUDIO_CHUNKS = 1024;

export function callDurationSeconds({ host, maxDurationSeconds = host === 'start2' ? 3600 : 900 } = {}) {
  if (!Number.isSafeInteger(maxDurationSeconds) || maxDurationSeconds < 1 || maxDurationSeconds > 86400) throw new TypeError('Invalid call duration');
  return maxDurationSeconds;
}

async function playbackDelay(ms, options) {
  await voiceOperation(options, ({ signal }) => new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  }));
}

/** Trusted server-only utterance authority. The browser sends PCM, never finals. */
export function createComposedVoiceCoordinator({ sessionId, callId, providerSessionId = `composed-${randomUUID()}`, epoch = 0,
  stt, tts, replyExecutor, admitComponent, authorize, commitUtterance, relay, now = Date.now,
  spendDeadlineAt, browserLivenessDeadlineAt, host, maxDurationSeconds, endpointMs = 500,
  maxUtteranceMs = 30_000, maxPendingTurns = 4, maxTextCharacters = 32_768, fragmentCharacters = 240,
  inputFormat = 'pcm_s16le', outputFormat = 'pcm_f32le', outputAudioFormat = { encoding: outputFormat, sampleRateHz: 24000, channels: 1 }, voice, context = {} } = {}) {
  if (!sessionId || !callId || !providerSessionId || !stt?.stream || !tts?.speak || !replyExecutor?.execute ||
    [admitComponent, authorize, commitUtterance, relay?.audio, relay?.silence, relay?.event].some(fn => typeof fn !== 'function') ||
    !Number.isSafeInteger(epoch) || epoch < 0 || inputFormat !== 'pcm_s16le' ||
    !['pcm_s16le', 'pcm_f32le'].includes(outputFormat) || outputAudioFormat.encoding !== outputFormat ||
    !Number.isSafeInteger(outputAudioFormat.sampleRateHz) || outputAudioFormat.sampleRateHz < 8000 || outputAudioFormat.sampleRateHz > 96000 || outputAudioFormat.channels !== 1 ||
    ![endpointMs, maxUtteranceMs, maxPendingTurns, maxTextCharacters, fragmentCharacters].every(n => Number.isSafeInteger(n) && n > 0) ||
    endpointMs > maxUtteranceMs || maxUtteranceMs > 60_000 || fragmentCharacters < 2 || fragmentCharacters > 1000 || maxPendingTurns > 16) {
    throw new TypeError('Composed coordinator requires trusted, bounded host ports');
  }
  const sampleBytes = outputFormat === 'pcm_s16le' ? 2 : 4;
  const bytesPerSecond = outputAudioFormat.sampleRateHz * sampleBytes;
  // Two bounded fragments plus one maximum provider chunk held by the pacer.
  // bytes below also counts that held chunk, so this reserve is conservative.
  const replyAudioBytes = 2 * TTS_SPEAK_BYTES + 64_000;
  // L = 1 s at both real 24 kHz formats: 96,000 B float32 / 48,000 B
  // PCM16. Even counting a whole not-yet-completed 64,000 B player frame,
  // 160,000 B < each 256,000 B bound, leaving 96,000 B for polling/startup
  // delay and control frames. Cap L's bytes at 96,000 for higher PCM rates.
  const leadBytes = Math.min(bytesPerSecond, 96_000), leadMs = leadBytes / bytesPerSecond * 1000;
  const pacedFrameBytes = Math.min(64_000, leadBytes);
  const startedAt = now();
  spendDeadlineAt = Math.min(spendDeadlineAt ?? Infinity, startedAt + callDurationSeconds({ host, maxDurationSeconds }) * 1000);
  if (!Number.isFinite(browserLivenessDeadlineAt) || Math.min(spendDeadlineAt, browserLivenessDeadlineAt) <= now()) throw new PluginError('deadline');
  let state = { ...createVoiceLifecycle(callId), epoch }, input = true, output = true, utterance,
    sequence = 0, playbackRevision = 0, holdRevision = 0, timer, closing, ingressPending = false, pauseController = new AbortController(), inputFlight = Promise.resolve();
  const cancellation = new AbortController(), revocation = new AbortController(), jobs = new Set(), speechJobs = new Set(), playbacks = new Set(), commits = new Map();
  let history = [], historyBytes = 0, commitTail = Promise.resolve();
  const dispatch = event => { state = reduceVoiceLifecycle(state, event); };
  dispatch({ type: 'start' });
  dispatch({ type: 'connected', providerSessionId, spendDeadlineAt, browserLivenessDeadlineAt });
  const stamp = () => ({ callId, providerSessionId, generation: state.providerGeneration, epoch });
  const event = value => relay.event({ ...value, ...stamp() });
  const lifetime = voiceLifetime({ spendDeadlineAt, browserLivenessDeadlineAt, now, onExpire: reason => {
    if (reason === 'browser-liveness-deadline') {
      holdRevision++;
      silence(reason); discardInput(); dispatch({ type: 'lease-expired' }); event({ type: 'waiting', reason });
    } else close(reason);
  } });
  const spendTimer = setTimeout(() => close('spend-deadline'), Math.max(0, spendDeadlineAt - now()));
  spendTimer.unref?.();
  const options = signal => ({ signal: signal ?? AbortSignal.any([revocation.signal, pauseController.signal]), deadlineAt: spendDeadlineAt });
  const current = () => state.state === 'active' && !cancellation.signal.aborted;
  const permitted = async opts => {
    if (!current() || now() >= Math.min(spendDeadlineAt, state.browserLivenessDeadlineAt)) throw new PluginError('not-admitted');
    if (await voiceOperation(opts ?? options(), bounded => authorize({ ...stamp(), sessionId }, bounded)) !== true || !current()) throw new PluginError('not-admitted');
  };
  const track = (set, promise) => { set.add(promise); promise.finally(() => set.delete(promise)).catch(() => {}); return promise; };
  function silence(reason = 'interrupted') {
    playbackRevision++;
    for (const playback of playbacks) playback.stop();
    // This effect is synchronous; neither remote acknowledgement nor accounting can delay silence.
    relay.silence({ ...stamp(), playbackRevision, reason });
    for (const job of speechJobs) job.controller.abort();
  }
  function discardInput() {
    clearTimeout(timer);
    if (utterance) { utterance.controller.abort(); utterance.queue.clear(); utterance = undefined; }
  }
  async function component(role, request, signal, consume) {
    const opts = options(signal);
    await permitted(opts);
    const admitted = await voiceOperation(opts, bounded => admitComponent({ role, request, ...stamp(), sessionId, ...bounded }));
    if (!admitted?.attempt || typeof admitted.report !== 'function') throw new PluginError('not-admitted');
    let reported = false, consumed = false;
    const guarded = { ...admitted, ...opts, deadlineAt: Math.min(admitted.deadlineAt ?? Infinity, opts.deadlineAt),
      signal: admitted.signal ? AbortSignal.any([admitted.signal, opts.signal]) : opts.signal, attempt: { ...admitted.attempt, async consume() {
      await permitted(opts); await admitted.attempt.consume(); consumed = true;
    } }, report: async terminal => {
      if (reported) throw new PluginError('already-claimed');
      reported = true; await admitted.report(terminal);
    } };
    try { return await consume(guarded); }
    finally {
      if (!reported) await guarded.report(consumed ? { attemptId: admitted.attempt.attemptId, outcome: 'uncertain' }
        : { attemptId: admitted.attempt.attemptId, outcome: 'cancelled', chargedMicro: 0,
          usage: { attemptId: admitted.attempt.attemptId, role, unit: role === 'stt' ? 'seconds' : 'characters',
            quantity: 0, upstreamMicro: 0, source: 'undispatched', estimated: false } });
    }
  }
  function appendHistory(role, content) {
    if (historyBytes + content.length > maxTextCharacters || history.length >= 512) throw new PluginError('limit', 'Generation history full');
    history.push({ role, content }); historyBytes += content.length;
  }
  function endpoint(turn) {
    if (utterance !== turn) return;
    clearTimeout(timer); utterance = undefined; turn.speechEndAt = now(); turn.endpointed = true; turn.queue.end();
  }
  function beginUtterance() {
    if (jobs.size >= maxPendingTurns) throw new PluginError('limit', 'Too many voice turns in flight');
    const turn = { id: `${providerSessionId}-${++sequence}`, sequence, queue: audioQueue(maxUtteranceMs * 32),
      controller: new AbortController(), durationMs: 0, silenceMs: 0, endpointed: false, playbackRevision };
    const committed = Promise.withResolvers(); turn.beforeCommit = commitTail; commitTail = committed.promise;
    utterance = turn;
    const signal = AbortSignal.any([revocation.signal, pauseController.signal, turn.controller.signal]);
    const job = component('stt', { maxDurationMs: maxUtteranceMs }, signal, async opts => {
      let final, text = '';
      for await (const part of boundedEvents(stt.stream({ audio: turn.queue, format: inputFormat }, opts), opts)) {
        if (typeof part?.text !== 'string' || typeof part.final !== 'boolean' || final !== undefined) throw new PluginError('invalid-output');
        text = part.text;
        if (text.length > maxTextCharacters) throw new PluginError('limit');
        if (part.final) final = text;
        else if (current()) event({ type: 'partial', role: 'user', turnId: turn.id, text });
      }
      if (!turn.endpointed || final === undefined) throw new PluginError('invalid-output', 'STT must finish after server endpointing');
      if (!final.trim()) return;
      // Finalizers may finish out of order; utterance history follows capture order.
      await voiceOperation(opts, () => turn.beforeCommit);
      await permitted(opts);
      appendHistory('user', final);
      // Exact text/history and generation metadata enter the existing Rule C store.
      // Never manufacture operation keys from a receipt, or deduplicate by text.
      const envelope = deepFreeze({ source: 'server-coordinator', payload: {
        sessionId, callId, providerSessionId, stream: true,
        callbackBody: { messages: structuredClone(history), context: structuredClone(context),
          metadata: { epoch, utteranceId: turn.id, sequence: turn.sequence } } } });
      commits.set(turn.id, envelope);
      await voiceOperation(opts, bounded => commitUtterance(envelope, bounded));
      event({ type: 'final', role: 'user', turnId: turn.id, text: final, speechEndAt: turn.speechEndAt });
      dispatch({ type: 'accepted', turnId: turn.id });
      committed.resolve();
      await reply(envelope, turn.playbackRevision, signal);
    });
    track(jobs, job.catch(error => {
      if (!signal.aborted && current()) {
        holdRevision++;
        silence('component-failed'); discardInput(); dispatch({ type: 'recovery-exhausted' });
        event({ type: 'waiting', reason: error?.code ?? 'provider' });
      }
    }).finally(committed.resolve));
    return turn;
  }
  function createPlayback(revision, turnSignal, replyId, onFailure) {
    const queue = audioQueue(replyAudioBytes), controller = new AbortController(), fragments = [];
    const signal = AbortSignal.any([turnSignal, controller.signal]), opts = options(signal);
    let bytes = 0, chunks = 0, endAt, speaking = false, failure;
    const valid = () => !signal.aborted && revision === playbackRevision && output && current();
    const drain = () => {
      while (fragments[0]?.ended && fragments[0].pending === 0) fragments.shift().drained.resolve();
    };
    const clear = () => {
      queue.clear(); bytes = 0; chunks = 0;
      for (const fragment of fragments) fragment.drained.resolve();
      fragments.length = 0;
    };
    signal.addEventListener('abort', clear, { once: true });
    const playback = {
      signal,
      throwIfFailed() { if (failure) throw failure; },
      stop() { controller.abort(); clear(); },
      async beginSpeak() {
        // N+1 may open at N's provider terminal, but N+2 needs N's last
        // relay acknowledgement. Abort releases this wait without clock time.
        if (fragments.length === 2) await voiceOperation(opts, () => fragments[0].drained.promise);
        if (failure) throw failure;
        if (!valid()) return;
        const fragment = { drained: Promise.withResolvers(), pending: 0, generated: 0, ended: false };
        fragments.push(fragment);
        return fragment;
      },
      endSpeak(fragment) { fragment.ended = true; drain(); },
      enqueue(value, fragment) {
        if (failure) throw failure;
        if (!valid()) return;
        if (fragment.generated + value.byteLength > TTS_SPEAK_BYTES ||
          bytes + value.byteLength > replyAudioBytes || chunks >= REPLY_AUDIO_CHUNKS) throw new PluginError('limit', 'Reply audio queue full');
        bytes += value.byteLength; chunks++; fragment.pending++; fragment.generated += value.byteLength;
        queue.push({ byteLength: value.byteLength, bytes: Uint8Array.from(value), fragment });
      },
      async finish() { queue.end(); await pacer; if (failure) throw failure; },
    };
    playbacks.add(playback);
    const pacer = (async () => {
      try {
        for await (const { bytes: chunk, fragment } of boundedEvents(queue, opts)) {
          for (let offset = 0; offset < chunk.byteLength; offset += pacedFrameBytes) {
            const frame = chunk.subarray(offset, offset + pacedFrameBytes), durationMs = frame.byteLength / bytesPerSecond * 1000;
            // This cursor spans every fragment; provider gaps earn no catch-up
            // credit. Only the pacer waits: the provider reader only enqueues.
            const frameEndAt = Math.max(endAt ?? now(), now()) + durationMs;
            let delay;
            while ((delay = frameEndAt - now() - leadMs) > 0) await playbackDelay(delay, opts);
            if (!valid()) return;
            endAt = Math.max(frameEndAt, now() + durationMs);
            // Fragment dispatch does not start a new speaking phase. Extra
            // control polls at sentence boundaries can delay paced PCM.
            if (!speaking) { speaking = true; event({ type: 'speaking' }); }
            await voiceOperation(opts, () => {
              // The speaking event can synchronously trigger silence. Fence
              // publication again inside the host callback.
              if (valid()) return relay.audio({ ...stamp(), replyId, playbackRevision: revision, format: outputFormat,
                sampleRateHz: outputAudioFormat.sampleRateHz, channels: outputAudioFormat.channels, bytes: frame });
            });
          }
          if (!valid()) return;
          bytes -= chunk.byteLength; chunks--; fragment.pending--; drain();
        }
      } catch (error) {
        if (!signal.aborted) { failure = error; onFailure(error); }
      }
      finally {
        playback.stop(); signal.removeEventListener('abort', clear); playbacks.delete(playback);
      }
    })();
    if (!valid()) playback.stop();
    return playback;
  }
  async function speak(text, revision, turnSignal, playback) {
    if (!text.trim() || revision !== playbackRevision || !output || !current()) return;
    const controller = new AbortController(), job = { controller }; speechJobs.add(job);
    const signal = AbortSignal.any([turnSignal, controller.signal, playback.signal]);
    try {
      const fragment = await playback.beginSpeak();
      if (!fragment) return;
      await component('tts', { text, voice, format: outputFormat }, signal, async opts => {
        for await (const bytes of boundedEvents(tts.speak({ text, voice, format: outputFormat }, opts), opts)) {
          if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength % sampleBytes || bytes.byteLength > 64_000) throw new PluginError('limit');
          playback.enqueue(bytes, fragment);
        }
      });
      playback.endSpeak(fragment);
    } catch (error) {
      // A relay failure aborts playback too, but must take the recovery path.
      playback.throwIfFailed();
      if (!signal.aborted) throw error;
    }
    finally { speechJobs.delete(job); }
  }
  async function reply(envelope, revision, turnSignal) {
    // Only playback failure cancels reasoning. Deliberate silence still lets
    // admitted reasoning finish; keep the turn signal live for error recovery.
    const controller = new AbortController(), signal = AbortSignal.any([turnSignal, controller.signal]);
    let pending = '', full = '', replyId, complete = false, playback;
    try {
      for await (const item of boundedEvents(replyExecutor.execute(envelope, options(signal)), options(signal))) {
        if (complete) throw new PluginError('invalid-output');
        if (item.type === 'operation') {
          if (replyId || typeof item.replyId !== 'string') throw new PluginError('invalid-output');
          replyId = item.replyId;
          playback = createPlayback(revision, signal, replyId, error => controller.abort(error));
        } else if (item.type === 'delta' && replyId && typeof item.text === 'string') {
          full += item.text; pending += item.text;
          if (full.length > maxTextCharacters) throw new PluginError('limit');
          while (pending.length >= fragmentCharacters || /[.!?]\s/u.test(pending)) {
            let end = Math.min(fragmentCharacters, pending.length);
            const boundary = /[.!?]\s/u.exec(pending.slice(0, end));
            if (boundary) end = boundary.index + 2;
            if (/[\uD800-\uDBFF]/u.test(pending[end - 1])) end--;
            const fragment = pending.slice(0, end); pending = pending.slice(end);
            // Await the provider terminal/accounting, then allow one fragment
            // of lookahead. beginSpeak waits for N's last relay before N+2;
            // the eager reader never waits while a provider stream is open.
            await speak(fragment, revision, signal, playback);
          }
        } else if (item.type === 'completion' && replyId && item.replyId === replyId && item.text === full) {
          complete = true;
          // Deliberate silence retains completed reasoning. Playback failure
          // aborts this reply signal and prevents any later final publication.
          if (!signal.aborted) {
            appendHistory('assistant', full);
            event({ type: 'final', role: 'assistant', turnId: replyId, text: full });
          }
          await speak(pending, revision, signal, playback);
        } else throw new PluginError('invalid-output');
      }
      if (!complete) throw new PluginError('invalid-output');
      await playback.finish();
    } catch (error) {
      // A failure can also interrupt a pending reasoning read, outside speak.
      playback?.throwIfFailed();
      throw error;
    } finally {
      if (playback) { playback.stop(); await playback.finish().catch(() => {}); }
    }
  }
  function receiveAudio(bytes, receipt = {}) {
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength % 2) return Promise.reject(new TypeError('PCM16 audio required'));
    if (bytes.byteLength > 64_000) return Promise.reject(new PluginError('limit'));
    if (receipt.providerSessionId !== undefined && receipt.providerSessionId !== providerSessionId || receipt.epoch !== undefined && receipt.epoch !== epoch) return Promise.reject(new PluginError('not-admitted'));
    // A bounded outstanding ingress flight prevents clients from queuing unlimited PCM copies.
    if (ingressPending) return Promise.reject(new PluginError('limit', 'Audio ingress is busy'));
    ingressPending = true;
    const copy = Uint8Array.from(bytes);
    const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength); let energy = 0;
    for (let i = 0; i < copy.byteLength; i += 2) energy += (view.getInt16(i, true) / 32768) ** 2;
    const voiced = Math.sqrt(energy / (copy.byteLength / 2)) >= 0.015;
    // Local detection stops playback before any remote authorization; capture still requires admission.
    if (current() && input && !utterance && voiced) silence('barge-in');
    inputFlight = (async () => {
      await permitted(); if (!input) throw new PluginError('not-admitted');
      if (!utterance && !voiced) return;
      const turn = utterance ?? beginUtterance(), ms = copy.byteLength / 32;
      turn.durationMs += ms; turn.silenceMs = voiced ? 0 : turn.silenceMs + ms;
      turn.queue.push(copy); clearTimeout(timer);
      if (turn.silenceMs >= endpointMs || turn.durationMs >= maxUtteranceMs) endpoint(turn);
      else { timer = setTimeout(() => endpoint(turn), endpointMs); timer.unref?.(); }
    })().finally(() => { ingressPending = false; });
    return inputFlight;
  }
  function close(reason = 'closed') {
    if (closing) return closing;
    closing = Promise.resolve({ acknowledged: true });
    silence(reason); discardInput(); lifetime.dispose(); clearTimeout(spendTimer);
    if (!recoverableVoiceEnd(reason)) revocation.abort();
    dispatch({ type: 'end', reason }); event({ type: 'ended', reason }); cancellation.abort();
    return closing;
  }
  const api = {
    callId, providerSessionId, replyExecutor, signal: cancellation.signal,
    get state() { return structuredClone(state); }, get exposureIsComponentOnly() { return true; },
    receiveAudio,
    interrupt() { silence(); return Promise.resolve(); },
    async pause() {
      holdRevision++;
      silence('pause'); discardInput(); dispatch({ type: 'pause' }); pauseController.abort();
      return { acknowledged: true, paused: true };
    },
    async resume() {
      if (state.state === 'ended') throw new PluginError('unavailable');
      if (state.needsRecovery) throw new PluginError('unavailable', 'A fresh server segment is required');
      const revision = holdRevision;
      if (await voiceOperation(options(cancellation.signal), bounded => authorize({ ...stamp(), sessionId }, bounded)) !== true) throw new PluginError('not-admitted');
      if (revision !== holdRevision) throw new PluginError('cancelled', 'Resume superseded by a hold');
      if (state.state === 'ended') throw new PluginError('unavailable');
      if (now() >= Math.min(spendDeadlineAt, state.browserLivenessDeadlineAt)) throw new PluginError('deadline');
      pauseController = new AbortController(); dispatch({ type: 'resume-acknowledged' }); event({ type: 'listening' });
      return { acknowledged: true, paused: false };
    },
    async setInput(on) { if (!on) discardInput(); await permitted(); input = Boolean(on); },
    async setOutput(on) { if (!on) silence('output-off'); await permitted(); output = Boolean(on); },
    async sendText() { throw new PluginError('unavailable', 'Composed input is server-relayed audio'); },
    async updateContext(value) { await permitted(); context = structuredClone(value); },
    async heartbeat(opts) {
      await permitted(opts); const lease = Math.min(now() + 30_000, spendDeadlineAt);
      lifetime.heartbeat(lease); dispatch({ type: 'heartbeat', browserLivenessDeadlineAt: lease });
      return { acknowledged: true, browserLivenessDeadlineAt: lease };
    },
    close,
    async idle() { await inputFlight.catch(() => {}); while (jobs.size) await Promise.allSettled([...jobs]); },
    snapshot: () => ({ ...stamp(), sessionId, startedAt, spendDeadlineAt,
      browserLivenessDeadlineAt: state.browserLivenessDeadlineAt, paused: state.holds.length > 0, context: structuredClone(context) }),
    committedEnvelope: turnId => commits.get(turnId),
  };
  event({ type: 'listening' });
  return api;
}
