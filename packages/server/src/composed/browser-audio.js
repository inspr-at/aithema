const cancelled = () => new DOMException('Capture cancelled', 'AbortError');

/** Permission denial is surfaced to the host; a late permission result cannot
 * resurrect a stopped capture. onFault feeds the existing lifecycle controller. */
export function createPCMCapture({ mediaDevices = navigator.mediaDevices, AudioContext: Context = globalThis.AudioContext,
  workletURL = new URL('./pcm-capture-worklet.js', import.meta.url), onTiming = () => {}, onFault = () => {},
  audioProcessing = true, clock = () => performance.now() } = {}) {
  return async function capture({ signal, onAudio, onError = () => {} }) {
    let stream, context, source, node, stopped = false, pending = 0, tail = Promise.resolve(), level = 0, levelAt = -Infinity;
    const stop = () => {
      if (stopped) return;
      stopped = true; signal?.removeEventListener('abort', stop);
      if (node) node.port.onmessage = null;
      source?.disconnect(); node?.disconnect(); stream?.getTracks().forEach(track => track.stop());
      if (context) void context.close().catch(() => {});
    };
    const fault = error => { if (!stopped) { stop(); onFault(error); onError(error); } };
    signal?.addEventListener('abort', stop, { once: true });
    try {
      if (signal?.aborted) throw cancelled();
      if (typeof mediaDevices?.getUserMedia !== 'function') throw new DOMException('No microphone available', 'NotFoundError');
      stream = await mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000,
        echoCancellation: audioProcessing, noiseSuppression: audioProcessing, autoGainControl: false }, video: false });
      if (stopped || signal?.aborted) { stream.getTracks().forEach(track => track.stop()); throw cancelled(); }
      for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => fault(new Error('Capture track ended')), { once: true });
      context = new Context({ sampleRate: 16000 });
      await context.audioWorklet.addModule(workletURL);
      if (stopped) throw cancelled();
      source = context.createMediaStreamSource(stream);
      node = new AudioWorkletNode(context, 'composed-pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.onmessage = ({ data }) => {
        if (stopped) return;
        if (++pending > 8) { fault(new Error('Capture transport fell behind')); return; }
        const receivedAt = clock(), receivedContextTime = context.currentTime;
        // All browser timings use the same monotonic performance clock. Preserve
        // device frame/time too so OPS can inspect worklet delivery jitter.
        const captureAt = receivedAt + (data.captureFrame / data.contextSampleRate - receivedContextTime) * 1000;
        const view = new DataView(data.bytes.buffer, data.bytes.byteOffset, data.bytes.byteLength); let energy = 0;
        for (let i = 0; i < data.bytes.length; i += 2) energy += (view.getInt16(i, true) / 32768) ** 2;
        level = Math.sqrt(energy / (data.bytes.length / 2)); levelAt = receivedAt;
        onTiming({ kind: 'capture', captureAt, receivedAt, voiced: Math.sqrt(energy / (data.bytes.length / 2)) >= 0.015,
          durationMs: data.bytes.length / 32, captureFrame: data.captureFrame,
          contextSampleRate: data.contextSampleRate, byteLength: data.bytes.byteLength });
        tail = tail.then(() => { if (!stopped) return onAudio(data.bytes); }).catch(fault).finally(() => { pending--; });
      };
      source.connect(node); node.connect(context.destination); // Worklet output is silence.
      await context.resume(); if (stopped) throw cancelled();
      return { stop, audioLevel: () => stopped || clock() - levelAt > 150 ? 0 : Math.min(1, level) };
    } catch (error) { stop(); throw error; }
  };
}

/** Explicit wire formats and one scheduling cursor preserve fragment order.
 * stop() cancels every scheduled source synchronously, including future audio. */
