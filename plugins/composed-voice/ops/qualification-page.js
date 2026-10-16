import { createPCMCapture, createPCMPlayer } from '/plugins/composed-voice/src/browser-audio.js';
import { createNetworkRelayClient } from '/plugins/composed-voice/src/network-client.js';
import { createComposedBrowserMedia } from '/plugins/composed-voice/src/client.js';

// This hook contains no provider, transcript, accounting or fixture authority.
window.composedQualification = {
  async run({ grant, headers }) {
    const trace = [], done = Promise.withResolvers();
    done.promise.catch(() => {});
    const scripted = window.qualificationScriptedCapture;
    let session, eventsTask, finished = false, firstAudioAt, bargeInAt, mediaFailure, stoppedAt = -Infinity;
    const fail = error => { mediaFailure ??= error; done.reject(error); };
    const refuse = reason => {
      if (!['late-first-audio', 'barge-in-before-first-audio', 'missing-playback-stop'].includes(reason)) {
        throw new Error('Unknown qualification media refusal');
      }
      done.resolve({ refusal: reason });
    };
    const sourceStatus = () => {
      const status = scripted.diagnostics();
      if (!status || typeof status.started !== 'boolean' || typeof status.barged !== 'boolean') throw new Error('Missing scripted capture diagnostics');
      if (status.failure) throw new Error(`Scripted capture failed: ${status.failure}`);
      if (status.refusal) refuse(status.refusal);
      return status;
    };
    const finishTiming = () => {
      try {
        const status = sourceStatus();
        if (status.refusal) return;
        if (status.started && firstAudioAt === undefined && trace.some(event => event.kind === 'capture' && event.voiced)) refuse('late-first-audio');
        else if (Number.isFinite(bargeInAt)) refuse('missing-playback-stop');
        else throw new Error('Incomplete scripted capture evidence');
      } catch (error) { fail(error); }
    };
    const onTiming = event => {
      if (finished) return;
      try {
        if (trace.length >= 100_000) throw new Error('Timing evidence bound exceeded');
        trace.push(event);
        if (event.kind === 'capture-outcome') {
          if (event.status === 'refused') refuse(event.reason);
          else throw new Error(`Scripted capture failed: ${event.reason}`);
        }
        if (event.kind === 'playback-start' && firstAudioAt === undefined) {
          firstAudioAt = event.firstAudioAt; scripted.firstAudio(firstAudioAt); sourceStatus();
          // Source callbacks and rendered output callbacks can arrive out of order.
          bargeInAt = trace.find(row => row.kind === 'capture' && row.voiced && row.captureAt >= firstAudioAt)?.captureAt;
        }
        // Both lanes use the injected stream's onset in the SOURCE clock. Only
        // the product's own capture/VAD/turn logic may interrupt its playback.
        if (event.kind === 'capture' && event.voiced && event.captureAt >= firstAudioAt) bargeInAt ??= event.captureAt;
        if (event.kind === 'playback-stop') stoppedAt = Math.max(stoppedAt, event.stoppedAt);
        if (stoppedAt >= bargeInAt) done.resolve({});
      } catch (error) { fail(error); }
    };
    const player = createPCMPlayer({ onTiming });
    const media = createComposedBrowserMedia({ player, capture: createPCMCapture({ audioProcessing: false, onFault: fail }),
      openRelay: createNetworkRelayClient({ headers }) });
    const timer = setTimeout(finishTiming, 50_000);
    const unsubscribe = scripted.subscribe(onTiming);
    try {
      session = await media.connect(grant);
      scripted.startUtterance(); sourceStatus();
      eventsTask = (async () => {
        for await (const event of session.events) {
          if (event.type === 'ended' && event.reason === 'closed') finishTiming();
          else if (event.type === 'waiting' || event.type === 'ended') {
            // Only the normal end of an otherwise healthy sample is eligible
            // for timing classification. Every failure reason remains an abort.
            fail(new Error(`Qualification media ${event.type}: ${event.reason}`));
          }
        }
      })().catch(fail);
      const result = await done.promise;
      sourceStatus();
      if (mediaFailure) throw mediaFailure;
      return { trace, ...result };
    } catch (error) {
      const counts = Object.fromEntries(['capture', 'playback-scheduled', 'playback-start', 'playback-stop'].map(kind => [kind, trace.filter(event => event.kind === kind).length]));
      counts.voiced = trace.filter(event => event.kind === 'capture' && event.voiced).length;
      throw new Error(`${error.message}; device evidence ${JSON.stringify(counts)}`, { cause: error });
    } finally {
      finished = true; clearTimeout(timer); unsubscribe();
      try {
        await session?.close(); await eventsTask;
        if (mediaFailure) throw mediaFailure;
      }
      finally { try { await player.close(); } finally { await scripted.close(); } }
    }
  },
};
