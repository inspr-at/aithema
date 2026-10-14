// Serialized into Chrome by Puppeteer. Records timing/flags only, never content.
export async function installProbe({ mode, locale }) {
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
        if (turn && turn.firstResponseMs === undefined && (event.type === 'speaking' || event.type === 'final' && event.role === 'assistant')) turn.firstResponseMs = atMs - turn.atMs;
        if (turn && turn.finalMs === undefined && event.type === 'final' && event.role === 'assistant') turn.finalMs = atMs - turn.atMs;
        if (event.type === 'ended') state.closed = true;
        yield event;
      }
    })();
    return consume.call(this, session, generation);
  };
  // All input comes from Chrome's fake file device. Gate the captured WAV without
  // replacing the SDK or bypassing the provider's normal microphone acquisition.
  const media = navigator.mediaDevices, native = media.getUserMedia.bind(media);
  const stream = await native({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }), context = new AudioContext();
  await context.resume();
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
  state.turn = ({ ordinal, bargeIn }) => {
    const turn = { ordinal, atMs: clock(), bargeIn, bargeAttempted: false };
    state.turns.push(turn); state.input();
    if (mode === 'fake') document.querySelector('#fake-say').click();
  };
  state.barge = () => {
    const turn = state.turns.at(-1);
    if (!turn?.bargeIn || turn.bargeAttempted || !state.speaking || clock() - turn.atMs < 500) return false;
    state.input(); turn.bargeAttempted = true;
    if (mode === 'fake') document.querySelector('#fake-interrupt').click();
    return true;
  };
  state.recover = async () => {
    if (mode === 'fake') document.querySelector('#fake-disconnect').click();
    else if (state.session?.lifecycle) await state.session.lifecycle.recover();
  };
  let stopping;
  state.stop = () => stopping ??= (async () => {
    state.gateUntil = 0; gain.gain.value = 0;
    clearInterval(state.meter); clearInterval(state.heartbeat);
    try { await state.session?.close({ reason: 'closed', deadlineAt: Date.now() + 10_000 }); }
    finally { stream.getTracks().forEach(t => t.stop()); destination.stream.getTracks().forEach(t => t.stop()); await context.close(); }
  })();
  state.snapshot = () => ({ events: state.events, turns: state.turns, speaking: state.speaking, closed: state.closed,
    samples: state.samples, peak: state.peak, speechSamples: state.speechSamples,
    overlapSamples: state.overlapSamples, heartbeatFailures: state.heartbeatFailures,
    audioContextState: context.state, inputTrackState: stream.getAudioTracks()[0]?.readyState });
  state.input();
  await new Promise(resolve => setTimeout(resolve, 1500));
  if (!state.speechSamples) throw new Error('Synthetic microphone preflight is silent');
  state.gateUntil = 0;
  if (mode === 'fake') {
    const c = document.querySelector('aithema-session');
    await c.changeLocale(locale);
    const { postJson } = await import('/packages/ui/src/post-json.js');
    const response = await postJson(`/api/sessions/${c.session.id}/consent`, { granted: true });
    if (!response.ok) throw new Error('Fake consent setup failed');
    c.receive((await response.json()).event);
  }
}
