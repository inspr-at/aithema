/** CDP new-document injection in BOTH lanes, before any product getUserMedia.
 * Only this source replaces capture. Physical output and its probe stay intact. */
export function installScriptedCapture(clips) {
  // AIT-256: OPS observed 1–3 s replies. 800 ms after the observed device onset
  // lands inside that playback; never anchor to user speech end or a WAV offset.
  const BARGE_IN_DELAY_MS = 800;
  const listeners = new Set(), sources = new Set();
  let context, destination, observer, silence, buffers, started = false, barged = false, closed = false;
  let pendingFirstAudioAt, failure;
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
        if (closed) return;
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
    await initialize();
    return destination.stream.clone();
  };
  const firstAudio = firstAudioAt => {
    if (barged || !Number.isFinite(firstAudioAt)) return;
    pendingFirstAudioAt = firstAudioAt;
    if (!started) return;
    const remaining = firstAudioAt + BARGE_IN_DELAY_MS - performance.now();
    if (remaining < 0) { failure = 'late-first-audio'; return; }
    barged = true;
    play('bargeIn', context.currentTime + remaining / 1000);
  };
  window.qualificationScriptedCapture = Object.freeze({
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    startUtterance() {
      if (started) return;
      if (!context || closed) throw new Error('Scripted capture not ready');
      started = true; play('utterance', context.currentTime);
      firstAudio(pendingFirstAudioAt);
    },
    firstAudio,
    diagnostics: () => ({ started, barged, failure }),
    async close() {
      closed = true; listeners.clear();
      for (const source of sources) { source.stop(); source.disconnect(); }
      destination?.stream.getTracks().forEach(track => track.stop());
      observer?.disconnect(); silence?.disconnect(); await context?.close();
    },
  });
}
