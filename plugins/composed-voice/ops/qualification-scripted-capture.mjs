/** CDP new-document injection in BOTH lanes, before any product getUserMedia.
 * Only this source replaces capture. Physical output and its probe stay intact. */
export function installScriptedCapture(clips) {
  // AIT-256: OPS observed 1–3 s replies. 800 ms after the observed device onset
  // lands inside that playback; never anchor to user speech end or a WAV offset.
  const BARGE_IN_DELAY_MS = 800;
  const listeners = new Set(), sources = new Set();
  let context, destination, observer, silence, buffers, started = false, barged = false, closed = false, inputStopped = false;
  let pendingFirstAudioAt, failure, refusal;
  const terminal = (status, reason) => {
    if (failure || refusal) return;
    if (status === 'refused') refusal = reason; else failure = reason;
    for (const listener of listeners) listener({ kind: 'capture-outcome', status, reason });
  };
  const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const initialize = async () => {
    if (!context) {
      context = new AudioContext({ sampleRate: 16000 });
      destination = context.createMediaStreamDestination();
      buffers = Object.fromEntries(Object.entries(clips).map(([name, clip]) => {
        const bytes = Uint8Array.from(atob(clip.pcm), value => value.charCodeAt(0));
        const view = new DataView(bytes.buffer), buffer = context.createBuffer(1, bytes.length / 2, clip.sampleRateHz);
        const samples = buffer.getChannelData(0);
        for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
        return [name, buffer];
      }));
      observer = context.createScriptProcessor(1024, 1, 1);
      silence = context.createGain(); silence.gain.value = 0;
      observer.connect(silence); silence.connect(context.destination);
      observer.onaudioprocess = event => {
        if (closed || inputStopped) return;
        const samples = event.inputBuffer.getChannelData(0), receivedAt = performance.now();
        const frame = Math.round((event.playbackTime - event.inputBuffer.duration) * context.sampleRate);
        // Same monotonic performance domain as both probes. Map this SOURCE's
        // AudioContext frames at observation, exactly like createPCMCapture and
        // the baseline tap; do not use scheduling time as speech evidence.
        const captureAt = receivedAt + (frame / context.sampleRate - context.currentTime) * 1000;
        let energy = 0; for (const value of samples) energy += value * value;
        const timing = { kind: 'capture', captureAt, receivedAt, captureFrame: frame,
          contextSampleRate: context.sampleRate, voiced: Math.sqrt(energy / samples.length) >= 0.015,
          durationMs: samples.length / context.sampleRate * 1000, byteLength: samples.length * 2 };
        for (const listener of listeners) listener(timing);
      };
    }
    await context.resume();
  };
  const play = (name, at) => {
    const source = context.createBufferSource(); source.buffer = buffers[name];
    source.connect(destination); source.connect(observer); sources.add(source);
    source.onended = () => { sources.delete(source); source.disconnect(); };
    source.start(at);
  };
  navigator.mediaDevices.getUserMedia = async constraints => {
    if (!constraints?.audio) return nativeGetUserMedia(constraints);
    if (closed) throw new Error('Scripted capture closed');
    try { await initialize(); return destination.stream.clone(); }
    catch (error) { terminal('error', 'start-failed'); throw error; }
  };
  const firstAudio = firstAudioAt => {
    if (inputStopped || barged || failure || refusal || !Number.isFinite(firstAudioAt)) return;
    pendingFirstAudioAt = firstAudioAt;
    if (!started) return;
    const remaining = firstAudioAt + BARGE_IN_DELAY_MS - performance.now();
    if (remaining < 0) { terminal('refused', 'late-first-audio'); return; }
    try {
      play('bargeIn', context.currentTime + remaining / 1000); barged = true;
    } catch { terminal('error', 'start-failed'); }
  };
  // Fence synchronously at the measurement outcome; AudioContext cleanup may
  // await, but no remaining barge-in audio may reach the product meanwhile.
  const stopInput = () => {
    if (inputStopped) return;
    inputStopped = true;
    for (const source of sources) { source.stop(); source.disconnect(); }
    sources.clear();
    destination?.stream.getTracks().forEach(track => track.stop());
  };
  window.qualificationScriptedCapture = Object.freeze({
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    startUtterance() {
      if (started || inputStopped) return;
      if (!context || closed) throw new Error('Scripted capture not ready');
      try { play('utterance', context.currentTime); started = true; }
      catch (error) { terminal('error', 'start-failed'); throw error; }
      firstAudio(pendingFirstAudioAt);
    },
    firstAudio, stopInput,
    diagnostics: () => ({ started, barged, failure, refusal }),
    async close() {
      stopInput(); closed = true; listeners.clear();
      observer?.disconnect(); silence?.disconnect(); await context?.close();
    },
  });
}
