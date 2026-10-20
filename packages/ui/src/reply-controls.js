import { icon } from './icons.js';

// The reply owns this row. Neither newer replies, notices nor transport state
// can move it or retire it after playback. Recovery's separate notice actions
// retain their existing lifetime and copy.
export class ReplyControls {
  constructor({ target, reply, owner }) {
    Object.assign(this, { reply, owner });
    this.row = target.ownerDocument.createElement('div');
    this.row.className = 'reply-actions';
    this.row.innerHTML = `<button type="button" data-reply-action="replay" aria-haspopup="dialog">${icon('volume')}</button><button type="button" data-reply-action="read" aria-haspopup="dialog">${icon('conversations')}</button>`;
    this.button = this.row.firstElementChild; this.readText = this.row.lastElementChild;
    this.button.addEventListener('click', () => void this.repeat());
    this.readText.addEventListener('click', () => this.showText());
    target.append(this.row);
  }
  current() { return this.row.isConnected && this.owner.replyVisible(this.reply.text, this.reply.turnId); }
  render(latest) {
    const owner = this.owner, c = owner.copy, duringCall = owner.inCall();
    // The legacy latest-reply hooks address only the current reply; every row
    // has permanent reply-action hooks for its own lifetime.
    this.row.classList.toggle('voice-reply-actions', latest && !owner.recovery);
    this.button.classList.toggle('voice-repeat', latest && !owner.recovery);
    this.readText.classList.toggle('voice-read-text', latest && !owner.recovery);
    const label = this.playing ? c.voiceReplayStop : this.fallback || !owner.audioAvailable() ? c.voiceReadFullReply : c.voiceRepeatReply;
    for (const [control, name] of [[this.button, label], [this.readText, c.voiceReadText]]) {
      control.disabled = duringCall || !owner.available() || !this.current();
      control.setAttribute('aria-disabled', String(control.disabled));
      control.setAttribute('aria-label', name);
      control.title = duringCall ? c.voiceReplyDuringCall : name;
      if (duringCall) control.setAttribute('aria-description', c.voiceReplyDuringCall);
      else control.removeAttribute('aria-description');
    }
    this.button.dataset.replayState = this.playing ? 'playing' : 'idle';
    this.button.setAttribute('aria-pressed', String(Boolean(this.playing)));
    if (this.wasInCall !== duringCall && duringCall) this.playing = false;
    this.wasInCall = duringCall;
  }
  showText() {
    if (this.readText.disabled || !this.current()) return;
    this.owner.root.querySelector('.voice-reply-text').textContent = this.reply.text;
    if (!this.owner.dialog.open) this.owner.dialog.showModal();
  }
  async repeat() {
    if (this.button.disabled || !this.current()) return;
    if (this.playing) { await this.owner.stopReplay?.(); this.playing = false; this.owner.render(); return; }
    if (this.fallback || !this.owner.audioAvailable()) { this.showText(); return; }
    this.playing = true; this.owner.render();
    try {
      const result = await this.owner.replay(this.reply, {
        onState: playing => { this.playing = playing; this.owner.render(); },
        current: candidate => !this.owner.inCall() && this.owner.available() && this.current() && candidate.turnId === this.reply.turnId && candidate.text === this.reply.text,
      });
      if (!this.current() || this.owner.inCall() || !this.owner.available()) return;
      if (result?.kind !== 'audio') this.playing = false;
      if (result?.kind === 'text' && result.text === this.reply.text) { this.fallback = true; this.showText(); }
    } catch { this.playing = false; }
    finally { this.owner.render(); }
  }
  dispose() { this.row.remove(); }
}