export function createPCMPlayer({ AudioContext: Context = globalThis.AudioContext, onTiming = () => {},
  clock = () => performance.now(), maxQueuedSeconds = 8, observeOutput = () => {} } = {}) {
  let context, analyser, meter, cursor = 0;
  const sources = new Set();
  const stop = ({ origin = 'control' } = {}) => {
    const requestedAt = clock();
    for (const row of sources) { clearTimeout(row.timer); row.source.stop(); row.source.disconnect(); row.resolve(); }
    sources.clear(); cursor = context?.currentTime ?? 0;
    onTiming({ kind: 'playback-stop', origin, requestedAt, stoppedAt: clock(), outputLatency: context?.outputLatency ?? null,
      outputTimestamp: context?.getOutputTimestamp?.() ?? null });
  };
  return Object.freeze({
    async play(bytes, { format, sampleRateHz, channels, replyId } = {}) {
      if (!(bytes instanceof Uint8Array) || !bytes.length || !['pcm_s16le', 'pcm_f32le'].includes(format) ||
        !Number.isSafeInteger(sampleRateHz) || sampleRateHz < 8000 || sampleRateHz > 96000 || channels !== 1) throw new TypeError('Explicit mono PCM format required');
      const width = format === 'pcm_s16le' ? 2 : 4;
      if (bytes.length % width) throw new TypeError('Misaligned PCM frame');
      if (!context) {
        context = new Context();
        analyser = context.createAnalyser(); analyser.fftSize = 256;
        meter = new Float32Array(analyser.fftSize); analyser.connect(context.destination);
      }
      // Reserve and schedule synchronously; resume cannot reorder queued sources.
      const start = Math.max(cursor, context.currentTime + 0.02), duration = bytes.length / width / sampleRateHz;
      if (start + duration - context.currentTime > maxQueuedSeconds) throw new Error('Playback queue full');
      const buffer = context.createBuffer(1, bytes.length / width, sampleRateHz), samples = buffer.getChannelData(0),
        view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < samples.length; i++) {
        const value = width === 2 ? view.getInt16(i * width, true) / 32768 : view.getFloat32(i * width, true);
        if (!Number.isFinite(value)) throw new TypeError('Invalid PCM sample');
        samples[i] = Math.max(-1, Math.min(1, value));
      }

      const resuming = context.resume(); cursor = start + duration;
      const source = context.createBufferSource(); source.buffer = buffer; source.connect(analyser); observeOutput(source);
      const completion = Promise.withResolvers(), row = { source, resolve: completion.resolve }; sources.add(row);
      source.onended = () => { clearTimeout(row.timer); sources.delete(row); source.disconnect(); completion.resolve(); };
      source.start(start);
      // Autoplay may leave resume pending indefinitely. Surface that existing blocked-playback state.
      const resumeTimer = setTimeout(() => {
        if (sources.has(row) && context.state !== 'running') {
          completion.reject(new DOMException('Playback requires a user gesture', 'NotAllowedError'));
          stop({ origin: 'playback-blocked' });
        }
      }, 250);
      void resuming.then(() => { clearTimeout(resumeTimer); }, error => {
        clearTimeout(resumeTimer); completion.reject(error); stop({ origin: 'teardown' });
      });
      completion.promise.finally(() => clearTimeout(resumeTimer)).catch(() => {});
      const observeStart = () => {
        if (!sources.has(row)) return;
        const timestamp = context.getOutputTimestamp?.();
        if (timestamp?.contextTime >= start && timestamp.performanceTime > 0) {
          onTiming({ kind: 'playback-start', replyId, firstAudioAt: timestamp.performanceTime - (timestamp.contextTime - start) * 1000,
            outputTimestamp: timestamp });
        } else row.timer = setTimeout(observeStart, 10);
      };
      observeStart();
      const scheduledAt = clock() + (start - context.currentTime) * 1000;
      onTiming({ kind: 'playback-scheduled', replyId, scheduledAt, contextStart: start, sampleRateHz, channels, format,
        // getOutputTimestamp maps the actual audio device clock to performance time.
        outputTimestamp: context.getOutputTimestamp?.() ?? null });
      return completion.promise;
    },
    stop,
    audioLevel() {
      if (!sources.size || context?.state !== 'running') return 0;
      analyser.getFloatTimeDomainData(meter);
      return Math.min(1, Math.sqrt(meter.reduce((sum, value) => sum + value * value, 0) / meter.length));
    },
    async retry() {
      if (!context) return;
      await context.resume();
      if (context.state !== 'running') throw new DOMException('Playback requires a user gesture', 'NotAllowedError');
    },
    async close() { stop({ origin: 'teardown' }); await context?.close(); analyser?.disconnect(); context = analyser = meter = undefined; },
  });
}
