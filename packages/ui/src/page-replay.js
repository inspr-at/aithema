import { createReplyReplay } from '../../core/src/reply-replay.js';
import { playReplyAudio } from './reply-audio.js';

/** The same explicit replay outside a call uses page audio and the host's current-reply fence. */
export function createPageReplay({ control, document = globalThis.document, playAudio = playReplyAudio }) {
  let fence = () => false, cleanup, onState;
  const player = createReplyReplay({ current: reply => !document?.hidden && fence(reply),
    synthesize: (reply, options) => control.speakText?.({ turnId: reply.turnId, replayId: options.replayId }, options),
    release: replayId => control.stopReplyReplay?.({ replayId }),
    playAudio: (audio, options) => playAudio(audio, { ...options, document }),
    onState: playing => { onState?.(playing); if (!playing) { cleanup?.(); cleanup = null; } } });
  return { stop() { const released = player.stop(); cleanup?.(); cleanup = null; return released; }, get active() { return player.active; },
    async replay(reply, options = {}) {
      player.stop();
      onState = options.onState;
      fence = candidate => !options.holdSignal?.aborted && options.current?.(candidate) !== false;
      const stop = () => player.stop(), hidden = () => { if (document.hidden) stop(); };
      document?.addEventListener('visibilitychange', hidden); document?.addEventListener('freeze', stop);
      options.holdSignal?.addEventListener('abort', stop, { once: true });
      cleanup = () => { document?.removeEventListener('visibilitychange', hidden); document?.removeEventListener('freeze', stop);
        options.holdSignal?.removeEventListener('abort', stop); };
      try {
        return await player.replay(reply, { ...options,
          signal: options.holdSignal ? options.signal ? AbortSignal.any([options.signal, options.holdSignal]) : options.holdSignal : options.signal });
      } finally {
        // Keep holds bound during playback, then release them when it stops.
        if (!player.active) { cleanup?.(); cleanup = null; }
      }
    },
  };
}
