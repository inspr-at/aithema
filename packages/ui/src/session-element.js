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

export class AithemaSession extends HTMLElement {
  #concept; #rail; #voiceClient; #voiceClients; #voicePlayback; #deviceReasoning; #deviceController; #copy; #session; #sessionToken; #abort; #cursor = 0; #invalidatedAt = 0; #base; #partials = new Map(); #reasoningRevision = 0; #pending;
  #hover = new Set(); #dirty = new Set(); #open = []; #cleared = []; #failure = false; #sending = false;
  #dialog; #connector; #createDevice; #deviceEndpoint; #chooser = { choice: null, busy: false, error: '' };
  constructor() { super(); this.attachShadow({ mode: 'open' }); }
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
    this.#open = []; this.#cleared = []; this.#dirty.clear(); this.#hover.clear();
    this.#mount();
    if (this.isConnected) this.#connect();
    if (reopen) this.shadowRoot.querySelector('.settings-open').focus();
  }
  connectedCallback() { if (this.#session) { this.#concept?.connect(); this.#connect(); } }
  disconnectedCallback() { this.#concept?.suspend(); this.#rail?.destroy(); this.#abort?.abort(); this.#deviceController?.abort(); }
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
        <div class="audio-rail"></div><div class="concept-rail"></div><div class="transcript-shell"><div class="concept-preview-slot"></div><ol aria-live="polite"></ol></div><div class="intro" hidden></div>
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
    root.querySelector('.preset-panel').addEventListener('pointerenter', () => this.#hover.add('features'));
    root.querySelector('.preset-panel').addEventListener('pointerleave', () => {
      this.#hover.delete('features'); if (this.#dirty.delete('features')) this.#render('features');
    });
    this.#concept = new ConceptView({ root, copy: this.#copy, baseUrl: this.#base, sessionToken: this.#sessionToken,
      receive: event => this.receive(event), feature: () => this.#feature('images', true) });
    this.#concept.update(this.#session);
    this.#render('features');
    for (const node of root.querySelectorAll('[data-copy]')) node.textContent = this.#copy[node.dataset.copy];
    root.querySelector('textarea').placeholder = this.#copy.placeholder;
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
      feature: () => this.#feature('voice', true), playback: this.#voicePlayback,
      context: () => ({ understanding: this.#session.understanding, focusedQuestion: this.#session.focusedQuestion ?? null }),
      onEnd: () => {
        if (this.#pending) { delete this.#pending.voiceCallId; delete this.#pending.providerSessionId; }
      },
      onPause: paused => {
        this.#session.paused = paused;
        this.#render('features'); this.#render('composer'); this.#render('aside');
        if (this.isConnected) void this.#refreshFeatures();
      } });
    root.querySelector('.pause').addEventListener('click', async () => {
      const button = root.querySelector('.pause'), sessionId = this.#session.id;
      if (this.#rail.session) { await this.#rail.pause(!this.#session.paused); return; }
      button.disabled = true;
      try {
        const response = await postJson(`${this.#base}/api/sessions/${sessionId}/pause`, { paused: !this.#session.paused }, { sessionToken: this.#sessionToken });
        if (!response.ok) throw new Error();
        const ack = await response.json();
        if (sessionId === this.#session.id) this.receive(ack.event);
      } catch { if (sessionId === this.#session.id) this.#status(this.#copy.controlFailed); }
      finally { button.disabled = false; }
    });
    // Automatic updates wait until the pointer leaves the region. Fixed outer sizes
    // and internal scrolling keep composer/export targets stable even during growth.
    for (const [selector, name] of [['.transcript-shell', 'transcript'], ['.intro', 'transcript'], ['.understanding', 'aside']]) {
      const pane = root.querySelector(selector);
      pane.addEventListener('pointerenter', () => this.#hover.add(name));
      pane.addEventListener('pointerleave', () => {
        this.#hover.delete(name); if (this.#dirty.delete(name)) this.#render(name);
      });
    }
    this.#render('transcript'); this.#render('aside'); this.#render('composer');
  }
  #status(value) { this.shadowRoot.querySelector('.status').textContent = value; }
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
    return visitor && !value.available ? { ...value, reason: reasonText(this.#copy, value.reason) } : value;
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
    // The visitor's own acknowledged change may update the panel under the pointer.
    this.#renderMode();
    this.#render('features', true); this.#render('composer'); this.#render('aside'); this.#render('transcript', true); this.#rail.render();
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
  // `force` is for the visitor's own action: their click may change the region under the pointer.
  #render(part, force = false) {
    if (this.#hover.has(part) && !force) { this.#dirty.add(part); return; }
    const root = this.shadowRoot, copy = this.#copy;
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
      reason.textContent = text.available ? copy.shortcut : text.reason;
      reason.title = text.available ? '' : text.reason;
      return;
    }
    if (part === 'features') {
      this.#renderEngine();
      root.querySelector('.features').replaceChildren(...FEATURES.map(feature => {
        const value = this.#feature(feature, true);
        const row = element('li', copy.features[feature], value.available ? '' : 'unavailable');
        if (!value.available) row.append(element('span', value.reason)); return row;
      }));
      return;
    }
    if (part === 'transcript') {
      this.#renderIntro();
      const list = root.querySelector('ol');
      list.replaceChildren(...[...this.#session.transcript.filter(t => !t.erased || t.role === 'user'), ...this.#partials.values()].map(t => {
        const row = element('li', undefined, `turn ${t.role === 'user' ? 'user' : ''} ${t.partial ? 'partial' : ''}`);
        row.dataset.id = t.id;
        row.append(element('strong', t.role === 'user' ? copy.you : copy.assistant), element('span', t.erased ? copy.withdrawn : t.content));
        // Which acknowledged model and response style produced a reply.
        if (t.role === 'assistant' && !t.erased && t.engine?.label) {
          row.append(element('small', [t.engine.label, t.engine.effort && t.engine.effort !== 'none' ? copy.settings.efforts[t.engine.effort] ?? t.engine.effort : null]
            .filter(Boolean).join(' · '), 'engine-tag'));
        }
        if (t.role === 'user' && !t.erased) {
          const button = element('button', copy.withdraw, 'withdraw'); button.type = 'button';
          button.addEventListener('click', async () => {
            const sessionId = this.#session.id; button.disabled = true;
            try {
              if (this.#session.processingPreset === 'device') {
                this.#deviceController?.abort();
                this.receive({ sessionId, seq: this.#cursor + 1, type: 'turn.withdrawn',
                  data: { turnId: t.id, reason: 'withdrawal', at: new Date().toISOString() } });
                return;
              }
              const response = await postJson(`${this.#base}/api/sessions/${sessionId}/withdraw`, { turnId: t.id }, { sessionToken: this.#sessionToken });
              if (!response.ok) throw new Error();
              const ack = await response.json(); if (sessionId === this.#session.id) this.receive(ack.event);
            } catch { if (sessionId === this.#session.id) this.#status(copy.controlFailed); }
            finally { button.disabled = false; }
          });
          row.append(button);
        }
        return row;
      }));
      const shell = root.querySelector('.transcript-shell'); shell.scrollTop = shell.scrollHeight;
      return;
    }
    const analysis = this.#feature('analysis');
    const cached = this.#session.paused && this.#session.understanding.inputRevision !== null;
    for (const node of root.querySelectorAll('.analysis-content [data-redacted]')) {
      node.style.minHeight = ''; delete node.dataset.redacted;
    }
    root.querySelector('.understanding').setAttribute('aria-disabled', String(!analysis.available));
    // Keep the outer pane and readiness row in the grid when analysis is unavailable.
    root.querySelector('.readiness').style.visibility = analysis.available || cached ? '' : 'hidden';
    for (const section of root.querySelectorAll('.analysis-content section')) section.hidden = !analysis.available && !cached;
    const u = this.#session.understanding, stale = u.inputRevision !== inputRevision(this.#session);
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
      root.querySelector(selector).replaceChildren(...items.map(v => element('li', v)));
    }
    const items = readinessListItems(u.constraints, u.questionHistory, u.openQuestions, copy.constraints, this.#session.preset);
    const cleared = newlyClearedFirst(this.#open, this.#cleared, items.cleared);
    this.#open = items.open.map(i => i.key); this.#cleared = cleared.map(i => i.key);
    const window = readinessListWindow(items.open);
    root.querySelector('.missing').replaceChildren(...window.rows.map(i => {
      const row = element('li'); if (i.label) row.append(element('strong', i.label)); row.append(element('span', i.detail)); return row;
    }));
    root.querySelector('.overflow').textContent = window.remainder ? copy.more.replace('{count}', window.remainder) : '';
    const old = new Map([...root.querySelectorAll('.cleared details')].map(d => [d.dataset.key, d]));
    root.querySelector('.cleared').replaceChildren(...cleared.map(i => {
      const details = old.get(i.key) ?? element('details'); details.dataset.key = i.key;
      const label = element('summary', i.label ?? i.detail), value = element('p', i.label ? i.detail : copy.none);
      if (i.evidence) { const evidence = element('blockquote', i.evidence); evidence.setAttribute('aria-label', copy.evidence); value.append(evidence); }
      details.replaceChildren(label, value); details.addEventListener('toggle', () => this.#expandLabel(), { once: true }); return details;
    }));
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
    intro.replaceChildren(mode === 'ready' ? this.#readyCard() : this.#chooserCard());
    if (focus) intro.querySelector(`[data-focus-key="${focus}"]`)?.focus();
  }
  #chooserCard() {
    const copy = this.#copy, c = copy.chooser, current = this.#session.processingPreset ?? 'best', choice = this.#chooser.choice ?? current;
    const node = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
    const section = node('section', 'chooser'); section.setAttribute('aria-labelledby', 'chooser-title');
    const title = node('h3', '', c.title); title.id = 'chooser-title';
    const cards = node('div', 'chooser__list'); cards.setAttribute('role', 'group'); cards.setAttribute('aria-labelledby', 'chooser-title');
    for (const preset of PRESET_ORDER) {
      const verdict = this.#session.featureMatrix?.[preset]?.text;
      // Custom always opens settings; other presets are refused only for host reasons.
      const unavailable = preset !== 'custom' && preset !== current && verdict && !verdict.available && !isDynamicReason(verdict.reason);
      const card = node('button', 'chooser-option'); card.type = 'button'; card.dataset.focusKey = preset; card.dataset.preset = preset;
      card.setAttribute('aria-pressed', String(choice === preset)); card.setAttribute('aria-disabled', String(Boolean(unavailable)));
      const detail = node('span', 'chooser-option__detail'); detail.id = `chooser-${preset}-detail`;
      detail.append(node('span', '', c.lead[preset]), node('span', '', c.detail[preset]));
      card.setAttribute('aria-describedby', detail.id);
      const icon = node('span', 'chooser-option__icon'); icon.setAttribute('aria-hidden', 'true'); icon.innerHTML = ICONS[preset];
      const radio = node('span', 'radio'); radio.setAttribute('aria-hidden', 'true');
      const note = node('small', 'chooser-option__note', unavailable ? c.unavailable : '');
      if (unavailable) card.title = reasonText(copy, verdict.reason);
      const text = node('span', 'chooser-option__text'); text.append(node('strong', '', copy.presets[preset]), detail, note);
      card.append(radio, icon, text);
      card.addEventListener('click', () => {
        if (this.#chooser.busy) return;
        this.#chooser.error = unavailable ? `${copy.presets[preset]}: ${reasonText(copy, verdict.reason)}` : '';
        if (!unavailable) this.#chooser.choice = preset;
        this.#render('transcript', true);
      });
      cards.append(card);
    }
    const summary = node('div', 'chooser__summary');
    const live = node('strong', '', this.#chooser.busy ? c.saving : c.summary[choice] ?? c.choose); live.setAttribute('role', 'status');
    summary.append(live, ...[c.choose, c.saving, ...PRESET_ORDER.map(p => c.summary[p])].map(text => {
      const measure = node('strong', 'chooser__measure', text); measure.setAttribute('aria-hidden', 'true'); return measure;
    }));
    const hint = node('div', 'chooser__hint');
    hint.append(summary, node('span', '', (this.#session.settings?.origin === 'last' ? `${c.lastChoice} ` : '') + c.later));
    const go = node('button', 'chooser__continue'); go.type = 'button'; go.dataset.focusKey = 'continue'; go.disabled = this.#chooser.busy;
    const arrow = node('span', 'chooser__arrow'); arrow.setAttribute('aria-hidden', 'true'); arrow.innerHTML = ICONS.arrow;
    go.append(node('span', '', c.continue), arrow);
    go.addEventListener('click', () => void this.#confirmChoice(go));
    const action = node('div', 'chooser__action'); action.append(hint, go);
    const error = node('p', 'chooser__error', this.#chooser.error); error.setAttribute('role', 'alert');
    section.append(title, cards, action, error);
    return section;
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
    this.#chooser = { ...this.#chooser, busy: true, error: '' }; this.#render('transcript', true);
    const result = await this.#saveSettings(body);
    if (sessionId !== this.#session.id) return;
    this.#chooser.busy = false;
    if (!result.ok) {
      this.#chooser.error = result.error === 'setting-not-allowed' ? copy.settings.notAllowed.replace('{reason}', reasonText(copy, result.body.reason))
        : result.error === 'settings-conflict' ? copy.settings.conflict : copy.chooser.failed;
    }
    this.#render('transcript', true);
    if (result.ok) {
      const input = this.shadowRoot.querySelector('textarea');
      if (!input.disabled) input.focus(); else this.shadowRoot.querySelector('.ready__change')?.focus();
      // START continues into consent when the confirmed choice is not covered yet.
      if (result.ack.consent?.required) this.#requestConsent('chooser', result.ack.consent.features);
    } else this.shadowRoot.querySelector('.chooser__continue')?.focus();
  }
  #readyCard() {
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
    const section = document.createElement('section'); section.className = 'ready'; section.setAttribute('aria-labelledby', 'ready-title');
    const title = document.createElement('h3'); title.id = 'ready-title'; title.textContent = r.title;
    const list = document.createElement('dl');
    list.append(...rows.map(([id, label, value, state]) => {
      const row = document.createElement('div'); row.className = 'ready__row'; row.dataset.ready = id; row.dataset.state = state;
      const dt = document.createElement('dt'); dt.textContent = label;
      const dd = document.createElement('dd'), check = document.createElement('span'), text = document.createElement('span');
      check.className = 'ready__check'; check.setAttribute('aria-hidden', 'true'); check.textContent = '✓'; text.textContent = value;
      dd.append(check, text); row.append(dt, dd); return row;
    }));
    const change = document.createElement('button'); change.type = 'button'; change.className = 'ready__change'; change.dataset.focusKey = 'change';
    change.textContent = r.change; change.addEventListener('click', () => this.openSettings(change));
    const actions = document.createElement('div'); actions.className = 'ready__actions'; actions.append(change);
    if (['missing', 'withdrawn'].includes(consent)) {
      const ask = document.createElement('button'); ask.type = 'button'; ask.className = 'ready__consent'; ask.dataset.focusKey = 'consent';
      ask.textContent = copy.settings.reviewConsent; ask.addEventListener('click', () => this.#requestConsent('ready'));
      actions.append(ask);
    }
    section.append(title, list, actions);
    return section;
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
        // Redact sensitive content immediately; keep layout updates deferred.
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
        this.#invalidatedAt = Math.max(this.#invalidatedAt, event.seq);
        if (event.data.paused) this.#deviceController?.abort();
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
      this.#status(this.#copy.reconnecting); if (this.isConnected) this.#connect();
    }
  }
  #connect() {
    if (this.#session.processingPreset === 'device') return;
    this.#abort?.abort(); const controller = new AbortController(); this.#abort = controller;
    void this.#events(controller.signal);
  }
  async #events(signal) {
    while (!signal.aborted) {
      let reader;
      try {
        this.#status(this.#copy.connecting);
        const response = await fetch(`${this.#base}/api/sessions/${this.#session.id}/events`, {
          signal, headers: this.#headers({ 'Last-Event-ID': String(this.#cursor) }),
        });
        if (signal.aborted) return;
        if (response.status === 400) { await this.#restore(); return; }
        if (!response.ok) { if (response.status === 404) void this.#rail.close(); throw new Error(); }
        this.#status(this.#copy.connected); reader = response.body.getReader();
        let buffer = ''; const decoder = new TextDecoder();
        while (!signal.aborted) {
          const { done, value } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 2_000_000) throw new Error();
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('\n');
            if (data) this.receive(JSON.parse(data));
          }
        }
      } catch { if (signal.aborted) return; }
      finally { await reader?.cancel().catch(() => {}); }
      if (signal.aborted) return;
      if (this.#session.operations) this.#session.operations.running = [];
      this.#partials.clear(); this.#render('transcript'); this.#render('aside'); this.#status(this.#copy.reconnecting);
      await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, 1000); signal.addEventListener('abort', finish, { once: true });
      });
    }
  }
}
if (!customElements.get('aithema-session')) customElements.define('aithema-session', AithemaSession);
