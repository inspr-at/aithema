import { neutralBindingReason } from './reason-text.js';
import { isConsentReason } from '../../core/src/settings.js';
import { featureConsentText, paintConsentLine, paintNarrowText } from './consent-line.js';
import { narrowVoiceStatus } from './voice-status.js';
import { icon } from './icons.js';
import { setText } from './dom.js';
import { Waveform } from './waveform.js';
import { RecoveryNotices } from './recovery-notices.js';
import { watchVoiceHeartbeat, voiceAuthorityLost, voiceRetryAt } from '../../core/src/voice-lifecycle-controller.js';
// START's rail lifecycle, ported to the live-voice session interface (INSPR D3). The presentation is
// START's conversation rail (index.astro .v2__conversation-rail): an orb dock, icon controls in fixed
// cells and the waveform with one status phrase. Alternatives share a cell (Start and the microphone,
// End and Retry call, Sound and Enable sound), so no state change moves a control.
const BUTTONS = { start: ['mic'], input: ['mic', true], output: ['volume', true], playback: ['volume'], close: ['stop'], retry: ['refresh'] };
const TAKEOVER_DEADLINE_MS = 10_000;
const MIC_FAILURES = ['voiceMicDenied', 'voiceMicMissing', 'voiceMicBusy', 'voiceMicUnavailable', 'voiceMicFailed'];
// Unlike a provider deadline, a visitor-controlled permission prompt is unbounded.
function startupWait(pending, signal, timeoutMs) {
  let timer, abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason ?? new DOMException('Startup cancelled', 'AbortError'));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
  const timeout = timeoutMs === undefined ? new Promise(() => {}) : new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); });
  return Promise.race([pending === undefined ? new Promise(() => {}) : pending, cancelled, timeout]).finally(() => { clearTimeout(timer); signal.removeEventListener('abort', abort); });
}
export class AudioRail {
  constructor({ root, noticesRoot, copy, client, feature, consent, context, lastReply, replyVisible, replyTarget, onPartial, onFinal, onPause, onEnd, onState, onRender, onLevel, playback, journal, ready, usedUp, endReason, nextTier, lowCredit, ending, waitingCall, heartbeatMs = 10_000 }) {
    Object.assign(this, { root, copy, client, feature, consent, context, lastReply, replyVisible, replyTarget, onPartial, onFinal, onPause, onEnd, onState, onRender, onLevel, playback, journal, ready, usedUp, endReason, nextTier, lowCredit, ending, heartbeatMs });
    this.state = 'idle'; this.input = true; this.output = true; this.generation = 0; this.connected = true;
    this.pauseRequests = new Set(); this.resumeRequests = new Map(); this.pauseRevision = 0;
    this.ownershipState = waitingCall;
    if (waitingCall?.providerSessionId && (waitingCall.state === 'waiting' || waitingCall.controllingTabId &&
      waitingCall.state !== 'ended' && waitingCall.controllingTabId !== client?.tabId)) {
      this.waitingCall = { callId: waitingCall.callId, providerSessionId: waitingCall.providerSessionId, ...(waitingCall.epoch !== undefined ? { epoch: waitingCall.epoch } : {}) };
      this.requiresTakeover = Boolean(waitingCall.controllingTabId && waitingCall.controllingTabId !== client?.tabId);
      this.state = 'waiting'; this.paused = true;
    }
    const button = name => `<button data-reveal class="voice-${name}" type="button">${name === 'pause' ? `<span class="voice-icon">${icon('pause')}</span><span class="voice-icon voice-icon--resume">${icon('play')}</span>`
      : icon(BUTTONS[name][0], { slash: BUTTONS[name][1] === true })}<span class="voice-label"></span></button>`;
    root.innerHTML = `<div class="voice-cell voice-cell--output">${button('output')}${button('playback')}</div>
      <div class="voice-signal" data-reveal><canvas class="voice-wave" aria-hidden="true"></canvas><span class="voice-state" role="status"></span><span class="voice-caption" aria-hidden="true"></span></div>
      <div class="voice-cell voice-cell--pause">${button('pause')}</div>
      <div class="voice-cell voice-cell--mic">${button('start')}${button('input')}</div>
      <div class="voice-cell voice-cell--end">${button('close')}${button('retry')}</div>`;
    if (!noticesRoot) { noticesRoot = root.ownerDocument.createElement('div'); noticesRoot.className = 'voice-notices'; root.append(noticesRoot); }
    this.notices = new RecoveryNotices({ root: noticesRoot, copy, available: () => Boolean((this.session || this.lastReply?.()) && !this.paused && !this.busy && this.output &&
      !['recovering', 'waiting', 'closing'].includes(this.state)),
      replyVisible: (text, turnId) => this.replyVisible?.(text, turnId) ?? Boolean(text && this.lastReply?.()?.text === text),
      replyTarget,
      audioAvailable: () => !this.usedUp?.() && !this.allowanceDenied && this.feature()?.available !== false &&
        Boolean(this.session ? this.session.replayLastReply : this.client?.replayReply),
      stopReplay: () => this.session?.stopReplay?.() ?? this.client?.stopReplay?.(), replay: async () => {
        try {
          if (this.session) return await (this.session.replayLastReply?.() ?? { kind: 'text', text: this.notices.recovery?.lastReplyText });
          const reply = this.lastReply?.();
          return await (this.client?.replayReply?.(reply, {
            onState: (playing, detail) => {
              if (playing) { this.notices.playing = true; this.notices.render(); }
              else this.notices.playbackEnded(detail?.completed);
            },
            current: candidate => !this.session && !this.paused && this.lastReply?.()?.turnId === candidate.turnId && this.lastReply?.()?.text === candidate.text,
          }) ?? { kind: 'text', text: reply?.text });
        }
        catch (error) {
          if (error.code === 'not-admitted' && error.reason === 'host-limit') {
            this.failure(error); this.render();
            return { kind: 'text', text: this.notices.recovery?.lastReplyText ?? this.lastReply?.()?.text };
          }
          throw error;
        }
      } });
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
    this.button('pause').addEventListener('click', () => void (this.moved || this.waitingCall ? this.start() : this.pause(!this.pauseIntent)));
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
      this.client?.stopReplay?.();
      this.takeoverController?.abort();
      if (this.unloading) return;
      this.holdController?.abort();
      if (this.session) { if (!this.paused || this.busy) void this.pause(true); }
      else if (this.state === 'connecting') { this.pauseRevision++; this.hidePending = true; }
    };
    this.visibility = () => { if (root.ownerDocument.hidden) this.hide(); };
    this.pagehide = () => this.takeoverController?.abort();
    root.ownerDocument.addEventListener('visibilitychange', this.visibility);
    root.ownerDocument.defaultView?.addEventListener('pagehide', this.pagehide);
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
    if (this.root.hasAttribute('data-message')) {
      const signal = this.root.querySelector('.voice-signal').getBoundingClientRect();
      const viewport = this.root.ownerDocument.documentElement.clientWidth;
      const header = (this.root.closest('.band') ?? this.root).getBoundingClientRect();
      const minLeft = Math.max(16, header.left), maxRight = Math.min(viewport - 16, header.right);
      const width = Math.min(280, Math.max(0, maxRight - minLeft));
      const anchor = (MIC_FAILURES.includes(this.errorKey) ? this.button(this.session ? 'input' : 'start')
        : this.errorKey === 'voicePlaybackBlocked' ? this.button('playback')
        : this.state === 'failed' && !this.session && ['voiceConnectionFailed', 'voiceDeadline', 'voiceConflict'].includes(this.errorKey) ? this.button('retry')
        : this.root.querySelector('.voice-signal')).getBoundingClientRect();
      const left = Math.max(minLeft, Math.min((anchor.left + anchor.right - width) / 2, maxRight - width));
      this.root.style.setProperty('--voice-message-width', `${width}px`);
      this.root.style.setProperty('--voice-message-left', `${left - signal.left}px`);
      this.root.style.setProperty('--voice-message-top', `${anchor.bottom + 8 - signal.top}px`);
    }
    const label = caption.textContent ? caption : this.root.querySelector('.voice-state');
    const range = this.root.ownerDocument.createRange();
    range.selectNodeContents(label);
    // Include every rendered line and any inline consent action. Measure their
    // actual position: held-call copy can borrow the adjacent pause cell.
    const narrow = this.root.ownerDocument.defaultView?.matchMedia?.('(max-width:599px)').matches && label.querySelector('.consent-narrow');
    const action = narrow && label.querySelector('.consent-action');
    const rects = (narrow ? [...narrow.getClientRects(), ...(action?.getClientRects() ?? [])] : [...range.getClientRects()])
      .filter(rect => rect.width > 0);
    const bounds = wave.getBoundingClientRect();
    const left = rects.length ? Math.min(...rects.map(rect => rect.left)) : bounds.left + bounds.width / 2;
    const right = rects.length ? Math.max(...rects.map(rect => rect.right)) : left;
    const half = (right - left) / 2;
    // Only paint changes. The clear gap, fades and 24px useful flanks never
    // resize a label, control or the bar when its state changes.
    wave.style.setProperty('--voice-label-half', `${half}px`);
    wave.style.setProperty('--voice-label-center', `${(left + right) / 2 - bounds.left - bounds.width / 2}px`);
    wave.toggleAttribute('data-short-flanks', Math.min(left - bounds.left, bounds.right - right) - 16 < 24);
  }
  // Both checks matter: a provider can end without changing the generation, and a new call can reuse a session object.
  current(session, generation) { return session === this.session && generation === this.generation; }
  get pauseIntent() { return this.pauseCommand?.paused ?? Boolean(this.paused); }
  rememberResume(id, revision) {
    this.resumeRequests.set(id, revision);
    if (this.resumeRequests.size > 128) this.resumeRequests.delete(this.resumeRequests.keys().next().value);
  }
  capability(name) { return this.client?.manifest?.liveVoice?.capabilities?.[name] !== 'unavailable'; }
  // New lifecycle signals are opt-in; absent declarations retain client-owned behavior.
  declaredSignal(name) { return ['native', 'emulated'].includes(this.client?.manifest?.liveVoice?.capabilities?.[name]); }
  canContinue() {
    if (this.usedUp?.() || this.ending?.() || this.allowanceDenied) return false;
    const feature = this.feature();
    // A held snapshot must permit the visitor's explicit command. The server
    // rechecks ownership, authorization and money admission before any capture.
    return feature.available || Boolean((this.moved || this.waitingCall) && (feature.reason === this.copy.paused || feature.rawReason === 'session paused'));
  }
  // Keep the failure's meaning so a locale repaint also translates a retained message.
  get error() {
    if (!this.errorKey) return null;
    if (this.errorKey === 'voiceAdmissionDenied' && isConsentReason(this.errorReason)) return featureConsentText(this.copy, 'voice');
    const neutral = this.errorKey === 'voiceAdmissionDenied' ? neutralBindingReason(this.copy, this.errorReason, 'voice') : undefined;
    if (neutral !== undefined) return neutral;
    if (this.errorKey === 'voiceAdmissionDenied' && Object.hasOwn(this.copy.reasons ?? {}, this.errorReason)) return this.copy.reasons[this.errorReason];
    if (this.errorKey === 'voiceEnded' && this.endedCall?.visitorDurationSource === 'aithema-measured') return this.copy.voiceEndedAithemaMeasured;
    return this.copy[this.errorKey];
  }
  // Reconcile only after a fresh server feature read. A repaint immediately
  // after an admission refusal still has the preview that preceded that refusal.
  get allowanceDenied() { return this.errorKey === 'voiceAdmissionDenied' && ['host-limit', 'budget denied'].includes(this.errorReason); }
  reconcileAdmission() {
    if (this.feature().available && !this.usedUp?.() && this.allowanceDenied) {
      this.errorKey = this.moved ? 'voiceMoved' : null; this.errorReason = null;
    }
  }
  render() {
    // Closing a rail that had no call (an invalidation while idle) is no call: it never marks one active.
    const c = this.copy, active = Boolean(this.session || this.waitingCall), available = this.feature(),
      transitional = this.retryConnecting || ['connecting', 'recovering'].includes(this.state) || this.state === 'closing' && this.closingCall;
    // The feature preview can deny new work because an admitted segment holds
    // the allowance. Only a wallet verdict or an actual admission refusal ends it.
    const usedUp = Boolean(this.usedUp?.()) || this.allowanceDenied;
    const creditEnding = Boolean(this.ending?.());
    const usedUpLabel = c.voiceStates[this.endReason?.() === 'one-hour' ? 'timeExpired' : 'usedUp'];
    this.root.toggleAttribute('data-used-up', usedUp && !creditEnding); this.root.toggleAttribute('data-credit-ending', creditEnding);
    const state = this.retryConnecting ? 'connecting' : this.paused && active && this.state !== 'waiting' ? 'paused' : this.state;
    if (this.root.dataset.state !== undefined && this.root.dataset.state !== state) queueMicrotask(() => { if (this.connected) this.onState?.(state); });
    this.root.dataset.state = state;
    this.root.dataset.call = active || transitional ? 'active' : 'none';
    this.root.toggleAttribute('data-call-reconciling', Boolean(this.endedCall && !this.endedCall.settled) && !active && state === 'idle');
    this.root.toggleAttribute('data-device-message', ['voiceMicBusy', 'voiceMicUnavailable', 'voiceMicFailed', 'voiceNoReply'].includes(this.errorKey));
    this.root.toggleAttribute('data-no-mic-api', this.errorKey === 'voiceMicUnavailable');
    this.root.dataset.startupPhase = this.startupPhase ?? '';
    this.root.toggleAttribute('data-playback-blocked', Boolean(this.playbackBlocked));
    this.root.toggleAttribute('data-moved', Boolean(this.moved));
    this.root.toggleAttribute('data-message', !usedUp && Boolean(this.error) && !['voiceClosureUncertain', 'voiceEnded', 'voiceMoved'].includes(this.errorKey));
    this.root.setAttribute('role', 'group'); this.root.setAttribute('aria-label', c.voiceRail);
    // The session's one exhaustion announcement describes both credits and the saved conversation.
    this.root.querySelector('.voice-state').setAttribute('aria-live', this.usedUp?.() ? 'off' : 'polite');
    paintConsentLine(this.root.querySelector('.voice-state'), { copy: c, feature: 'voice',
      verdict: active || transitional || usedUp || this.error ? { available: true } : available,
      text: usedUp ? (creditEnding ? c.voiceStates.creditEnding : usedUpLabel) : this.error ?? (this.startupPhase === 'cooldown' ? c.voiceCooldown.replace('{s}', this.countdown) :
      this.startupPhase ? c.voiceStates[this.startupPhase] : active || transitional ? c.voiceStates[this.root.dataset.state] :
      available.available && this.client ? c.voiceStates[this.state] : available.reason ?? c.notConfigured), open: opener => this.consent?.(opener) });
    const low = !usedUp && !this.error && active && ['listening', 'speaking', 'thinking'].includes(state) && this.lowCredit?.();
    this.root.querySelector('.voice-state').classList.toggle('low', Boolean(low));
    if (low) setText(this.root.querySelector('.voice-state'), c.voiceStates.low);
    const status = this.root.querySelector('.voice-state');
    const sentence = status.dataset.consentFeature ? featureConsentText(c, 'voice') : status.textContent;
    if (sentence && !status.dataset.consentFeature) paintNarrowText(status, sentence, this.startupPhase === 'cooldown' ? c.voiceCooldownNarrow.replace('{s}', this.countdown) : narrowVoiceStatus(c, sentence, {
      reason: this.usedUp?.() ? this.endReason?.() : this.allowanceDenied ? this.errorReason : available.rawReason,
      nextTier: this.nextTier?.(),
    }));
    if (this.startupPhase === 'cooldown') {
      const wide = status.querySelector('.consent-wide'), narrow = status.querySelector('.consent-narrow');
      const parts = sentence.split(String(this.countdown));
      if (wide && parts.length === 2) {
        const digits = status.ownerDocument.createElement('span'); digits.className = 'voice-countdown'; digits.textContent = String(this.countdown);
        wide.replaceChildren(parts[0], digits, parts[1]);
      }
      if (narrow) narrow.style.minWidth = '7ch';
    }
    if (status.getAttribute('aria-label') !== sentence) status.setAttribute('aria-label', sentence);
    const labels = { start: c.voiceStart, close: c.voiceClose, input: this.input ? c.voiceMicOn : c.voiceMicOff,
      output: this.output ? c.voiceSpeakerOn : c.voiceSpeakerOff, pause: this.requiresTakeover || this.moved ? c.voiceTakeover : this.pauseIntent ? c.resume : c.pause,
      retry: c.voiceRetry, playback: c.voicePlaybackRetry };
    for (const [name, label] of Object.entries(labels)) {
      const button = this.button(name); button.querySelector('.voice-label').textContent = label; button.title = label;
      const command = { input: 'setInput', output: 'setOutput', pause: this.pauseIntent ? 'resume' : 'pause' }[name];
      button.disabled = name === 'start' ? active || transitional || this.state === 'closing' || !available.available || !this.client
        : name === 'retry' ? active || this.state !== 'failed' || !available.available || this.errorKey === 'voiceMicUnavailable'
        : name === 'playback' ? !this.playbackBlocked
        : name === 'close' ? !active && this.state !== 'connecting' : !active || name !== 'close' && (this.busy && !(name === 'pause' && this.pauseCommand) || transitional || command && !this.capability(command));
      if (!usedUp && name === 'start' && button.disabled && !active) button.title = available.reason ?? c.notConfigured;
      if (!usedUp && command && !this.capability(command)) button.title = c.voiceCommandUnavailable;
      if (state === 'waiting' && ['input', 'output'].includes(name)) {
        button.disabled = true; button.title = this.moved ? c.voiceResumeHereFirst : c.voiceResumeFirst;
        button.querySelector('.voice-label').textContent = button.title;
      }
      if ((this.moved || this.waitingCall) && name === 'pause') button.disabled = Boolean(this.busy || transitional || !this.canContinue() || !this.client);
      if (usedUp) { button.disabled = true; button.title = usedUpLabel; }
    }
    this.button('input').setAttribute('aria-pressed', String(this.input));
    this.button('output').setAttribute('aria-pressed', String(this.output));
    this.button('pause').setAttribute('aria-pressed', String(Boolean(this.paused)));
    for (const [name, cellName] of [['input', 'mic'], ['output', 'output']]) {
      const cell = this.root.querySelector(`.voice-cell--${cellName}`), help = cell.querySelector('.voice-waiting-help'), waiting = state === 'waiting' && !usedUp;
      const resumeFirst = this.moved ? c.voiceResumeHereFirst : c.voiceResumeFirst;
      help.textContent = resumeFirst; help.hidden = !waiting;
      if (waiting) {
        cell.tabIndex = 0; cell.setAttribute('aria-label', `${labels[name]}. ${resumeFirst}`);
        cell.setAttribute('aria-describedby', help.id); this.button(name).setAttribute('aria-describedby', help.id);
      } else {
        cell.removeAttribute('tabindex'); cell.removeAttribute('aria-label'); cell.removeAttribute('aria-describedby'); this.button(name).removeAttribute('aria-describedby');
      }
    }
    const pageReply = !this.session && !transitional && !this.endedCall ? this.lastReply?.() : null;
    if (this.notices.pageReply?.turnId !== pageReply?.turnId || this.notices.pageReply?.text !== pageReply?.text) {
      this.client?.stopReplay?.(); this.notices.playing = false;
    }
    this.notices.pageReply = pageReply;
    this.notices.copy = c; this.notices.render();
    // A different wrapped phrase can keep the same capped box, so text repaints also measure it.
    this.measureLabel();
    this.onRender?.(this);
  }
  failure(error) {
    this.errorKey = error?.status === 429 ? 'voiceConnectionFailed' : error?.name === 'NotAllowedError' ? 'voiceMicDenied' :
      error?.name === 'NotFoundError' ? 'voiceMicMissing' :
      error?.name === 'NotReadableError' ? 'voiceMicBusy' :
      error?.name === 'NoMediaAPIError' ? 'voiceMicUnavailable' :
      ['OverconstrainedError', 'AbortError'].includes(error?.name) || error?.phase === 'microphone' ? 'voiceMicFailed' :
      error?.code === 'not-admitted' ? 'voiceAdmissionDenied' :
      error?.code === 'voice-conflict' ? 'voiceConflict' :
      error?.code === 'deadline' ? 'voiceDeadline' : 'voiceConnectionFailed';
    this.errorReason = error?.status !== 429 && error?.code === 'not-admitted' ? error.reason : null;
    this.retryAt = voiceRetryAt(error);
    this.render();
    if (this.state === 'failed') this.button(this.errorKey === 'voiceMicUnavailable' ? 'start' : 'retry').focus({ preventScroll: true });
  }
  async cooldown(until, signal) {
    const deadline = Math.min(until, Date.now() + 60_000);
    const token = {}; this.cooldownToken = token; this.startupPhase = 'cooldown';
    try {
      while (Date.now() < deadline) {
        this.countdown = Math.ceil((deadline - Date.now()) / 1000); this.render();
        await startupWait(undefined, signal, Math.min(1000, deadline - Date.now()));
        signal.throwIfAborted();
      }
      this.countdown = 0; this.render();
      // Let the zero paint before exchanging the status for Connecting.
      await startupWait(undefined, signal, 1);
      signal.throwIfAborted();
    } finally { if (this.cooldownToken === token) { this.startupPhase = null; this.cooldownToken = null; } }
  }
  stopReplyWatch() { clearTimeout(this.replyTimer); this.replyTimer = null; }
  awaitReply(session, generation) {
    this.stopReplyWatch();
    if (!this.declaredSignal('replyStarted')) return;
    this.replyTimer = setTimeout(() => {
      if (!this.current(session, generation) || this.paused || !['listening', 'speaking', 'thinking'].includes(this.state)) return;
      if (!this.errorKey) { this.errorKey = 'voiceNoReply'; this.render(); }
    }, 15_000);
  }
  receivedReply() {
    this.stopReplyWatch();
    if (this.errorKey === 'voiceNoReply') { this.errorKey = null; this.state = 'speaking'; }
  }
  async takeoverIdentity(retired, controller, deadlineAt) {
    const { signal } = controller;
    const authoritative = () => {
      const state = this.ownershipState;
      return state?.callId === retired.callId && state.providerSessionId && Number.isSafeInteger(state.epoch) &&
        state.epoch > retired.epoch && state.state !== 'ended'
        ? { callId: state.callId, providerSessionId: state.providerSessionId, ...(state.epoch !== undefined ? { epoch: state.epoch } : {}) } : null;
    };
    const known = authoritative();
    if (known) return known;
    // An ownership-lost response proves retirement, but carries no new epoch.
    // Keep this click only until its own deadline, independently of the request
    // deadline that starts once voice.state (or a snapshot) supplies the epoch.
    const notification = Promise.withResolvers(), wait = { callId: retired.callId, epoch: retired.epoch, resolve: notification.resolve };
    const cancel = () => notification.reject(new Error('Voice takeover cancelled'));
    signal.throwIfAborted(); signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), Math.max(0, deadlineAt - Date.now()));
    this.ownershipWait = wait;
    try {
      await notification.promise;
      signal.throwIfAborted();
      if (Date.now() >= deadlineAt || this.root.ownerDocument.hidden) { controller.abort(); signal.throwIfAborted(); }
      const identity = authoritative();
      if (!identity) throw new Error('Authoritative voice ownership required');
      return identity;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      if (this.ownershipWait === wait) this.ownershipWait = null;
    }
  }
  async start() {
    if (this.state === 'connecting' || !this.canContinue() || !this.client) return;
    if (this.moved || this.requiresTakeover) {
      if (this.busy) return;
      const generation = ++this.generation, takingBack = Boolean(this.moved), retired = this.session, opening = this.opening;
      if (takingBack && retired) this.retiredOwnership = { callId: retired.callId, epoch: retired.epoch };
      this.session = null; this.pauseCommand = null; this.pauseRequests.clear(); this.resumeRequests.clear();
      this.stopHeartbeat?.(); clearInterval(this.meter); this.quiet();
      // Retired SDK cleanup keeps its original epoch. It cannot close the call
      // this click is about to claim, and it must release the device guard first.
      const retirement = retired?.close({ reason: 'tab-takeover', deadlineAt: Date.now() + 1000 }).catch(() => {});
      const controller = new AbortController();
      const waitDeadlineAt = Date.now() + TAKEOVER_DEADLINE_MS;
      this.takeoverController = controller; this.busy = true; this.render();
      try {
        const identity = takingBack && this.retiredOwnership ? await this.takeoverIdentity(this.retiredOwnership, controller, waitDeadlineAt) : this.waitingCall;
        // A credit verdict can change while the original click waits for voice.state.
        if (generation !== this.generation || controller.signal.aborted || Date.now() >= waitDeadlineAt || this.root.ownerDocument.hidden || !this.canContinue()) return;
        const held = await this.client.takeover(identity, { signal: controller.signal, deadlineAt: Date.now() + TAKEOVER_DEADLINE_MS });
        if (generation !== this.generation || controller.signal.aborted || this.root.ownerDocument.hidden || held.epoch < this.ownershipState?.epoch) return;
        this.waitingCall = { callId: held.callId, providerSessionId: held.providerSessionId, epoch: held.epoch };
        this.ownershipState = held; this.requiresTakeover = false; this.moved = false; this.retiredOwnership = null; this.errorKey = null;
        if (takingBack) {
          await retirement; await opening?.catch(() => {});
          if (generation !== this.generation || controller.signal.aborted || this.root.ownerDocument.hidden) return;
          // This click is already the explicit visitor intent. A newcomer still
          // stops at the held takeover; an old tab continues straight to Resume.
          this.busy = false; await this.start();
        }
      } catch (error) { if (generation === this.generation && !controller.signal.aborted) this.failure(error); }
      finally {
        if (this.takeoverController === controller) this.takeoverController = null;
        if (generation === this.generation) { this.busy = false; this.render(); }
      }
      return;
    }
    if (this.session) return;
    const generation = ++this.generation, revision = this.pauseRevision, resuming = Boolean(this.waitingCall);
    this.resumeRequests.clear(); this.endedCall = null; this.errorKey = null; this.errorReason = null; this.state = 'connecting'; this.render();
    this.button('close').focus({ preventScroll: true });
    this.notices.clear();
    const controller = new AbortController(); this.controller = controller;
    const holdController = new AbortController(); this.holdController = holdController;
    if (this.root.ownerDocument.hidden) holdController.abort();
    let session, connectTimer;
    const connectDeadline = () => {
      clearTimeout(connectTimer);
      connectTimer = setTimeout(() => controller.abort(Object.assign(new Error('Voice connection deadline'), { code: 'deadline' })), 30_000);
    };
    this.playbackRetry = null;
    try {
      // A reloaded page first ends the call its predecessor left behind.
      if (this.ready) {
        this.startupPhase = 'cleanup'; this.render();
        // The orphan owns its own cleanup. A slow/rejected cleanup cannot hold this click forever.
        await startupWait(Promise.resolve().then(() => this.ready()).catch(() => {}), controller.signal, 5000);
      }
      if (generation !== this.generation) return;
      const retryAt = this.retryAt; this.retryAt = 0;
      if (retryAt > Date.now()) await this.cooldown(retryAt, controller.signal);
      if (generation !== this.generation) return;
      this.startupPhase = null; this.render();
      const view = this.root.ownerDocument.defaultView;
      if (this.input && typeof view?.isSecureContext === 'boolean' &&
        (!view.isSecureContext || typeof view.navigator.mediaDevices?.getUserMedia !== 'function')) {
        throw Object.assign(new Error('Microphone API unavailable'), { name: 'NoMediaAPIError' });
      }
      const microphonePhases = this.declaredSignal('onMicrophoneState');
      // Declared clients bound credential preparation separately from S3.
      // Only requesting opens S1 and suspends this guard; grant starts a fresh
      // 30 s provider deadline. Cleanup/cooldown above remain outside both.
      if (microphonePhases) connectDeadline();
      const opening = this.client.start(this.waitingCall ?? { callId: crypto.randomUUID() }, {
        signal: controller.signal, holdSignal: holdController.signal,
        // Today's clients retain main's option and their own deadline scopes.
        ...(!microphonePhases || !this.input ? { deadlineAt: Date.now() + 30_000 } : {}),
        // AIT-383 owns provider acquisition/grant signals; never infer a phase.
        onMicrophoneState: phase => {
          if (!microphonePhases || !this.input || generation !== this.generation || controller.signal.aborted || this.state !== 'connecting') return;
          if (phase === 'requesting') { clearTimeout(connectTimer); this.startupPhase = 'microphone'; }
          else if (phase === 'granted') { this.startupPhase = null; connectDeadline(); }
          this.render();
        },
        onPlaybackBlocked: retry => {
          if (generation === this.generation && (session ? session === this.session : this.state === 'connecting')) {
            this.playbackRetry = retry; this.reportPlaybackBlocked();
          }
        },
        onPauseRequest: id => {
          if (generation !== this.generation) return;
          this.pauseRequests.add(id);
          if (this.pauseRequests.size > 128) this.pauseRequests.delete(this.pauseRequests.values().next().value);
        },
        onResumeRequest: id => { if (generation === this.generation) this.rememberResume(id, revision); },
      });
      this.opening = opening;
      // Ports which ignore AbortSignal still cannot retain this click. Close any late session.
      void opening.then(late => { if (generation !== this.generation || controller.signal.aborted) void late.close().catch(() => {}); }, () => {});
      try { session = await startupWait(opening, controller.signal); }
      finally { if (this.opening === opening) this.opening = null; }
      if (generation !== this.generation) { await session.close(); return; }
      this.session = session; this.waitingCall = null; this.paused = false; this.startupPhase = null; this.state = 'listening';
      clearTimeout(connectTimer); this.stopReplyWatch();
      if (this.client.manifest?.liveVoice?.capabilities?.opener === true) this.awaitReply(session, generation);
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
      this.stopHeartbeat?.(); clearInterval(this.meter); this.session = null; controller.abort();
      if (this.startupPhase === 'microphone' && !error.code) error.phase = 'microphone';
      this.startupPhase = null; this.stopReplyWatch();
      this.state = this.waitingCall ? 'waiting' : 'failed'; this.failure(error);
    } finally { clearTimeout(connectTimer); }
  }
  receiveState(state) {
    if (!state?.callId) return;
    const known = this.ownershipState;
    if (known?.callId === state.callId && state.epoch < known.epoch) return;
    const foreign = state.controllingTabId && state.controllingTabId !== this.client?.tabId;
    // The first missing epoch can satisfy the saved click. A further takeover
    // belongs to a newer visitor intent and must retire this one immediately.
    if (this.takeoverController && known?.callId === state.callId && (state.state === 'ended' ||
      foreign && state.epoch > known.epoch && (this.retiredOwnership ? known.epoch > this.retiredOwnership.epoch : known.controllingTabId === this.client?.tabId))) {
      this.takeoverController.abort();
    }
    this.ownershipState = state;
    if (this.ownershipWait?.callId === state.callId && Number.isSafeInteger(state.epoch) && state.epoch > this.ownershipWait.epoch) {
      if (state.state === 'ended') this.takeoverController?.abort();
      else if (state.providerSessionId) this.ownershipWait.resolve();
    }
    if (this.session) {
      const session = this.session;
      session.receiveState?.(state); // Synchronous media hold precedes the repaint.
      if (state.callId === session.callId && (state.epoch > session.epoch || foreign)) {
        this.pauseRevision++; this.pauseCommand = null; this.busy = false;
        this.waitingCall = { callId: state.callId, providerSessionId: state.providerSessionId, ...(state.epoch !== undefined ? { epoch: state.epoch } : {}) };
        this.retryConnecting = false; this.state = 'waiting'; this.paused = true; this.moved = true; this.requiresTakeover = true;
        this.errorKey = this.allowanceDenied ? 'voiceAdmissionDenied' : 'voiceMoved'; this.notices.clear(); this.quiet();
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
      this.waitingCall = { callId: state.callId, providerSessionId: state.providerSessionId, ...(state.epoch !== undefined ? { epoch: state.epoch } : {}) };
      this.retryConnecting = false; this.state = 'waiting'; this.paused = true; this.moved = true; this.requiresTakeover = true;
      this.errorKey = this.allowanceDenied ? 'voiceAdmissionDenied' : 'voiceMoved'; this.busy = false; this.pauseCommand = null;
      this.notices.clear(); this.quiet(); this.onPause?.(true); this.render();
      return;
    }
    if (!state?.providerSessionId || state.state === 'ended' || this.state === 'connecting') return;
    const retired = this.retiredOwnership;
    const controlling = state.callId === this.waitingCall?.callId && state.controllingTabId && state.controllingTabId === this.client?.tabId &&
      Number.isSafeInteger(state.epoch) && (!retired || retired.callId === state.callId && state.epoch > retired.epoch);
    if (foreign || state.state === 'waiting' || controlling && this.moved) {
      if (foreign && !this.ownershipWait && known?.callId === state.callId && known.controllingTabId === this.client?.tabId) {
        if (this.busy) { this.generation++; this.pauseRevision++; this.busy = false; }
        this.moved = true; this.errorKey = this.allowanceDenied ? 'voiceAdmissionDenied' : 'voiceMoved';
      }
      this.waitingCall = { callId: state.callId, providerSessionId: state.providerSessionId, ...(state.epoch !== undefined ? { epoch: state.epoch } : {}) };
      this.requiresTakeover = Boolean(foreign);
      // A cancelled request may already have claimed this epoch on the server.
      // Reconcile the held identity, leaving Resume to the visitor's next click.
      if (controlling) {
        this.moved = false; this.retiredOwnership = null;
        if (this.errorKey === 'voiceMoved') this.errorKey = null;
      }
      this.retryConnecting = false; this.state = 'waiting'; this.paused = true; this.render();
    }
  }
  async consume(session, generation) {
    try {
      for await (const event of session.events) {
        if (!this.current(session, generation) || event.callId !== session.callId) return;
        if (['listening', 'speaking'].includes(event.type)) this.state = event.type;
        if (!this.paused && !event.replay) {
          // replyStarted promises audible, non-filler provenance. Mode-only
          // speaking from today's clients cannot qualify (AIT-383).
          if (this.declaredSignal('replyStarted') && event.type === 'speaking' && event.audio === true && !event.filler) this.receivedReply();
          if (['partial', 'final'].includes(event.type) && event.role === 'assistant' && event.text?.trim() &&
            !event.filler && !['Einen Moment, bitte.', 'One moment, please.'].includes(event.text.trim())) this.receivedReply();
          if (event.type === 'partial' && event.role === 'user') this.stopReplyWatch();
          if (event.type === 'final' && event.role === 'user') this.awaitReply(session, generation);
        }
        if (['recovering', 'waiting', 'ended'].includes(event.type)) this.stopReplyWatch();
        if (event.replay && event.type === 'listening') this.notices.playbackEnded(event.completed);
        if (event.type === 'partial' && !this.paused) {
          this.root.querySelector('.voice-caption').textContent = this.onPartial ? '' : event.text;
          this.onPartial?.(event);
        }
        if (event.type === 'final') { this.root.querySelector('.voice-caption').textContent = ''; this.onFinal?.(event); }
        if (['partial', 'final'].includes(event.type)) this.notices.clear();
        if (event.type === 'recovering') this.state = 'recovering';
        if (event.type === 'recovered') {
          this.state = 'listening'; this.errorKey = null; this.journal?.update({ providerSessionId: session.providerSessionId });
          this.notices.recovered(event.recovery);
          // Repair is silent: only a subsequent visitor turn can expect a reply.
          this.stopReplyWatch();
          void this.updateContext().catch(() => {});
        }
        if (event.type === 'waiting') {
          this.retryConnecting = false; this.retryAt = event.retryAt ?? 0;
          this.pauseRevision++; this.pauseCommand = null; this.busy = false;
          this.state = 'waiting'; this.paused = true; this.moved ||= event.reason === 'ownership-lost';
          this.errorKey = this.allowanceDenied ? 'voiceAdmissionDenied' : this.moved ? 'voiceMoved' : null; this.quiet();
          if (this.moved) {
            this.requiresTakeover = true;
            this.waitingCall ??= { callId: session.callId, providerSessionId: session.providerSessionId, epoch: session.epoch };
            this.notices.clear();
          }
          this.root.querySelector('.voice-caption').textContent = '';
        }
        if (event.type === 'ended') {
          this.retryConnecting = false; this.retryAt = 0;
          if (event.reason === 'provider-end') this.endedCall = { callId: session.callId, providerSessionId: session.providerSessionId };
          this.notices.clear();
          this.stopHeartbeat?.(); clearInterval(this.meter); this.session = null; this.journal?.clear();
          this.busy = false; this.pauseCommand = null; this.beating = false; this.hidePending = false; this.playbackBlocked = false;
          this.quiet(); this.onEnd?.();
          this.state = ['closed', 'cancelled', 'closure-uncertain', 'provider-end'].includes(event.reason) ? 'idle' : 'failed';
          this.errorKey = event.reason === 'provider-end' ? 'voiceClosureUncertain' : event.reason === 'recovery-failed' ? 'voiceRecoveryFailed' :
            event.reason === 'closure-uncertain' ? 'voiceClosureUncertain' :
            event.reason.includes('deadline') ? 'voiceDeadline' : this.state === 'failed' ? 'voiceConnectionFailed' : null;
          this.root.querySelector('.voice-caption').textContent = '';
          if (event.reason === 'provider-end' && event.terminal) this.settlement({ callId: session.callId, providerSessionId: session.providerSessionId, terminal: event.terminal });
        }
        this.render();
      }
    } catch (error) { if (this.current(session, generation)) { this.failure(error); await this.close(); } }
  }
  async pause(paused) {
    if (!paused && (this.usedUp?.() || this.ending?.() || this.allowanceDenied)) return;
    if (!paused && (this.moved || this.requiresTakeover)) return this.start();
    if (!this.session || this.busy && !paused && !this.pauseCommand || this.pauseCommand?.paused === paused || this.paused === paused && !this.busy) {
      if (paused && this.state === 'connecting') { this.pauseRevision++; this.holdController?.abort(); this.hidePending = true; }
      return;
    }
    const session = this.session, generation = this.generation;
    const revision = ++this.pauseRevision;
    this.pauseCommand = { paused, revision };
    if (paused) { this.paused = true; this.retryConnecting = false; this.stopReplyWatch(); this.cooldownController?.abort(); }
    // Repaint the next visitor action while capture retains its acknowledged hold.
    this.onPause?.(Boolean(this.paused));
    const wait = paused ? 0 : Math.max(0, (this.retryAt ?? 0) - Date.now());
    if (wait) { this.retryConnecting = true; this.errorKey = null; }
    this.busy = true; this.render();
    try {
      if (wait) {
        this.cooldownController?.abort();
        const controller = new AbortController(); this.cooldownController = controller;
        await this.cooldown(Date.now() + wait, controller.signal);
      }
      if (!this.current(session, generation) || revision !== this.pauseRevision) return;
      if (!paused) this.retryAt = 0;
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
        this.retryConnecting = false; this.busy = false; this.pauseCommand = null; this.onPause?.(Boolean(this.paused)); this.render(); this.settle();
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
  async sendText(text, options) {
    if (!this.session || this.paused || this.state === 'recovering' || !this.capability('sendText')) throw new Error('Voice text unavailable');
    this.notices.clear();
    const session = this.session, generation = this.generation;
    this.awaitReply(session, generation);
    try { return await session.sendText(text, options); }
    catch (error) { if (this.current(session, generation)) this.stopReplyWatch(); throw error; }
  }
  async updateContext() {
    if (!this.session || this.paused || !this.capability('updateContext')) return;
    await this.session.updateContext(this.context());
  }
  async retryPlayback() {
    if (!this.session && this.state !== 'connecting') return;
    const session = this.session, generation = this.generation;
    try {
      await this.playback?.();
      if (!this.current(session, generation)) return;
      const media = this.client?.ports?.browserMedia;
      if (!session && this.playbackRetry) await this.playbackRetry();
      else if (media?.retryPlayback) await media.retryPlayback(session);
      else await session?.retryPlayback?.();
      if (!this.current(session, generation)) return;
      this.playbackBlocked = false; this.errorKey = null;
    } catch { if (this.current(session, generation)) { this.playbackBlocked = true; this.errorKey = 'voicePlaybackBlocked'; } }
    if (this.current(session, generation)) this.render();
  }
  reportPlaybackBlocked() {
    if (!this.session && this.state !== 'connecting') return;
    this.playbackBlocked = true; this.errorKey = 'voicePlaybackBlocked'; this.render();
  }
  // A ledger receipt belongs to the ended identity captured before its request.
  // A newer Start clears that identity, even when startup subsequently fails.
  settleLedger(ended) {
    if (!ended || ended !== this.endedCall || ended.settled || this.session || this.state !== 'idle') return;
    ended.settled = true;
    if (this.errorKey === 'voiceClosureUncertain') this.errorKey = 'voiceEnded';
    this.render();
  }
  settlement(data) {
    const ended = this.endedCall;
    if (this.session || !ended || data.callId !== ended.callId || data.providerSessionId !== ended.providerSessionId ||
      data.terminal?.closureConfirmed !== true || !data.terminal.usage || data.terminal.usage.costEstimated === true) return;
    const measured = data.terminal.usage.visitorDurationSource === 'aithema-measured';
    if (ended.settled && (!measured || ended.visitorDurationSource === 'aithema-measured')) return;
    if (measured) ended.visitorDurationSource = 'aithema-measured';
    ended.settled = true;
    if (this.errorKey === 'voiceClosureUncertain') this.errorKey = 'voiceEnded';
    this.render();
  }
  close(reason) {
    const returnFocus = this.button('close').getRootNode().activeElement === this.button('close');
    this.client?.stopReplay?.(); this.stopReplyWatch(); this.cooldownController?.abort();
    if (this.closing && !this.session && this.state !== 'connecting') {
      if (reason) void this.closingSession?.close({ reason }).catch(() => {});
      return this.closing;
    }
    const waiting = this.waitingCall;
    const session = this.session ?? (waiting && this.client?.closeWaiting ? { ...waiting,
      close: options => this.client.closeWaiting(waiting, options) } : null);
    this.closingSession = session;
    const generation = ++this.generation;
    this.takeoverController?.abort();
    this.pauseRequests.clear(); this.resumeRequests.clear(); this.pauseCommand = null;
    // A restored Resume has capture guards but no returned session yet. Fence
    // startup before its late acknowledgement or the waiting-call POST can run.
    if (!this.session) { this.holdController?.abort(); this.controller?.abort(); }
    this.stopHeartbeat?.(); clearInterval(this.meter); this.quiet();
    this.endedCall = session ? { callId: session.callId, providerSessionId: session.providerSessionId } : null;
    this.session = null; this.waitingCall = null; this.requiresTakeover = false; this.moved = false; this.retiredOwnership = null;
    this.startupPhase = null; this.retryConnecting = false; this.retryAt = 0; this.hidePending = false; this.paused = false; this.busy = false; this.beating = false; this.playbackBlocked = false; this.state = 'idle';
    this.notices.clear();
    this.errorKey = session ? 'voiceClosureUncertain' : null;
    if (reason?.includes('deadline')) { this.state = 'failed'; this.errorKey = 'voiceDeadline'; }
    this.root.querySelector('.voice-caption').textContent = ''; this.render();
    if (returnFocus) this.button('start').focus({ preventScroll: true });
    this.onEnd?.();
    const controller = this.controller;
    const closing = (async () => {
      try {
        const terminal = await session?.close({ deadlineAt: Date.now() + 45_000, reason: reason ?? 'closed' });
        if (generation !== this.generation) return;
        if (session) {
          this.journal?.clear();
          this.settlement({ callId: session.callId, providerSessionId: session.providerSessionId, terminal });
        }
        if (session && !reason?.includes('deadline') && !this.endedCall?.settled) this.errorKey =
          terminal?.closureConfirmed && !terminal.usage?.costEstimated ? 'voiceEnded' : 'voiceClosureUncertain';
      } catch { /* Local hangup is complete; the durable server lease and journal retain unresolved closure. */ }
      finally { controller?.abort(); if (generation === this.generation) this.render(); }
    })().finally(() => { if (this.closing === closing) { this.closing = null; this.closingSession = null; } });
    this.closing = closing; return closing;
  }
  quiet() { if (!['listening', 'speaking', 'thinking'].includes(this.state)) { this.stopReplyWatch(); this.cooldownController?.abort(); } delete this.root.dataset.measured; this.waveform.baseline(); if (this.connected) this.onLevel?.(0); }
  connect() {
    this.connected = true; this.root.ownerDocument.addEventListener('visibilitychange', this.visibility); this.waveform.connect();
    this.root.ownerDocument.defaultView?.addEventListener('pagehide', this.pagehide);
    this.observeLabel();
  }
  disconnect() {
    this.client?.stopReplay?.();
    this.connected = false; this.root.ownerDocument.removeEventListener('visibilitychange', this.visibility); this.waveform.destroy(); this.labelSizes?.disconnect();
    this.root.ownerDocument.defaultView?.removeEventListener('pagehide', this.pagehide);
    if (this.session || this.takeoverController || this.state === 'connecting') void this.close();
  }
  destroy() {
    this.onState = null; this.onRender = null; this.onLevel = null; this.disconnect();
  }
}
