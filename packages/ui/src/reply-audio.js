import { PluginError } from '../../core/src/invocation.js';

/** PCM replay enters the call's existing WebSocket output graph or WebRTC audio element. */
export async function playReplyAudio(audio, { signal, current, conversation, document = globalThis.document, AudioContext = globalThis.AudioContext } = {}) {
  if (audio?.format !== 'pcm_16000' || typeof audio.data !== 'string' || audio.data.length > 5_592_408) throw new PluginError('unavailable');
  signal?.throwIfAborted();
  const raw = atob(audio.data), pcm = Uint8Array.from(raw, char => char.charCodeAt(0));
  if (!pcm.length || pcm.length % 2) throw new PluginError('invalid-output');
  const output = conversation?.output, existing = output?.context;
  const rtcElement = conversation?.connection?.audioAdapter?.audioElements?.[0];
  // A call with an unsupported output adapter falls back to text.
  if (conversation && !existing && !rtcElement) throw new PluginError('unavailable');
  let stop, cleanup;
  const finished = new Promise(resolve => { cleanup = resolve; });
  if (existing && output.gain) {
    const source = existing.createBufferSource(), buffer = existing.createBuffer(1, pcm.length / 2, 16_000), samples = buffer.getChannelData(0);
    const view = new DataView(pcm.buffer); for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    source.buffer = buffer; source.connect(output.gain);
    stop = () => { source.onended = null; try { source.stop(); } catch {} source.disconnect(); cleanup(false); };
    source.onended = () => { cleanup(true); stop(); };
    if (existing.state === 'suspended') await existing.resume();
    signal?.throwIfAborted(); if (current && !current()) { stop(); throw new PluginError('cancelled'); }
    source.start();
  } else {
    // Reuse the SDK's WebRTC sink. Restore the remote track when replay finishes.
    const element = rtcElement ?? document?.createElement('audio');
    if (!element) throw new PluginError('unavailable');
    const remote = element.srcObject, priorSrc = element.getAttribute('src');
    const wave = new Uint8Array(44 + pcm.length), view = new DataView(wave.buffer);
    const ascii = (at, text) => [...text].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
    ascii(0, 'RIFF'); view.setUint32(4, 36 + pcm.length, true); ascii(8, 'WAVE'); ascii(12, 'fmt '); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, pcm.length, true); wave.set(pcm, 44);
    const url = URL.createObjectURL(new Blob([wave], { type: 'audio/wav' }));
    let stopped = false;
    stop = () => {
      if (stopped) return; stopped = true; element.pause(); element.removeEventListener('error', stop);
      element.removeEventListener('ended', ended);
      element.removeAttribute('src'); element.srcObject = remote;
      if (priorSrc) element.setAttribute('src', priorSrc);
      URL.revokeObjectURL(url); cleanup(false);
      if (rtcElement && current?.()) void element.play().catch(() => {});
    };
    const ended = () => { cleanup(true); stop(); };
    element.addEventListener('ended', ended, { once: true }); element.addEventListener('error', stop, { once: true });
    element.srcObject = null; element.src = url;
    signal?.addEventListener('abort', stop, { once: true });
    try {
      signal?.throwIfAborted(); if (current && !current()) throw new PluginError('cancelled');
      await element.play();
      signal?.throwIfAborted(); if (current && !current()) throw new PluginError('cancelled');
    } catch (error) { stop(); throw error; }
  }
  signal?.addEventListener('abort', stop, { once: true });
  void finished.then(() => signal?.removeEventListener('abort', stop));
  return { stop, finished };
}
