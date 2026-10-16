// Classify and close before either lane's paid deadline. The 500 ms allowance
// covers evidence classification plus ordinary shutdown (baseline close starts
// 250 ms before the hard watchdog). This never extends the paid duration.
export function qualificationObservationWindow(deadlineAt, now = Date.now()) {
  if (!Number.isFinite(deadlineAt)) throw new TypeError('Sample deadline required');
  return Math.max(1, Math.min(50_000, deadlineAt - now - 500));
}

/** Self-contained for evaluateOnNewDocument in the production baseline. Both
 * lanes tap the rendered output with 1024-frame blocks (~21 ms at 48 kHz), map
 * them through getOutputTimestamp, and confirm sustained silence AFTER barge-in.
 * Explicit player.stop() calls are diagnostics only. */
export function installQualificationOutputProbe() {
  // Output-only level criterion: -40 dB (20*log10(.01)) relative to the reply's
  // own peak pre-barge rendered block RMS. This scales with TTS gain, rather
  // than borrowing the microphone VAD's .015. Freeze the reference before
  // barge-in so that a fade or resumed speech cannot lower/raise the stop bar.
  const OUTPUT_SILENCE_RMS_RATIO = .01;
  // 1000 ms is a conservative qualification policy, not the 300 ms latency bar.
  // Heldner & Edlund (2010), Table 2: within-utterance pauses have mean 300 ms,
  // median 280 ms, SD 210 ms. 1 s is >3x that mean and bridges ordinary word
  // gaps/closures with room to spare. Source and fixture limits: README.md,
  // "Sustained rendered-output stop"; DOI 10.1016/j.wocn.2010.08.002.
  const MIN_OUTPUT_SILENCE_MS = 1000;
  const sinks = new WeakMap(), active = new Set();
  const nativeConnect = AudioNode.prototype.connect;
  const probe = {
    stop(blocks, bargeInAt, teardownAt = Infinity) {
      if (!Number.isFinite(bargeInAt)) return;
      // Replay in rendered order when capture and output callbacks arrive in
      // different orders. Each lane supplies only its attributed reply graph.
      const ordered = [...blocks].sort((a, b) => a.at - b.at);
      const speechRms = ordered.reduce((peak, block) => block.at < bargeInAt && Number.isFinite(block.rms)
        ? Math.max(peak, block.rms) : peak, 0);
      if (speechRms <= 0) return;
      const threshold = speechRms * OUTPUT_SILENCE_RMS_RATIO;
      let start, previous, durationMs = 0;
      for (const block of ordered) {
        const endAt = block.at + block.durationMs;
        // Unknown, straddling or teardown-cut blocks cannot prove silence.
        if (!Number.isFinite(block.at) || !Number.isFinite(block.durationMs) || block.durationMs <= 0 ||
          block.at < bargeInAt || endAt > teardownAt || !Number.isFinite(block.rms) || block.rms < 0 || block.rms >= threshold) {
          start = previous = undefined; durationMs = 0; continue;
        }
        // Device frames establish continuity without treating timestamp mapping
        // jitter as missing PCM. The timestamp-only path serves trace replay.
        const contiguous = previous && (Number.isFinite(block.contextTime) && Number.isFinite(previous.contextTime)
          ? Math.abs(block.contextTime - previous.contextTime - previous.durationMs / 1000) < 1e-6
          : Math.abs(block.at - previous.at - previous.durationMs) < 1e-3);
        if (!contiguous) { start = block; durationMs = 0; }
        durationMs += block.durationMs; previous = block;
        if (durationMs + 1e-6 >= MIN_OUTPUT_SILENCE_MS) {
          return { kind: 'playback-stop', stoppedAt: start.at, outputTimestamp: start.timestamp,
            confirmedAt: endAt, confirmationOutputTimestamp: block.timestamp, silenceDurationMs: durationMs,
            outputRmsThreshold: threshold, origin: 'rendered-silence' };
        }
      }
    },
    tap(source, onRendered, { volume = () => 1, enabled = () => true, onFault = error => { throw error; } } = {}) {
      const context = source.context;
      let sink = sinks.get(context);
      if (!sink) {
        sink = context.createScriptProcessor(1024, 1, 1);
        const pending = []; let timer, voicedSince, speechRms = 0, closed = false;
        const observe = () => {
          clearTimeout(timer);
          if (closed || !enabled()) return;
          try {
            const timestamp = context.getOutputTimestamp();
            while (pending.length && timestamp.performanceTime > 0 &&
              timestamp.contextTime >= pending[0].time + pending[0].samples.length / context.sampleRate) {
              const { samples, time } = pending.shift();
              const at = timestamp.performanceTime + (time - timestamp.contextTime) * 1000;
              const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
              speechRms = Math.max(speechRms, rms);
              // Onset/graph attribution uses the same output ratio. stop() uses
              // the reply-only pre-barge reference, excluding baseline opener.
              const voiced = rms > 0 && rms >= speechRms * OUTPUT_SILENCE_RMS_RATIO;
              if (voiced) voicedSince ??= at; else voicedSince = undefined;
              onRendered({ samples, at, timestamp, rms, voiced, voicedSince, contextTime: time,
                durationMs: samples.length / context.sampleRate * 1000, sampleRateHz: context.sampleRate, sink });
            }
            if (pending.length) timer = setTimeout(observe, 10);
          } catch (error) { onFault(error); }
        };
        sink.onaudioprocess = event => {
          if (closed || !enabled()) return;
          if (pending.length * 1024 / context.sampleRate >= 8) { onFault(new Error('Output queue bound exceeded')); return; }
          pending.push({ samples: Float32Array.from(event.inputBuffer.getChannelData(0), value => value * volume()),
            time: event.playbackTime - event.inputBuffer.duration });
          observe();
        };
        const silence = context.createGain(); silence.gain.value = 0;
        nativeConnect.call(sink, silence); nativeConnect.call(silence, context.destination);
        active.add(() => { closed = true; clearTimeout(timer); sink.disconnect(); silence.disconnect(); });
        sinks.set(context, sink);
      }
      nativeConnect.call(source, sink);
    },
    close() { for (const close of active) close(); active.clear(); },
  };
  window.qualificationOutputProbe = probe;
  return probe;
}
