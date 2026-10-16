import { createPCMCapture, createPCMPlayer } from '/plugins/composed-voice/src/browser-audio.js';
import { createNetworkRelayClient } from '/plugins/composed-voice/src/network-client.js';
import { createComposedBrowserMedia } from '/plugins/composed-voice/src/client.js';

// This hook contains no provider, transcript, accounting or fixture authority.
window.composedQualification = {
  async run({ grant, headers }) {
    const trace = [], done = Promise.withResolvers();
    done.promise.catch(() => {});
    let session, firstAudioAt, bargeInAt, stopping = false;
    const onTiming = event => {
      if (trace.length >= 100_000) { done.reject(new Error('Timing evidence bound exceeded')); return; }
      trace.push(event);
      if (event.kind === 'playback-start') firstAudioAt ??= event.firstAudioAt;
      if (event.kind === 'capture' && event.voiced && event.captureAt >= firstAudioAt && session && !stopping) {
        bargeInAt = event.captureAt; stopping = true;
        void session.interrupt().catch(done.reject);
        // The barge-in is the final capture observation for this corpus item.
        void session.setInput(false).catch(done.reject);
      }
      if (stopping && event.kind === 'playback-stop' && event.stoppedAt >= bargeInAt) done.resolve();
    };
    const player = createPCMPlayer({ onTiming });
    const media = createComposedBrowserMedia({ player, capture: createPCMCapture({ audioProcessing: false, onTiming, onFault: done.reject }),
      openRelay: createNetworkRelayClient({ headers }) });
    const timer = setTimeout(() => done.reject(new Error('Physical capture/output/barge-in evidence timed out')), 50_000);
    let failure;
    try {
      session = await media.connect(grant);
      void (async () => {
        for await (const event of session.events) if (event.type === 'waiting' || event.type === 'ended') {
          done.reject(new Error(`Qualification media ${event.type}: ${event.reason}`));
        }
      })().catch(done.reject);
      await done.promise;
      return trace;
    } catch (error) {
      failure = error;
      const counts = Object.fromEntries(['capture', 'playback-scheduled', 'playback-start', 'playback-stop'].map(kind => [kind, trace.filter(event => event.kind === kind).length]));
      counts.voiced = trace.filter(event => event.kind === 'capture' && event.voiced).length;
      throw new Error(`${error.message}; device evidence ${JSON.stringify(counts)}`, { cause: error });
    } finally {
      clearTimeout(timer);
      try { await session?.close().catch(error => { if (!failure) throw error; }); }
      finally { await player.close(); }
    }
  },
};
