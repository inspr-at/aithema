import { ConceptView } from './concept-view.js';
import { applyEvent, inputRevision, activeTurns } from '../../core/src/session.js';
import { readinessScalePercent, readinessListItems, readinessListWindow, newlyClearedFirst } from '../../core/src/readiness.js';
import { displayedReadinessPercent } from '../../core/src/understanding.js';
import { FEATURES, deviceFeatures } from '../../core/src/presets.js';
import { SETTINGS_OFF, isDynamicReason, isConsentReason } from '../../core/src/settings.js';
import { AudioRail } from './audio-rail.js';
import { styles } from './styles.js';
import { settingsStyles } from './settings-styles.js';
import { SettingsDialog, ICONS, PRESET_ORDER, reasonText, engineView } from './settings-dialog.js';
import { LocalConnector } from './local-connector.js';
import { postJson } from './post-json.js';
import { voiceJournal, tabStorage, closeVoiceCall, answerVoicePings, voiceCallAbandoned } from './voice-orphan.js';

const PANES = '.transcript-shell, .analysis-content, .preset-panel, .intro';
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
// Keyed children: an item whose key survives keeps its node (and with it focus and the
// pointer anchor); nodes move only when the order changed.
function reconcile(parent, entries, create, update) {
  const old = new Map([...parent.children].map(node => [node.dataset.key, node]));
  let next = parent.firstElementChild;
  for (const [key, value] of entries) {
    let node = old.get(key); old.delete(key);
    if (!node) { node = create(value); node.dataset.key = key; }
    update(node, value);
    if (node !== next) parent.insertBefore(node, next); else next = next.nextElementSibling;
  }
  for (const node of old.values()) node.remove();
}
function node(tag, className, text) {
  const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n;
}
function setText(node, value) { if (node.textContent !== value) node.textContent = value; }
const NONE = '\u0000none';
// Repeated values get distinct keys by occurrence.
function textKeys(values) {
  const seen = new Map();
  return values.map(value => { const n = seen.get(value) ?? 0; seen.set(value, n + 1); return [`${value}\u0000${n}`, value]; });
}

