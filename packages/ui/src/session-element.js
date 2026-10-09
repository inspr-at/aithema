import { applyEvent, inputRevision } from '../../core/src/session.js';
import { readinessScalePercent, readinessListItems, readinessListWindow, newlyClearedFirst } from '../../core/src/readiness.js';
import { displayedReadinessPercent } from '../../core/src/understanding.js';
import { PROCESSING_PRESETS, FEATURES, deviceFeatures } from '../../core/src/presets.js';
import { styles } from './styles.js';
import { postJson } from './post-json.js';

export class AithemaSession extends HTMLElement {
  #device; #deviceController; #copy; #session; #abort; #cursor = 0; #base; #partials = new Map(); #pending;
  #hover = new Set(); #dirty = new Set(); #open = []; #cleared = []; #failure = false;
  constructor() { super(); this.attachShadow({ mode: 'open' }); }
  configure({ copy, baseUrl = '', session, deviceReasoning }) {
    if (!copy || !session) throw new TypeError('Host copy and session required');
    this.#abort?.abort(); this.#deviceController?.abort(); this.#device = deviceReasoning; this.#copy = copy; this.#base = baseUrl.replace(/\/$/u, '');
    this.#session = structuredClone(session); this.#cursor = session.seq; this.#partials.clear();
    this.#restoreFailure(); this.#pending = null;
    this.#open = []; this.#cleared = []; this.#dirty.clear(); this.#hover.clear();
    this.#mount();
    if (this.isConnected) this.#connect();
  }
  connectedCallback() { if (this.#session) this.#connect(); }
  disconnectedCallback() { this.#abort?.abort(); this.#deviceController?.abort(); }
  get session() { return structuredClone(this.#session); }
  #mount() {
    const root = this.shadowRoot;
    // Static trusted markup only. All host/model/user copy is assigned through textContent.
    root.innerHTML = `<style>${styles}</style><div class="workspace">
      <section class="preset-panel"><label>Processing <select class="preset-choice"></select></label><ul class="features"></ul></section>
      <section class="conversation"><header class="head"><h2 data-copy="conversation"></h2><span class="status" role="status"></span></header>
        <div class="transcript-shell"><ol aria-live="polite"></ol></div>
        <form class="composer"><label for="message" data-copy="composer"></label><textarea id="message" maxlength="8000"></textarea>
          <div class="composer-actions"><small data-copy="shortcut"></small><button class="send" data-copy="send"></button></div></form></section>
      <aside class="understanding"><header class="head"><h2 data-copy="understanding"></h2></header>
        <section class="readiness"><div class="scale" role="progressbar" aria-valuemin="0" aria-valuemax="100"><span class="fill"></span><span class="marker"></span></div>
          <div class="scale-labels"><span data-copy="talk"></span><span data-copy="build"></span></div><p class="talk-progress"></p><p class="build-progress"></p></section>
        <div class="analysis-content"><p class="notice" role="status"></p><section><h3 data-copy="summary"></h3><p class="summary-text"></p></section>
          <section><h3 data-copy="signals"></h3><ul class="signals"></ul></section><section><h3 data-copy="questions"></h3><ul class="questions"></ul></section>
          <section><h3 data-copy="missing"></h3><ul class="missing"></ul><p class="overflow"></p></section>
          <section><div class="cleared-head"><h3 data-copy="clarified"></h3><button class="expand" type="button"></button></div><div class="cleared"></div></section></div>
        <footer class="foot"><a class="export" data-copy="export"></a><button class="retry" type="button" data-copy="retry" hidden></button></footer></aside></div>`;
    const labels = ['Best', 'EU', 'On my device', 'Custom'];
    PROCESSING_PRESETS.forEach((preset, i) => {
      const option = document.createElement('option'); option.value = preset; option.textContent = labels[i];
      root.querySelector('.preset-choice').append(option);
    });
    root.querySelector('.preset-choice').value = this.#session.processingPreset ?? 'best';
    root.querySelector('.preset-choice').addEventListener('change', e => {
      const processingPreset = e.target.value;
      e.target.value = this.#session.processingPreset ?? 'best';
      this.dispatchEvent(new CustomEvent('aithema-preset', { detail: { processingPreset }, bubbles: true, composed: true }));
    });
    root.querySelector('.preset-panel').addEventListener('pointerenter', () => this.#hover.add('features'));
    root.querySelector('.preset-panel').addEventListener('pointerleave', () => {
      this.#hover.delete('features'); if (this.#dirty.delete('features')) this.#render('features');
    });
    this.#render('features');
    for (const node of root.querySelectorAll('[data-copy]')) node.textContent = this.#copy[node.dataset.copy];
    root.querySelector('textarea').placeholder = this.#copy.placeholder;
    root.querySelector('.scale').setAttribute('aria-label', `${this.#copy.talk} — ${this.#copy.build}`);
    root.querySelector('.export').href = `${this.#base}/api/sessions/${this.#session.id}/export`;
    if (this.#session.processingPreset === 'device') {
      root.querySelector('.export').removeAttribute('href'); root.querySelector('.export').setAttribute('aria-disabled', 'true');
      root.querySelector('.export').title = 'Device export is unavailable';
    }
    root.querySelector('form').addEventListener('submit', e => { e.preventDefault(); void this.#send(); });
    root.querySelector('textarea').addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); void this.#send(); }
    });
    root.querySelector('.expand').addEventListener('click', () => {
      const details = [...root.querySelectorAll('details')];
      const expand = !details.every(d => d.open);
      details.forEach(d => { d.open = expand; }); this.#expandLabel();
    });
    root.querySelector('.retry').addEventListener('click', async () => {
      try {
        const response = await postJson(`${this.#base}/api/sessions/${this.#session.id}/retry`);
        if (!response.ok) throw new Error(); this.#failure = false; this.#render('aside');
      } catch { this.#status(this.#copy.reasoningFailed); }
    });
    // Automatic updates wait until the pointer leaves the region. Fixed outer sizes
    // and internal scrolling keep composer/export targets stable even during growth.
    for (const [selector, name] of [['.transcript-shell', 'transcript'], ['.understanding', 'aside']]) {
      const pane = root.querySelector(selector);
      pane.addEventListener('pointerenter', () => this.#hover.add(name));
      pane.addEventListener('pointerleave', () => {
        this.#hover.delete(name); if (this.#dirty.delete(name)) this.#render(name);
      });
    }
    this.#render('transcript'); this.#render('aside');
  }
  #status(value) { this.shadowRoot.querySelector('.status').textContent = value; }
  #restoreFailure() {
    const operations = this.#session.operations;
    this.#failure = operations?.inputRevision === inputRevision(this.#session) && Boolean(operations.lastFailure);
  }
  #render(part) {
    if (this.#hover.has(part)) { this.#dirty.add(part); return; }
    const root = this.shadowRoot, copy = this.#copy;
    const element = (tag, value, className) => {
      const node = document.createElement(tag); if (value !== undefined) node.textContent = value;
      if (className) node.className = className; return node;
    };
    if (part === 'features') {
      const preset = this.#session.processingPreset ?? 'best';
      const matrix = this.#session.featureMatrix?.[preset] ?? (preset === 'device' ? deviceFeatures() : {});
      root.querySelector('.features').replaceChildren(...FEATURES.map(feature => {
        const value = matrix[feature] ?? { available: false, reason: 'not configured' };
        const row = element('li', feature, value.available ? '' : 'unavailable');
        if (!value.available) row.append(element('span', value.reason)); return row;
      }));
      return;
    }
    if (part === 'transcript') {
      const list = root.querySelector('ol');
      list.replaceChildren(...[...this.#session.transcript, ...this.#partials.values()].map(t => {
        const row = element('li', undefined, `turn ${t.role === 'user' ? 'user' : ''} ${t.partial ? 'partial' : ''}`);
        row.dataset.id = t.id;
        row.append(element('strong', t.role === 'user' ? copy.you : copy.assistant), element('span', t.content)); return row;
      }));
      const shell = root.querySelector('.transcript-shell'); shell.scrollTop = shell.scrollHeight;
      return;
    }
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
    root.querySelector('.notice').textContent = this.#failure ? copy.reasoningFailed : !u.readinessAssessed ? copy.empty
      : stale ? copy.stale : u.draft ? copy.draft : copy.final;
    const revision = inputRevision(this.#session), operations = this.#session.operations;
    const running = operations?.inputRevision === revision && operations.running.length > 0;
    const hasPersonTurn = this.#session.transcript.some(t => t.role === 'user');
    const missingReply = hasPersonTurn && !this.#session.transcript.some(t => t.role === 'assistant' && t.inputRevision === revision);
    root.querySelector('.retry').hidden = this.#session.processingPreset === 'device' || Boolean(running) || !(this.#failure || hasPersonTurn && (stale || u.draft || missingReply));
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
    const old = new Map([...root.querySelectorAll('details')].map(d => [d.dataset.key, d]));
    root.querySelector('.cleared').replaceChildren(...cleared.map(i => {
      const details = old.get(i.key) ?? element('details'); details.dataset.key = i.key;
      const label = element('summary', i.label ?? i.detail), value = element('p', i.label ? i.detail : copy.none);
      if (i.evidence) { const evidence = element('blockquote', i.evidence); evidence.setAttribute('aria-label', copy.evidence); value.append(evidence); }
      details.replaceChildren(label, value); details.addEventListener('toggle', () => this.#expandLabel(), { once: true }); return details;
    }));
    this.#expandLabel();
  }
  #expandLabel() {
    const details = [...this.shadowRoot.querySelectorAll('details')], button = this.shadowRoot.querySelector('.expand');
    button.textContent = details.length && details.every(d => d.open) ? this.#copy.collapse : this.#copy.expand;
    button.disabled = !details.length;
  }
  async #send() {
    const root = this.shadowRoot, input = root.querySelector('textarea'), button = root.querySelector('.send');
    if (button.disabled || !input.value.trim()) return;
    const content = input.value;
    if (this.#session.processingPreset === 'device') { await this.#sendDevice(content); return; }
    const sessionId = this.#session.id;
    if (!this.#pending || this.#pending.content !== content) this.#pending = { clientEventId: crypto.randomUUID(), content };
    button.disabled = true; this.#status(this.#copy.sending);
    try {
      const response = await postJson(`${this.#base}/api/sessions/${sessionId}/turns`, this.#pending);
      if (!response.ok) throw new Error();
      const event = await response.json();
      if (sessionId !== this.#session.id) return;
      this.receive(event);
      if (input.value === content) input.value = '';
      this.#pending = null; this.#status(this.#copy.saved);
    } catch { if (sessionId === this.#session.id) this.#status(this.#copy.failed); }
    finally { button.disabled = false; }
  }
  async #sendDevice(content) {
    const root = this.shadowRoot, button = root.querySelector('.send'), input = root.querySelector('textarea');
    if (!this.#device) { this.#status('Connect a local model first'); return; }
    button.disabled = true; const controller = new AbortController(); this.#deviceController = controller;
    const sessionId = this.#session.id, deadlineAt = Date.now() + 180_000;
    const current = () => !controller.signal.aborted && sessionId === this.#session.id;
    try {
      await this.#device.connect({ signal: controller.signal, deadlineAt });
      if (!current()) return;
      this.receive({ seq: this.#cursor + 1, type: 'turn.final', data: { id: crypto.randomUUID(), role: 'user', content } });
      input.value = '';
      const id = crypto.randomUUID(), revision = inputRevision(this.#session); let answer = '';
      for await (const delta of this.#device.stream({ messages: this.#session.transcript.map(({ role, content }) => ({ role, content })) },
        { signal: controller.signal, deadlineAt })) {
        if (!current()) return; answer += delta;
        this.receive({ type: 'turn.partial', data: { id, delta, inputRevision: revision } });
      }
      if (current()) this.receive({ seq: this.#cursor + 1, type: 'turn.final', data: { id, role: 'assistant', content: answer, inputRevision: revision } });
      if (current()) this.#status('On my device — this conversation stays in this tab');
    } catch { if (current()) { this.#partials.clear(); this.#render('transcript'); this.#status('Local model unavailable'); } }
    finally { if (current()) button.disabled = false; }
  }
  receive(event) {
    if (event.sessionId && event.sessionId !== this.#session.id) return;
    if (event.seq) {
      if (event.seq <= this.#cursor) return;
      if (event.seq !== this.#cursor + 1) { this.#abort?.abort(); void this.#restore(); return; }
      this.#session = applyEvent(this.#session, event); this.#cursor = event.seq;
      if (event.type === 'turn.final') {
        this.#partials.delete(event.data.id);
        if (event.data.role === 'user') { this.#partials.clear(); this.#failure = false; }
      }
      if (event.type === 'understanding.updated' && this.#session.operations?.lastFailure?.lane !== 'reaction') this.#failure = false;
      this.dispatchEvent(new CustomEvent('aithema-event', { detail: event, bubbles: true, composed: true }));
    } else if (event.type === 'features.updated') {
      this.#session.featureMatrix = event.data; this.#render('features');
    } else if (event.type === 'turn.partial' && event.data.inputRevision === inputRevision(this.#session)) {
      const existing = this.#partials.get(event.data.id);
      this.#partials.set(event.data.id, { id: event.data.id, role: 'assistant', partial: true,
        content: (existing?.content ?? '') + event.data.delta });
    } else if (event.type === 'lane.status' && event.data.inputRevision === inputRevision(this.#session)) {
      this.#session.operations = event.data; this.#restoreFailure();
    } else if (event.type === 'lane.failed' && (!event.data.inputRevision || event.data.inputRevision === inputRevision(this.#session))) {
      this.#failure = true; this.#partials.clear();
    }
    this.#render('transcript'); this.#render('aside');
  }
  async #restore() {
    const sessionId = this.#session.id;
    try {
      const response = await fetch(`${this.#base}/api/sessions/${sessionId}`);
      if (!response.ok) throw new Error();
      const session = await response.json();
      if (sessionId !== this.#session.id) return;
      this.#session = session; this.#cursor = this.#session.seq; this.#partials.clear();
      this.#restoreFailure();
      this.#render('features'); this.#render('transcript'); this.#render('aside');
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
          signal, headers: { 'Last-Event-ID': String(this.#cursor) },
        });
        if (signal.aborted) return;
        if (response.status === 400) { await this.#restore(); return; }
        if (!response.ok) throw new Error();
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
