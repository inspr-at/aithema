// The conversation waveform, adapted from START src/lib/waveform-level.ts and the conversation
// signal of src/lib/microphone.ts (INSPR rights, D3). The rail draws a rolling history of the
// measured level: the visitor's input runs from the left while listening, the spoken reply from
// the right while speaking. Display only: it never changes capture or playback.
const WIDTH = 480, HEIGHT = 64, HISTORY = 64;
const COLOUR = { user: '#12908c', assistant: '#b66a23' };

/** Display-only gain: quiet speech still fills most of the height; silence stays flat. */
export class WaveformLevel {
  #reference = .04; #level = 0;
  reset() { this.#reference = .04; this.#level = 0; }
  sample(peak, rms, elapsedMs = 20) {
    const dt = Math.min(100, Math.max(1, elapsedMs));
    if (!Number.isFinite(peak) || !Number.isFinite(rms)) return 0;
    const audible = rms > .009 && peak > .015;
    // Follow louder speech quickly; release slowly so syllables keep their dynamics.
    if (audible) this.#reference += (Math.max(.02, peak) - this.#reference) * (1 - Math.exp(-dt / (peak > this.#reference ? 45 : 1800)));
    const gain = Math.min(48, .94 / Math.max(.02, this.#reference));
    const target = audible ? Math.min(1, peak * gain) : 0;
    this.#level += (target - this.#level) * (1 - Math.exp(-dt / (target > this.#level ? 18 : 65)));
    if (this.#level < .005) this.#level = 0;
    return this.#level;
  }
}

export class Waveform {
  #history = new Float32Array(HISTORY); #levels = { user: new WaveformLevel(), assistant: new WaveformLevel() }; #direction = 'user'; #context;
  constructor(canvas) {
    const ratio = Math.min(2, Math.max(1, canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1));
    canvas.width = WIDTH * ratio; canvas.height = HEIGHT * ratio; this.canvas = canvas; this.ratio = ratio;
    try { this.#context = canvas.getContext('2d'); } catch { this.#context = null; }
    this.baseline();
  }
  get direction() { return this.#direction; }
  /** One measured level (0 to 1); a change of direction starts a fresh history. */
  push(level, direction, elapsedMs) {
    if (direction !== this.#direction) { this.#history.fill(0); this.#direction = direction; }
    const value = Math.min(1, Math.max(0, Number(level) || 0));
    this.#history.copyWithin(0, 1); this.#history[HISTORY - 1] = this.#levels[direction].sample(value, value / Math.SQRT2, elapsedMs);
    this.#draw();
  }
  baseline() { this.#history.fill(0); this.#levels.user.reset(); this.#levels.assistant.reset(); this.#draw(); }
  #draw() {
    const context = this.#context; if (!context) return;
    const { width, height } = this.canvas, middle = height / 2, amplitude = height * .47;
    context.clearRect(0, 0, width, height); context.beginPath();
    context.lineCap = 'round'; context.lineJoin = 'round'; context.lineWidth = 1.5 * this.ratio; context.strokeStyle = COLOUR[this.#direction];
    context.moveTo(0, middle); context.lineTo(width, middle);
    this.#history.forEach((level, index) => {
      const position = index / (HISTORY - 1), x = (this.#direction === 'assistant' ? 1 - position : position) * width, bar = level * amplitude;
      if (bar >= .5) { context.moveTo(x, middle - bar); context.lineTo(x, middle + bar); }
    });
    context.stroke();
  }
}