export class AithemaSession extends HTMLElement {
  #concept; #rail; #voiceClient; #voiceClients; #voicePlayback; #deviceReasoning; #deviceController; #copy; #session; #sessionToken; #abort; #cursor = 0; #invalidatedAt = 0; #base; #partials = new Map(); #reasoningRevision = 0; #pending;
  #open = []; #cleared = []; #failure = false; #sending = false;
  #pointer = null; #onTranscript = false; #follow = true; #connection = ''; #notice = ''; #journal; #orphan; #pings; #pausePrompt = false;
  #dialog; #connector; #createDevice; #deviceEndpoint; #chooser = { choice: null, busy: false, error: '' };
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
   */
  configure({ copy, baseUrl = '', session, sessionToken, deviceReasoning, deviceConnector, deviceEndpoint, voiceClient, voiceClients, voicePlayback }) {
    if (!copy || !session) throw new TypeError('Host copy and session required');
    const reopen = this.#dialog?.open;
    this.#concept?.destroy(); this.#rail?.destroy(); this.#voiceClient = voiceClient; this.#voiceClients = voiceClients; this.#voicePlayback = voicePlayback;
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
    this.#invalidatedAt = 0; this.#chooser = { choice: null, busy: false, error: '' };
    this.#open = []; this.#cleared = []; this.#follow = true; this.#onTranscript = false; this.#notice = ''; this.#connection = '';
    // A page that loads paused stays paused until the person resumes it (AIT-116 D4).
    this.#pausePrompt = Boolean(session.paused);
    // Every conversation keeps a journal: a choice at conversation start can switch it out of
    // On my device in place, and a device conversation never starts a call, so its journal stays empty.
    this.#journal = voiceJournal(tabStorage(), session.id);
    this.#mount();
    this.#pings ??= answerVoicePings(() => this.#rail?.session?.callId ?? null);
    this.#orphan = this.#endOrphanedCall();
    if (this.isConnected) { this.#connect(); this.#watchPage(true); this.#offerResume(); }
    if (reopen) this.shadowRoot.querySelector('.settings-open').focus();
  }
  connectedCallback() {
    if (!this.#session) return;
    this.#pings ??= answerVoicePings(() => this.#rail?.session?.callId ?? null);
    this.#concept?.connect(); this.#connect(); this.#watchPage(true); this.#offerResume();
  }
  disconnectedCallback() {
    this.#watchPage(false); this.#concept?.suspend(); this.#rail?.destroy(); this.#abort?.abort(); this.#deviceController?.abort();
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
    root.innerHTML = `<style>${styles}${settingsStyles}</style><div class="workspace">
      <section class="preset-panel"><div class="engine"><div class="engine__text"><span class="engine__label" data-copy="processing"></span>
          <strong class="engine__value"></strong><span class="engine__detail"></span></div>
        <button class="settings-open" type="button" aria-haspopup="dialog">${ICONS.gear}<span></span></button></div><ul class="features"></ul></section>
      <section class="conversation"><header class="head"><h2 data-copy="conversation"></h2><button class="pause" type="button"></button><span class="status" role="status"></span></header>
        <div class="audio-rail"></div><div class="concept-rail"></div><div class="transcript-shell"><div class="concept-preview-slot"></div><ol aria-live="polite"></ol><button class="transcript-latest" type="button" data-copy="transcriptLatest" style="visibility:hidden"></button></div><div class="intro" hidden></div>
        <form class="composer"><label for="message" data-copy="composer"></label><textarea id="message" maxlength="8000"></textarea>
          <div class="composer-actions"><small class="composer-reason" role="status" id="composer-reason"></small><button class="send" data-copy="send"></button></div></form></section>
      <aside class="understanding"><header class="head"><h2 data-copy="understanding"></h2><button class="concept-tab" type="button" data-copy="conceptTab"></button></header>
        <section class="readiness"><div class="scale" role="progressbar" aria-valuemin="0" aria-valuemax="100"><span class="fill"></span><span class="marker"></span></div>
          <div class="scale-labels"><span data-copy="talk"></span><span data-copy="build"></span></div><p class="talk-progress"></p><p class="build-progress"></p></section>
        <div class="analysis-content"><p class="notice" role="status"></p><section><h3 data-copy="summary"></h3><p class="summary-text"></p></section>
          <section><h3 data-copy="signals"></h3><ul class="signals"></ul></section><section><h3 data-copy="questions"></h3><ul class="questions"></ul></section>
          <section><h3 data-copy="missing"></h3><ul class="missing"></ul><p class="overflow"></p></section>
          <section><div class="cleared-head"><h3 data-copy="clarified"></h3><button class="expand" type="button"></button></div><div class="cleared"></div></section></div>
        <footer class="foot"><a class="export" data-copy="export"></a><button class="retry" type="button" data-copy="retry" hidden></button></footer></aside></div>
      <dialog class="settings"></dialog>`;
    root.querySelector('.settings-open span').textContent = this.#copy.settings.open;
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
      receive: event => this.receive(event), feature: () => this.#feature('images', true) });
    this.#concept.update(this.#session);
    this.#render('features');
    for (const node of root.querySelectorAll('[data-copy]')) node.textContent = this.#copy[node.dataset.copy];
    root.querySelector('textarea').placeholder = this.#copy.placeholder;
    root.querySelector('.transcript-latest').addEventListener('click', () => this.#scrollToLatest());
    root.querySelector('textarea').setAttribute('aria-describedby', 'composer-reason');
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
      ready: () => this.#orphan, onState: () => this.#clearNotice(),
      context: () => ({ understanding: this.#session.understanding, focusedQuestion: this.#session.focusedQuestion ?? null }),
      onEnd: () => {
        if (this.#pending) { delete this.#pending.voiceCallId; delete this.#pending.providerSessionId; }
      },
      onPause: paused => {
        this.#session.paused = paused; this.#clearNotice();
        this.#render('features'); this.#render('composer'); this.#render('aside');
        if (this.isConnected) void this.#refreshFeatures();
      } });
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
    shell.addEventListener('pointerleave', () => { this.#onTranscript = false; if (this.#follow) this.#scrollToLatest(); });
    for (const pane of root.querySelectorAll(PANES)) pane.addEventListener('pointerleave', () => clearSlack(pane));
    this.#render('transcript'); this.#render('aside'); this.#render('composer');
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
    const chain = [];
    for (let node = hovered; node && node !== this.shadowRoot; node = node.parentNode) chain.push([node, node.getBoundingClientRect().top]);
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
    this.#paintStatus();
    root.querySelector('.pause').textContent = this.#session.paused ? copy.resume : copy.pause;
    root.querySelector('.pause').setAttribute('aria-pressed', String(this.#session.paused));
    const element = (tag, value, className) => {
      const node = document.createElement(tag); if (value !== undefined) node.textContent = value;
      if (className) node.className = className; return node;
    };
    if (part === 'composer') {
      const text = this.#feature('text', true);
      root.querySelector('textarea').disabled = !text.available;
      root.querySelector('.send').disabled = this.#sending || !text.available;
      const reason = root.querySelector('.composer-reason');
      const mac = /Mac|iPhone|iPad/u.test(globalThis.navigator?.platform ?? '');
      reason.textContent = text.available ? copy.shortcut.replace('{key}', copy.shortcutKeys?.[mac ? 'mac' : 'other'] ?? '') : text.reason;
      reason.title = text.available ? '' : text.reason;
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
      // Rows are keyed by turn id and updated in place: new turns append below, and
      // focus and the hovered row survive updates. Superseded partials lose their rows.
      const list = root.querySelector('ol'), shell = root.querySelector('.transcript-shell');
      const turns = [...this.#session.transcript.filter(t => !t.erased || t.role === 'user'), ...this.#partials.values()];
      const rows = new Map([...list.children].map(row => [row.dataset.id, row]));
      const hovered = this.#onTranscript, count = list.children.length;
      let next = list.firstElementChild;
      for (const t of turns) {
        let row = rows.get(t.id); rows.delete(t.id);
        if (!row) {
          row = element('li'); row.dataset.id = t.id; row.append(element('strong'), element('span'));
        }
        row.className = `turn ${t.role === 'user' ? 'user' : ''} ${t.partial ? 'partial' : ''}`;
        // Redacted rows keep their height only while the pointer rests on the transcript.
        if (!hovered) row.style.minHeight = '';
        row.querySelector('strong').textContent = t.role === 'user' ? copy.you : copy.assistant;
        row.querySelector('span').textContent = t.erased ? copy.withdrawn : t.content;
        // Which acknowledged model and response style produced a reply.
        const engine = t.role === 'assistant' && !t.erased && t.engine?.label ? [t.engine.label,
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
    const analysis = this.#feature('analysis', true);
    const cached = this.#session.paused && this.#session.understanding.inputRevision !== null;
    for (const node of root.querySelectorAll('.analysis-content [data-redacted]')) {
      node.style.minHeight = ''; delete node.dataset.redacted;
    }
    root.querySelector('.understanding').setAttribute('aria-disabled', String(!analysis.available));
    // Keep the outer pane and readiness row in the grid when analysis is unavailable.
    root.querySelector('.readiness').style.visibility = analysis.available || cached ? '' : 'hidden';
    const u = this.#session.understanding, stale = u.inputRevision !== inputRevision(this.#session);
    // Sections appear with the first assessment; empty lists then say so quietly (D15).
    for (const section of root.querySelectorAll('.analysis-content section')) section.hidden = !analysis.available && !cached || !u.readinessAssessed;
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
    root.querySelector('.retry').hidden = !analysis.available || Boolean(running) || !(this.#failure || hasPersonTurn && (stale || u.draft || missingReply));
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
  #engineDetail() {
    const copy = this.#copy, preset = this.#session.processingPreset ?? 'best', view = engineView(this.#session);
    if (preset === 'device') return `${copy.engine.localModel}: ${this.#device?.model ?? copy.engine.notConnected}`;
    const name = value => value === SETTINGS_OFF ? copy.engine.off : value.label ?? value.id;
    return [view.model && [name(view.model), view.effort && view.effort !== 'none' ? copy.settings.efforts[view.effort] ?? view.effort : null].filter(Boolean).join(' · '),
      `${copy.engine.voice}: ${name(view.voice)}`, `${copy.engine.visuals}: ${name(view.visuals)}`].filter(Boolean).join(' · ');
  }
  #renderEngine() {
    const root = this.shadowRoot, preset = this.#session.processingPreset ?? 'best';
    root.querySelector('.engine__value').textContent = this.#copy.presets[preset] ?? preset;
    root.querySelector('.engine__detail').textContent = this.#engineDetail();
    root.querySelector('.engine__detail').title = this.#engineDetail();
  }
  // Conversation start (START LandingPresets and ConversationReadiness): a preset chooser
  // until the visitor confirms a choice, then the ready card until the first message.
  #renderIntro() {
    const root = this.shadowRoot, intro = root.querySelector('.intro'), active = root.activeElement;
    const focus = active && intro.contains(active) ? active.dataset.focusKey : null;
    const started = this.#session.transcript.length || this.#partials.size || this.#session.tombstone;
    const mode = started ? '' : (this.#session.settings?.origin ?? 'default') === 'chosen' ? 'ready' : 'chooser';
    // The chooser covers the call and concept rails until a choice exists; the ready
    // card covers only the still empty transcript, so a call can start from it.
    for (const selector of ['.audio-rail', '.concept-rail']) root.querySelector(selector).inert = mode === 'chooser';
    intro.dataset.mode = mode; intro.hidden = !mode;
    if (!mode) { intro.replaceChildren(); return; }
    // The card is built once per mode and its controls are keyed and updated in place, so a
    // live update keeps the hovered and focused nodes, and #anchored keeps them still (AIT-116 D2).
    if (intro.firstElementChild?.className !== mode) intro.replaceChildren(mode === 'ready' ? this.#readyCard() : this.#chooserCard());
    if (mode === 'ready') this.#paintReady(intro.firstElementChild); else this.#paintChooser(intro.firstElementChild);
    if (focus && !intro.contains(root.activeElement)) intro.querySelector(`[data-focus-key="${focus}"]`)?.focus();
  }
  // A preset other than the acknowledged one is refused at the start only for host reasons;
  // Custom always opens settings.
  #presetRefusal(preset) {
    const verdict = this.#session.featureMatrix?.[preset]?.text;
    const refused = preset !== 'custom' && preset !== (this.#session.processingPreset ?? 'best') && verdict && !verdict.available && !isDynamicReason(verdict.reason);
    return refused ? verdict.reason : null;
  }
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
    const go = node('button', 'chooser__continue'); go.type = 'button'; go.dataset.focusKey = 'continue';
    const arrow = node('span', 'chooser__arrow'); arrow.setAttribute('aria-hidden', 'true'); arrow.innerHTML = ICONS.arrow;
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
    card.setAttribute('aria-describedby', detail.id);
    const icon = node('span', 'chooser-option__icon'); icon.setAttribute('aria-hidden', 'true'); icon.innerHTML = ICONS[preset];
    const radio = node('span', 'radio'); radio.setAttribute('aria-hidden', 'true');
    const text = node('span', 'chooser-option__text'); text.append(node('strong', '', copy.presets[preset]), detail, node('small', 'chooser-option__note'));
    card.append(radio, icon, text);
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
      const input = this.shadowRoot.querySelector('textarea');
      if (!input.disabled) input.focus(); else this.shadowRoot.querySelector('.ready__change')?.focus();
      // START continues into consent when the confirmed choice is not covered yet.
      if (result.ack.consent?.required) this.#requestConsent('chooser', result.ack.consent.features);
    } else this.shadowRoot.querySelector('.chooser__continue')?.focus();
  }
  #readyCard() {
    const section = document.createElement('section'); section.className = 'ready'; section.setAttribute('aria-labelledby', 'ready-title');
    const title = document.createElement('h3'); title.id = 'ready-title'; title.textContent = this.#copy.ready.title;
    const actions = document.createElement('div'); actions.className = 'ready__actions';
    section.append(title, document.createElement('dl'), actions);
    return section;
  }
  #paintReady(section) {
    const copy = this.#copy, r = copy.ready, device = this.#session.processingPreset === 'device', view = engineView(this.#session);
    const consent = this.#consentState(), local = this.#device?.model;
    const voice = device ? SETTINGS_OFF : view.voice, visuals = device ? SETTINGS_OFF : view.visuals;
    const effort = view.effort, model = view.model?.label ?? view.model?.id;
    const rows = [
      ['model', r.model, device ? local ? `${copy.engine.localModel}: ${local}` : r.notConnected
        : [model, effort && effort !== 'none' ? copy.settings.efforts[effort] ?? effort : null].filter(Boolean).join(' · '), device && !local ? 'pending' : 'selected'],
      ['consent', r.consent, consent === 'device' ? r.notNeeded : consent === 'granted' ? r.granted : r.missing, ['device', 'granted'].includes(consent) ? 'confirmed' : 'pending'],
      ['microphone', r.microphone, voice !== SETTINGS_OFF ? r.checkOnStart : r.off, voice !== SETTINGS_OFF ? 'pending' : 'off'],
      ['speaker', r.speaker, voice !== SETTINGS_OFF ? r.onOnStart : r.off, voice !== SETTINGS_OFF ? 'selected' : 'off'],
      ['visuals', r.visuals, visuals !== SETTINGS_OFF ? r.on : r.off, visuals !== SETTINGS_OFF ? 'selected' : 'off'],
    ];
    reconcile(section.querySelector('dl'), rows.map(row => [row[0], row]), ([id]) => {
      const row = document.createElement('div'); row.className = 'ready__row'; row.dataset.ready = id;
      const dd = document.createElement('dd'), check = document.createElement('span');
      check.className = 'ready__check'; check.setAttribute('aria-hidden', 'true'); check.textContent = '✓';
      dd.append(check, document.createElement('span')); row.append(document.createElement('dt'), dd); return row;
    }, (row, [, label, value, state]) => {
      row.dataset.state = state; setText(row.querySelector('dt'), label); setText(row.querySelector('dd > span:last-child'), value);
    });
    const actions = ['change', ...['missing', 'withdrawn'].includes(consent) ? ['consent'] : []];
    reconcile(section.querySelector('.ready__actions'), actions.map(action => [action, action]), action => {
      const button = document.createElement('button'); button.type = 'button'; button.className = `ready__${action}`; button.dataset.focusKey = action;
      button.textContent = action === 'change' ? r.change : copy.settings.reviewConsent;
      button.addEventListener('click', () => { if (action === 'change') this.openSettings(button); else this.#requestConsent('ready'); });
      return button;
    }, () => {});
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
      const id = crypto.randomUUID(), revision = inputRevision(this.#session); let answer = '';
      for await (const delta of device.stream({ messages: activeTurns(this.#session).map(({ role, content }) => ({ role, content })) },
        { signal: controller.signal, deadlineAt })) {
        if (!current()) return; answer += delta;
        this.receive({ type: 'turn.partial', data: { id, delta, inputRevision: revision } });
      }
      if (current()) this.receive({ seq: this.#cursor + 1, type: 'turn.final', data: { id, role: 'assistant', content: answer, inputRevision: revision } });
      if (current()) this.#status(this.#copy.deviceConversation);
    } catch { if (current()) { this.#partials.clear(); this.#render('transcript'); this.#status(this.#copy.deviceUnavailable); } }
    finally { if (sessionId === this.#session.id) { this.#sending = false; button.disabled = !this.#feature('text').available; this.#render('composer'); } }
  }
  receive(event) {
    if (event.sessionId && event.sessionId !== this.#session.id) return;
    if (event.seq) {
      if (event.seq <= this.#cursor) return;
      const invalidation = ['turn.withdrawn', 'session.erased', 'consent.revised'].includes(event.type);
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
      this.#restoreFailure(); this.#concept.update(this.#session); this.#renderMode(); this.#dialog?.sync();
      this.#render('features'); this.#render('transcript'); this.#render('aside'); this.#render('composer');
      if (this.isConnected) this.#connect();
    } catch {
      if (sessionId !== this.#session.id) return;
      this.#connectionStatus(this.#copy.reconnecting); if (this.isConnected) this.#connect();
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
      await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, 1000); signal.addEventListener('abort', finish, { once: true });
      });
    }
  }
}
if (!customElements.get('aithema-session')) customElements.define('aithema-session', AithemaSession);
