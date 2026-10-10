import { watchVoicePlayback } from './voice-playback.js';
import { icon } from './icons.js';
import { Waveform } from './waveform.js';
// START's rail lifecycle, ported to the live-voice session interface (INSPR D3). The presentation is
// START's conversation rail (index.astro .v2__conversation-rail): an orb dock, icon controls in fixed
// cells and the waveform with one status phrase. Alternatives share a cell (Start and the microphone,
// End and Retry call, Sound and Enable sound), so no state change moves a control.
const BUTTONS = { start: ['mic'], input: ['mic', true], output: ['volume', true], playback: ['volume'], close: ['stop'], retry: ['refresh'] };
export class AudioRail {
  constructor({ root, copy, client, feature, context, onPartial, onPause, onEnd, onState, onLevel, playback, journal, ready, heartbeatMs = 10_000 }) {
    Object.assign(this, { root, copy, client, feature, context, onPartial, onPause, onEnd, onState, onLevel, playback, journal, ready, heartbeatMs });
    this.state = 'idle'; this.input = true; this.output = true; this.generation = 0;
    const button = name => `<button class="voice-${name}" type="button">${name === 'pause' ? `<span class="voice-icon">${icon('pause')}</span><span class="voice-icon voice-icon--resume">${icon('play')}</span>`
      : icon(BUTTONS[name][0], { slash: BUTTONS[name][1] === true })}<span class="voice-label"></span></button>`;
    root.innerHTML = `<div class="voice-orb" aria-hidden="true"></div>
      <div class="voice-cell voice-cell--output">${button('output')}${button('playback')}</div>
      <div class="voice-signal"><canvas class="voice-wave" aria-hidden="true"></canvas><span class="voice-state" role="status"></span><span class="voice-caption"></span></div>
      <div class="voice-cell voice-cell--pause">${button('pause')}</div>
      <div class="voice-cell voice-cell--mic">${button('start')}${button('input')}</div>
      <div class="voice-cell voice-cell--end">${button('close')}${button('retry')}</div>`;
    this.waveform = new Waveform(root.querySelector('.voice-wave'));
    this.button('start').addEventListener('click', () => void this.start());
    this.button('close').addEventListener('click', () => void this.close());
    this.button('pause').addEventListener('click', () => void this.pause(!this.paused));
    for (const [name, channel] of [['input', 'setInput'], ['output', 'setOutput']]) {
      this.button(name).addEventListener('click', async () => {
        if (!this.session || this.busy) return;
        this.busy = true; this.render();
        try { await this.session[channel](!this[name]); this[name] = !this[name]; }
        catch (error) { this.failure(error); }
        finally { this.busy = false; this.render(); this.settle(); }
      });
    }
    this.button('retry').addEventListener('click', () => void this.start());
    this.button('playback').addEventListener('click', () => void this.retryPlayback());
    // START pauses a voice call when the page is hidden (src/scripts/v2.ts handleVisibilityLoss,
    // pauseOrigin "visibility"; server hold in src/pages/api/v2/pause.ts). START also binds
    // window blur to it; AIT-116 D7 deliberately does not: switching to another window while
    // the tab stays visible keeps the call running. A hide during another command
    // (a microphone toggle or a pending resume, say) is queued and applied when that
    // command settles, so a hidden rail never keeps listening.
    this.hide = () => {
      if (this.unloading) return;
      if (this.session && !this.busy) { if (!this.paused) void this.pause(true); }
      else if (this.session || this.state === 'connecting') this.hidePending = true;
    };
    this.visibility = () => { if (root.ownerDocument.hidden) this.hide(); };
    root.ownerDocument.addEventListener('visibilitychange', this.visibility);
    this.render();
  }
  settle() {
    if (!this.hidePending || !this.session || this.busy) return;
    this.hidePending = false; this.hide();
  }
  button(name) { return this.root.querySelector(`.voice-${name}`); }
  capability(name) { return this.client?.manifest?.liveVoice?.capabilities?.[name] !== 'unavailable'; }
  render() {
    // Closing a rail that had no call (an invalidation while idle) is no call: it never marks one active.
    const c = this.copy, active = Boolean(this.session), available = this.feature(),
      transitional = ['connecting', 'recovering'].includes(this.state) || this.state === 'closing' && this.closingCall;
    const state = this.paused && active ? 'paused' : this.state;
    if (this.root.dataset.state !== undefined && this.root.dataset.state !== state) queueMicrotask(() => this.onState?.(state));
    this.root.dataset.state = state;
    this.root.dataset.call = active || transitional ? 'active' : 'none';
    this.root.toggleAttribute('data-playback-blocked', Boolean(this.playbackBlocked)); this.root.toggleAttribute('data-message', Boolean(this.error));
    this.root.setAttribute('role', 'group'); this.root.setAttribute('aria-label', c.voiceRail);
    this.root.querySelector('.voice-state').textContent = this.error ?? (active || transitional ? c.voiceStates[this.root.dataset.state] :
      available.available && this.client ? c.voiceStates[this.state] : available.reason ?? c.notConfigured);
    const labels = { start: c.voiceStart, close: c.voiceClose, input: this.input ? c.voiceMicOn : c.voiceMicOff,
      output: this.output ? c.voiceSpeakerOn : c.voiceSpeakerOff, pause: this.paused ? c.resume : c.pause,
      retry: c.voiceRetry, playback: c.voicePlaybackRetry };
    for (const [name, label] of Object.entries(labels)) {
      const button = this.button(name); button.querySelector('.voice-label').textContent = label; button.title = label;
      const command = { input: 'setInput', output: 'setOutput', pause: this.paused ? 'resume' : 'pause' }[name];
      button.disabled = name === 'start' ? active || transitional || this.state === 'closing' || !available.available || !this.client
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
      error?.code === 'not-admitted' ? (Object.hasOwn(this.copy.reasons ?? {}, error.reason) ? this.copy.reasons[error.reason] : this.copy.voiceAdmissionDenied) :
      error?.code === 'voice-conflict' ? this.copy.voiceConflict :
      error?.code === 'deadline' ? this.copy.voiceDeadline : this.copy.voiceConnectionFailed;
    // A conflict may say when the earlier call's lease ends; Retry then waits it out.
    this.retryAt = error?.code === 'voice-conflict' && error.retryAfterMs > 0 ? Date.now() + Math.min(error.retryAfterMs, 60_000) : 0;
    this.render();
  }
  async start() {
    if (this.session || this.state === 'connecting' || !this.feature().available || !this.client) return;
    const generation = ++this.generation; this.error = null; this.state = 'connecting'; this.render();
    const controller = new AbortController(); this.controller = controller;
    try {
      // A reloaded page first ends the call its predecessor left behind.
      await this.ready?.();
      const wait = (this.retryAt ?? 0) - Date.now(); this.retryAt = 0;
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      if (generation !== this.generation) return;
      this.playbackWatcher = watchVoicePlayback(this.root.ownerDocument, () => this.reportPlaybackBlocked());
      const session = await this.client.start({ callId: crypto.randomUUID() }, { signal: controller.signal, deadlineAt: Date.now() + 30_000 });
      if (generation !== this.generation) { await session.close(); return; }
      this.session = session; this.paused = false; this.state = 'listening';
      this.journal?.save({ callId: session.callId, providerSessionId: session.providerSessionId });
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
      // The waveform follows the measured level; under reduced motion it keeps its still baseline.
      const still = this.root.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      this.meter = setInterval(() => {
        const levels = session.audioLevels?.(); if (!levels) return;
        const speaking = this.state === 'speaking', level = this.paused ? 0 : Math.min(1, Math.max(0, levels[speaking ? 'output' : 'input'] ?? 0));
        this.root.dataset.measured = '';
        if (!still) this.waveform.push(level, speaking ? 'assistant' : 'user', 80);
        // The orb reacts to the audible reply only, never to the visitor's input (START orb).
        this.onLevel?.(speaking ? level : 0);
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
          this.quiet(); this.onEnd?.();
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
  async pause(paused) {
    if (!this.session || this.busy || this.paused === paused) {
      if (paused && this.state === 'connecting') this.hidePending = true;
      return;
    }
    const session = this.session, generation = this.generation;
    this.busy = true; this.render();
    try {
      const ack = await session[paused ? 'pause' : 'resume']();
      if (generation !== this.generation || session !== this.session) return;
      if (ack?.acknowledged !== true || ack.paused !== paused) throw new Error('Pause acknowledgement required');
      this.paused = paused; this.error = null; this.onPause?.(paused);
      if (!paused) { this.state = 'listening'; void this.updateContext().catch(() => {}); }
    } catch { this.error = this.copy.voicePauseFailed; }
    finally { this.busy = false; this.render(); this.settle(); }
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
    const session = this.session; this.closingCall = Boolean(session) || ['connecting', 'recovering'].includes(this.state);
    ++this.generation; clearInterval(this.heartbeat); clearInterval(this.meter); this.playbackWatcher?.destroy(); this.quiet();
    this.session = null; this.hidePending = false; this.state = 'closing'; this.render();
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
  quiet() { delete this.root.dataset.measured; this.waveform.baseline(); this.onLevel?.(0); }
  destroy() {
    this.onState = null; this.onLevel = null;
    this.root.ownerDocument.removeEventListener('visibilitychange', this.visibility);
    void this.close();
  }
}
