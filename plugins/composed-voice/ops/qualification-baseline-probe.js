/** Injected with evaluateOnNewDocument. No secrets, expected text or product
 * imports. Observe the production graph and final-user persistence unchanged.
 * PCM/trace bounds: qualification-live-server.mjs / live-qualification.js.
 * RMS .015: browser-audio.js. 1024 frames: ScriptProcessor's supported size,
 * chosen for ~21 ms output observations at 48 kHz, not a quality threshold. */
export function installBaselineProbe() {
  const trace = [], pcm = [], buffered = [], contexts = new Set(), observers = [];
  const outputProbe = window.qualificationOutputProbe;
  let agentSink, speechStartAt, speechEndAt, lastVoicedEndAt, openerFinalAt, openerFinishedAt, openerDrainedAt;
  let openerSpeaking = false, bufferedBytes = 0;
  let armed = false, bytes = 0, format, hypothesis, firstAudioAt, bargeInAt, stoppedAt, failure, refusal;
  const emit = event => { if (trace.length >= 100_000) failure ??= 'trace-bound'; else trace.push(event); };
  const rms = samples => Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
  const nativeConnect = AudioNode.prototype.connect;
  const nativeDisconnect = AudioNode.prototype.disconnect;
  const tapped = new WeakSet();
  // The production rail exposes the SDK's speaking/listening lifecycle. Its
  // first speaking -> listening edge AND first assistant final identify opener
  // completion. Neither sentence silence nor elapsed time can establish it.
  const nativeAttachShadow = Element.prototype.attachShadow;
  const watch = root => {
    const observer = new MutationObserver(records => {
      if (!armed || failure || speechStartAt !== undefined) return;
      for (const [index, record] of records.entries()) {
        if (record.attributeName !== 'data-state' || !record.target.matches('.audio-rail')) continue;
        const next = records.slice(index + 1).find(row => row.target === record.target && row.attributeName === 'data-state');
        const state = next ? next.oldValue : record.target.getAttribute('data-state');
        if (state === 'speaking') { openerSpeaking = true; openerFinishedAt = openerDrainedAt = undefined; }
        else if (state === 'listening' && openerSpeaking) {
          openerSpeaking = false; openerFinishedAt = performance.now();
          emit({ kind: 'opener-finished', at: openerFinishedAt });
        }
      }
    });
    observer.observe(root, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['data-state'] });
    observers.push(observer);
  };
  watch(document);
  Element.prototype.attachShadow = function(...args) {
    const root = nativeAttachShadow.apply(this, args); watch(root); return root;
  };
  const attribute = ({ samples, at, timestamp, voiced, voicedSince, sampleRateHz }) => {
    if (!hypothesis || failure || at < speechEndAt || voiced && voicedSince < speechEndAt) return;
    if (voiced && firstAudioAt === undefined) {
      firstAudioAt = at;
      emit({ kind: 'playback-start', firstAudioAt, outputTimestamp: timestamp });
      window.qualificationScriptedCapture?.firstAudio(firstAudioAt);
      // Capture callbacks may precede the asynchronously persisted user final.
      bargeInAt = trace.find(e => e.kind === 'capture' && e.voiced && e.captureAt >= firstAudioAt)?.captureAt;
    }
    if (firstAudioAt === undefined || stoppedAt !== undefined) return;
    if (format && format.sampleRateHz !== sampleRateHz) { failure = 'output-format'; return; }
    format = { encoding: 'pcm_f32le', sampleRateHz, channels: 1 };
    const stop = outputProbe.stop({ at, timestamp, voiced }, bargeInAt);
    if (stop) { stoppedAt = stop.stoppedAt; emit(stop); return; }
    bytes += samples.byteLength;
    if (bytes > 16_000_000) { failure = 'pcm-bound'; return; }
    pcm.push(samples);
  };
  function output(source, volume = () => 1) {
    outputProbe.tap(source, block => {
      const { at, voiced, sink } = block;
      if (agentSink && agentSink !== sink) return;
      if (voiced) agentSink ??= sink;
      if (speechStartAt === undefined) {
        if (voiced) openerDrainedAt = undefined;
        // Drain only the opener's graph after its completion signals.
        else if (agentSink === sink && [openerFinalAt, openerFinishedAt].every(Number.isFinite) &&
          at >= Math.max(openerFinalAt, openerFinishedAt) && openerDrainedAt === undefined) {
          openerDrainedAt = at; emit({ kind: 'opener-drained', at });
          window.qualificationScriptedCapture?.startUtterance();
        }
        return;
      }
      if (at < speechStartAt || agentSink !== sink) return;
      if (hypothesis) attribute(block);
      else {
        bufferedBytes += block.samples.byteLength;
        if (bufferedBytes > 16_000_000) { failure = 'reply-buffer-bound'; return; }
        buffered.push(block);
      }
    }, { volume, enabled: () => armed && !failure, onFault: () => { failure ??= 'output-queue-bound'; } });
  }
  AudioNode.prototype.connect = function(destination, ...args) {
    const result = nativeConnect.call(this, destination, ...args);
    if (armed && destination === this.context.destination && !tapped.has(this)) { tapped.add(this); output(this); }
    return result;
  };
  // WebRTC SDK output uses HTMLAudioElement.srcObject. Observe its track in a
  // silent parallel Web Audio graph; retain the element's actual volume gate.
  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function(...args) {
    if (armed && this.srcObject instanceof MediaStream && !tapped.has(this)) {
      tapped.add(this);
      const context = new AudioContext(); contexts.add(context);
      output(context.createMediaStreamSource(this.srcObject), () => this.muted ? 0 : this.volume);
      void context.resume();
    }
    return nativePlay.apply(this, args);
  };
  const capture = event => {
    if (!armed || failure || refusal) return;
    if (event.kind === 'capture-outcome') {
      emit(event);
      if (event.status === 'refused' && event.reason === 'late-first-audio') refusal = event.reason;
      else failure = 'scripted-capture-failed';
      return;
    }
    const { captureAt, voiced, durationMs } = event;
    emit(event);
    if (voiced && speechStartAt === undefined) {
      speechStartAt = captureAt;
      if (![openerFinalAt, openerFinishedAt, openerDrainedAt].every(Number.isFinite) ||
        captureAt < Math.max(openerFinalAt, openerFinishedAt, openerDrainedAt)) {
        failure = 'opener-overlap'; emit({ kind: 'invalid-evidence', reason: failure, captureAt }); return;
      }
    }
    if (voiced && !hypothesis) lastVoicedEndAt = captureAt + durationMs;
    if (voiced && captureAt >= firstAudioAt) bargeInAt ??= captureAt;
  };
  const scripted = window.qualificationScriptedCapture;
  const unsubscribe = scripted?.subscribe(capture);
  const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async function(constraints) {
    const stream = await getUserMedia(constraints);
    if (!scripted && armed && constraints?.audio && !tapped.has(stream)) {
      tapped.add(stream);
      const context = new AudioContext({ sampleRate: 16000 }); contexts.add(context);
      const source = context.createMediaStreamSource(stream), sink = context.createScriptProcessor(1024, 1, 1);
      let frames = 0;
      sink.onaudioprocess = event => {
        const samples = event.inputBuffer.getChannelData(0), receivedAt = performance.now();
        const frame = Math.round((event.playbackTime - event.inputBuffer.duration) * context.sampleRate);
        const captureAt = receivedAt + (frame / context.sampleRate - context.currentTime) * 1000;
        capture({ kind: 'capture', captureAt, receivedAt, voiced: rms(samples) >= 0.015,
          durationMs: samples.length / context.sampleRate * 1000, captureFrame: frame,
          contextSampleRate: context.sampleRate, byteLength: samples.length * 2, wavFrame: frames });
        frames += samples.length;
      };
      const silence = context.createGain(); silence.gain.value = 0;
      nativeConnect.call(source, sink); nativeConnect.call(sink, silence); nativeConnect.call(silence, context.destination);
      await context.resume();
    }
    return stream;
  };
  const fetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    // Production client.js emits final user callbacks through voice-control.js.
    // Observe only ordinal 1 in this fresh visitor session, never tentative STT
    // or a later committed barge-in phrase. Do not change body or callbacks.
    try {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (armed && url.origin === location.origin && /\/voice\/[^/]+\/events$/u.test(url.pathname)) {
        const event = JSON.parse(init?.body).event;
        if (event.type === 'final' && event.role === 'assistant' && openerFinalAt === undefined) {
          openerFinalAt = performance.now(); emit({ kind: 'opener-final', at: openerFinalAt });
        }
        if (!failure && !hypothesis && event.type === 'final' && event.role === 'user' &&
          event.userTurnOrdinal === 1 && typeof event.text === 'string' && event.text.trim()) {
          // A final delayed beyond speech resuming over a buffered reply cannot
          // anchor corpus speech end: lastVoicedEndAt already includes barge-in.
          // Inspect the rendered graph at each capture observation, rather than
          // treating every pause inside the corpus utterance as an endpoint.
          buffered.sort((a, b) => a.at - b.at);
          let outputIndex = 0, outputBlock, previousVoicedEndAt;
          for (const capture of trace.filter(e => e.kind === 'capture').sort((a, b) => a.captureAt - b.captureAt)) {
            while (outputIndex < buffered.length && buffered[outputIndex].at <= capture.receivedAt) outputBlock = buffered[outputIndex++];
            if (!capture.voiced) continue;
            if (outputBlock?.voiced && outputBlock.voicedSince >= previousVoicedEndAt) {
              failure = 'barge-in-before-user-final';
              emit({ kind: 'invalid-evidence', reason: failure, captureAt: capture.captureAt });
              break;
            }
            previousVoicedEndAt = capture.captureAt + capture.durationMs;
          }
          if (!failure) {
            hypothesis = event.text; speechEndAt = lastVoicedEndAt;
            emit({ kind: 'user-final', userTurnOrdinal: 1, at: performance.now(), speechEndAt });
            if (!Number.isFinite(speechEndAt)) failure ??= 'missing-corpus-capture';
            // The final anchors the utterance; replay device-timestamped blocks,
            // retaining an early reply's original onset and PCM without an offset.
            buffered.forEach(attribute);
          }
          buffered.length = 0; bufferedBytes = 0;
        }
      }
    } catch { failure ??= 'probe-exception'; }
    return fetch(input, init);
  };
  window.qualificationBaselineProbe = {
    arm() { armed = true; },
    diagnostics() { return { armed, hasHypothesis: !!hypothesis, speechStartAt, speechEndAt, openerFinalAt, openerFinishedAt, openerDrainedAt, bufferedBytes, firstAudioAt, bargeInAt, stoppedAt, failure, refusal, source: scripted?.diagnostics?.(),
      counts: Object.fromEntries(['capture', 'playback-start', 'playback-stop'].map(kind => [kind, trace.filter(e => e.kind === kind).length])),
      voiced: trace.filter(e => e.kind === 'capture' && e.voiced).slice(-8) }; },
    trace: () => trace,
    complete() {
      const source = scripted?.diagnostics?.();
      if (scripted && (!source || typeof source.started !== 'boolean' || typeof source.barged !== 'boolean')) failure ??= 'missing-scripted-diagnostics';
      if (source?.failure) failure ??= 'scripted-capture-failed';
      if (source?.refusal === 'late-first-audio') refusal ??= source.refusal;
      else if (source?.refusal) failure ??= 'scripted-capture-failed';
      return !!failure || !!refusal || !!hypothesis && [firstAudioAt, bargeInAt, stoppedAt].every(Number.isFinite);
    },
    result() {
      if (failure) throw new Error(`Invalid production media evidence: ${failure}`);
      if (refusal) return { trace, refusal };
      if (!hypothesis || !pcm.length || ![firstAudioAt, bargeInAt, stoppedAt].every(Number.isFinite)) throw new Error('Incomplete production media evidence');
      // Chunk conversion avoids argument/string limits for bounded PCM evidence.
      const samples = new Float32Array(bytes / 4); let offset = 0;
      for (const chunk of pcm) { samples.set(chunk, offset); offset += chunk.length; }
      const data = new Uint8Array(samples.buffer); let binary = '';
      for (let i = 0; i < data.length; i += 8192) binary += String.fromCharCode(...data.subarray(i, i + 8192));
      return { hypothesis, trace, ttsPCM: btoa(binary), ttsFormat: format };
    },
    async close() {
      armed = false; unsubscribe?.(); outputProbe.close();
      await scripted?.close();
      for (const observer of observers) observer.disconnect();
      Element.prototype.attachShadow = nativeAttachShadow;
      HTMLMediaElement.prototype.play = nativePlay; window.fetch = fetch;
      for (const context of contexts) await context.close().catch(() => {});
      AudioNode.prototype.connect = nativeConnect; AudioNode.prototype.disconnect = nativeDisconnect;
    },
  };
}
