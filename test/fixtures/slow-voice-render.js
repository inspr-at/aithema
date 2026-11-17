// Deterministic load control, outside the default test glob:
// node --test --import ./test/fixtures/slow-voice-render.js demo/test/voice.test.js
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AudioRail } from '../../packages/ui/src/audio-rail.js';

// A forked demo server inherits --import too; only the journey worker is slowed.
if (resolve(process.argv[1] ?? '.') === fileURLToPath(new URL('../../demo/test/voice.test.js', import.meta.url))) {
  const { render, sendText, receivedReply, destroy } = AudioRail.prototype;
  let slow = false;
  AudioRail.prototype.sendText = function (...args) {
    slow = true;
    return sendText.apply(this, args);
  };
  AudioRail.prototype.receivedReply = function (...args) {
    slow = false;
    return receivedReply.apply(this, args);
  };
  AudioRail.prototype.render = function (...args) {
    const result = render.apply(this, args);
    if (slow) {
      const until = performance.now() + 200;
      while (performance.now() < until) {}
    }
    return result;
  };
  AudioRail.prototype.destroy = function (...args) {
    slow = false;
    return destroy.apply(this, args);
  };
}
