// Recovery notices share a permanently reserved space. Only a new recovery changes the
// live region; ordinary render/locale passes never repeat its announcement.
export class RecoveryNotices {
  constructor({ root, copy, available, replay, stopReplay, replyVisible = text => Boolean(text), audioAvailable = () => true }) {
    Object.assign(this, { root, copy, available, replay, stopReplay, replyVisible, audioAvailable });
    this.revision = 0;
    root.innerHTML = `<div class="voice-notice voice-notice--recovered"></div>
      <div class="voice-notice voice-notice--user"></div>
      <div class="voice-notice voice-notice--reply"><span></span><div class="voice-reply-actions"><button class="voice-repeat" type="button" aria-haspopup="dialog" hidden><span class="voice-repeat-label"></span></button><button class="voice-read-text" type="button" aria-haspopup="dialog" hidden></button></div></div>
      <span class="visually-hidden voice-notice-live" role="status" aria-live="polite" aria-atomic="true"></span>
      <dialog class="voice-reply-dialog" aria-labelledby="voice-reply-title" aria-describedby="voice-reply-note">
        <h2 id="voice-reply-title"></h2><p class="voice-reply-note" id="voice-reply-note"></p><p class="voice-reply-text"></p>
        <button class="voice-reply-close" type="button"></button></dialog>`;
    this.button = root.querySelector('.voice-repeat'); this.dialog = root.querySelector('dialog');
    this.readText = root.querySelector('.voice-read-text');
    this.button.addEventListener('click', () => void this.repeat());
    this.readText.addEventListener('click', () => this.showText());
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
    this.playing = false; this.interrupted = false; this.fallback = false;
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
    const reply = recovery?.lastReplyText ?? this.pageReply?.text;
    const label = this.playing ? c.voiceReplayStop : this.fallback || !this.audioAvailable() ? c.voiceReadFullReply : c.voiceRepeatReply;
    text('.voice-repeat-label', label);
    this.button.dataset.stopLabel = c.voiceReplayStop; this.button.dataset.fallbackLabel = c.voiceReadFullReply;
    text('.voice-read-text', c.voiceReadText);
    this.button.dataset.replayState = this.playing ? 'playing' : this.interrupted ? 'interrupted' : 'idle';
    this.button.setAttribute('aria-pressed', String(Boolean(this.playing)));
    this.button.hidden = !(recovery?.deliveryUncertain && recovery.playbackPositionUnknown || this.pageReply) || !this.replyVisible(reply);
    this.readText.hidden = this.button.hidden;
    this.readText.disabled = !available;
    this.button.disabled = !available || Boolean(this.pending) && !this.playing || !(recovery?.lastReplyText ?? this.pageReply?.text);
    this.button.title = reply ? label : c.voiceReplyUnavailable;
    this.button.setAttribute('aria-label', this.button.title);
    text('#voice-reply-title', c.voiceLastReply); text('.voice-reply-note', c.voiceReplayTextOnly); text('.voice-reply-close', c.voiceReplayClose);
    if (!available && this.dialog.open) this.dialog.close();
  }
  showText() {
    const text = this.recovery?.lastReplyText ?? this.pageReply?.text;
    if (this.readText.hidden || this.readText.disabled || !this.available() || !this.replyVisible(text)) return;
    this.root.querySelector('.voice-reply-text').textContent = text;
    if (!this.dialog.open) this.dialog.showModal();
  }
  async repeat() {
    if (this.button.hidden || this.button.disabled || !this.available()) return;
    if (this.playing) {
      this.revision++; this.pending = null; this.playing = false; this.interrupted = true; this.render();
      await this.stopReplay?.(); return;
    }
    if (this.fallback || !this.audioAvailable()) { this.showText(); return; }
    this.interrupted = false;
    const revision = this.revision;
    const pending = Symbol('repeat'); this.pending = pending;
    this.playing = true; this.render();
    try {
      const result = await this.replay();
      if (revision !== this.revision || !this.available()) return;
      if (result?.kind === 'audio') { this.playing = true; this.render(); }
      if (result?.kind !== 'audio') this.playing = false;
      if (result?.kind === 'text' && result.text === (this.recovery?.lastReplyText ?? this.pageReply?.text)) {
        this.fallback = true; this.showText();
      }
    } catch { if (revision === this.revision) this.playing = false; /* A superseding hold/end stays fenced. */ }
    finally { if (this.pending === pending) { this.pending = null; this.render(); } }
  }
}
