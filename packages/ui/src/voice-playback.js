/** Observe SDK-created playback only while this call owns the page's voice lane. */
export function watchVoicePlayback(document, onBlocked) {
  const audio = new Set();
  const play = async element => {
    try { await element.play(); }
    catch (error) { if (error?.name === 'NotAllowedError') { onBlocked(); throw error; } }
  };
  const register = node => {
    if (!node.querySelectorAll) return;
    const candidates = [...(node.tagName === 'AUDIO' ? [node] : []), ...node.querySelectorAll('audio')];
    for (const element of candidates) {
      if (audio.has(element)) continue;
      audio.add(element);
      if (element.autoplay && element.paused) void play(element).catch(() => {});
    }
  };
  const Observer = document.defaultView.MutationObserver;
  const observer = new Observer(records => { for (const record of records) for (const node of record.addedNodes) register(node); });
  observer.observe(document.body, { childList: true, subtree: true });
  return { async retry() {
    for (const element of audio) {
      if (!element.isConnected || element.ended) audio.delete(element);
      else if (element.paused) await play(element);
    }
  }, destroy() { observer.disconnect(); audio.clear(); } };
}
