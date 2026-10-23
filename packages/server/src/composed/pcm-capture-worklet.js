// Native capture clock -> PCM16 LE mono 16 kHz. A fixed 40 ms packet keeps
// transport overhead bounded. Audio never flows through the main-thread graph.
// The public asset URL can also be resolved/imported by server-side hosts.
if (typeof AudioWorkletProcessor === 'function' && typeof registerProcessor === 'function') {
  class ComposedPCMCapture extends AudioWorkletProcessor {
    constructor() {
      super(); this.phase = 0; this.sum = 0; this.count = 0; this.offset = 0;
      this.bytes = new Uint8Array(1280); this.firstFrame = 0;
    }
    process(inputs) {
      const channels = inputs[0]; if (!channels?.length) return true;
      for (let i = 0; i < channels[0].length; i++) {
        let mono = 0; for (const channel of channels) mono += channel[i] / channels.length;
        this.sum += mono; this.count++; this.phase += 16000;
        if (this.phase < sampleRate) continue;
        this.phase -= sampleRate;
        if (this.offset === 0) this.firstFrame = currentFrame + i;
        const sample = Math.max(-1, Math.min(1, this.sum / this.count)); this.sum = 0; this.count = 0;
        new DataView(this.bytes.buffer).setInt16(this.offset, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
        this.offset += 2;
        if (this.offset === this.bytes.length) {
          this.port.postMessage({ bytes: this.bytes, captureFrame: this.firstFrame, contextSampleRate: sampleRate }, [this.bytes.buffer]);
          this.bytes = new Uint8Array(1280); this.offset = 0;
        }
      }
      return true;
    }
  }
  registerProcessor('composed-pcm-capture', ComposedPCMCapture);
}
