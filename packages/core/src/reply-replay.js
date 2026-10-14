import { PluginError } from './invocation.js';
import { voiceOperation } from './live-voice.js';

/** Playback has its own lifetime; it never blocks pause, hangup or turn delivery. */
export function createReplyReplay({ current, synthesize, playAudio, onState = () => {}, release = () => {} }) {
  let active, revision = 0;
  const stop = () => {
    revision++;
    const previous = active; active = null;
    if (!previous) return;
    previous.controller.abort(); previous.player?.stop(); previous.cleanup?.(); onState(false);
    return Promise.resolve().then(() => release(previous.replayId)).catch(() => {});
  };
  return { stop, get revision() { return revision; }, get active() { return Boolean(active); },
    async replay(reply, options = {}) {
      if (!reply || !current(reply)) throw new PluginError('unavailable');
      stop();
      const entry = { controller: new AbortController(), replayId: crypto.randomUUID() }; active = entry;
      const valid = () => active === entry && current(reply);
      const signal = options.signal ? AbortSignal.any([entry.controller.signal, options.signal]) : entry.controller.signal;
      const aborted = () => { if (active === entry) stop(); };
      signal.addEventListener('abort', aborted, { once: true });
      entry.cleanup = () => signal.removeEventListener('abort', aborted);
      try {
        const result = await voiceOperation({ ...options, signal }, async bounded => {
          let result;
          try { result = await synthesize?.(reply, { ...bounded, replayId: entry.replayId }); }
          catch (error) {
            if (signal.aborted || !valid() || ['not-admitted', 'already-claimed', 'voice-ownership-lost', 'cancelled', 'deadline'].includes(error.code)) throw error;
          }
          if (!valid()) throw new PluginError('unavailable');
          if (result?.kind === 'busy') return { kind: 'busy' };
          if (result?.kind !== 'audio' || !playAudio) return { kind: 'text', text: reply.text };
          let player;
          try { player = await playAudio(result.audio, { ...bounded, current: valid }); }
          catch (error) { if (signal.aborted || !valid()) throw error; return { kind: 'text', text: reply.text }; }
          if (!valid()) { player?.stop(); throw new PluginError('cancelled'); }
          entry.player = player; onState(true);
          Promise.resolve(player.finished).finally(() => { if (active === entry) stop(); }).catch(() => {});
          return { kind: 'audio', text: reply.text };
        });
        if (['text', 'busy'].includes(result.kind) && active === entry) stop();
        return result;
      } catch (error) { if (active === entry) stop(); throw error; }
      finally { if (!active || active !== entry) signal.removeEventListener('abort', aborted); }
    },
  };
}
