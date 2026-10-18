// Synthetic data only, read 2026-10-18. No captured audio, keys or provider runs.
export const STT_DOC = 'https://docs.x.ai/developers/model-capabilities/audio/speech-to-text';
export const STREAM_DOC = `${STT_DOC}#streaming`;
export const config = {
  model: 'grok-voice-transcribe-2.0', secretRef: 'private:fixture-key', accountRef: 'private:fixture-account',
  accountEvidence: { zdrEnabled: true, dpaAccepted: true, recipient: 'SpaceXAI LLC', recipientCountry: 'US',
    processing: 'international-no-guaranteed-region', reviewedAt: '2026-10-18', expiresAt: '2099-01-01',
    zdrRef: 'private:zdr', dpaRef: 'private:dpa', retentionRef: 'private:retention', transferRef: 'private:transfers',
    approvalRef: 'private:approval', contractRef: 'private:contract' },
};
export const text = 'Hello world.';
export const expectedTranscripts = [
  { text: 'Hallo', final: false }, { text: 'Hello', final: false },
  { text: 'Hello worl', final: false }, { text, final: false }, { text, final: true },
];
// Each shape below follows STT_DOC Response / Server Events. Segment start is
// the replacement key; speech_final contains the stitched utterance, not a delta.
export const wire = {
  ready: { type: 'transcript.created' },
  partial: (value, start = 0, is_final = false, speech_final = false) => ({ type: 'transcript.partial',
    text: value, words: [], start, duration: 1, is_final, speech_final }),
  done: { type: 'transcript.done', text, duration: 3.45 },
  rest: { text, language: 'en', duration: 3.45, words: [] },
};
export function harness({ mode: initial = 'completed', onConnect, onSend, duration = 3.45 } = {}) {
  let mode = initial, requests = 0, active = 0, observed = 0;
  const sent = [], urls = [], bodies = [];
  const stalled = () => new Promise(() => {});
  const resource = () => { requests++; active++; let closed = false;
    return () => { if (!closed) { closed = true; active--; } }; };
  const connect = async ({ url }) => {
    let doneAudio;
    const release = resource(), close = () => { release(); doneAudio?.(); }; urls.push(url); onConnect?.();
    if (mode === 'late-open') { await new Promise(resolve => setTimeout(resolve, 80)); }
    const endpoint = new Promise(resolve => { doneAudio = resolve; });
    return { close, send(value) { sent.push(value); onSend?.(value);
      if (typeof value === 'string' && JSON.parse(value).type === 'audio.done') doneAudio(); },
    events: mode.startsWith('active-') ? { [Symbol.asyncIterator]() { return this; }, next: stalled, async return() { return { done: true }; } }
      : (async function* () {
        if (mode === 'before-ready') { yield JSON.stringify(wire.done); return; }
        if (mode === 'malformed') { yield '{'; return; }
        yield JSON.stringify(wire.ready);
        if (mode === 'provider-error') { yield JSON.stringify({ type: 'error', message: 'Synthetic error' }); return; }
        if (mode === 'overflow') { yield JSON.stringify(wire.partial('x'.repeat(32769))); return; }
        yield JSON.stringify(wire.partial('Hallo'));
        yield JSON.stringify(wire.partial('Hello', 0, true));
        yield JSON.stringify(wire.partial(' worl', 1));
        yield JSON.stringify(wire.partial(text, 0, true, true));
        await endpoint;
        if (mode !== 'missing-final') {
          if (mode !== 'bad-duration') observed = Math.ceil(duration * 200000 / 3600);
          yield JSON.stringify({ ...wire.done, duration: mode === 'bad-duration' ? -1 : duration });
          yield JSON.stringify(wire.done); // duplicate terminal must not leak a second final
        }
      })() };
  };
  const fetchImpl = async (url, options) => {
    const close = resource(); urls.push(url); bodies.push(options.body);
    if (mode.startsWith('http-')) { close(); return new Response('', { status: Number(mode.slice(5)) }); }
    let value = mode === 'missing-final' ? { text } : mode === 'overflow' ? { ...wire.rest, text: 'x'.repeat(32769) }
      : { ...wire.rest, duration: mode === 'bad-duration' ? -1 : duration };
    const bytes = new TextEncoder().encode(mode === 'malformed' ? '{' : JSON.stringify(value)); let read = false;
    return new Response(new ReadableStream({ pull(controller) {
      if (mode.startsWith('active-')) return stalled();
      if (!read) { read = true; controller.enqueue(bytes); } else { controller.close(); close(); }
    }, cancel: close }), { headers: { 'content-type': 'application/json' } });
  };
  return { connect, fetchImpl, sent, urls, bodies,
    fixtures: { formats: [{ encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 }],
      incompatibleFormats: [[{ encoding: 'pcm_f32le', sampleRateHz: 16000, channels: 1 }]],
      prepare(value) { mode = value.mode; observed = 0; }, requestCount: () => requests, activeCount: () => active,
      observedMicro: () => observed, expectedText: text, expectedTranscripts },
  };
}
export function operation(extra = {}) {
  const reports = []; let consumed = 0;
  return { reports, get consumed() { return consumed; }, options: {
    deadlineAt: Date.now() + 2000,
    attempt: { attemptId: 'fixture-attempt', claimId: 'fixture-child-claim', maxMicro: 1000000, consume() { consumed++; } },
    report(value) { reports.push(value); }, ...extra,
  } };
}
