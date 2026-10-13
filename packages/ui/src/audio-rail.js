import { watchVoicePlayback } from './voice-playback.js';
import { icon } from './icons.js';
import { Waveform } from './waveform.js';
import { RecoveryNotices } from './recovery-notices.js';
import { watchVoiceHeartbeat, voiceAuthorityLost } from '../../core/src/voice-lifecycle-controller.js';
// START's rail lifecycle, ported to the live-voice session interface (INSPR D3). The presentation is
// START's conversation rail (index.astro .v2__conversation-rail): an orb dock, icon controls in fixed
// cells and the waveform with one status phrase. Alternatives share a cell (Start and the microphone,
// End and Retry call, Sound and Enable sound), so no state change moves a control.
const BUTTONS = { start: ['mic'], input: ['mic', true], output: ['volume', true], playback: ['volume'], close: ['stop'], retry: ['refresh'] };
export class AudioRail {
  constructor({ root, noticesRoot, copy, client, feature, context, onPartial, onPause, onEnd, onState, onRender, onLevel, playback, journal, ready, waitingCall, heartbeatMs = 10_000 }) {
    Object.assign(this, { root, copy, client, feature, context, onPartial, onPause, onEnd, onState, onRender, onLevel, playback, journal, ready, heartbeatMs });
    this.state = 'idle'; this.input = true; this.output = true; this.generation = 0; this.connected = true;
    this.pauseRequests = new Set(); this.resumeRequests = new Map(); this.pauseRevision = 0;
    this.ownershipState = waitingCall;
    if (waitingCall?.providerSessionId && (waitingCall.state === 'waiting' || waitingCall.controllingTabId &&
      waitingCall.state !== 'ended' && waitingCall.controllingTabId !== client?.tabId)) {
      this.waitingCall = { callId: waitingCall.callId, providerSessionId: waitingCall.providerSessionId, epoch: waitingCall.epoch };
      this.requiresTakeover = Boolean(waitingCall.controllingTabId && waitingCall.controllingTabId !== client?.tabId);
      this.state = 'waiting'; this.paused = true;
    }
    const button = name => `<button data-reveal class="voice-${name}" type="button">${name === 'pause' ? `<span class="voice-icon">${icon('pause')}</span><span class="voice-icon voice-icon--resume">${icon('play')}</span>`
      : icon(BUTTONS[name][0], { slash: BUTTONS[name][1] === true })}<span class="voice-label"></span></button>`;
    root.innerHTML = `<div class="voice-cell voice-cell--output">${button('output')}${button('playback')}</div>
      <div class="voice-signal" data-reveal><canvas class="voice-wave" aria-hidden="true"></canvas><span class="voice-state" role="status"></span><span class="voice-caption"></span></div>
      <div class="voice-cell voice-cell--pause">${button('pause')}</div>
      <div class="voice-cell voice-cell--mic">${button('start')}${button('input')}</div>
      <div class="voice-cell voice-cell--end">${button('close')}${button('retry')}</div>`;
    if (!noticesRoot) { noticesRoot = root.ownerDocument.createElement('div'); noticesRoot.className = 'voice-notices'; root.append(noticesRoot); }
    this.notices = new RecoveryNotices({ root: noticesRoot, copy, available: () => Boolean(this.session && !this.paused && !this.busy && this.output &&
      !['recovering', 'waiting'].includes(this.state)), replay: () => this.session.replayLastReply?.() ?? { kind: 'text', text: this.notices.recovery?.lastReplyText } });
    for (const [name, cell] of [['input', 'mic'], ['output', 'output']]) {
      const help = root.ownerDocument.createElement('span'); help.className = 'voice-waiting-help'; help.id = `voice-${name}-waiting-help`;
      help.setAttribute('role', 'tooltip'); root.querySelector(`.voice-cell--${cell}`).append(help);
    }
    this.waveform = new Waveform(root.querySelector('.voice-wave'));
    const Observer = root.ownerDocument.defaultView?.ResizeObserver;
    if (Observer) {
      this.labelSizes = new Observer(() => this.measureLabel());
      this.observeLabel();
    }
    this.button('start').addEventListener('click', () => void this.start());
    this.button('close').addEventListener('click', () => void this.close());
    this.button('pause').addEventListener('click', () => void (this.waitingCall ? this.start() : this.pause(!this.pauseIntent)));
    for (const [name, channel] of [['input', 'setInput'], ['output', 'setOutput']]) {
      this.button(name).addEventListener('click', async () => {
        if (!this.session || this.busy) return;
        const session = this.session, generation = this.generation, value = !this[name];
        this.busy = true; this.render();
        try { await session[channel](value); if (this.current(session, generation)) this[name] = value; }
        catch (error) { if (this.current(session, generation)) this.failure(error); }
        finally { if (this.current(session, generation)) { this.busy = false; this.render(); this.settle(); } }
      });
    }
    this.button('retry').addEventListener('click', () => void this.start());
    this.button('playback').addEventListener('click', () => void this.retryPlayback());
    // START pauses a voice call when the page is hidden (src/scripts/v2.ts handleVisibilityLoss,
    // pauseOrigin "visibility"; server hold in src/pages/api/v2/pause.ts). START also binds
    // window blur to it; AIT-116 D7 deliberately does not: switching to another window while
    // the tab stays visible keeps the call running. A hide during another command
    // (a microphone toggle or a pending resume, say) stops media immediately and
    // retains a hold through the command, so a hidden rail never keeps listening.
    this.hide = () => {
      if (this.unloading) return;
      this.holdController?.abort();
      if (this.session) { if (!this.paused || this.busy) void this.pause(true); }
      else if (this.state === 'connecting') { this.pauseRevision++; this.hidePending = true; }
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
  observeLabel() {
    for (const selector of ['.voice-state', '.voice-caption', '.voice-wave']) this.labelSizes?.observe(this.root.querySelector(selector));
  }
  measureLabel() {
    const wave = this.root.querySelector('.voice-wave'), caption = this.root.querySelector('.voice-caption');
    const label = caption.textContent ? caption : this.root.querySelector('.voice-state');
    const range = this.root.ownerDocument.createRange();
    range.selectNodeContents(label);
    const half = Math.max(0, ...Array.from(range.getClientRects(), rect => rect.width)) / 2;
    // Only paint changes: the label and every control keep their existing layout boxes.
    wave.style.setProperty('--voice-label-half', `${half}px`);
    wave.toggleAttribute('data-short-flanks', wave.getBoundingClientRect().width / 2 - half - 8 < 24);
  }
  // Both checks matter: a provider can end without changing the generation, and a new call can reuse a session object.
  current(session, generation) { return session === this.session && generation === this.generation; }
  get pauseIntent() { return this.pauseCommand?.paused ?? Boolean(this.paused); }
  rememberResume(id, revision) {
    this.resumeRequests.set(id, revision);
    if (this.resumeRequests.size > 128) this.resumeRequests.delete(this.resumeRequests.keys().next().value);
  }
  capability(name) { return this.client?.manifest?.liveVoice?.capabilities?.[name] !== 'unavailable'; }
  canContinue() {
    const feature = this.feature();
    // A held snapshot must permit the visitor's explicit command. The server
    // rechecks ownership, authorization and money admission before any capture.
    return feature.available || Boolean(this.waitingCall && (feature.reason === this.copy.paused || feature.rawReason === 'session paused'));
  }
  // Keep the failure's meaning so a locale repaint also translates a retained message.
  get error() {
    if (!this.errorKey) return null;
    if (this.errorKey === 'voiceAdmissionDenied' && Object.hasOwn(this.copy.reasons ?? {}, this.errorReason)) return this.copy.reasons[this.errorReason];
    return this.copy[this.errorKey];
  }
  render() {
    // Closing a rail that had no call (an invalidation while idle) is no call: it never marks one active.
    const c = this.copy, active = Boolean(this.session || this.waitingCall), available = this.feature(),
      transitional = ['connecting', 'recovering'].includes(this.state) || this.state === 'closing' && this.closingCall;
    const state = this.paused && active && this.state !== 'waiting' ? 'paused' : this.state;
    if (this.root.dataset.state !== undefined && this.root.dataset.state !== state) queueMicrotask(() => { if (this.connected) this.onState?.(state); });
    this.root.dataset.state = state;
    this.root.dataset.call = active || transitional ? 'active' : 'none';
    this.root.toggleAttribute('data-playback-blocked', Boolean(this.playbackBlocked));
    this.root.toggleAttribute('data-moved', Boolean(this.moved));
    this.root.toggleAttribute('data-message', Boolean(this.error) && !['voiceClosureUncertain', 'voiceEnded', 'voiceMoved'].includes(this.errorKey));
    this.root.setAttribute('role', 'group'); this.root.setAttribute('aria-label', c.voiceRail);
    this.root.querySelector('.voice-state').textContent = this.error ?? (active || transitional ? c.voiceStates[this.root.dataset.state] :
      available.available && this.client ? c.voiceStates[this.state] : available.reason ?? c.notConfigured);
    const labels = { start: c.voiceStart, close: c.voiceClose, input: this.input ? c.voiceMicOn : c.voiceMicOff,
      output: this.output ? c.voiceSpeakerOn : c.voiceSpeakerOff, pause: this.requiresTakeover || this.moved ? c.voiceTakeover : this.pauseIntent ? c.resume : c.pause,
      retry: c.voiceRetry, playback: c.voicePlaybackRetry };
    for (const [name, label] of Object.entries(labels)) {
      const button = this.button(name); button.querySelector('.voice-label').textContent = label; button.title = label;
      const command = { input: 'setInput', output: 'setOutput', pause: this.pauseIntent ? 'resume' : 'pause' }[name];
      button.disabled = name === 'start' ? active || transitional || this.state === 'closing' || !available.available || !this.client
        : name === 'retry' ? active || this.state !== 'failed' || !available.available
        : name === 'playback' ? !this.playbackBlocked
        : name === 'close' ? !active && this.state !== 'connecting' : !active || name !== 'close' && (this.busy && !(name === 'pause' && this.pauseCommand) || transitional || command && !this.capability(command));
      if (name === 'start' && button.disabled && !active) button.title = available.reason ?? c.notConfigured;
      if (command && !this.capability(command)) button.title = c.voiceCommandUnavailable;
      if (state === 'waiting' && ['input', 'output'].includes(name)) {
        button.disabled = true; button.title = this.moved ? c.voiceResumeHereFirst : c.voiceResumeFirst;
        button.querySelector('.voice-label').textContent = button.title;
      }
      if (this.waitingCall && name === 'pause') button.disabled = Boolean(this.busy || transitional || !this.canContinue() || !this.client);
    }
    this.button('input').setAttribute('aria-pressed', String(this.input));
    this.button('output').setAttribute('aria-pressed', String(this.output));
    this.button('pause').setAttribute('aria-pressed', String(Boolean(this.paused)));
    for (const [name, cellName] of [['input', 'mic'], ['output', 'output']]) {
      const cell = this.root.querySelector(`.voice-cell--${cellName}`), help = cell.querySelector('.voice-waiting-help'), waiting = state === 'waiting';
      const resumeFirst = this.moved ? c.voiceResumeHereFirst : c.voiceResumeFirst;
      help.textContent = resumeFirst; help.hidden = !waiting;
      if (waiting) {
        cell.tabIndex = 0; cell.setAttribute('aria-label', `${labels[name]}. ${resumeFirst}`);
        cell.setAttribute('aria-describedby', help.id); this.button(name).setAttribute('aria-describedby', help.id);
      } else {
        cell.removeAttribute('tabindex'); cell.removeAttribute('aria-label'); cell.removeAttribute('aria-describedby'); this.button(name).removeAttribute('aria-describedby');
      }
    }
    this.notices.copy = c; this.notices.render();
    // A different wrapped phrase can keep the same capped box, so text repaints also measure it.
    this.measureLabel();
    this.onRender?.(this);
  }
  failure(error) {
    this.errorKey = error?.name === 'NotAllowedError' ? 'voiceMicDenied' :
      error?.name === 'NotFoundError' ? 'voiceMicMissing' :
      error?.code === 'not-admitted' ? 'voiceAdmissionDenied' :
      error?.code === 'voice-conflict' ? 'voiceConflict' :
      error?.code === 'deadline' ? 'voiceDeadline' : 'voiceConnectionFailed';
    this.errorReason = error?.code === 'not-admitted' ? error.reason : null;
    // A conflict may say when the earlier call's lease ends; Retry then waits it out.
    this.retryAt = error?.code === 'voice-conflict' && error.retryAfterMs > 0 ? Date.now() + Math.min(error.retryAfterMs, 60_000) : 0;
    this.render();
  }
  async start() {
    if (this.state === 'connecting' || !this.canContinue() || !this.client) return;
    if (this.requiresTakeover) {
      if (this.busy) return;
      const generation = ++this.generation, takingBack = Boolean(this.moved), retired = this.session, opening = this.opening;
      this.session = null; this.pauseCommand = null; this.pauseRequests.clear(); this.resumeRequests.clear();
      this.stopHeartbeat?.(); clearInterval(this.meter); this.playbackWatcher?.destroy(); this.quiet();
      // Retired SDK cleanup keeps its original epoch. It cannot close the call
      // this click is about to claim, and it must release the device guard first.
      const retirement = retired?.close({ reason: 'tab-takeover', deadlineAt: Date.now() + 1000 }).catch(() => {});
      this.busy = true; this.render();
      try {
        const held = await this.client.takeover(this.waitingCall, { deadlineAt: Date.now() + 10_000 });
        if (generation !== this.generation || held.epoch < this.ownershipState?.epoch) return;
        this.waitingCall = { callId: held.callId, providerSessionId: held.providerSessionId, epoch: held.epoch };
        this.ownershipState = held; this.requiresTakeover = false; this.moved = false; this.errorKey = null;
        if (takingBack) {
          await retirement; await opening?.catch(() => {});
          if (generation !== this.generation) return;
          // This click is already the explicit visitor intent. A newcomer still
          // stops at the held takeover; an old tab continues straight to Resume.
          this.busy = false; await this.start();
        }
      } catch (error) { if (generation === this.generation) this.failure(error); }
      finally { if (generation === this.generation) { this.busy = false; this.render(); } }
      return;
    }
    if (this.session) return;
    const generation = ++this.generation, revision = this.pauseRevision, resuming = Boolean(this.waitingCall);
    this.resumeRequests.clear(); this.endedCall = null; this.errorKey = null; this.state = 'connecting'; this.render();
    this.notices.clear();
    const controller = new AbortController(); this.controller = controller;
    const holdController = new AbortController(); this.holdController = holdController;
    if (this.root.ownerDocument.hidden) holdController.abort();
    let session;
    try {
      // A reloaded page first ends the call its predecessor left behind.
      await this.ready?.();
      if (generation !== this.generation) return;
      const wait = (this.retryAt ?? 0) - Date.now(); this.retryAt = 0;
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      if (generation !== this.generation) return;
      this.playbackWatcher = watchVoicePlayback(this.root.ownerDocument, () => {
        if (generation === this.generation && (session ? session === this.session : this.state === 'connecting')) this.reportPlaybackBlocked();
      });
      const opening = this.client.start(this.waitingCall ?? { callId: crypto.randomUUID() }, {
        signal: controller.signal, holdSignal: holdController.signal, deadlineAt: Date.now() + 30_000,
        onPauseRequest: id => {
          if (generation !== this.generation) return;
          this.pauseRequests.add(id);
          if (this.pauseRequests.size > 128) this.pauseRequests.delete(this.pauseRequests.values().next().value);
        },
        onResumeRequest: id => { if (generation === this.generation) this.rememberResume(id, revision); },
      });
      this.opening = opening;
      try { session = await opening; }
      finally { if (this.opening === opening) this.opening = null; }
      if (generation !== this.generation) { await session.close(); return; }
      this.session = session; this.waitingCall = null; this.paused = false; this.state = 'listening';
      this.journal?.save({ callId: session.callId, providerSessionId: session.providerSessionId, tabId: session.tabId, epoch: session.epoch });
      await session.setInput(this.input);
      if (!this.current(session, generation)) return;
      await session.setOutput(this.output);
      if (!this.current(session, generation)) return;
      await this.updateContext();
      if (!this.current(session, generation)) return;
      this.render();
      this.stopHeartbeat = session.lifecycle?.startHeartbeat(this.heartbeatMs) ?? watchVoiceHeartbeat({
        heartbeat: opts => session.heartbeat?.(opts), current: () => this.current(session, generation), heartbeatMs: this.heartbeatMs,
        onFailure: error => {
          if (voiceAuthorityLost(error)) { this.failure(error); void this.close('call-authorization-lost'); }
          else { void this.pause(true); }
        },
      });
      // The waveform follows the measured level; under reduced motion it keeps its still baseline.
      const still = this.root.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      this.meter = setInterval(() => {
        if (!this.current(session, generation)) return;
        const levels = session.audioLevels?.(); if (!levels) return;
        const speaking = this.state === 'speaking', level = this.paused ? 0 : Math.min(1, Math.max(0, levels[speaking ? 'output' : 'input'] ?? 0));
        this.root.dataset.measured = '';
        if (!still && this.motion !== false) this.waveform.push(level, speaking ? 'assistant' : 'user', 80);
        // The orb reacts to the audible reply only, never to the visitor's input (START orb).
        if (this.connected) this.onLevel?.(speaking ? level : 0);
      }, 80);
      void this.consume(session, generation);
      if (this.root.ownerDocument.hidden || this.hidePending) { this.hidePending = false; this.hide(); }
      // An early Resume echo stays fenced until startup succeeds. Publish its
      // acknowledged projection now, retaining any hold that superseded startup.
      if (resuming && this.current(session, generation)) this.onPause?.(Boolean(this.paused));
    } catch (error) {
      if (generation !== this.generation || session && session !== this.session) return;
      this.stopHeartbeat?.(); clearInterval(this.meter); this.playbackWatcher?.destroy(); this.session = null; controller.abort();
      this.state = this.waitingCall ? 'waiting' : 'failed'; this.failure(error);
    }
  }
  receiveState(state) {
    if (!state?.callId) return;
    const known = this.ownershipState;
    if (known?.callId === state.callId && state.epoch < known.epoch) return;
    this.ownershipState = state;
    const foreign = state.controllingTabId && state.controllingTabId !== this.client?.tabId;
    if (this.session) {
      const session = this.session;
      session.receiveState?.(state); // Synchronous media hold precedes the repaint.
      if (state.callId === session.callId && (state.epoch > session.epoch || foreign)) {
        this.pauseRevision++; this.pauseCommand = null; this.busy = false;
        this.waitingCall = { callId: state.callId, providerSessionId: state.providerSessionId, epoch: state.epoch };
        this.state = 'waiting'; this.paused = true; this.moved = true; this.requiresTakeover = true;
        this.errorKey = 'voiceMoved'; this.notices.clear(); this.quiet();
        this.root.querySelector('.voice-caption').textContent = ''; this.onPause?.(true); this.render();
      }
      return;
    }
    if (this.state === 'connecting' && this.waitingCall && state?.callId === this.waitingCall.callId &&
      (state.epoch > this.waitingCall.epoch || foreign)) {
      // The server may have resumed before its HTTP receipt arrives. Retire
      // startup and stop SDK media synchronously; that receipt owns no new tab.
      this.generation++; this.pauseRevision++; this.holdController?.abort('ownership-lost');
      this.controller?.abort('ownership-lost');
      this.waitingCall = { callId: state.callId, providerSessionId: state.providerSessionId, epoch: state.epoch };
      this.state = 'waiting'; this.paused = true; this.moved = true; this.requiresTakeover = true;
      this.errorKey = 'voiceMoved'; this.busy = false; this.pauseCommand = null;
      this.playbackWatcher?.destroy(); this.notices.clear(); this.quiet(); this.onPause?.(true); this.render();
      return;
    }
    if (!state?.providerSessionId || state.state === 'ended' || this.state === 'connecting') return;
    if (foreign || state.state === 'waiting') {
      if (foreign && this.busy && known?.controllingTabId === this.client?.tabId) {
        this.generation++; this.pauseRevision++; this.busy = false; this.moved = true; this.errorKey = 'voiceMoved';
      }
      this.waitingCall = { callId: state.callId, providerSessionId: state.providerSessionId, epoch: state.epoch };
      this.requiresTakeover = Boolean(foreign);
      this.state = 'waiting'; this.paused = true; this.render();
    }
  }
  async consume(session, generation) {
    try {
      for await (const event of session.events) {
        if (!this.current(session, generation) || event.callId !== session.callId) return;
        if (['listening', 'speaking'].includes(event.type)) this.state = event.type;
        if (event.type === 'partial') { this.root.querySelector('.voice-caption').textContent = event.text; this.onPartial?.(event); }
        if (event.type === 'final') this.root.querySelector('.voice-caption').textContent = '';
        if (['partial', 'final'].includes(event.type)) this.notices.clear();
        if (event.type === 'recovering') this.state = 'recovering';
        if (event.type === 'recovered') {
          this.state = 'listening'; this.errorKey = null; this.journal?.update({ providerSessionId: session.providerSessionId });
          this.notices.recovered(event.recovery);
          void this.updateContext().catch(() => {});
        }
        if (event.type === 'waiting') {
          this.pauseRevision++; this.pauseCommand = null; this.busy = false;
          this.state = 'waiting'; this.paused = true; this.moved = event.reason === 'ownership-lost';
          this.errorKey = this.moved ? 'voiceMoved' : null; this.quiet();
          if (this.moved) this.notices.clear();
          this.root.querySelector('.voice-caption').textContent = '';
        }
        if (event.type === 'ended') {
          this.notices.clear();
          this.stopHeartbeat?.(); clearInterval(this.meter); this.playbackWatcher?.destroy(); this.session = null; this.journal?.clear();
          this.busy = false; this.pauseCommand = null; this.beating = false; this.hidePending = false; this.playbackBlocked = false;
          this.quiet(); this.onEnd?.();
          this.state = ['closed', 'cancelled', 'closure-uncertain'].includes(event.reason) ? 'idle' : 'failed';
          this.errorKey = event.reason === 'recovery-failed' ? 'voiceRecoveryFailed' :
            event.reason === 'closure-uncertain' ? 'voiceClosureUncertain' :
            event.reason.includes('deadline') ? 'voiceDeadline' : this.state === 'failed' ? 'voiceConnectionFailed' : null;
          this.root.querySelector('.voice-caption').textContent = '';
        }
        this.render();
      }
    } catch (error) { if (this.current(session, generation)) { this.failure(error); await this.close(); } }
  }
  async pause(paused) {
    if (!this.session || this.busy && !paused && !this.pauseCommand || this.pauseCommand?.paused === paused || this.paused === paused && !this.busy) {
      if (paused && this.state === 'connecting') { this.pauseRevision++; this.holdController?.abort(); this.hidePending = true; }
      return;
    }
    const session = this.session, generation = this.generation;
    const revision = ++this.pauseRevision;
    this.pauseCommand = { paused, revision };
    if (paused) this.paused = true;
    // Repaint the next visitor action while capture retains its acknowledged hold.
    this.onPause?.(Boolean(this.paused));
    this.busy = true; this.render();
    try {
      const ack = await session[paused ? 'pause' : 'resume'](paused ? undefined : {
        onResumeRequest: id => { if (this.current(session, generation)) this.rememberResume(id, revision); },
      });
      if (!this.current(session, generation) || revision !== this.pauseRevision) return;
      if (ack?.acknowledged !== true || ack.paused !== paused) throw new Error('Pause acknowledgement required');
      this.paused = paused; this.errorKey = null;
      if (!paused) { this.state = 'listening'; void this.updateContext().catch(() => {}); }
    } catch { if (this.current(session, generation) && revision === this.pauseRevision) this.errorKey = 'voicePauseFailed'; }
    finally {
      if (this.current(session, generation) && revision === this.pauseRevision) {
        this.busy = false; this.pauseCommand = null; this.onPause?.(Boolean(this.paused)); this.render(); this.settle();
      }
    }
  }
  // Return whether the durable event may change the conversation's local pause projection.
  syncPause(paused, pauseRequestId, resumeRequestId) {
    // Our own durable pause echo acknowledges an existing hold. It must neither
    // queue another Pause nor fence the Resume following muted SDK setup.
    if (paused && this.pauseRequests.delete(pauseRequestId)) return false;
    if (!paused) {
      if (!this.session && !this.waitingCall && this.state !== 'connecting') return true;
      // An echo acknowledges only its original visitor intent. A newer hold or
      // command supersedes it; even a matching echo cannot unlock media before
      // that Resume's HTTP acknowledgement. Events never create Resume commands.
      return this.resumeRequests.get(resumeRequestId) === this.pauseRevision && !this.paused;
    }
    // A server hold must win over pending Resume, including restored startup.
    if (this.state === 'connecting' || this.session && (!this.paused || this.busy)) void this.pause(true);
    return true;
  }
  async sendText(text) {
    if (!this.session || this.paused || this.state === 'recovering' || !this.capability('sendText')) throw new Error('Voice text unavailable');
    this.notices.clear();
    return this.session.sendText(text);
  }
  async updateContext() {
    if (!this.session || this.paused || !this.capability('updateContext')) return;
    await this.session.updateContext(this.context());
  }
  async retryPlayback() {
    if (!this.session && this.state !== 'connecting') return;
    const session = this.session, generation = this.generation, watcher = this.playbackWatcher;
    try {
      await this.playback?.();
      if (!this.current(session, generation)) return;
      await watcher?.retry();
      if (!this.current(session, generation)) return;
      this.playbackBlocked = false; this.errorKey = null;
    } catch { if (this.current(session, generation)) { this.playbackBlocked = true; this.errorKey = 'voicePlaybackBlocked'; } }
    if (this.current(session, generation)) this.render();
  }
  reportPlaybackBlocked() {
    if (!this.session && this.state !== 'connecting') return;
    this.playbackBlocked = true; this.errorKey = 'voicePlaybackBlocked'; this.render();
  }
  settlement(data) {
    const ended = this.endedCall;
    if (this.session || !ended || data.callId !== ended.callId || data.providerSessionId !== ended.providerSessionId ||
      data.terminal?.closureConfirmed !== true || !data.terminal.usage || data.terminal.usage.costEstimated === true) return;
    ended.settled = true;
    if (this.errorKey === 'voiceClosureUncertain') { this.errorKey = 'voiceEnded'; this.render(); }
  }
  close(reason) {
    if (this.closing && !this.session && this.state !== 'connecting') {
      if (reason) void this.closingSession?.close({ reason }).catch(() => {});
      return this.closing;
    }
    const waiting = this.waitingCall;
    const session = this.session ?? (waiting && this.client?.closeWaiting ? { ...waiting,
      close: options => this.client.closeWaiting(waiting, options) } : null);
    this.closingSession = session;
    const generation = ++this.generation;
    this.pauseRequests.clear(); this.resumeRequests.clear(); this.pauseCommand = null;
    // A restored Resume has capture guards but no returned session yet. Fence
    // startup before its late acknowledgement or the waiting-call POST can run.
    if (!this.session) { this.holdController?.abort(); this.controller?.abort(); }
    this.stopHeartbeat?.(); clearInterval(this.meter); this.playbackWatcher?.destroy(); this.quiet();
    this.endedCall = session ? { callId: session.callId, providerSessionId: session.providerSessionId } : null;
    this.session = null; this.waitingCall = null; this.requiresTakeover = false; this.moved = false;
    this.hidePending = false; this.paused = false; this.busy = false; this.beating = false; this.playbackBlocked = false; this.state = 'idle';
    this.notices.clear();
    this.errorKey = session ? 'voiceClosureUncertain' : null;
    if (reason?.includes('deadline')) { this.state = 'failed'; this.errorKey = 'voiceDeadline'; }
    this.root.querySelector('.voice-caption').textContent = ''; this.render();
    this.onEnd?.();
    const controller = this.controller;
    const closing = (async () => {
      try {
        const terminal = await session?.close({ deadlineAt: Date.now() + 45_000, reason: reason ?? 'closed' });
        if (generation !== this.generation) return;
        if (session) this.journal?.clear();
        if (session && !reason?.includes('deadline') && !this.endedCall?.settled) this.errorKey =
          terminal?.closureConfirmed && !terminal.usage?.costEstimated ? 'voiceEnded' : 'voiceClosureUncertain';
      } catch { /* Local hangup is complete; the durable server lease and journal retain unresolved closure. */ }
      finally { controller?.abort(); if (generation === this.generation) this.render(); }
    })().finally(() => { if (this.closing === closing) { this.closing = null; this.closingSession = null; } });
    this.closing = closing; return closing;
  }
  quiet() { delete this.root.dataset.measured; this.waveform.baseline(); if (this.connected) this.onLevel?.(0); }
  connect() {
    this.connected = true; this.root.ownerDocument.addEventListener('visibilitychange', this.visibility); this.waveform.connect();
    this.observeLabel();
  }
  disconnect() {
    this.connected = false; this.root.ownerDocument.removeEventListener('visibilitychange', this.visibility); this.waveform.destroy(); this.labelSizes?.disconnect();
    if (this.session || this.state === 'connecting') void this.close();
  }
  destroy() {
    this.onState = null; this.onRender = null; this.onLevel = null; this.disconnect();
  }
}
