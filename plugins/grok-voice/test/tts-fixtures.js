// Synthetic wire only. Shapes: connection, client/server messages, interruption.
export const TTS_DOC = 'https://docs.x.ai/developers/model-capabilities/audio/text-to-speech#streaming-tts-websocket';
export const PRICE_DOC = 'https://docs.x.ai/developers/pricing';
export const ttsText = 'Grüße 世界 😀 👩‍🚀';
export const ttsWire = {
  audio: { type: 'audio.delta', delta: 'AAAAAA==' },
  done: { type: 'audio.done', trace_id: '00000000-0000-4000-8000-000000000345' },
  interrupted: { type: 'audio.clear' },
};
export function ttsHarness({ mode: initial = 'completed', onSend, onRead } = {}) {
  let mode = initial, requests = 0, active = 0, reads = 0;
  const sent = [], urls = [], stalled = () => new Promise(() => {});
  const connect = async ({ url }) => {
    requests++; active++; urls.push(url);
    let closed = false;
    const close = () => { if (!closed) { closed = true; active--; } };
    if (mode === 'late-open') await new Promise(resolve => setTimeout(resolve, 80));
    let index = 0;
    const values = mode === 'overflow-total' ? [...Array(16).fill({ ...ttsWire.audio, delta: 'AAAA'.repeat(349524) }), ttsWire.done]
      : mode === 'overflow' ? [{ ...ttsWire.audio, delta: 'AAAA'.repeat(400000) }]
      : mode === 'malformed' ? ['{'] : mode === 'bad-base64' ? [{ ...ttsWire.audio, delta: 'AA?=' }]
      : mode === 'noncanonical-base64' ? [{ ...ttsWire.audio, delta: 'AAB=' }]
      : mode === 'odd-pcm' ? [{ ...ttsWire.audio, delta: 'AA==' }]
      : mode === 'provider-error' ? [{ type: 'error', message: 'Synthetic failure' }]
      : [ttsWire.audio, ...(mode === 'missing-final' ? [] : [mode === 'interrupted' ? ttsWire.interrupted
        : mode === 'missing-trace' ? { type: 'audio.done' } : ttsWire.done])];
    return { close, send(value) { sent.push(JSON.parse(value)); return onSend?.(JSON.parse(value)); },
      events: { [Symbol.asyncIterator]() { return this; }, next() {
        reads++; onRead?.(reads);
        if (mode.startsWith('active-') || ['stalled-after-audio', 'return'].includes(mode) && index > 0) return stalled();
        if (index >= values.length) return Promise.resolve({ done: true });
        const value = values[index++]; return Promise.resolve({ value: typeof value === 'string' ? value : JSON.stringify(value), done: false });
      }, async return() { return { done: true }; } } };
  };
  return { connect, sent, urls, get reads() { return reads; }, fixtures: {
    formats: [{ encoding: 'pcm_s16le', sampleRateHz: 24000, channels: 1 }],
    incompatibleFormats: [[{ encoding: 'mp3', sampleRateHz: 24000, channels: 1 }]],
    prepare(value) { mode = value.mode; }, requestCount: () => requests, activeCount: () => active, observedMicro: () => 0,
  } };
}
