import { checkAbort, speechError } from './common.js';

/** Bounded deterministic energy VAD for inline 16 kHz mono PCM16 frames.
 * This is an activity detector, not end-of-turn prediction or speaker ID.
 * Thresholds need corpus qualification at P16/P18/P19; no quality claim here.
 */
export class PcmEnergyVad {
  constructor({ threshold = 0.02, maxFrameMs = 100 } = {}) {
    if (!Number.isFinite(threshold) || threshold < 0.000001 || threshold > 1
        || !Number.isSafeInteger(maxFrameMs) || maxFrameMs < 1 || maxFrameMs > 100) throw new TypeError('Invalid VAD bounds');
    this.threshold = threshold;
    this.maxBytes = maxFrameMs * 32;
  }

  async detect({ bytes, signal }) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('VAD signal must be an AbortSignal');
    checkAbort(signal);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength % 2 || bytes.byteLength > this.maxBytes) {
      throw speechError('invalid_audio', 'VAD requires a bounded PCM16 frame');
    }
    const frame = Buffer.from(bytes);
    let energy = 0;
    for (let offset = 0; offset < frame.length; offset += 2) energy += (frame.readInt16LE(offset) / 32768) ** 2;
    const rms = Math.sqrt(energy / (frame.length / 2));
    checkAbort(signal);
    return { speech: rms >= this.threshold, rms };
  }
}
