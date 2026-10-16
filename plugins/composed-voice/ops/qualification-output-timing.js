// Classify and close before either lane's paid deadline. The 500 ms allowance
// covers evidence classification plus ordinary shutdown (baseline close starts
// 250 ms before the hard watchdog). This never extends the paid duration.
export function qualificationObservationWindow(deadlineAt, now = Date.now()) {
  if (!Number.isFinite(deadlineAt)) throw new TypeError('Sample deadline required');
  return Math.max(1, Math.min(50_000, deadlineAt - now - 500));
}

/** Self-contained for evaluateOnNewDocument in the production baseline. Both
 * lanes tap the rendered output with 1024-frame blocks (~21 ms at 48 kHz), map
 * them through getOutputTimestamp, and stop at the first block AFTER barge-in
 * with RMS < .015. Explicit player.stop() calls are diagnostics only. */
export function installQualificationOutputProbe() {
  const sinks = new WeakMap(), active = new Set();
  const nativeConnect = AudioNode.prototype.connect;
  const probe = {
    stop(block, bargeInAt, teardownAt = Infinity) {
      if (Number.isFinite(bargeInAt) && block.at >= bargeInAt && block.at < teardownAt && !block.voiced) {
        return { kind: 'playback-stop', stoppedAt: block.at, outputTimestamp: block.timestamp, origin: 'rendered-silence' };
      }
    },
    tap(source, onRendered, { volume = () => 1, enabled = () => true, onFault = error => { throw error; } } = {}) {
      const context = source.context;
      let sink = sinks.get(context);
      if (!sink) {
        sink = context.createScriptProcessor(1024, 1, 1);
        const pending = []; let timer, voicedSince, closed = false;
        const observe = () => {
          clearTimeout(timer);
          if (closed || !enabled()) return;
          try {
            const timestamp = context.getOutputTimestamp();
            while (pending.length && timestamp.performanceTime > 0 && timestamp.contextTime >= pending[0].time) {
              const { samples, time } = pending.shift();
              const at = timestamp.performanceTime + (time - timestamp.contextTime) * 1000;
              const voiced = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length) >= .015;
              if (voiced) voicedSince ??= at; else voicedSince = undefined;
              onRendered({ samples, at, timestamp, voiced, voicedSince, sampleRateHz: context.sampleRate, sink });
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
