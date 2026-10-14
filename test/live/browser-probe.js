// Serialized into Chrome by Puppeteer. Records timing/flags only, never content.
export async function installProbe({ mode, locale, utterances }) {
  const { AudioRail } = await import('/packages/ui/src/audio-rail.js');
  const state = globalThis.soak = { events: [], turns: [], session: null, speaking: false,
    samples: 0, peak: 0, speechSamples: 0, overlapSamples: 0, gateUntil: 0, closed: false, heartbeatFailures: 0 };
  const clock = () => performance.now();
  const consume = AudioRail.prototype.consume;
  AudioRail.prototype.consume = function (session, generation) {
    state.session = session;
    const source = session.events;
    session.events = (async function* () {
      for await (const event of source) {
        const atMs = clock();
        state.events.push({ type: event.type, atMs, ...(event.role ? { role: event.role } : {}) });
        if (event.type === 'speaking') state.speaking = true;
        if (['listening', 'ended', 'waiting', 'recovering'].includes(event.type)) state.speaking = false;
        const turn = state.turns.at(-1);
        if (turn && (turn.speechEndMs === undefined || atMs >= turn.speechEndMs)) {
          // With no marker yet, retain only the gate-open observation. A later
          // end marker clears any response that belonged to earlier playback.
          if (turn.firstResponseAtMs === undefined && (event.type === 'speaking' || event.type === 'final' && event.role === 'assistant')) turn.firstResponseAtMs = atMs;
          if (turn.speechEndMs !== undefined && turn.finalMs === undefined && event.type === 'final' && event.role === 'assistant') turn.finalMs = atMs - turn.speechEndMs;
        }
        if (event.type === 'ended') state.closed = true;
        yield event;
      }
    })();
    return consume.call(this, session, generation);
  };
  // Preflight Chrome's fake file device. Scripted input then uses one-shot WAV
  // buffers in the same capture destination, independent of Chrome's loop phase.
  const media = navigator.mediaDevices, native = media.getUserMedia.bind(media);
  const stream = await native({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const context = new AudioContext({ sinkId: { type: 'none' } });
  await context.resume();
  const buffers = await Promise.all(utterances.map(async encoded => {
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    return context.decodeAudioData(bytes.buffer);
  }));
  const source = context.createMediaStreamSource(stream), gain = context.createGain(), analyser = context.createAnalyser();
  const destination = context.createMediaStreamDestination();
  // Fake voice never consumes the media stream. Keep the graph pulled through a
  // output as well, so Chrome processes the same input in both modes. Chrome's
  // --mute-audio keeps this test output silent without pruning a zero-gain sink.
  analyser.connect(context.destination);
  gain.gain.value = 0; source.connect(gain); gain.connect(analyser); analyser.connect(destination);
  media.getUserMedia = async constraints => constraints.audio ? destination.stream.clone() : native(constraints);
  const samples = new Float32Array(analyser.fftSize);
  state.meter = setInterval(() => {
    gain.gain.value = clock() < state.gateUntil ? 1 : 0;
    analyser.getFloatTimeDomainData(samples);
    const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
    state.samples++; state.peak = Math.max(state.peak, rms);
    if (rms > .001) { state.speechSamples++; if (state.speaking) state.overlapSamples++; }
  }, 50);
  state.heartbeat = setInterval(() => { void state.session?.heartbeat({ deadlineAt: Date.now() + 2500 }).catch(() => { state.heartbeatFailures++; }); }, 3000);
  state.input = () => { state.gateUntil = clock() + 6000; };
  const inputs = new Set();
  let bargeTimer;
  const playInput = (ordinal, onEnd) => {
    const input = context.createBufferSource();
    input.buffer = buffers[ordinal % buffers.length]; input.connect(analyser);
    const startTime = context.currentTime + .05;
    const endTime = startTime + input.buffer.duration;
    const scheduledSpeechEndMs = clock() + (endTime - context.currentTime) * 1000;
    inputs.add(input);
    input.onended = () => {
      inputs.delete(input); input.disconnect();
      // Map the known sample end back to the monotonic event clock. Callback
      // delay does not move speech end forward; context suspension is accounted for.
      const speechEndMs = clock() - Math.max(0, context.currentTime - endTime) * 1000;
      if (!state.closed) onEnd?.(speechEndMs);
    };
    input.start(startTime);
    return scheduledSpeechEndMs;
  };
  state.turn = ({ ordinal, bargeIn }) => {
    const turn = { ordinal, atMs: clock(), bargeIn, bargeAttempted: false };
    state.turns.push(turn);
    turn.scheduledSpeechEndMs = playInput(ordinal, speechEndMs => {
      turn.speechEndMs = speechEndMs;
      if (turn.firstResponseAtMs < speechEndMs) delete turn.firstResponseAtMs;
      state.events.push({ type: 'speech-end', atMs: speechEndMs, ordinal, source: 'scripted-wav' });
      if (mode === 'fake') document.querySelector('#fake-say').click();
    });
  };
  state.barge = () => {
    const turn = state.turns.at(-1);
    if (!turn?.bargeIn || turn.bargeAttempted || turn.speechEndMs === undefined || !state.speaking || clock() - turn.speechEndMs < 500) return false;
    turn.bargeScheduledSpeechEndMs = playInput(2, speechEndMs => {
      turn.bargeSpeechEndMs = speechEndMs;
      state.events.push({ type: 'barge-speech-end', atMs: speechEndMs, ordinal: turn.ordinal, source: 'scripted-wav' });
    });
    turn.bargeAttempted = true;
    // Let the actual synthetic input overlap simulated playback before asking
    // the fake provider to acknowledge the interruption.
    if (mode === 'fake') bargeTimer = setTimeout(() => document.querySelector('#fake-interrupt').click(), 300);
    return true;
  };
  state.recover = async () => {
    if (mode === 'fake') document.querySelector('#fake-disconnect').click();
    else if (state.session?.lifecycle) await state.session.lifecycle.recover();
  };
  let stopping;
  state.stop = () => stopping ??= (async () => {
    state.gateUntil = 0; gain.gain.value = 0;
    clearTimeout(bargeTimer);
    for (const input of inputs) { input.onended = null; input.stop(); input.disconnect(); }
    inputs.clear();
    clearInterval(state.meter); clearInterval(state.heartbeat);
    try { await state.session?.close({ reason: 'closed', deadlineAt: Date.now() + 10_000 }); }
    finally { stream.getTracks().forEach(t => t.stop()); destination.stream.getTracks().forEach(t => t.stop()); await context.close(); }
  })();
  state.snapshot = () => ({ events: state.events, turns: state.turns, speaking: state.speaking, closed: state.closed,
    samples: state.samples, peak: state.peak, speechSamples: state.speechSamples,
    overlapSamples: state.overlapSamples, heartbeatFailures: state.heartbeatFailures,
    audioContextState: context.state, inputTrackState: stream.getAudioTracks()[0]?.readyState, audioPreflight: state.audioPreflight });
  state.input();
  await new Promise(resolve => setTimeout(resolve, 1500));
  state.audioPreflight = { contextState: context.state, contextTime: context.currentTime,
    trackState: stream.getAudioTracks()[0]?.readyState, trackMuted: stream.getAudioTracks()[0]?.muted };
  if (!state.speechSamples) throw new Error('Synthetic microphone preflight is silent');
  state.gateUntil = 0; gain.gain.value = 0; source.disconnect();
  if (mode === 'fake') {
    const c = document.querySelector('aithema-session');
    await c.changeLocale(locale);
    const { postJson } = await import('/packages/ui/src/post-json.js');
    const response = await postJson(`/api/sessions/${c.session.id}/consent`, { granted: true });
    if (!response.ok) throw new Error('Fake consent setup failed');
    c.receive((await response.json()).event);
  }
}
