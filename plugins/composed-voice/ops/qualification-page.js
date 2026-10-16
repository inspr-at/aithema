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
    const media = createComposedBrowserMedia({ player, capture: createPCMCapture({ onTiming, onFault: done.reject }),
      openRelay: createNetworkRelayClient({ headers }) });
    const timer = setTimeout(() => done.reject(new Error('Physical capture/output/barge-in evidence timed out')), 60_000);
    try {
      session = await media.connect(grant);
      await done.promise;
      return trace;
    } finally { clearTimeout(timer); await session?.close(); await player.close(); }
  },
};
