import { ConceptView } from './concept-view.js';
import './html-preview.js'; // <aithema-html-preview>, the concept viewer's stage for drafts
import { applyEvent, inputRevision, activeTurns } from '../../core/src/session.js';
import { understandingDeferred } from '../../core/src/document-context.js';
import { aiTextOrigin } from '../../core/src/text-origin.js';
import { readinessScalePercent, readinessListItems, readinessListWindow, newlyClearedFirst } from '../../core/src/readiness.js';
import { displayedReadinessPercent } from '../../core/src/understanding.js';
import { FEATURES, deviceFeatures } from '../../core/src/presets.js';
import { SETTINGS_OFF, isDynamicReason, isConsentReason } from '../../core/src/settings.js';
import { aiNotice } from '../../core/src/ai-notice.js';
import { AudioRail } from './audio-rail.js';
import { styles } from './styles.js';
import { settingsStyles } from './settings-styles.js';
import { SettingsDialog, ICONS, PRESET_ORDER, reasonText, engineView, catalogLabel } from './settings-dialog.js';
import { LocalConnector } from './local-connector.js';
import { postJson, postForm, sameOrigin } from './post-json.js';
import { UPLOAD_LIMITS, UPLOAD_ACCEPT, UPLOAD_ICONS, uploadLimits, planUploads, refusalText, uploadStateText, uploadStateTexts, uploadsPossible, formatBytes, plural, limitsText, dropText } from './uploads.js';
import { voiceJournal, tabStorage, closeVoiceCall, answerVoicePings, voiceCallAbandoned } from './voice-orphan.js';
import { node, setText, reconcile } from './dom.js';
import { HostSurface } from './host-surface.js';
import { hostStyles } from './host-styles.js';
import { entranceStyles } from './entrance-styles.js';
import { orbStyles, createOrb } from './orb.js';
import { icon } from './icons.js';

const PANES = '.transcript-shell, .analysis-content, .preset-panel';
function clearSlack(pane) { pane.style.removeProperty('--aithema-slack-top'); pane.style.removeProperty('--aithema-slack-bottom'); }
// Empty space below a pane's content: padding fills it before it adds any scroll room.
function spareSpace(pane) {
  const last = pane.lastElementChild; if (!last) return 0;
  const end = last.getBoundingClientRect().bottom + parseFloat(getComputedStyle(last).marginBottom) + parseFloat(getComputedStyle(pane).paddingBottom);
  return Math.max(0, pane.getBoundingClientRect().top + pane.clientTop + pane.clientHeight - end);
}
// Server-sent events from a fetch body, one parsed event at a time.
async function* serverEvents(reader) {
  let buffer = ''; const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read(); if (done) return;
    buffer += decoder.decode(value, { stream: true });
    if (buffer.length > 2_000_000) throw new Error('Event stream too large');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('\n');
      if (data) yield JSON.parse(data);
    }
  }
}
const NONE = '\u0000none';
function reconnectDelay(signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, 1000); signal.addEventListener('abort', finish, { once: true });
  });
}
// Repeated values get distinct keys by occurrence.
function textKeys(values) {
  const seen = new Map();
  return values.map(value => { const n = seen.get(value) ?? 0; seen.set(value, n + 1); return [`${value}\u0000${n}`, value]; });
}

