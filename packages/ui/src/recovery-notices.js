// Recovery notices share a permanently reserved space. Only a new recovery changes the
// live region; ordinary render/locale passes never repeat its announcement.
export class RecoveryNotices {
  constructor({ root, copy, available, replay, stopReplay }) {
    Object.assign(this, { root, copy, available, replay, stopReplay });
    this.revision = 0;
    root.innerHTML = `<div class="voice-notice voice-notice--recovered"></div>
      <div class="voice-notice voice-notice--user"></div>
      <div class="voice-notice voice-notice--reply"><span></span><button class="voice-repeat" type="button" aria-haspopup="dialog" hidden></button></div>
      <span class="visually-hidden voice-notice-live" role="status" aria-live="polite" aria-atomic="true"></span>
      <dialog class="voice-reply-dialog" aria-labelledby="voice-reply-title" aria-describedby="voice-reply-note">
        <h2 id="voice-reply-title"></h2><p class="voice-reply-note" id="voice-reply-note"></p><p class="voice-reply-text"></p>
        <button class="voice-reply-close" type="button"></button></dialog>`;
    this.button = root.querySelector('.voice-repeat'); this.dialog = root.querySelector('dialog');
    this.button.addEventListener('click', () => void this.repeat());
    root.querySelector('.voice-reply-close').addEventListener('click', () => this.dialog.close());
    this.render();
  }
  recovered(recovery = {}) {
    this.clear(); this.recovery = { ...recovery }; this.render();
    this.root.querySelector('.voice-notice-live').textContent = [this.copy.voiceRecovered,
      recovery.userUnconfirmed && this.copy.voiceUserUnconfirmed,
      recovery.deliveryUncertain && recovery.playbackPositionUnknown && this.copy.voiceReplyIncomplete].filter(Boolean).join('. ');
  }
  clear() {
    this.playing = false;
    this.revision++; this.recovery = null; this.pending = null;
    if (this.dialog.open) this.dialog.close();
    for (const selector of ['.voice-notice-live', '.voice-reply-text']) {
      const node = this.root.querySelector(selector); if (node.textContent) node.textContent = '';
    }
    this.render();
  }
  render() {
    const c = this.copy, recovery = this.recovery, available = this.available();
    if (!available && this.wasAvailable) { this.revision++; this.pending = null; }
    this.wasAvailable = available;
    const text = (selector, value) => { const node = this.root.querySelector(selector); if (node.textContent !== value) node.textContent = value; };
    text('.voice-notice--recovered', recovery ? c.voiceRecovered : '');
    text('.voice-notice--user', recovery?.userUnconfirmed ? c.voiceUserUnconfirmed : '');
    text('.voice-notice--reply span', recovery?.deliveryUncertain && recovery.playbackPositionUnknown ? c.voiceReplyIncomplete : '');
    text('.voice-repeat', c.voiceRepeatReply);
    this.button.dataset.replayState = this.playing ? 'playing' : this.interrupted ? 'interrupted' : 'idle';
    this.button.setAttribute('aria-pressed', String(Boolean(this.playing)));
    this.button.hidden = !(recovery?.deliveryUncertain && recovery.playbackPositionUnknown);
    this.button.disabled = !available || Boolean(this.pending) || !recovery?.lastReplyText;
    this.button.title = this.playing ? c.voiceReplayStop : recovery?.lastReplyText ? c.voiceRepeatReply : c.voiceReplyUnavailable;
    this.button.setAttribute('aria-label', this.button.title);
    text('#voice-reply-title', c.voiceLastReply); text('.voice-reply-note', c.voiceReplayTextOnly); text('.voice-reply-close', c.voiceReplayClose);
    if (!available && this.dialog.open) this.dialog.close();
  }
  async repeat() {
    if (this.button.hidden || this.button.disabled || !this.available()) return;
    if (this.playing) { await this.stopReplay?.(); this.playing = false; this.interrupted = true; this.render(); return; }
    this.interrupted = false;
    const revision = this.revision;
    const pending = Symbol('repeat'); this.pending = pending;
    this.button.disabled = true;
    try {
      const result = await this.replay();
      if (revision !== this.revision || !this.available()) return;
      if (result?.kind === 'audio') { this.playing = true; this.render(); }
      if (result?.kind === 'text' && result.text === this.recovery?.lastReplyText) {
        this.root.querySelector('.voice-reply-text').textContent = result.text;
        this.dialog.showModal();
      }
    } catch { /* A superseding hold/end keeps playback and the fallback closed. */ }
    finally { if (this.pending === pending) { this.pending = null; this.render(); } }
  }
}
