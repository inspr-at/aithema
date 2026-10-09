import { watchVoicePlayback } from './voice-playback.js';
// START's rail lifecycle, ported to the live-voice session interface (INSPR D3).
export class AudioRail {
  constructor({ root, copy, client, feature, context, onPartial, onPause, onEnd, onState, playback, journal, ready, heartbeatMs = 10_000 }) {
    Object.assign(this, { root, copy, client, feature, context, onPartial, onPause, onEnd, onState, playback, journal, ready, heartbeatMs });
    this.state = 'idle'; this.input = true; this.output = true; this.generation = 0;
    root.innerHTML = `<div class="voice-orb" aria-hidden="true"><div class="voice-wave">${'<i></i>'.repeat(9)}</div></div>
      <div class="voice-info"><span class="voice-state" role="status"></span><span class="voice-caption"></span></div>
      <div class="voice-controls"><button class="voice-start" type="button"></button><button class="voice-close" type="button"></button>
        <button class="voice-input" type="button"></button><button class="voice-output" type="button"></button>
        <button class="voice-pause" type="button"></button><button class="voice-retry" type="button"></button>
        <button class="voice-playback" type="button"></button></div>`;
    this.button('start').addEventListener('click', () => void this.start());
    this.button('close').addEventListener('click', () => void this.close());
    this.button('pause').addEventListener('click', () => void this.pause(!this.paused));
    for (const [name, channel] of [['input', 'setInput'], ['output', 'setOutput']]) {
      this.button(name).addEventListener('click', async () => {
        if (!this.session || this.busy) return;
        this.busy = true; this.render();
        try { await this.session[channel](!this[name]); this[name] = !this[name]; }
        catch (error) { this.failure(error); }
        finally { this.busy = false; this.render(); }
      });
    }
    this.button('retry').addEventListener('click', () => void this.start());
    this.button('playback').addEventListener('click', () => void this.retryPlayback());
    // START pauses a voice call when the page is hidden (src/scripts/v2.ts handleVisibilityLoss,
    // pauseOrigin "visibility"; server hold in src/pages/api/v2/pause.ts). START also binds
    // window blur to it; AIT-116 D7 deliberately does not: switching to another window while
    // the tab stays visible keeps the call running.
    this.hide = () => {
      if (this.paused || this.unloading) return;
      if (this.session) { this.journal?.update({ autoPaused: true }); void this.pause(true, { automatic: true }); }
      else if (this.state === 'connecting') this.hidePending = true;
    };
    this.visibility = () => { if (root.ownerDocument.hidden) this.hide(); };
    root.ownerDocument.addEventListener('visibilitychange', this.visibility);
    this.render();
  }
  button(name) { return this.root.querySelector(`.voice-${name}`); }
  capability(name) { return this.client?.manifest?.liveVoice?.capabilities?.[name] !== 'unavailable'; }
  render() {
    const c = this.copy, active = Boolean(this.session), available = this.feature(), transitional = ['connecting', 'closing', 'recovering'].includes(this.state);
    const state = this.paused && active ? 'paused' : this.state;
    if (this.root.dataset.state !== undefined && this.root.dataset.state !== state) queueMicrotask(() => this.onState?.(state));
    this.root.dataset.state = state;
    this.root.setAttribute('aria-label', c.voiceRail);
    this.root.querySelector('.voice-state').textContent = this.error ?? (active || transitional ? c.voiceStates[this.root.dataset.state] :
      available.available && this.client ? c.voiceStates[this.state] : available.reason ?? c.notConfigured);
    const labels = { start: c.voiceStart, close: c.voiceClose, input: this.input ? c.voiceMicOn : c.voiceMicOff,
      output: this.output ? c.voiceSpeakerOn : c.voiceSpeakerOff, pause: this.paused ? c.resume : c.pause,
      retry: c.voiceRetry, playback: c.voicePlaybackRetry };
    for (const [name, label] of Object.entries(labels)) {
      const button = this.button(name); button.textContent = label; button.title = label;
      const command = { input: 'setInput', output: 'setOutput', pause: this.paused ? 'resume' : 'pause' }[name];
      button.disabled = name === 'start' ? active || transitional || !available.available || !this.client
        : name === 'retry' ? active || this.state !== 'failed' || !available.available
        : name === 'playback' ? !this.playbackBlocked
        : name === 'close' ? !active && this.state !== 'connecting' : !active || name !== 'close' && (this.busy || transitional || command && !this.capability(command));
      if (name === 'start' && button.disabled && !active) button.title = available.reason ?? c.notConfigured;
      if (command && !this.capability(command)) button.title = c.voiceCommandUnavailable;
    }
    this.button('input').setAttribute('aria-pressed', String(this.input));
    this.button('output').setAttribute('aria-pressed', String(this.output));
    this.button('pause').setAttribute('aria-pressed', String(Boolean(this.paused)));
  }
  failure(error) {
    this.error = error?.name === 'NotAllowedError' ? this.copy.voiceMicDenied :
      error?.name === 'NotFoundError' ? this.copy.voiceMicMissing :
      error?.code === 'not-admitted' ? this.copy.voiceAdmissionDenied :
      error?.code === 'voice-conflict' ? this.copy.voiceConflict :
      error?.code === 'deadline' ? this.copy.voiceDeadline : this.copy.voiceConnectionFailed;
    this.render();
  }
  async start() {
    if (this.session || this.state === 'connecting' || !this.feature().available || !this.client) return;
    const generation = ++this.generation; this.error = null; this.state = 'connecting'; this.render();
    const controller = new AbortController(); this.controller = controller;
    try {
      // A reloaded page first ends the call its predecessor left behind.
      await this.ready?.();
      if (generation !== this.generation) return;
      this.playbackWatcher = watchVoicePlayback(this.root.ownerDocument, () => this.reportPlaybackBlocked());
      const session = await this.client.start({ callId: crypto.randomUUID() }, { signal: controller.signal, deadlineAt: Date.now() + 30_000 });
      if (generation !== this.generation) { await session.close(); return; }
      this.session = session; this.paused = false; this.state = 'listening';
      this.journal?.save({ callId: session.callId, providerSessionId: session.providerSessionId, autoPaused: false });
      await session.setInput(this.input); await session.setOutput(this.output);
      await this.updateContext();
      this.render();
      this.heartbeat = setInterval(() => {
        if (this.beating) return;
        this.beating = true;
        Promise.resolve(session.heartbeat?.({ deadlineAt: Date.now() + 5000 })).catch(error => {
          this.failure(error); void this.close();
        }).finally(() => { this.beating = false; });
      }, this.heartbeatMs);
      this.meter = setInterval(() => {
        const levels = session.audioLevels?.(); if (!levels) return;
        const level = this.paused ? 0 : Math.min(1, Math.max(0, levels[this.state === 'speaking' ? 'output' : 'input'] ?? 0));
        this.root.dataset.measured = '';
        this.root.querySelector('.voice-orb').style.setProperty('--voice-energy', String(level));
        [...this.root.querySelectorAll('.voice-wave i')].forEach((bar, index) => {
          bar.style.transform = `scaleY(${.08 + level * (1 - Math.abs(index - 4) / 7)})`;
        });
      }, 80);
      void this.consume(session, generation);
      if (this.root.ownerDocument.hidden || this.hidePending) { this.hidePending = false; this.hide(); }
    } catch (error) {
      if (generation !== this.generation) return;
      clearInterval(this.heartbeat); clearInterval(this.meter); this.playbackWatcher?.destroy(); this.session = null; controller.abort(); this.state = 'failed'; this.failure(error);
    }
  }
  async consume(session, generation) {
    try {
      for await (const event of session.events) {
        if (generation !== this.generation || event.callId !== session.callId) return;
        if (['listening', 'speaking'].includes(event.type)) this.state = event.type;
        if (event.type === 'partial') { this.root.querySelector('.voice-caption').textContent = event.text; this.onPartial?.(event); }
        if (event.type === 'final') this.root.querySelector('.voice-caption').textContent = '';
        if (event.type === 'recovering') this.state = 'recovering';
        if (event.type === 'recovered') {
          this.state = 'listening'; this.error = null; this.journal?.update({ providerSessionId: session.providerSessionId });
          void this.updateContext().catch(() => {});
        }
        if (event.type === 'ended') {
          clearInterval(this.heartbeat); clearInterval(this.meter); this.playbackWatcher?.destroy(); this.session = null; this.journal?.clear();
          this.onEnd?.();
          this.state = ['closed', 'cancelled'].includes(event.reason) ? 'idle' : 'failed';
          this.error = event.reason === 'recovery-failed' ? this.copy.voiceRecoveryFailed :
            event.reason === 'closure-uncertain' ? this.copy.voiceClosureUncertain :
            event.reason.includes('deadline') ? this.copy.voiceDeadline : this.state === 'failed' ? this.copy.voiceConnectionFailed : null;
          this.root.querySelector('.voice-caption').textContent = '';
        }
        this.render();
      }
    } catch (error) { if (generation === this.generation) { this.failure(error); await this.close(); } }
  }
  async pause(paused, { automatic = false } = {}) {
    if (!this.session || this.busy || this.paused === paused) {
      if (paused && this.state === 'connecting') this.hidePending = true;
      return;
    }
    if (!automatic) this.journal?.update({ autoPaused: false });
    const session = this.session, generation = this.generation;
    this.busy = true; this.render();
    try {
      const ack = await session[paused ? 'pause' : 'resume']();
      if (generation !== this.generation || session !== this.session) return;
      if (ack?.acknowledged !== true || ack.paused !== paused) throw new Error('Pause acknowledgement required');
      this.paused = paused; this.error = null; this.onPause?.(paused);
      if (!paused) { this.state = 'listening'; void this.updateContext().catch(() => {}); }
    } catch { this.error = this.copy.voicePauseFailed; }
    finally { this.busy = false; this.render(); }
  }
  syncPause(paused) {
    if (this.session && this.paused !== paused && !this.busy) void this.pause(paused);
  }
  async sendText(text) {
    if (!this.session || this.paused || this.state === 'recovering' || !this.capability('sendText')) throw new Error('Voice text unavailable');
    return this.session.sendText(text);
  }
  async updateContext() {
    if (!this.session || this.paused || !this.capability('updateContext')) return;
    await this.session.updateContext(this.context());
  }
  async retryPlayback() {
    try { await this.playback?.(); await this.playbackWatcher?.retry(); this.playbackBlocked = false; this.error = null; }
    catch { this.playbackBlocked = true; this.error = this.copy.voicePlaybackBlocked; }
    this.render();
  }
  reportPlaybackBlocked() { this.playbackBlocked = true; this.error = this.copy.voicePlaybackBlocked; this.render(); }
  close(reason) {
    if (this.closing) return this.closing;
    const session = this.session; ++this.generation; clearInterval(this.heartbeat); clearInterval(this.meter); this.playbackWatcher?.destroy();
    this.session = null; this.state = 'closing'; this.render();
    this.onEnd?.();
    const controller = this.controller;
    this.closing = (async () => {
      try {
        const terminal = await session?.close({ deadlineAt: Date.now() + 45_000 });
        this.state = terminal && !terminal.closureConfirmed ? 'failed' : 'idle';
        this.error = terminal && !terminal.closureConfirmed ? this.copy.voiceClosureUncertain : null;
        if (reason?.includes('deadline')) { this.state = 'failed'; this.error = this.copy.voiceDeadline; }
        if (session) this.journal?.clear();
      } catch { this.state = 'failed'; this.error = this.copy.voiceClosureUncertain; }
      finally { controller?.abort(); this.paused = false; this.root.querySelector('.voice-caption').textContent = ''; this.render(); }
    })().finally(() => { this.closing = null; });
    return this.closing;
  }
  destroy() {
    this.onState = null;
    this.root.ownerDocument.removeEventListener('visibilitychange', this.visibility);
    void this.close();
  }
}