export class AithemaSession extends HTMLElement {
  #concept; #rail; #voiceClient; #voiceClients; #voicePlayback; #deviceReasoning; #deviceController; #copy; #session; #sessionToken; #abort; #cursor = 0; #invalidatedAt = 0; #base; #partials = new Map(); #reasoningRevision = 0; #pending;
  #open = []; #cleared = []; #failure = false; #sending = false;
  #pointer = null; #onTranscript = false; #follow = true; #connection = ''; #notice = ''; #journal; #orphan; #pings; #pausePrompt = false;
  #dialog; #connector; #createDevice; #deviceEndpoint; #chooser = { choice: null, busy: false, error: '' }; #aiNotice; #host; #options; #refocus = null;
  #orb = null; #started = false; #inputMode = null; #microphone = 'unknown'; #permission = null;
  #uploadAt = new Map(); #uploading = false; #uploadNotice = ''; #reading = ''; #limits = UPLOAD_LIMITS; #limitsLoad = null; #dragDepth = 0;
  constructor() {
    super(); this.attachShadow({ mode: 'open' });
    // Track the resting pointer so updates can keep the element under it in place.
    this.addEventListener('pointermove', e => { this.#pointer = { x: e.clientX, y: e.clientY }; }, { passive: true });
    this.addEventListener('pointerleave', () => {
      this.#pointer = null;
      for (const pane of this.shadowRoot.querySelectorAll(PANES)) clearSlack(pane);
    });
  }
  /**
   * `deviceConnector` is the browser device plugin factory for the settings Advanced tab;
   * `voiceClients` maps host voice option ids to browser clients (else `voiceClient`).
   * `aiNotice` ({text?, voice?}) rewords the AI notice ahead of `copy.aiNotice`; it cannot remove it.
   * `host` ({library, verification, handover, credits, locale}) turns on the host surface (AIT-104 B2):
   * the conversation library, email verification, handover and credits; see the README.
   */
  configure(options) {
    const { copy, baseUrl = '', session, sessionToken, deviceReasoning, deviceConnector, deviceEndpoint, voiceClient, voiceClients, voicePlayback, aiNotice } = options ?? {};
    if (!copy || !session) throw new TypeError('Host copy and session required');
    this.#aiNotice = aiNotice; this.#options = { ...options }; delete this.#options.session;
    this.#host?.destroy(); this.#host = null;
    const reopen = this.#dialog?.open;
    this.#concept?.destroy(); this.#rail?.destroy(); this.#rail = null; this.#orb?.destroy(); this.#orb = null; this.#voiceClient = voiceClient; this.#voiceClients = voiceClients; this.#voicePlayback = voicePlayback;
    this.#abort?.abort(); this.#deviceController?.abort(); this.#deviceReasoning = deviceReasoning; this.#copy = copy; this.#base = baseUrl.replace(/\/$/u, '');
    // The local connection belongs to this tab, not to a conversation: it survives a new session.
    if (deviceConnector !== this.#createDevice || deviceEndpoint !== this.#deviceEndpoint) {
      this.#connector?.clear();
      this.#connector = deviceConnector ? new LocalConnector({ copy, create: deviceConnector, endpoint: deviceEndpoint,
        onChange: () => { this.#render('features'); this.#render('transcript'); this.#dialog?.sync(); } }) : null;
    }
    this.#createDevice = deviceConnector; this.#deviceEndpoint = deviceEndpoint;
    this.#session = structuredClone(session); this.#sessionToken = sessionToken; this.#cursor = session.seq; this.#partials.clear(); this.#reasoningRevision = 0;
    this.#restoreFailure(); this.#pending = null; this.#sending = false;
    this.#invalidatedAt = 0; this.#chooser = { choice: null, busy: false, error: '' }; this.#started = false; this.#inputMode = null;
    this.#open = []; this.#cleared = []; this.#follow = true; this.#onTranscript = false; this.#notice = ''; this.#connection = '';
    this.#uploadAt.clear(); this.#uploading = false; this.#uploadNotice = ''; this.#reading = ''; this.#limits = UPLOAD_LIMITS; this.#limitsLoad = null; this.#dragDepth = 0;
    // A page that loads paused stays paused until the person resumes it (AIT-116 D4).
    this.#pausePrompt = Boolean(session.paused);
    // Every conversation keeps a journal: a choice at conversation start can switch it out of
    // On my device in place, and a device conversation never starts a call, so its journal stays empty.
    this.#journal = voiceJournal(tabStorage(), session.id);
    this.#mount();
    this.#pings ??= answerVoicePings(() => this.#rail?.session?.callId ?? null);
    this.#orphan = this.#endOrphanedCall();
    if (this.isConnected) { this.#connect(); this.#watchPage(true); this.#offerResume(); this.#host?.connect(); }
    if (reopen) this.shadowRoot.querySelector('.settings-open').focus();
    if (this.#refocus) { this.shadowRoot.querySelector(this.#refocus)?.focus(); this.#refocus = null; }
  }
  connectedCallback() {
    if (!this.#session) return;
    this.#pings ??= answerVoicePings(() => this.#rail?.session?.callId ?? null);
    this.#concept?.connect(); this.#connect(); this.#watchPage(true); this.#offerResume(); this.#host?.connect(); this.#orb?.mount();
  }
  disconnectedCallback() {
    this.#host?.disconnect(); this.#watchPage(false); this.#concept?.suspend(); this.#rail?.destroy(); this.#orb?.destroy(); this.#abort?.abort(); this.#deviceController?.abort();
    this.#pings?.close(); this.#pings = null;
  }
  reportVoicePlaybackBlocked() { this.#rail?.reportPlaybackBlocked(); }
  get session() { return structuredClone(this.#session); }
  // A visitor-connected local model takes precedence over a host-supplied device client.
  get #device() { return this.#connector?.client ?? this.#deviceReasoning; }
  #voiceClientFor(session = this.#session) {
    const voice = engineView(session).voice;
    return this.#voiceClients?.[voice?.id] ?? this.#voiceClient;
  }
  /** Opens the settings dialog; `preset` preselects a preset (the chooser's Custom path). */
  openSettings(opener = this.shadowRoot.querySelector('.settings-open'), { tab = 'model', continueLabel = false, preset } = {}) {
    this.#dialog.open(opener, { tab, continueLabel, preset });
  }
  #mount() {
    const root = this.shadowRoot;
    // Static trusted markup only. All host/model/user copy is assigned through textContent.
    // START's shell (app.css .shell, index.astro .v2__workspace): a top row, the conversation and,
    // once there is input, the understanding beside it. The entrance (promise, orb and processing
    // choice, then readiness) fills the conversation column until the conversation starts.
    root.innerHTML = `<style>${styles}${orbStyles}${entranceStyles}${settingsStyles}${hostStyles}</style><div class="workspace" data-stage="entrance" data-understanding="absent">
      <header class="toolbar"><section class="preset-panel"><div class="engine"><div class="engine__text"><span class="engine__label" data-copy="processing"></span>
          <strong class="engine__value"></strong><span class="engine__detail"></span></div></div><ul class="features"></ul></section>
        <div class="host-bar" role="group" hidden><button class="library-open-dialog" type="button" aria-haspopup="dialog" hidden></button>
          <div class="host-verify"></div><div class="host-account"><slot name="account"></slot></div>
          <p class="host-credits" hidden><span class="host-credits__text"></span> <span class="host-credits__limit" hidden><slot name="credits-limit"></slot></span></p></div>
        <button class="settings-open" type="button" aria-haspopup="dialog">${icon('settings')}<span class="visually-hidden"></span></button></header>
      <section class="conversation" aria-labelledby="conversation-title"><header class="head"><h2 class="visually-hidden" id="conversation-title" data-copy="conversation"></h2>
          <p class="ai-notice"><span id="ai-notice"></span><span class="ai-notice__sizer" aria-hidden="true"></span></p><span class="status" role="status"></span></header>
        <div class="intro" hidden><div class="intro__prompt"><div class="intro__orb"></div><div class="intro__promise"><slot name="promise"><h2 class="promise"></h2><p class="promise__lead"></p></slot></div></div>
          <div class="intro__card"></div></div>
        <div class="audio-rail"></div><div class="concept-bar"><div class="concept-rail"></div><div class="concept-preview-slot"></div></div>
        <div class="transcript-shell"><ol aria-live="polite"></ol><button class="transcript-latest" type="button" data-copy="transcriptLatest" style="visibility:hidden"></button></div>
        <form class="composer"><label for="message" data-copy="composer"></label><textarea id="message" maxlength="8000" rows="2"></textarea>
          <div class="composer-actions"><button class="attach" type="button" aria-describedby="attach-limits ai-notice">${UPLOAD_ICONS.attach}<span class="attach__label"></span></button>
            <span class="sr-only" id="attach-limits"></span><input class="attach-input" type="file" multiple hidden tabindex="-1" accept="${UPLOAD_ACCEPT}">
            <small class="composer-reason" role="status" id="composer-reason"></small><button class="send" aria-describedby="ai-notice">${icon('arrowRight')}<span class="visually-hidden"></span></button></div></form>
        <div class="drop-overlay" aria-hidden="true"><p><strong></strong><span></span></p></div></section>
      <aside class="understanding" aria-labelledby="understanding-title"><header class="head"><h2 id="understanding-title" data-copy="understanding"></h2><button class="concept-tab" type="button" data-copy="conceptTab"></button></header>
        <section class="readiness"><div class="scale" role="progressbar" aria-valuemin="0" aria-valuemax="100"><span class="fill"></span><span class="marker"></span></div>
          <div class="scale-labels" aria-hidden="true"><span data-copy="talk"></span><span data-copy="build"></span></div><p class="talk-progress"></p><p class="build-progress"></p></section>
        <div class="analysis-content"><p class="notice" role="status"></p><div class="verify-lock" hidden></div><section class="summary"><h3 data-copy="summary"></h3><p class="summary-text"></p></section>
          <section><h3 data-copy="signals"></h3><ul class="signals"></ul></section><section><h3 data-copy="questions"></h3><ul class="questions"></ul></section>
          <section><h3 data-copy="missing"></h3><ul class="missing"></ul><p class="overflow"></p></section>
          <section><div class="cleared-head"><h3 data-copy="clarified"></h3><button class="expand" type="button"></button></div><div class="cleared"></div></section></div>
        <section class="handover" aria-labelledby="handover-title" hidden><h3 id="handover-title"></h3><p class="handover__offer"><slot name="handover-offer"></slot></p>
          <div class="handover__row"><button class="handover-request" type="button" aria-describedby="handover-state"></button><p class="handover__state" id="handover-state" role="status"></p></div></section>
        <footer class="foot"><a class="export">${icon('download')}<span data-copy="export"></span></a><button class="retry" type="button" data-copy="retry" hidden></button></footer></aside>
      <footer class="host-foot" hidden><slot name="legal"></slot><slot name="footer"></slot></footer></div>
      <dialog class="settings"></dialog><dialog class="library"></dialog><dialog class="verify-dialog"></dialog>`;
    // The promise is host content when the host slots it; otherwise START's three lines (contract: AIT-128/129).
    const promise = root.querySelector('.promise');
    for (const [index, line] of (this.#copy.entrance?.promise ?? []).entries()) { if (index) promise.append(' '); promise.append(node('span', '', line)); }
    root.querySelector('.promise__lead').textContent = this.#copy.entrance?.lead ?? '';
    root.querySelector('.send .visually-hidden').textContent = this.#copy.send;
    root.querySelector('.settings-open span').textContent = this.#copy.settings.open; root.querySelector('.settings-open').title = this.#copy.settings.open;
    root.querySelector('.settings-open').addEventListener('click', event => this.openSettings(event.currentTarget));
    this.#dialog = new SettingsDialog({ dialog: root.querySelector('dialog.settings'), copy: this.#copy, ports: {
      // Withdrawn turns still mark a started conversation (the server's device lock agrees).
      state: () => ({ session: this.#session, voiceActive: Boolean(this.#rail?.session), hasTurns: this.#session.transcript.length > 0 || this.#partials.size > 0,
        running: this.#session.operations?.inputRevision === inputRevision(this.#session) && (this.#session.operations?.running?.length ?? 0) > 0,
        consent: this.#consentState() }),
      catalog: () => this.#loadCatalog(), save: body => this.#saveSettings(body),
      endCall: () => this.#rail.close(), connector: this.#connector,
      newConversation: detail => this.#newConversation(detail), consent: (reason, features) => this.#requestConsent(reason, features),
      // The re-rendered twin of a replaced opener, else the settings button, which is never replaced.
      focusFallback: opener => [...root.querySelectorAll('[data-focus-key]')].find(node => opener?.dataset?.focusKey && node.dataset.focusKey === opener.dataset.focusKey &&
        !node.closest('[hidden]')) ?? root.querySelector('.settings-open'),
    } });
    this.#concept = new ConceptView({ root, copy: this.#copy, baseUrl: this.#base, sessionToken: this.#sessionToken,
      // The host's visual kind decides which feature verdict gates requests: images or clickable drafts.
      receive: event => this.receive(event), feature: () => this.#feature(this.#session.conceptVisualKind === 'html' ? 'html' : 'images', true) });
    this.#concept.update(this.#session);
    this.#render('features');
    for (const node of root.querySelectorAll('[data-copy]')) node.textContent = this.#copy[node.dataset.copy];
    root.querySelector('.transcript-latest').addEventListener('click', () => this.#scrollToLatest());
    root.querySelector('textarea').setAttribute('aria-describedby', 'composer-reason ai-notice');
    root.querySelector('.scale').setAttribute('aria-label', `${this.#copy.talk} — ${this.#copy.build}`);
    this.#renderMode();
    root.querySelector('.export').addEventListener('click', e => {
      if (!this.#sessionToken || this.#session.processingPreset === 'device') return;
      e.preventDefault(); void this.#export();
    });
    root.querySelector('form').addEventListener('submit', e => { e.preventDefault(); void this.#send(); });
    root.querySelector('textarea').addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); void this.#send(); }
    });
    root.querySelector('textarea').addEventListener('input', () => { if (this.#uploadNotice) { this.#uploadNotice = ''; this.#render('composer'); } });
    this.#mountUploads();
    root.querySelector('.expand').addEventListener('click', () => {
      const details = [...root.querySelectorAll('.cleared details')];
      const expand = !details.every(d => d.open);
      details.forEach(d => { d.open = expand; }); this.#expandLabel();
    });
    root.querySelector('.retry').addEventListener('click', async () => {
      if (!this.#feature('analysis').available) return;
      try {
        const response = await postJson(`${this.#base}/api/sessions/${this.#session.id}/retry`, {}, { sessionToken: this.#sessionToken });
        if (!response.ok) throw new Error(); this.#failure = false; this.#render('aside');
      } catch { this.#status(this.#copy.reasoningFailed); }
    });
    this.#rail = new AudioRail({ root: root.querySelector('.audio-rail'), copy: this.#copy, client: this.#voiceClientFor(),
      feature: () => this.#feature('voice', true), playback: this.#voicePlayback, journal: this.#journal ?? undefined,
      ready: () => this.#orphan, onLevel: level => this.#orb?.setEnergy(level),
      // A call that starts, ends or fails moves the stage and the avatar with it.
      onState: state => { this.#orb?.setVoice(state); this.#clearNotice(); this.#render('transcript'); this.#render('composer'); },
      context: () => ({ understanding: this.#session.understanding, focusedQuestion: this.#session.focusedQuestion ?? null }),
      onEnd: () => {
        if (this.#pending) { delete this.#pending.voiceCallId; delete this.#pending.providerSessionId; }
      },
      onPause: paused => {
        this.#session.paused = paused; this.#clearNotice();
        this.#render('features'); this.#render('composer'); this.#render('aside');
        if (this.isConnected) void this.#refreshFeatures();
      } });
    // Screen readers hear the AI notice with every control that begins an interaction (Art. 50(1)),
    // after the control's own description: here Start and Retry call, the composer above, and the
    // chooser and ready card where they are built.
    for (const name of ['start', 'retry']) root.querySelector(`.voice-${name}`).setAttribute('aria-describedby', 'ai-notice');
    // One pause for the conversation and its call, in the rail's pause cell (START's single capsule):
    // it drives the call when one runs and the acknowledged conversation pause otherwise.
    const pause = node('button', 'pause'); pause.type = 'button';
    pause.innerHTML = `<span class="voice-icon">${icon('pause')}</span><span class="voice-icon voice-icon--resume">${icon('play')}</span><span class="voice-label"></span>`;
    root.querySelector('.voice-cell--pause').prepend(pause); root.querySelector('.audio-rail').tabIndex = -1;
    root.querySelector('.pause').addEventListener('click', async () => {
      const button = root.querySelector('.pause');
      if (this.#rail.session) { await this.#rail.pause(!this.#session.paused); return; }
      button.disabled = true;
      try { await this.#setPaused(!this.#session.paused); }
      finally { button.disabled = false; }
    });
    // Updates render at once (AIT-116 D2). Fixed outer sizes and internal scrolling keep
    // composer/export targets stable; #anchored keeps the element under the pointer in place.
    const shell = root.querySelector('.transcript-shell');
    shell.addEventListener('scroll', () => {
      this.#follow = shell.scrollTop + shell.clientHeight >= shell.scrollHeight - 8;
      if (this.#follow) root.querySelector('.transcript-latest').style.visibility = 'hidden';
    }, { passive: true });
    shell.addEventListener('pointerenter', () => { this.#onTranscript = true; });
    shell.addEventListener('pointerleave', () => {
      this.#onTranscript = false;
      if (this.#follow) this.#scrollToLatest();
    });
    for (const pane of root.querySelectorAll(PANES)) pane.addEventListener('pointerleave', () => clearSlack(pane));
    if (this.#options.host) this.#host = new HostSurface({ root, copy: this.#copy, options: this.#options.host, baseUrl: this.#base, sessionToken: this.#sessionToken,
      session: () => this.#session, status: text => this.#status(text), adopt: (session, reason) => this.#adopt(session, reason),
      onLock: () => this.#render('aside'),
      // Unlocking keeps a deliberate pause: Resume is offered, else the composer takes focus.
      focusAfterUnlock: () => { const input = root.querySelector('textarea'); (this.#session.paused || input.disabled ? root.querySelector('.pause') : input).focus(); } });
    this.#render('transcript'); this.#render('aside'); this.#render('composer');
  }
  // A conversation from the library (open, new, reset, or the replacement of a deleted one). The host
  // usually handles it (its voice clients belong to one conversation); otherwise this element switches.
  #adopt(session, reason) {
    const event = new CustomEvent('aithema-open-conversation', { detail: { session: structuredClone(session), reason, previousSessionId: this.#session.id },
      bubbles: true, composed: true, cancelable: true });
    this.#refocus = '.library-open-dialog';
    if (this.dispatchEvent(event)) this.configure({ ...this.#options, session });
  }
  async #setPaused(paused) {
    const sessionId = this.#session.id;
    try {
      const response = await postJson(`${this.#base}/api/sessions/${sessionId}/pause`, { paused }, { sessionToken: this.#sessionToken });
      if (!response.ok) throw new Error();
      const ack = await response.json();
      if (sessionId === this.#session.id) this.receive(ack.event);
    } catch { if (sessionId === this.#session.id) this.#status(this.#copy.controlFailed); }
  }
  // A reload cannot drive the call the previous page started. End it through the
  // owner-authenticated close route only when it is provably abandoned; otherwise (another
  // live tab answers, or there is no BroadcastChannel) the server lease ends it. A pause
  // is never lifted here: the person resumes with one click on the focused Resume.
  async #endOrphanedCall() {
    const record = this.#journal?.read(), sessionId = this.#session.id;
    if (!record) return;
    try {
      const abandoned = await voiceCallAbandoned(record.callId);
      if (sessionId !== this.#session.id) return;
      if (!abandoned) { this.#journal.clear(); return; }
      const response = await closeVoiceCall({ baseUrl: this.#base, sessionId, sessionToken: this.#sessionToken, record, reason: 'page-reloaded' });
      if ((response.ok || response.status === 404) && sessionId === this.#session.id) this.#journal.clear();
    } catch { /* The server lease still ends the call; Start reports a conflict precisely. */ }
  }
  #offerResume() {
    if (this.#pausePrompt && this.#session.paused) this.shadowRoot.querySelector('.pause')?.focus();
  }
  #pagehide = () => {
    const record = this.#journal?.read();
    if (!record || !this.#rail?.session) return;
    this.#rail.unloading = true;
    void closeVoiceCall({ baseUrl: this.#base, sessionId: this.#session.id, sessionToken: this.#sessionToken, record, reason: 'page-hidden' }).catch(() => {});
  };
  #pageshow = () => { if (this.#rail) this.#rail.unloading = false; };
  #watchPage(on) {
    const view = this.ownerDocument.defaultView, listen = on ? 'addEventListener' : 'removeEventListener';
    view?.[listen]('pagehide', this.#pagehide); view?.[listen]('pageshow', this.#pageshow);
  }
  // The status line shows the latest action until the connection, pause or call state changes.
  #status(value) { this.#notice = value; this.#paintStatus(); }
  #connectionStatus(value) { this.#connection = value; this.#notice = ''; this.#paintStatus(); }
  #clearNotice() { this.#notice = ''; this.#paintStatus(); }
  #paintStatus() {
    const node = this.shadowRoot?.querySelector('.status'); if (!node) return;
    node.textContent = this.#notice || (this.#session.paused ? this.#pausePrompt ? this.#copy.pausedResume : this.#copy.paused : this.#connection);
  }
  #scrollToLatest() {
    const shell = this.shadowRoot.querySelector('.transcript-shell');
    shell.scrollTop = shell.scrollHeight; this.#follow = true;
    this.shadowRoot.querySelector('.transcript-latest').style.visibility = 'hidden';
  }
  #hovered() {
    const point = this.#pointer;
    return point ? this.shadowRoot.elementFromPoint?.(point.x, point.y) ?? null : null;
  }
  // Scroll anchoring done by hand (panes set overflow-anchor:none): keep the element under
  // a resting pointer at the same viewport position while content above it changes. Keyed
  // nodes survive updates, so this is the hovered element itself, not a surviving parent.
  // When a pane cannot scroll far enough, temporary padding (slack) makes room until the
  // pointer leaves. Slack is derived afresh on every update, so it never accumulates.
  #anchored(update) {
    const hovered = this.#hovered();
    if (!hovered) { update(); return; }
    // Host content in a slot belongs to the page: its chain ends at the document, never at this root.
    const chain = [];
    for (let node = hovered; node?.nodeType === 1; node = node.parentNode) chain.push([node, node.getBoundingClientRect().top]);
    update();
    const [node, top] = chain.find(([n]) => n.isConnected && n.getRootNode() === this.shadowRoot) ?? [];
    const pane = node?.closest?.(PANES);
    if (!pane) return;
    const slack = { top: 0, bottom: 0 };
    const apply = () => {
      for (const side of ['top', 'bottom']) {
        if (slack[side] > 0) pane.style.setProperty(`--aithema-slack-${side}`, `${slack[side]}px`);
        else pane.style.removeProperty(`--aithema-slack-${side}`);
      }
    };
    apply();
    // Bottom slack first fills any spare space, then adds scroll room; measure until it holds.
    for (let round = 0; round < 4; round++) {
      const delta = node.getBoundingClientRect().top - top;
      if (Math.abs(delta) < .5) return;
      const target = pane.scrollTop + delta, max = pane.scrollHeight - pane.clientHeight;
      if (target < 0) slack.top += -target;
      else if (target > max) slack.bottom += target - max + (max < 1 ? spareSpace(pane) : 0);
      apply(); pane.scrollTop = Math.max(0, target);
    }
  }
  #headers(headers = {}) {
    return { ...headers, ...(this.#sessionToken ? { 'x-aithema-session-token': this.#sessionToken } : {}) };
  }
  async #export() {
    const sessionId = this.#session.id;
    let url;
    try {
      const response = await fetch(`${this.#base}/api/sessions/${sessionId}/export`, { headers: this.#headers() });
      if (!response.ok) throw new Error();
      const blob = await response.blob();
      if (sessionId !== this.#session.id) return;
      url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = 'aithema-session.zip'; link.click();
    } catch { if (sessionId === this.#session.id) this.#status(this.#copy.controlFailed); }
    finally { if (url) URL.revokeObjectURL(url); }
  }
  #feature(feature, visitor = false) {
    const preset = this.#session.processingPreset ?? 'best';
    if (this.#session.paused) return { available: false, reason: this.#copy.paused };
    if (this.#session.consentWithdrawn || this.#session.tombstone) return { available: false, reason: this.#copy.consentRequired };
    const matrix = this.#session.featureMatrix?.[preset] ?? (preset === 'device' ? deviceFeatures() : {});
    const value = matrix[feature] ?? { available: false, reason: this.#copy.notConfigured };
    // Shown verdicts speak the page language; decisions keep the server's machine reasons.
    return visitor ? { ...value, reason: reasonText(this.#copy, value.reason) } : value;
  }
  // The visitor's consent position for the acknowledged choice, from the server verdicts.
  #consentState() {
    if ((this.#session.processingPreset ?? 'best') === 'device') return 'device';
    if (this.#session.consentWithdrawn) return 'withdrawn';
    const matrix = this.#session.featureMatrix?.[this.#session.processingPreset ?? 'best'] ?? {};
    return FEATURES.some(feature => isConsentReason(matrix[feature]?.reason)) ? 'missing' : 'granted';
  }
  // Mode-dependent controls; a choice made at conversation start can switch the mode in place.
  #renderMode() {
    const exported = this.shadowRoot.querySelector('.export'), device = this.#session.processingPreset === 'device';
    if (device) { exported.removeAttribute('href'); exported.setAttribute('aria-disabled', 'true'); exported.title = this.#copy.deviceExportUnavailable; }
    else { exported.href = `${this.#base}/api/sessions/${this.#session.id}/export`; exported.removeAttribute('aria-disabled'); exported.title = ''; }
    if (this.#rail) { const client = this.#voiceClientFor(); if (!this.#rail.session && this.#rail.client !== client) { this.#rail.client = client; this.#rail.render(); } }
  }
  async #loadCatalog() {
    const sessionId = this.#session.id;
    const response = await fetch(`${this.#base}/api/sessions/${sessionId}/settings`, { headers: this.#headers() });
    if (!response.ok) throw new Error('Settings unavailable');
    const catalog = await response.json();
    if (sessionId !== this.#session.id) throw new Error('Session changed');
    return catalog;
  }
  /** Sends ids only; the component shows what the server acknowledges. */
  async #saveSettings(body) {
    const sessionId = this.#session.id;
    let response, value = null;
    try { response = await postJson(`${this.#base}/api/sessions/${sessionId}/settings`, body, { sessionToken: this.#sessionToken }); }
    catch { return { ok: false, error: 'network', body: {} }; }
    try { value = await response.json(); } catch { /* A body-less failure is retried by the visitor. */ }
    if (sessionId !== this.#session.id) return { ok: false, error: 'stale', body: {} };
    if (!response.ok || !value) return { ok: false, error: value?.error ?? 'network', body: value ?? {} };
    this.#applySettings(value);
    return { ok: true, ack: value };
  }
  #applySettings(ack) {
    if (ack.event) this.receive(ack.event);
    if (this.#session.settings?.revision === ack.settings.revision && this.#session.processingPreset === ack.processingPreset) {
      this.#session.featureMatrix = ack.featureMatrix; this.#session.engine = ack.engine;
    }
    this.#renderMode();
    this.#render('features'); this.#render('composer'); this.#render('aside'); this.#render('transcript'); this.#rail.render();
  }
  #modeChanged(before) {
    if (this.#session.processingPreset === 'device') { this.#abort?.abort(); this.#abort = null; }
    else if (before === 'device' && this.isConnected) this.#connect();
  }
  #newConversation({ processingPreset, settings }) {
    this.#dialog.close();
    this.dispatchEvent(new CustomEvent('aithema-new-conversation', { detail: { processingPreset, settings: structuredClone(settings ?? {}),
      previousSessionId: this.#session.id }, bubbles: true, composed: true }));
  }
  #requestConsent(reason, features = FEATURES.filter(f => isConsentReason(this.#feature(f).reason))) {
    // The host's consent interface lies outside this modal dialog.
    this.#dialog.close();
    this.dispatchEvent(new CustomEvent('aithema-consent', { detail: { sessionId: this.#session.id, reason, features: [...features] },
      bubbles: true, composed: true }));
  }
  #restoreFailure() {
    const operations = this.#session.operations;
    this.#failure = operations?.inputRevision === inputRevision(this.#session) && Boolean(operations.lastFailure);
  }
  #render(part) {
    if (['features', 'transcript', 'aside'].includes(part)) { this.#anchored(() => this.#paint(part)); return; }
    this.#paint(part);
  }
  #paint(part) {
    const root = this.shadowRoot, copy = this.#copy;
    this.#paintStatus(); this.#paintNotice();
    const pause = root.querySelector('.pause');
    if (pause) {
      setText(pause.querySelector('.voice-label'), this.#session.paused ? copy.resume : copy.pause); pause.title = pause.textContent;
      pause.setAttribute('aria-pressed', String(this.#session.paused));
    }
    const element = (tag, value, className) => {
      const node = document.createElement(tag); if (value !== undefined) node.textContent = value;
      if (className) node.className = className; return node;
    };
    if (part === 'composer') {
      const text = this.#feature('text', true), input = root.querySelector('textarea');
      input.disabled = !text.available;
      // START's composer: during a call it invites speaking or typing, otherwise the next message.
      input.placeholder = this.#rail?.session ? copy.placeholderVoice ?? copy.placeholder : copy.placeholder;
      root.querySelector('.send').disabled = this.#sending || !text.available;
      const reason = root.querySelector('.composer-reason');
      const mac = /Mac|iPhone|iPad/u.test(globalThis.navigator?.platform ?? '');
      // An upload refusal stands until the person types or attaches again.
      const words = this.#uploadNotice || (text.available ? copy.shortcut.replace('{key}', copy.shortcutKeys?.[mac ? 'mac' : 'other'] ?? '') : text.reason);
      setText(reason, words); reason.title = this.#uploadNotice || text.available ? '' : text.reason;
      this.#paintAttach();
      return;
    }
    if (part === 'features') {
      this.#renderEngine();
      reconcile(root.querySelector('.features'), FEATURES.map(feature => [feature, feature]), () => {
        const row = element('li'); row.append(document.createTextNode('')); return row;
      }, (row, feature) => {
        const value = this.#feature(feature, true);
        row.className = value.available ? '' : 'unavailable'; row.firstChild.nodeValue = copy.features[feature];
        const reason = row.querySelector('span');
        if (value.available) reason?.remove(); else (reason ?? row.appendChild(element('span'))).textContent = value.reason;
      });
      return;
    }
    if (part === 'transcript') {
      this.#renderIntro();
      // Rows are keyed by turn id (uploads by "upload:" and their id) and updated in place: new turns
      // append below, and focus and the hovered row survive updates. Superseded partials lose their rows.
      const list = root.querySelector('ol'), shell = root.querySelector('.transcript-shell');
      const entries = this.#transcriptEntries(this.#session.transcript.filter(t => !t.erased || t.role === 'user'));
      const rows = new Map([...list.children].map(row => [row.dataset.id, row]));
      const hovered = this.#onTranscript, count = list.children.length, kept = new Set(entries.map(entry => entry.key));
      // Rows that go are removed first, so a surviving row never moves past them: moving a node drops its focus.
      for (const [key, row] of rows) if (!kept.has(key)) { row.remove(); rows.delete(key); }
      let next = list.firstElementChild;
      for (const { key, turn: t, upload } of entries) {
        let row = rows.get(key); rows.delete(key);
        if (upload) {
          if (!row) { row = this.#uploadRow(upload.id); row.dataset.id = key; }
          this.#paintUpload(row, upload);
          if (row !== next) list.insertBefore(row, next); else next = next.nextElementSibling;
          continue;
        }
        if (!row) {
          row = element('li'); row.dataset.id = t.id; row.append(element('strong'), element('span'));
        }
        row.className = `turn ${t.role === 'user' ? 'user' : ''} ${t.partial ? 'partial' : ''}`;
        // Redacted rows keep their height only while the pointer rests on the transcript.
        if (!hovered) row.style.minHeight = '';
        row.querySelector('strong').textContent = t.role === 'user' ? copy.you : copy.assistant;
        row.querySelector('span').textContent = t.erased ? copy.withdrawn : t.content;
        // Which acknowledged model and response style produced a reply.
        const engine = t.role === 'assistant' && !t.erased && t.engine?.label ? [catalogLabel(copy, t.engine.label),
          t.engine.effort && t.engine.effort !== 'none' ? copy.settings.efforts[t.engine.effort] ?? t.engine.effort : null].filter(Boolean).join(' · ') : '';
        const tag = row.querySelector('.engine-tag');
        if (engine) (tag ?? row.appendChild(element('small', undefined, 'engine-tag'))).textContent = engine; else tag?.remove();
        const withdrawable = t.role === 'user' && !t.erased;
        if (withdrawable && !row.querySelector('.withdraw')) row.append(this.#withdrawButton(row));
        if (!withdrawable) row.querySelector('.withdraw')?.remove();
        if (row !== next) list.insertBefore(row, next); else next = next.nextElementSibling;
      }
      for (const row of rows.values()) row.remove();
      const grew = list.children.length > count;
      if (this.#follow && !hovered) this.#scrollToLatest();
      else if (this.#follow && grew && shell.scrollHeight > shell.clientHeight) root.querySelector('.transcript-latest').style.visibility = '';
      return;
    }
    const analysis = this.#feature('analysis', true), locked = this.#host?.locked ?? false;
    const cached = this.#session.paused && this.#session.understanding.inputRevision !== null;
    for (const node of root.querySelectorAll('.analysis-content [data-redacted]')) {
      node.style.minHeight = ''; delete node.dataset.redacted;
    }
    // A pane that holds the host's own controls (the verification form, handover) is never marked
    // disabled as a whole: only its unavailable parts are, through the notice and the hidden, inert content.
    const aside = root.querySelector('.understanding');
    if (this.#host?.holdsControls) aside.removeAttribute('aria-disabled'); else aside.setAttribute('aria-disabled', String(!analysis.available));
    // Keep the outer pane and readiness row in the grid when analysis is unavailable.
    // A host verification lock (AIT-104 B2) replaces the assessment in place with the email form.
    root.querySelector('.readiness').style.visibility = !locked && (analysis.available || cached) ? '' : 'hidden';
    root.querySelector('.readiness').toggleAttribute('inert', locked);
    root.querySelector('.notice').hidden = locked;
    const u = this.#session.understanding, stale = u.inputRevision !== inputRevision(this.#session);
    // Sections appear with the first assessment; empty lists then say so quietly (D15).
    for (const section of root.querySelectorAll('.analysis-content section')) section.hidden = locked || !analysis.available && !cached || !u.readinessAssessed;
    const percent = u.readinessAssessed ? readinessScalePercent(u.progress, this.#session.preset) : 0;
    root.querySelector('.scale').setAttribute('aria-valuenow', percent);
    root.querySelector('.scale').setAttribute('aria-valuetext', u.readinessAssessed ? `${percent}%` : copy.notAssessed);
    root.querySelector('.fill').style.width = `${percent}%`;
    root.querySelector('.marker').style.left = `${this.#session.preset.talkMarker}%`;
    root.querySelector('.talk-progress').textContent = u.readinessAssessed
      ? copy.talkProgress.replace('{percent}', displayedReadinessPercent(u.progress.talk.value)) : copy.notAssessed;
    root.querySelector('.build-progress').textContent = u.readinessAssessed
      ? copy.buildProgress.replace('{percent}', displayedReadinessPercent(u.progress.build.value)) : '';
    root.querySelector('.notice').textContent = !analysis.available ? analysis.reason : this.#failure ? copy.reasoningFailed : !u.readinessAssessed ? copy.empty
      : stale ? copy.stale : u.draft ? copy.draft : copy.final;
    const revision = inputRevision(this.#session), operations = this.#session.operations;
    const running = operations?.inputRevision === revision && operations.running.length > 0;
    const hasPersonTurn = activeTurns(this.#session).some(t => t.role === 'user');
    const missingReply = hasPersonTurn && !activeTurns(this.#session).some(t => t.role === 'assistant' && t.inputRevision === revision);
    root.querySelector('.retry').disabled = !analysis.available;
    root.querySelector('.retry').hidden = locked || !analysis.available || Boolean(running) || !(this.#failure || hasPersonTurn &&
      (missingReply || !understandingDeferred(this.#session) && (stale || u.draft)));
    root.querySelector('.summary-text').textContent = u.summary;
    for (const [selector, items] of [['.signals', u.signals], ['.questions', u.openQuestions]]) {
      reconcile(root.querySelector(selector), items.length ? textKeys(items) : [[NONE, null]],
        value => element('li', undefined, value === null ? 'none-yet' : undefined), (node, value) => setText(node, value ?? copy.noneYet));
    }
    const items = readinessListItems(u.constraints, u.questionHistory, u.openQuestions, copy.constraints, this.#session.preset);
    const cleared = newlyClearedFirst(this.#open, this.#cleared, items.cleared);
    this.#open = items.open.map(i => i.key); this.#cleared = cleared.map(i => i.key);
    const window = readinessListWindow(items.open);
    reconcile(root.querySelector('.missing'), window.rows.length ? window.rows.map(i => [i.key, i]) : [[NONE, null]],
      i => i ? element('li') : element('li', copy.noneYet, 'none-yet'), (row, i) => {
        if (!i) { setText(row, copy.noneYet); return; }
        const label = row.querySelector('strong');
        if (i.label) setText(label ?? row.insertBefore(element('strong'), row.firstChild), i.label); else label?.remove();
        setText(row.querySelector('span') ?? row.appendChild(element('span')), i.detail);
      });
    root.querySelector('.overflow').textContent = window.remainder ? copy.more.replace('{count}', window.remainder) : '';
    // Summaries keep their nodes, so keyboard focus survives unsolicited updates.
    reconcile(root.querySelector('.cleared'), cleared.length ? cleared.map(i => [i.key, i]) : [[NONE, null]], i => {
      if (!i) return element('p', copy.noneYet, 'none-yet');
      const details = element('details'); details.append(element('summary'), element('p'));
      details.addEventListener('toggle', () => this.#expandLabel()); return details;
    }, (details, i) => {
      if (!i) { setText(details, copy.noneYet); return; }
      setText(details.querySelector('summary'), i.label ?? i.detail);
      const value = details.querySelector('p'), evidence = i.evidence ? element('blockquote', i.evidence) : null;
      evidence?.setAttribute('aria-label', copy.evidence);
      if (value.firstChild?.nodeValue !== (i.label ? i.detail : copy.none) || value.querySelector('blockquote')?.textContent !== i.evidence) {
        value.replaceChildren(i.label ? i.detail : copy.none, ...evidence ? [evidence] : []);
      }
    });
    this.#expandLabel();
  }
  // Art. 50(1) (AIT-119): one quiet line under the conversation header from the first paint on, so it
  // stands before choosing, typing or a call can begin. The configured wording wins over the bundle's,
  // an empty part falls back to the default. The hidden copy of the full notice holds the line's
  // height, so the voice sentence appearing or going never moves anything.
  #paintNotice() {
    const root = this.shadowRoot, pick = part => [this.#aiNotice?.[part], this.#copy.aiNotice?.[part]].find(value => typeof value === 'string' && value.trim());
    const notice = aiNotice(this.#session.locale, { text: pick('text'), voice: pick('voice') });
    setText(root.querySelector('#ai-notice'), this.#voiceOffered() ? `${notice.text} ${notice.voice}` : notice.text);
    setText(root.querySelector('.ai-notice__sizer'), `${notice.text} ${notice.voice}`);
  }
  // Replies can be spoken here: voice is available now, or once consent, a resume or the provider allows it.
  #voiceOffered() {
    const preset = this.#session.processingPreset ?? 'best', voice = this.#session.featureMatrix?.[preset]?.voice;
    return preset !== 'device' && Boolean(this.#voiceClientFor()) && Boolean(voice?.available || isDynamicReason(voice?.reason));
  }
  #engineDetail() {
    const copy = this.#copy, preset = this.#session.processingPreset ?? 'best', view = engineView(this.#session);
    if (preset === 'device') return `${copy.engine.localModel}: ${this.#device?.model ?? copy.engine.notConnected}`;
    const name = value => value === SETTINGS_OFF ? copy.engine.off : catalogLabel(copy, value.label ?? value.id);
    return [view.model && [name(view.model), view.effort && view.effort !== 'none' ? copy.settings.efforts[view.effort] ?? view.effort : null].filter(Boolean).join(' · '),
      `${copy.engine.voice}: ${name(view.voice)}`, `${copy.engine.visuals}: ${name(view.visuals)}`].filter(Boolean).join(' · ');
  }
  #renderEngine() {
    const root = this.shadowRoot, preset = this.#session.processingPreset ?? 'best';
    root.querySelector('.engine__value').textContent = this.#copy.presets[preset] ?? preset;
    root.querySelector('.engine__detail').textContent = this.#engineDetail();
    root.querySelector('.engine__detail').title = this.#engineDetail();
  }
  // Anything the visitor contributed (or its withdrawal) means the conversation has begun.
  #hasInput() {
    const session = this.#session;
    return Boolean(session.transcript.length || session.uploads?.length || this.#partials.size || session.tombstone);
  }
  // START's journey (index.astro data-entry, data-choosing-preset): the entrance with the processing
  // choice, readiness once a choice is confirmed, then the live conversation after an explicit start or
  // once the conversation has input. A pause or a running call also shows the live view (its controls).
  #stage() {
    if (this.#hasInput() || this.#started || this.#session.paused || this.#rail?.root.dataset.call === 'active') return 'live';
    return (this.#session.settings?.origin ?? 'default') === 'chosen' ? 'ready' : 'entrance';
  }
  #renderIntro() {
    const root = this.shadowRoot, workspace = root.querySelector('.workspace'), intro = root.querySelector('.intro'), active = root.activeElement;
    const focus = active && intro.contains(active) ? active.dataset.focusKey : null;
    const stage = this.#stage(), mode = { entrance: 'chooser', ready: 'ready' }[stage] ?? '';
    workspace.dataset.stage = stage;
    // Understanding is absent before the first input, then opens beside the conversation (START, ~560 ms).
    const understanding = this.#hasInput() ? 'present' : 'absent';
    if (workspace.dataset.understanding !== understanding) {
      workspace.dataset.understanding = understanding; root.querySelector('.understanding').inert = understanding === 'absent';
    }
    // Before the start only the entrance is operable: the call and concept rails wait for it.
    for (const selector of ['.audio-rail', '.concept-bar']) root.querySelector(selector).inert = stage !== 'live';
    this.#placeOrb(stage);
    intro.dataset.mode = mode; intro.hidden = !mode;
    const card = intro.querySelector('.intro__card');
    if (!mode) { card.replaceChildren(); return; }
    // The card is built once per mode and its controls are keyed and updated in place, so a
    // live update keeps the hovered and focused nodes, and #anchored keeps them still (AIT-116 D2).
    if (card.firstElementChild?.className !== mode) card.replaceChildren(mode === 'ready' ? this.#readyCard() : this.#chooserCard());
    if (mode === 'ready') this.#paintReady(card.firstElementChild); else this.#paintChooser(card.firstElementChild);
    if (focus && !intro.contains(root.activeElement)) intro.querySelector(`[data-focus-key="${focus}"]`)?.focus();
  }
  // One orb: the entrance shows it, the rail docks it as the voice avatar (START Orb.astro, v2 orb dock).
  #placeOrb(stage) {
    this.#orb ??= createOrb(this.ownerDocument);
    const dock = this.shadowRoot.querySelector(stage === 'live' ? '.audio-rail .voice-orb' : '.intro__orb');
    if (dock && this.#orb.element.parentNode !== dock) dock.append(this.#orb.element);
    if (this.isConnected) this.#orb.mount();
  }
  // A preset other than the acknowledged one is refused at the start only for host reasons;
  // Custom always opens settings.
  #presetRefusal(preset) {
    const verdict = this.#session.featureMatrix?.[preset]?.text;
    const refused = preset !== 'custom' && preset !== (this.#session.processingPreset ?? 'best') && verdict && !verdict.available && !isDynamicReason(verdict.reason);
    return refused ? verdict.reason : null;
  }
  // START LandingPresets: four choices, a summary area that reserves its longest text and a Continue
  // whose position never changes.
  #chooserCard() {
    const copy = this.#copy, c = copy.chooser;
    const section = node('section', 'chooser'); section.setAttribute('aria-labelledby', 'chooser-title');
    const title = node('h3', '', c.title); title.id = 'chooser-title';
    const cards = node('div', 'chooser__list'); cards.setAttribute('role', 'group'); cards.setAttribute('aria-labelledby', 'chooser-title');
    const summary = node('div', 'chooser__summary');
    const live = node('strong'); live.setAttribute('role', 'status');
    summary.append(live, ...[c.choose, c.saving, ...PRESET_ORDER.map(p => c.summary[p])].map(text => {
      const measure = node('strong', 'chooser__measure', text); measure.setAttribute('aria-hidden', 'true'); return measure;
    }));
    const hint = node('div', 'chooser__hint');
    hint.append(summary, node('span'));
    const go = node('button', 'chooser__continue'); go.type = 'button'; go.dataset.focusKey = 'continue'; go.setAttribute('aria-describedby', 'ai-notice');
    const arrow = node('span', 'chooser__arrow'); arrow.setAttribute('aria-hidden', 'true'); arrow.innerHTML = icon('arrowRight');
    go.append(node('span', '', c.continue), arrow);
    go.addEventListener('click', () => void this.#confirmChoice(go));
    const action = node('div', 'chooser__action'); action.append(hint, go);
    const error = node('p', 'chooser__error'); error.setAttribute('role', 'alert');
    section.append(title, cards, action, error);
    return section;
  }
  #chooserOption(preset) {
    const copy = this.#copy, c = copy.chooser;
    const card = node('button', 'chooser-option'); card.type = 'button'; card.dataset.focusKey = preset; card.dataset.preset = preset;
    const detail = node('span', 'chooser-option__detail'); detail.id = `chooser-${preset}-detail`;
    detail.append(node('span', '', c.lead[preset]), node('span', '', c.detail[preset]));
    card.setAttribute('aria-describedby', `${detail.id} ai-notice`);
    const glyph = node('span', 'chooser-option__icon'); glyph.setAttribute('aria-hidden', 'true'); glyph.innerHTML = ICONS[preset];
    const radio = node('span', 'radio'); radio.setAttribute('aria-hidden', 'true');
    card.append(glyph, radio, node('strong', '', copy.presets[preset]), detail, node('small', 'chooser-option__note'));
    // The verdict is read at click time: it may have changed since the card was built.
    card.addEventListener('click', () => {
      if (this.#chooser.busy) return;
      const refusal = this.#presetRefusal(preset);
      this.#chooser.error = refusal ? `${copy.presets[preset]}: ${reasonText(copy, refusal)}` : '';
      if (!refusal) this.#chooser.choice = preset;
      this.#render('transcript');
    });
    return card;
  }
  #paintChooser(section) {
    const copy = this.#copy, c = copy.chooser, choice = this.#chooser.choice ?? this.#session.processingPreset ?? 'best';
    reconcile(section.querySelector('.chooser__list'), PRESET_ORDER.map(preset => [preset, preset]), preset => this.#chooserOption(preset), (card, preset) => {
      const refusal = this.#presetRefusal(preset);
      card.setAttribute('aria-pressed', String(choice === preset)); card.setAttribute('aria-disabled', String(Boolean(refusal)));
      if (refusal) card.title = reasonText(copy, refusal); else card.removeAttribute('title');
      setText(card.querySelector('.chooser-option__note'), refusal ? c.unavailable : '');
    });
    setText(section.querySelector('.chooser__summary [role=status]'), this.#chooser.busy ? c.saving : c.summary[choice] ?? c.choose);
    setText(section.querySelector('.chooser__hint > span'), (this.#session.settings?.origin === 'last' ? `${c.lastChoice} ` : '') + c.later);
    section.querySelector('.chooser__continue').disabled = this.#chooser.busy;
    setText(section.querySelector('.chooser__error'), this.#chooser.error);
  }
  async #confirmChoice(button) {
    if (this.#chooser.busy) return;
    const copy = this.#copy, current = this.#session.processingPreset ?? 'best', choice = this.#chooser.choice ?? current;
    if (choice === 'custom') {
      const custom = this.#session.featureMatrix?.custom?.text;
      this.openSettings(button, { continueLabel: true, preset: custom && (custom.available || isDynamicReason(custom.reason)) ? 'custom' : undefined });
      return;
    }
    const sessionId = this.#session.id, view = engineView(this.#session), settings = this.#session.settings ?? {};
    const body = { processingPreset: choice, baseRevision: settings.revision ?? 0 };
    const id = value => value === SETTINGS_OFF ? SETTINGS_OFF : value?.id;
    // Confirming the offered preset keeps the offered (possibly last) choice exactly.
    if (choice === current && choice !== 'device') Object.assign(body, { model: view.model?.id, effort: view.effort ?? undefined,
      voice: id(view.voice), visuals: id(view.visuals) });
    for (const key of Object.keys(body)) if (body[key] === undefined || body[key] === null) delete body[key];
    this.#chooser = { ...this.#chooser, busy: true, error: '' }; this.#render('transcript');
    const result = await this.#saveSettings(body);
    if (sessionId !== this.#session.id) return;
    this.#chooser.busy = false;
    if (!result.ok) {
      this.#chooser.error = result.error === 'setting-not-allowed' ? copy.settings.notAllowed.replace('{reason}', reasonText(copy, result.body.reason))
        : result.error === 'settings-conflict' ? copy.settings.conflict : copy.chooser.failed;
    }
    this.#render('transcript');
    if (result.ok) {
      // Readiness follows; Start takes focus. START continues into consent when the choice is not covered yet.
      this.shadowRoot.querySelector('.ready__start')?.focus();
      if (result.ack.consent?.required) this.#requestConsent('chooser', result.ack.consent.features);
    } else this.shadowRoot.querySelector('.chooser__continue')?.focus();
  }
  // START ConversationReadiness and the readiness card around it (index.astro .v2__consent): the model,
  // consent, microphone and speaker states, a reversible choice to speak or to type, and an explicit start.
  #readyCard() {
    const copy = this.#copy, r = copy.ready, section = node('section', 'ready'); section.setAttribute('aria-labelledby', 'ready-title');
    const title = node('h3', '', r.title); title.id = 'ready-title';
    const route = node('p', 'ready__route'); route.id = 'ready-route';
    const modes = node('div', 'ready__modes'); modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', r.inputMode);
    for (const [mode, glyph, label] of [['voice', 'mic', r.voice], ['type', 'keyboard', r.type]]) {
      const choice = node('button', 'ready__mode'); choice.type = 'button'; choice.dataset.mode = mode; choice.dataset.focusKey = `mode-${mode}`;
      choice.innerHTML = icon(glyph); choice.append(node('span', '', label));
      choice.addEventListener('click', () => { if (choice.getAttribute('aria-disabled') !== 'true') { this.#inputMode = mode; this.#render('transcript'); } });
      modes.append(choice);
    }
    const start = node('button', 'ready__start'); start.type = 'button'; start.dataset.focusKey = 'start';
    start.setAttribute('aria-describedby', 'ready-route ai-notice');
    const arrow = node('span', 'ready__arrow'); arrow.setAttribute('aria-hidden', 'true'); arrow.innerHTML = icon('arrowRight');
    start.append(node('span', '', r.start), arrow);
    start.addEventListener('click', () => this.#start());
    section.append(title, node('dl'), node('div', 'ready__actions'), route, modes, start);
    this.#watchMicrophone();
    return section;
  }
  // Voice is offered here only when a voice client exists and the selection allows it (or will, after consent).
  #voiceChoice() {
    const voice = this.#feature('voice'), device = this.#session.processingPreset === 'device';
    return !device && Boolean(this.#voiceClientFor()) && engineView(this.#session).voice !== SETTINGS_OFF && (voice.available || isDynamicReason(voice.reason));
  }
  #mode() { return this.#voiceChoice() ? this.#inputMode ?? 'voice' : 'type'; }
  // Read-only, as START: a permission query never acquires the microphone or starts a provider.
  #watchMicrophone() {
    if (this.#permission) return;
    this.#permission = Promise.resolve().then(() => globalThis.navigator?.permissions?.query?.({ name: 'microphone' })).then(status => {
      if (!status) return;
      const update = () => { this.#microphone = status.state; if (this.shadowRoot.querySelector('.ready')) this.#render('transcript'); };
      status.addEventListener?.('change', update); update();
    }).catch(() => { this.#microphone = 'unknown'; });
  }
  #paintReady(section) {
    const copy = this.#copy, r = copy.ready, device = this.#session.processingPreset === 'device', view = engineView(this.#session);
    const consent = this.#consentState(), local = this.#device?.model, mode = this.#mode(), voiceMode = mode === 'voice';
    const visuals = device ? SETTINGS_OFF : view.visuals;
    const effort = view.effort, model = catalogLabel(copy, view.model?.label ?? view.model?.id);
    const microphone = { granted: [r.micGranted, 'confirmed'], denied: [r.micDenied, 'pending'], prompt: [r.micPrompt, 'pending'] }[this.#microphone] ?? [r.checkOnStart, 'pending'];
    const rows = [
      ['model', 'settings', r.model, device ? local ? `${copy.engine.localModel}: ${local}` : r.notConnected
        : [model, effort && effort !== 'none' ? copy.settings.efforts[effort] ?? effort : null].filter(Boolean).join(' · '), device && !local ? 'pending' : 'selected'],
      ['consent', 'info', r.consent, consent === 'device' ? r.notNeeded : consent === 'granted' ? r.granted : r.missing, ['device', 'granted'].includes(consent) ? 'confirmed' : 'pending'],
      ['microphone', 'mic', r.microphone, voiceMode ? microphone[0] : r.off, voiceMode ? microphone[1] : 'off'],
      ['speaker', 'volume', r.speaker, voiceMode ? r.onOnStart : r.off, voiceMode ? 'selected' : 'off'],
      ['visuals', 'concept', r.visuals, visuals !== SETTINGS_OFF ? r.on : r.off, visuals !== SETTINGS_OFF ? 'selected' : 'off'],
    ];
    reconcile(section.querySelector('dl'), rows.map(row => [row[0], row]), ([id, glyph]) => {
      const row = node('div', 'ready__row'); row.dataset.ready = id;
      const dt = node('dt'), dd = node('dd'), mark = node('span', 'ready__icon'), check = node('span', 'ready__check');
      mark.setAttribute('aria-hidden', 'true'); mark.innerHTML = icon(glyph);
      check.setAttribute('aria-hidden', 'true'); check.innerHTML = icon('check');
      dt.append(mark, node('span')); dd.append(check, node('span')); row.append(dt, dd); return row;
    }, (row, [, , label, value, state]) => {
      row.dataset.state = state; setText(row.querySelector('dt > span:last-child'), label); setText(row.querySelector('dd > span:last-child'), value);
    });
    const actions = ['change', ...['missing', 'withdrawn'].includes(consent) ? ['consent'] : []];
    reconcile(section.querySelector('.ready__actions'), actions.map(action => [action, action]), action => {
      const button = node('button', `ready__${action}`, action === 'change' ? r.change : copy.settings.reviewConsent); button.type = 'button'; button.dataset.focusKey = action;
      button.setAttribute('aria-describedby', 'ai-notice');
      button.addEventListener('click', () => { if (action === 'change') this.openSettings(button); else this.#requestConsent('ready'); });
      return button;
    }, () => {});
    setText(section.querySelector('.ready__route'), copy.chooser.summary[this.#session.processingPreset ?? 'best'] ?? '');
    const offered = this.#voiceChoice();
    for (const choice of section.querySelectorAll('.ready__mode')) {
      choice.setAttribute('aria-pressed', String(choice.dataset.mode === mode));
      const unavailable = choice.dataset.mode === 'voice' && !offered;
      choice.setAttribute('aria-disabled', String(unavailable));
      if (unavailable) choice.title = this.#feature('voice', true).reason ?? copy.notConfigured; else choice.removeAttribute('title');
    }
  }
  // The explicit start: typing opens the composer; speaking starts the call, the only path to the
  // microphone. A start the current consent does not cover goes to the host's consent first.
  #start() {
    const mode = this.#mode(), feature = this.#feature(mode === 'voice' ? 'voice' : 'text');
    if (!feature.available && isConsentReason(feature.reason)) { this.#requestConsent('ready'); return; }
    this.#started = true; this.#render('transcript'); this.#render('composer');
    // Focus lands where the conversation continues: the composer, or the call's own group (no key there ends it).
    if (mode === 'voice') { void this.#rail.start(); this.shadowRoot.querySelector('.audio-rail').focus(); }
    else this.shadowRoot.querySelector('textarea').focus();
  }
  #withdrawButton(row) {
    const copy = this.#copy, button = document.createElement('button');
    button.className = 'withdraw'; button.type = 'button'; button.textContent = copy.withdraw;
    button.addEventListener('click', async () => {
      const sessionId = this.#session.id, turnId = row.dataset.id; button.disabled = true;
      try {
        if (this.#session.processingPreset === 'device') {
          this.#deviceController?.abort();
          this.receive({ sessionId, seq: this.#cursor + 1, type: 'turn.withdrawn',
            data: { turnId, reason: 'withdrawal', at: new Date().toISOString() } });
          return;
        }
        const response = await postJson(`${this.#base}/api/sessions/${sessionId}/withdraw`, { turnId }, { sessionToken: this.#sessionToken });
        if (!response.ok) throw new Error();
        const ack = await response.json(); if (sessionId === this.#session.id) this.receive(ack.event);
      } catch { if (sessionId === this.#session.id) this.#status(copy.controlFailed); }
      finally { button.disabled = false; }
    });
    return button;
  }
  // Uploads sit in the transcript where they arrived: before the first turn saved after them, and
  // ahead of a running reply. A withdrawn upload keeps the place it had on this page; one already
  // withdrawn when the page loaded has no time left (it was erased) and stands before the turns.
  #transcriptEntries(turns) {
    // Files of one request share a time; the order they were first seen breaks the tie (a state change
    // moves an upload to the end of the session's list).
    const uploads = (this.#session.uploads ?? []).map(upload => {
      if (upload.at && !this.#uploadAt.has(upload.id)) this.#uploadAt.set(upload.id, { at: upload.at, order: this.#uploadAt.size });
      const seen = this.#uploadAt.get(upload.id);
      return { key: `upload:${upload.id}`, upload, at: seen?.at ?? '', order: seen?.order ?? -1 };
    }).sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order);
    const entries = []; let next = 0;
    for (const turn of turns) {
      if (turn.at) while (next < uploads.length && uploads[next].at < turn.at) entries.push(uploads[next++]);
      entries.push({ key: turn.id, turn });
    }
    entries.push(...uploads.slice(next));
    for (const turn of this.#partials.values()) entries.push({ key: turn.id, turn });
    return entries;
  }
  // GUI-27, not a pill: a plain line with a file glyph, the name and Withdraw upload, then the muted
  // size and the state. Every part has its own slot, so no state change moves or resizes the row:
  // the name is one line, the action slot keeps the width of its label after withdrawal, and the
  // state slot is as tall as the longest state of this language (invisible copies stacked under it).
  // Names are text, never markup; the file's contents never reach the page.
  #uploadRow(id) {
    const copy = this.#copy, row = node('li', 'upload'); row.tabIndex = -1;
    const glyph = node('span', 'upload__glyph'); glyph.innerHTML = UPLOAD_ICONS.file;
    const name = node('span', 'upload__name'); name.id = `upload-name-${id}`;
    const sizer = text => { const n = node('small', 'upload__sizer', text); n.setAttribute('aria-hidden', 'true'); return n; };
    const action = node('span', 'upload__action'); action.append(sizer(copy.uploads.withdraw));
    const status = node('span', 'upload__status'); status.append(node('small', 'upload__state'), ...uploadStateTexts(copy).map(sizer));
    row.append(glyph, name, action, node('small', 'upload__size'), status);
    return row;
  }
  #paintUpload(row, upload) {
    const copy = this.#copy, gone = upload.state === 'withdrawn' || Boolean(upload.erased);
    row.dataset.state = gone ? 'withdrawn' : upload.state;
    const name = row.querySelector('.upload__name');
    setText(name, gone ? copy.uploads.withdrawn : upload.filename ?? ''); name.title = gone ? '' : upload.filename ?? '';
    setText(row.querySelector('.upload__size'), gone || !Number.isFinite(upload.bytes) ? '' : formatBytes(upload.bytes, this.#session.locale));
    setText(row.querySelector('.upload__state'), gone ? '' : uploadStateText(copy, upload));
    const button = row.querySelector('.upload-withdraw');
    if (!gone && !button) row.querySelector('.upload__action').prepend(this.#uploadWithdrawButton(row, upload.id));
    if (gone && button) {
      // Focus stays where it was: on the row, never dropped to the page.
      const focused = this.shadowRoot.activeElement === button;
      button.remove(); if (focused) row.focus();
    }
  }
  #uploadWithdrawButton(row, uploadId) {
    const copy = this.#copy, button = node('button', 'upload-withdraw', copy.uploads.withdraw);
    button.type = 'button'; button.setAttribute('aria-describedby', `upload-name-${uploadId}`);
    // Busy is aria-disabled, not disabled: a disabled button would drop keyboard focus to the page.
    button.addEventListener('click', async () => {
      if (button.getAttribute('aria-disabled') === 'true') return;
      const sessionId = this.#session.id; button.setAttribute('aria-disabled', 'true');
      try {
        const path = `${this.#base}/api/sessions/${sessionId}/uploads/${encodeURIComponent(uploadId)}/withdraw`;
        const response = await postJson(sameOrigin(this.ownerDocument.defaultView, path), {}, { sessionToken: this.#sessionToken });
        if (!response.ok) throw new Error();
        const ack = await response.json(); if (sessionId === this.#session.id) this.receive(ack.event);
      } catch { if (sessionId === this.#session.id) this.#status(copy.uploads.withdrawFailed); }
      finally { button.removeAttribute('aria-disabled'); }
    });
    return button;
  }
  // The attach button opens the native picker; files dropped anywhere on the conversation (the
  // transcript or the composer) go the same way. The overlay is absolutely placed: it never moves layout.
  #mountUploads() {
    const root = this.shadowRoot, input = root.querySelector('.attach-input'), zone = root.querySelector('.conversation');
    root.querySelector('.attach__label').textContent = this.#copy.uploads.attach;
    root.querySelector('.drop-overlay strong').textContent = this.#copy.uploads.dropActive;
    root.querySelector('.attach').addEventListener('click', () => {
      const refusal = this.#attachRefusal();
      if (refusal) { this.#uploadRefusal(refusal); return; }
      void this.#loadLimits(); input.click();
    });
    input.addEventListener('change', () => { const files = [...input.files ?? []]; input.value = ''; void this.#attach(files); });
    const carriesFiles = event => [...event.dataTransfer?.types ?? []].includes('Files');
    zone.addEventListener('dragenter', event => {
      if (!carriesFiles(event)) return;
      event.preventDefault(); this.#dragDepth++; this.#dropping(true);
    });
    zone.addEventListener('dragover', event => {
      if (!carriesFiles(event)) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
    });
    zone.addEventListener('dragleave', event => {
      if (!carriesFiles(event)) return;
      this.#dragDepth = Math.max(0, this.#dragDepth - 1); if (!this.#dragDepth) this.#dropping(false);
    });
    // A dropped file never navigates the page away, also when uploading is unavailable.
    zone.addEventListener('drop', event => {
      if (!carriesFiles(event)) return;
      event.preventDefault(); this.#dragDepth = 0; this.#dropping(false);
      void this.#attach([...event.dataTransfer.files ?? []]);
    });
  }
  #dropping(on) {
    const zone = this.shadowRoot.querySelector('.conversation'), feature = this.#feature('uploads', true);
    if (on) {
      if (feature.available) void this.#loadLimits();
      setText(zone.querySelector('.drop-overlay strong'), feature.available ? this.#copy.uploads.dropActive : this.#copy.uploads.unavailable.replace('{reason}', feature.reason));
      setText(zone.querySelector('.drop-overlay span'), feature.available ? dropText(this.#copy, this.#limits, this.#session.locale) : '');
    }
    zone.toggleAttribute('data-dropping', on);
  }
  // Why nothing can be attached right now, or '' when it can. Attach is aria-disabled exactly then, and
  // every way in (the button, the picker's files, a drop) is refused by it before anything is sent.
  #attachRefusal() {
    const copy = this.#copy, feature = this.#feature('uploads', true);
    if (!feature.available) return copy.uploads.unavailable.replace('{reason}', feature.reason);
    if (this.#uploading) return copy.uploads.busy;
    return uploadsPossible(this.#limits) ? '' : copy.uploads.impossible;
  }
  // Unavailable (consent, preset, extractors, pause) stays focusable and says why when pressed.
  #paintAttach() {
    const root = this.shadowRoot, attach = root.querySelector('.attach'), feature = this.#feature('uploads', true);
    const limits = limitsText(this.#copy, this.#limits, this.#session.locale);
    const unavailable = feature.available ? '' : this.#copy.uploads.unavailable.replace('{reason}', feature.reason);
    attach.setAttribute('aria-disabled', String(Boolean(this.#attachRefusal())));
    attach.title = unavailable || limits;
    setText(root.querySelector('#attach-limits'), unavailable || limits);
  }
  #uploadRefusal(text) { this.#uploadNotice = text; this.#render('composer'); }
  // Limits are the host's (possibly lowered) values; the route defaults hold until they arrive.
  #loadLimits() {
    if (this.#limitsLoad) return this.#limitsLoad;
    const sessionId = this.#session.id, path = `${this.#base}/api/sessions/${sessionId}/uploads`;
    // Started on the next microtask, so a refusal before sending (another origin) can clear it.
    const load = Promise.resolve().then(async () => {
      try {
        const response = await fetch(sameOrigin(this.ownerDocument.defaultView, path), { headers: this.#headers(), cache: 'no-store', signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error();
        const body = await response.json();
        if (sessionId === this.#session.id) { this.#limits = uploadLimits(body.limits); this.#render('composer'); }
      } catch { if (this.#limitsLoad === load) this.#limitsLoad = null; }
    });
    this.#limitsLoad = load;
    return load;
  }
  async #attach(files) {
    if (!files.length) return;
    const copy = this.#copy, sessionId = this.#session.id, refusal = this.#attachRefusal();
    if (refusal) { this.#uploadRefusal(refusal); return; }
    this.#uploading = true; this.#uploadNotice = ''; this.#render('composer');
    try {
      await this.#loadLimits();
      if (sessionId !== this.#session.id) return;
      // The host's limits may have arrived just now and leave no room: nothing is sent.
      if (!uploadsPossible(this.#limits)) { this.#uploadNotice = copy.uploads.impossible; return; }
      const plan = planUploads(files, { limits: this.#limits, uploads: this.#session.uploads });
      const notices = [refusalText(copy, plan, this.#session.locale)], count = plan.batches.flat().length;
      if (count) {
        this.#status(plural(copy.uploads.uploading, count));
        let sent = 0;
        for (const batch of plan.batches) {
          const failure = await this.#postUploads(batch);
          if (sessionId !== this.#session.id) return;
          if (failure) { notices.push(failure); break; }
          sent += batch.length;
        }
        if (sent && this.#session.uploads.some(u => u.state === 'pending')) { this.#reading = plural(copy.uploads.received, sent); this.#status(this.#reading); }
        else this.#clearNotice();
      }
      this.#uploadNotice = notices.filter(Boolean).join(' ');
    } finally {
      if (sessionId === this.#session.id) { this.#uploading = false; this.#render('composer'); }
    }
  }
  /** One multipart request; returns the plain-words failure, or '' once the server accepted it. */
  async #postUploads(files) {
    const copy = this.#copy, sessionId = this.#session.id, form = new FormData();
    form.append('clientEventId', crypto.randomUUID());
    for (const file of files) form.append('files', file, file.name);
    let response, body = null;
    try {
      const path = `${this.#base}/api/sessions/${sessionId}/uploads`;
      response = await postForm(sameOrigin(this.ownerDocument.defaultView, path), form, { sessionToken: this.#sessionToken });
      body = await response.json().catch(() => null);
    } catch { return copy.uploads.failed; }
    if (sessionId !== this.#session.id) return '';
    if (response.ok && body) {
      if (body.limits) this.#limits = uploadLimits(body.limits);
      for (const event of body.events ?? []) this.receive(event);
      return '';
    }
    if (response.status === 413) return copy.uploads.overLimit;
    if (response.status === 429) return copy.uploads.busy;
    if (response.status === 403 && typeof body?.reason === 'string') return copy.uploads.unavailable.replace('{reason}', reasonText(copy, body.reason));
    return copy.uploads.failed;
  }
  #expandLabel() {
    const details = [...this.shadowRoot.querySelectorAll('.cleared details')], button = this.shadowRoot.querySelector('.expand');
    button.textContent = details.length && details.every(d => d.open) ? this.#copy.collapse : this.#copy.expand;
    button.disabled = !details.length;
  }
  async #send() {
    const root = this.shadowRoot, input = root.querySelector('textarea'), button = root.querySelector('.send');
    if (this.#sending || !this.#feature('text').available || !input.value.trim()) return;
    const content = input.value;
    if (this.#session.processingPreset === 'device') { await this.#sendDevice(content); return; }
    const sessionId = this.#session.id;
    const voiceSession = this.#rail.session;
    if (!this.#pending || this.#pending.content !== content) this.#pending = { clientEventId: crypto.randomUUID(), content,
      ...(voiceSession ? { voiceCallId: voiceSession.callId, providerSessionId: voiceSession.providerSessionId } : {}) };
    this.#sending = true; button.disabled = true; this.#status(this.#copy.sending);
    try {
      const response = await postJson(`${this.#base}/api/sessions/${sessionId}/turns`, this.#pending, { sessionToken: this.#sessionToken });
      if (!response.ok) throw new Error();
      const event = await response.json();
      if (sessionId !== this.#session.id) return;
      this.receive(event);
      const voiceText = voiceSession && voiceSession === this.#rail.session && event.data.voiceCallId === voiceSession.callId;
      if (voiceText) {
        await this.#rail.sendText(content);
        if (sessionId !== this.#session.id) return;
      }
      if (input.value === content) input.value = '';
      this.#pending = null; this.#status(voiceText ? this.#copy.voiceTextSent : this.#copy.saved);
    } catch { if (sessionId === this.#session.id) this.#status(this.#copy.failed); }
    finally { if (sessionId === this.#session.id) { this.#sending = false; button.disabled = !this.#feature('text').available; this.#render('composer'); } }
  }
  async #sendDevice(content) {
    const root = this.shadowRoot, button = root.querySelector('.send'), input = root.querySelector('textarea'), device = this.#device;
    if (!device) { this.#status(this.#copy.deviceConnectFirst); return; }
    this.#sending = true; button.disabled = true; const controller = new AbortController(); this.#deviceController = controller;
    const sessionId = this.#session.id, deadlineAt = Date.now() + 180_000;
    const current = () => !controller.signal.aborted && sessionId === this.#session.id;
    try {
      await device.connect({ signal: controller.signal, deadlineAt });
      if (!current()) return;
      this.receive({ seq: this.#cursor + 1, type: 'turn.final', data: { id: crypto.randomUUID(), role: 'user', content } });
      input.value = '';
      const id = crypto.randomUUID(), revision = inputRevision(this.#session), origin = aiTextOrigin({ model: device.model, plugin: device.id }); let answer = '';
      for await (const delta of device.stream({ messages: activeTurns(this.#session).map(({ role, content }) => ({ role, content })) },
        { signal: controller.signal, deadlineAt })) {
        if (!current()) return; answer += delta;
        this.receive({ type: 'turn.partial', data: { id, delta, ...origin, inputRevision: revision } });
      }
      if (current()) this.receive({ seq: this.#cursor + 1, type: 'turn.final', data: { id, role: 'assistant', content: answer, ...origin, inputRevision: revision } });
      if (current()) this.#status(this.#copy.deviceConversation);
    } catch { if (current()) { this.#partials.clear(); this.#render('transcript'); this.#status(this.#copy.deviceUnavailable); } }
    finally { if (sessionId === this.#session.id) { this.#sending = false; button.disabled = !this.#feature('text').available; this.#render('composer'); } }
  }
  receive(event) {
    if (event.sessionId && event.sessionId !== this.#session.id) return;
    if (event.seq) {
      if (event.seq <= this.#cursor) return;
      // A withdrawn upload revokes what was derived from it, like a withdrawn statement. (A replayed
      // earlier state whose content is gone is only a tombstone; its withdrawal follows in the journal.)
      const invalidation = ['turn.withdrawn', 'session.erased', 'consent.revised'].includes(event.type) ||
        event.type === 'upload.state' && event.data.state === 'withdrawn';
      if (invalidation) {
        this.#invalidatedAt = Math.max(this.#invalidatedAt, event.seq);
        this.#deviceController?.abort(); void this.#rail.close();
        this.#partials.clear(); this.#failure = false;
        // Redact sensitive content immediately, holding row heights while the pointer rests there.
        for (const row of this.shadowRoot.querySelectorAll('.turn')) {
          const turn = this.#session.transcript.find(t => t.id === row.dataset.id);
          if (event.type === 'session.erased' || turn?.role === 'assistant' || row.dataset.id === event.data.turnId || row.classList.contains('partial')) {
            row.style.minHeight = `${row.getBoundingClientRect().height}px`;
            row.querySelector('span').textContent = this.#copy.withdrawn;
          }
        }
        for (const selector of ['.summary-text', '.signals', '.questions', '.missing', '.cleared', '.overflow']) {
          const node = this.shadowRoot.querySelector(selector);
          node.style.minHeight = `${node.getBoundingClientRect().height}px`; node.dataset.redacted = '';
          node.textContent = '';
        }
      }
      if (event.seq !== this.#cursor + 1) {
        if (invalidation) {
          this.#session = applyEvent(this.#session, event);
          this.#concept.update(this.#session); this.#render('transcript'); this.#render('aside');
        }
        this.#abort?.abort(); void this.#restore(); return;
      }
      const presetBefore = this.#session.processingPreset, settingsBefore = this.#session.settings;
      this.#session = applyEvent(this.#session, event); this.#cursor = event.seq;
      this.#concept.update(this.#session);
      if (event.type === 'settings.changed') {
        // A changed model, effort or preset supersedes the running reply on the server:
        // its partial text goes, and late fragments tagged with an older revision are ignored.
        const after = this.#session.settings;
        if (presetBefore !== this.#session.processingPreset || settingsBefore?.model !== after.model || settingsBefore?.effort !== after.effort) {
          this.#partials.clear(); this.#reasoningRevision = after.revision ?? 0;
        }
        // Labels and verdicts belong to the old choice until the snapshot refresh confirms them.
        if (presetBefore !== this.#session.processingPreset) this.#modeChanged(presetBefore);
        this.#renderMode(); this.#dialog?.sync();
        if (this.isConnected) void this.#refreshFeatures();
      }
      if (event.type === 'session.paused') {
        this.#invalidatedAt = Math.max(this.#invalidatedAt, event.seq); this.#notice = '';
        if (event.data.paused) this.#deviceController?.abort(); else this.#pausePrompt = false;
        this.#rail.syncPause(event.data.paused);
      }
      if ((invalidation || event.type === 'session.paused') && this.isConnected) void this.#refreshFeatures();
      if (event.type === 'turn.final') {
        this.#partials.delete(event.data.id);
        if (event.data.role === 'user') { this.#partials.clear(); this.#failure = false; }
      }
      // Every upload state is new input: a running reply belongs to the input before it.
      if (event.type === 'upload.state') {
        this.#partials.clear(); this.#failure = false;
        // "Reading them…" ends with the last pending file; each chip then says how it went.
        if (this.#reading && this.#notice === this.#reading && !this.#session.uploads.some(u => u.state === 'pending')) this.#notice = '';
      }
      if (['understanding.updated', 'question.focused', 'turn.corrected'].includes(event.type)) {
        void this.#rail.updateContext().catch(() => {});
      }
      if (event.type === 'turn.corrected') {
        for (const selector of ['.summary-text', '.signals', '.questions', '.missing', '.cleared', '.overflow']) {
          const node = this.shadowRoot.querySelector(selector);
          node.style.minHeight = `${node.getBoundingClientRect().height}px`; node.dataset.redacted = ''; node.textContent = '';
        }
        const row = [...this.shadowRoot.querySelectorAll('.turn')].find(n => n.dataset.id === event.data.id);
        if (row) { row.style.minHeight = `${row.getBoundingClientRect().height}px`; row.querySelector('span').textContent = event.data.content; }
      }
      if (event.type === 'understanding.updated' && this.#session.operations?.lastFailure?.lane !== 'reaction') this.#failure = false;
      this.#host?.receive(event);
      this.dispatchEvent(new CustomEvent('aithema-event', { detail: event, bubbles: true, composed: true }));
    } else if (event.type === 'voice.state') {
      const voice = this.#rail.session;
      if (voice && ['closing', 'ended'].includes(event.data.state) && event.data.reason !== 'recovery-failed' &&
        voice.callId === event.data.callId && voice.providerSessionId === event.data.providerSessionId) void this.#rail.close(event.data.reason);
    } else if (event.type === 'turn.partial' && event.data.inputRevision === inputRevision(this.#session) &&
      (event.data.settingsRevision === undefined || event.data.settingsRevision >= this.#reasoningRevision)) {
      const existing = this.#partials.get(event.data.id);
      this.#partials.set(event.data.id, { id: event.data.id, role: 'assistant', partial: true,
        content: (existing?.content ?? '') + event.data.delta });
    } else if (event.type === 'lane.status' && event.data.inputRevision === inputRevision(this.#session)) {
      this.#session.operations = event.data; this.#restoreFailure();
    } else if (event.type === 'lane.failed' && (!event.data.inputRevision || event.data.inputRevision === inputRevision(this.#session))) {
      this.#failure = true; this.#partials.clear();
    }
    this.#render('features'); this.#render('transcript'); this.#render('aside'); this.#render('composer'); this.#rail.render();
  }
  async #refreshFeatures() {
    if (this.#session.processingPreset === 'device') return;
    const sessionId = this.#session.id;
    try {
      const response = await fetch(`${this.#base}/api/sessions/${sessionId}`, { headers: this.#headers() });
      if (!response.ok) return;
      const session = await response.json();
      if (sessionId !== this.#session.id || session.seq !== this.#cursor || session.id !== sessionId) return;
      this.#session.featureMatrix = session.featureMatrix;
      if (session.engine) this.#session.engine = session.engine;
      // A changed visuals choice can switch between images and drafts, and their cost.
      if (session.conceptVisualKind) this.#session.conceptVisualKind = session.conceptVisualKind;
      if ('conceptCost' in session) this.#session.conceptCost = session.conceptCost;
      this.#renderMode(); this.#rail.render(); this.#concept.update(this.#session); this.#dialog?.sync();
      this.#render('features'); this.#render('aside'); this.#render('composer'); this.#render('transcript');
      this.dispatchEvent(new CustomEvent('aithema-features', { bubbles: true, composed: true }));
    } catch { /* Existing verdicts stay closed until the host confirms coverage. */ }
  }
  async #restore() {
    const sessionId = this.#session.id;
    try {
      const response = await fetch(`${this.#base}/api/sessions/${sessionId}`, { headers: this.#headers() });
      if (!response.ok) throw new Error();
      const session = await response.json();
      if (sessionId !== this.#session.id) return;
      // A snapshot requested before a withdrawal must never restore its content.
      if (session.seq < this.#invalidatedAt) return;
      this.#session = session; this.#cursor = this.#session.seq; this.#partials.clear();
      this.#restoreFailure(); this.#concept.update(this.#session); this.#renderMode(); this.#dialog?.sync(); this.#host?.resync();
      this.#render('features'); this.#render('transcript'); this.#render('aside'); this.#render('composer');
      if (this.isConnected) this.#connect();
    } catch {
      if (sessionId !== this.#session.id) return;
      this.#connectionStatus(this.#copy.reconnecting);
      const controller = new AbortController(); this.#abort?.abort(); this.#abort = controller;
      await reconnectDelay(controller.signal);
      if (!controller.signal.aborted && sessionId === this.#session.id && this.isConnected) this.#connect();
    }
  }
  #connect() {
    if (this.#session.processingPreset === 'device') return;
    this.#abort?.abort(); const controller = new AbortController(); this.#abort = controller;
    void this.#events(controller.signal);
  }
  async #events(signal) {
    let attempt = 0;
    while (!signal.aborted) {
      let reader;
      try {
        this.#connectionStatus(this.#copy.connecting);
        const response = await fetch(`${this.#base}/api/sessions/${this.#session.id}/events`, {
          signal, headers: this.#headers({ 'Last-Event-ID': String(this.#cursor) }),
        });
        if (signal.aborted) return;
        if (response.status === 400) { await this.#restore(); return; }
        if (!response.ok) { if (response.status === 404) void this.#rail.close(); throw new Error(); }
        this.#connectionStatus(this.#copy.connected); reader = response.body.getReader();
        // A reconnect may follow a host restart: grants held in memory may be gone (D6).
        if (attempt++ > 0) void this.#refreshFeatures();
        for await (const event of serverEvents(reader)) { if (signal.aborted) break; this.receive(event); }
      } catch { if (signal.aborted) return; }
      finally { await reader?.cancel().catch(() => {}); }
      if (signal.aborted) return;
      if (this.#session.operations) this.#session.operations.running = [];
      attempt ||= 1;
      this.#partials.clear(); this.#render('transcript'); this.#render('aside'); this.#connectionStatus(this.#copy.reconnecting);
      await reconnectDelay(signal);
    }
  }
}
if (!customElements.get('aithema-session')) customElements.define('aithema-session', AithemaSession);
