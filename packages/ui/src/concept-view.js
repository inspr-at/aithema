import { postJson } from './post-json.js';

// START generated-ui-progress: estimates reserve completion for durable success.
export function conceptProgress(status, now = Date.now()) {
  const elapsed = Math.max(0, now - status.startedAt), duration = Math.max(1000, status.estimateMs ?? 45000);
  return { percent: Math.min(99, Math.floor(elapsed / duration * 100)), seconds: Math.max(0, Math.ceil((duration - elapsed) / 1000)), overdue: elapsed >= duration };
}

/** Generic START viewer experience, private owner-authenticated bytes only. */
export class ConceptView {
  #session; #selected; #seen = new Set(); #urls = new Map(); #loads = new Map(); #epoch = 0;
  #busy = false; #trigger; #timer; #touchX;
  constructor({ root, copy, baseUrl, sessionToken, receive, feature }) {
    Object.assign(this, { root, copy, baseUrl, sessionToken, receive, feature });
    this.visibility = () => { if (root.ownerDocument.hidden) void this.endEligibility(); };
    this.pagehide = () => { void this.endEligibility(); };
    root.querySelector('.concept-rail').innerHTML = `<div class="concept-scene" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <div class="concept-activity"><span class="concept-activity-text" role="status"></span><progress class="concept-progress" max="100" value="0"></progress><small class="concept-countdown"></small></div>
      <button class="concept-request" type="button"></button>`;
    root.querySelector('.concept-preview-slot').innerHTML = `<button class="concept-preview" type="button"><img alt="" decoding="async"><span class="concept-preview-label"></span></button>`;
    const dialog = document.createElement('dialog'); dialog.className = 'concept-viewer'; dialog.setAttribute('aria-labelledby', 'concept-title');
    dialog.innerHTML = `<header class="concept-viewer-head"><h2 id="concept-title"></h2><span class="concept-count" aria-live="polite"></span><button class="concept-close" type="button"></button></header>
      <div class="concept-stage"><img class="concept-image" decoding="async"><p class="concept-image-status" role="status"></p></div>
      <footer class="concept-viewer-controls"><div class="concept-navigation"><button class="concept-previous" type="button"></button><button class="concept-next" type="button"></button><button class="concept-download" type="button"></button><button class="concept-regenerate" type="button"></button></div>
        <p class="concept-disclosure"></p><div class="concept-feedback"><button class="concept-up" type="button"></button><button class="concept-down" type="button"></button><button class="concept-reject" type="button"></button></div>
        <div class="concept-guidance-options"></div><div class="concept-guidance-selected" aria-live="polite"></div><p class="concept-viewer-message" role="status"></p></footer>`;
    root.append(dialog); this.dialog = dialog;
    const labels = { '.concept-close': 'conceptClose', '.concept-previous': 'conceptPrevious', '.concept-next': 'conceptNext',
      '.concept-download': 'conceptDownload', '.concept-up': 'conceptUp', '.concept-down': 'conceptDown', '.concept-reject': 'conceptReject', '.concept-preview-label': 'conceptView' };
    for (const [selector, key] of Object.entries(labels)) root.querySelector(selector).textContent = copy[key];
    root.querySelector('.concept-image').alt = copy.conceptImageAlt;
    root.querySelector('.concept-preview').setAttribute('aria-label', copy.conceptView);
    root.querySelector('.concept-request').addEventListener('click', () => void this.request());
    root.querySelector('.concept-regenerate').addEventListener('click', () => void this.request(this.#selected));
    root.querySelector('.concept-tab').addEventListener('click', () => this.open());
    root.querySelector('.concept-preview').addEventListener('click', () => this.open());
    root.querySelector('.concept-close').addEventListener('click', () => this.close());
    root.querySelector('.concept-previous').addEventListener('click', () => this.navigate(-1));
    root.querySelector('.concept-next').addEventListener('click', () => this.navigate(1));
    root.querySelector('.concept-download').addEventListener('click', () => void this.download());
    for (const vote of ['up', 'down']) root.querySelector('.concept-' + vote).addEventListener('click', () => {
      const current = this.current(); void this.feedback(current?.feedback?.vote === vote ? 'clear' : vote, current?.feedback?.chips ?? []);
    });
    root.querySelector('.concept-reject').addEventListener('click', () => void this.feedback('down', this.current()?.feedback?.chips ?? [], true));
    for (const value of copy.conceptGuidance) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = value;
      button.addEventListener('click', () => { const current = this.current(), chips = current?.feedback?.chips ?? [];
        if (!chips.includes(value)) void this.feedback(current?.feedback?.vote ?? 'clear', [...chips, value]); });
      root.querySelector('.concept-guidance-options').append(button);
    }
    dialog.addEventListener('cancel', e => { e.preventDefault(); this.close(); });
    dialog.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); this.close(); }
      if (!['INPUT', 'TEXTAREA'].includes(e.target.tagName) && ['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); this.navigate(e.key === 'ArrowLeft' ? -1 : 1); }
      // Keep keyboard focus in the single immersive viewer, including hosts whose
      // dialog polyfill doesn't implement native focus containment.
      if (e.key === 'Tab') {
        const buttons = [...dialog.querySelectorAll('button')].filter(b => !b.disabled && !b.hidden);
        const index = buttons.indexOf(root.activeElement); e.preventDefault(); buttons[(index + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }
    });
    const stage = root.querySelector('.concept-stage');
    stage.addEventListener('touchstart', e => { this.#touchX = e.touches[0]?.clientX; }, { passive: true });
    stage.addEventListener('touchend', e => { const delta = e.changedTouches[0]?.clientX - this.#touchX; if (Math.abs(delta) > 60) this.navigate(delta > 0 ? -1 : 1); }, { passive: true });
    this.connect();
  }
  get items() { return (this.#session?.concepts ?? []).filter(c => !c.archived && !c.erased); }
  current() { return this.items.find(c => c.id === this.#selected); }
  path(suffix = '') { return `${this.baseUrl}/api/sessions/${this.#session.id}/concepts${suffix}`; }
  sameOrigin(path) {
    const location = this.root.ownerDocument.defaultView?.location;
    if (location?.origin && location.origin !== 'null' && new URL(path, location.href).origin !== location.origin) throw new Error('Concept images require same-origin routes');
    return path;
  }
  connect() {
    this.root.ownerDocument.addEventListener('visibilitychange', this.visibility);
    this.root.ownerDocument.defaultView?.addEventListener('pagehide', this.pagehide);
    if (!this.#timer) { this.#timer = setInterval(() => this.progress(), 1000); this.#timer.unref?.(); }
  }
  suspend() {
    this.root.ownerDocument.removeEventListener('visibilitychange', this.visibility);
    this.root.ownerDocument.defaultView?.removeEventListener('pagehide', this.pagehide);
    this.#epoch++; clearInterval(this.#timer); this.#timer = null; for (const url of this.#urls.values()) URL.revokeObjectURL(url); this.#urls.clear(); this.close();
  }
  async endEligibility() {
    if (!this.#session || this.#session.tombstone || this.#session.processingPreset === 'device') return;
    const sessionId = this.#session.id;
    try {
      const response = await postJson(this.sameOrigin(this.path('/eligibility')), { eligible: false }, { sessionToken: this.sessionToken, keepalive: true });
      if (!response.ok) return;
      const ack = await response.json(); if (sessionId === this.#session.id && ack.event) this.receive(ack.event);
    } catch { /* Server idle spending is disabled even if teardown loses this signal. */ }
  }
  headers() { return this.sessionToken ? { 'x-aithema-session-token': this.sessionToken } : {}; }
  update(session) {
    const changedOwner = this.#session && this.#session.id !== session.id;
    this.#session = session;
    const valid = new Set((session.concepts ?? []).filter(c => !c.erased).map(c => c.id));
    if (changedOwner || session.consentWithdrawn || session.tombstone) valid.clear();
    for (const [id, url] of this.#urls) if (!valid.has(id)) { URL.revokeObjectURL(url); this.#urls.delete(id); }
    // Redact revoked content immediately.
    if (changedOwner || session.consentWithdrawn || session.tombstone || this.#selected && !valid.has(this.#selected)) {
      this.#epoch++; this.root.querySelector('.concept-image').removeAttribute('src'); this.root.querySelector('.concept-disclosure').textContent = '';
      this.root.querySelector('.concept-guidance-selected').textContent = ''; this.close();
    }
    const latest = this.items.at(-1);
    if (!latest) this.root.querySelector('.concept-preview img').removeAttribute('src');
    this.render();
  }
  progress() {
    if (!this.#session) return;
    const status = this.#session.conceptStatus ?? { phase: 'idle' }, node = this.root.querySelector('.concept-progress');
    const text = this.root.querySelector('.concept-activity-text'), countdown = this.root.querySelector('.concept-countdown');
    const feature = this.feature();
    if (status.phase === 'pending') {
      const estimate = conceptProgress(status); node.value = estimate.percent;
      text.textContent = this.copy.conceptRendering; countdown.textContent = estimate.overdue ? this.copy.conceptOverdue : this.copy.conceptCountdown.replace('{seconds}', estimate.seconds);
    } else {
      node.value = status.phase === 'ready' ? 100 : 0; countdown.textContent = '';
      text.textContent = status.phase === 'failed' ? this.copy.conceptFailed : status.phase === 'waiting' ? this.copy.conceptWaiting
        : this.items.length ? this.copy.conceptReady : feature.available ? this.copy.conceptIntro : feature.reason;
    }
    this.root.querySelector('.concept-rail').dataset.phase = status.phase;
  }
  // Every control keeps a fixed slot, so state renders at once, also under the pointer (AIT-116 D3).
  render() {
    this.progress();
    const latest = this.items.at(-1), tab = this.root.querySelector('.concept-tab');
    tab.dataset.unread = String(Boolean(latest && !this.#seen.has(latest.id))); tab.disabled = !latest;
    tab.title = latest ? this.copy.conceptView : this.feature().reason ?? this.copy.conceptIntro;
    const preview = this.root.querySelector('.concept-preview'); preview.disabled = !latest; preview.style.visibility = latest ? '' : 'hidden';
    if (latest) void this.load(latest.id).then(url => { if (this.items.at(-1)?.id === latest.id && url) preview.querySelector('img').src = url; });
    this.gates();
    if (!this.dialog.open) return;
    let current = this.current();
    if (!current) { this.#selected = latest?.id; current = latest; }
    if (!current) { this.close(); return; }
    const index = this.items.findIndex(c => c.id === current.id);
    this.root.querySelector('#concept-title').textContent = this.copy.conceptTitle.replace('{number}', index + 1);
    this.root.querySelector('.concept-count').textContent = this.copy.conceptCount.replace('{current}', index + 1).replace('{count}', this.items.length);
    this.root.querySelector('.concept-previous').disabled = index <= 0; this.root.querySelector('.concept-next').disabled = index >= this.items.length - 1;
    const fake = current.provenance?.generator?.provider === 'local-demo-fake';
    this.root.querySelector('.concept-disclosure').textContent = fake ? this.copy.conceptFake : current.provenance?.origin === 'ai-manipulated' ? this.copy.conceptManipulated : this.copy.conceptGenerated;
    for (const vote of ['up', 'down']) this.root.querySelector('.concept-' + vote).setAttribute('aria-pressed', String(current.feedback?.vote === vote));
    this.root.querySelector('.concept-guidance-selected').replaceChildren(...(current.feedback?.chips ?? []).map(value => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = this.copy.conceptRemoveGuidance.replace('{guidance}', value);
      button.addEventListener('click', () => void this.feedback(current.feedback.vote, current.feedback.chips.filter(c => c !== value))); return button;
    }));
    const image = this.root.querySelector('.concept-image'), imageStatus = this.root.querySelector('.concept-image-status');
    if (image.dataset.id !== current.id) { image.removeAttribute('src'); image.dataset.id = current.id; }
    imageStatus.textContent = this.copy.conceptLoading;
    void this.load(current.id).then(url => { if (this.current()?.id === current.id && this.dialog.open) {
      if (url) image.src = url; imageStatus.textContent = url ? '' : this.copy.conceptImageFailed;
    } });
  }
  gates() {
    const feature = this.feature(), pending = this.#session?.conceptStatus?.phase === 'pending';
    const source = this.#session?.transcript.some(t => t.role === 'user' && !t.erased && !t.withdrawn);
    const cost = this.#session?.conceptCost, costCopy = cost ? cost.maxMicro === 0 ? this.copy.conceptFree : this.copy.conceptCost.replace('{micro}', cost.maxMicro) : this.copy.conceptCostUnknown;
    const request = this.root.querySelector('.concept-request');
    request.textContent = `${this.#session?.conceptStatus?.phase === 'failed' ? this.copy.conceptRetry : this.copy.conceptRequest} · ${costCopy}`;
    request.disabled = this.#busy || pending || !feature.available || !source; request.title = !feature.available ? feature.reason : !source ? this.copy.conceptNeedsInput : '';
    const regenerate = this.root.querySelector('.concept-regenerate'); regenerate.textContent = `${this.copy.conceptRegenerate} · ${costCopy}`;
    regenerate.disabled = request.disabled || !this.current(); regenerate.title = request.title;
    for (const node of this.root.querySelectorAll('.concept-feedback button, .concept-guidance-options button, .concept-guidance-selected button')) {
      node.disabled = this.#busy || !feature.available || !this.current(); node.title = !feature.available ? feature.reason : '';
    }
  }
  // A control disabled while busy drops focus out of the modal viewer, and with it the
  // arrow-key navigation. Return focus to it, or to the close button when it went away.
  refocus(node) {
    if (!this.dialog.open || this.dialog.contains(this.root.activeElement)) return;
    (node?.isConnected && !node.disabled && this.dialog.contains(node) ? node : this.root.querySelector('.concept-close')).focus();
  }
  open(id = this.items.at(-1)?.id) {
    if (!id || !this.items.some(c => c.id === id)) return;
    this.#trigger = this.root.activeElement; this.#selected = id; this.#seen.add(id);
    if (!this.dialog.open) this.dialog.showModal(); this.render(); this.root.querySelector('.concept-close').focus();
    // Viewing is a local cached read. It never POSTs or records spending intent.
  }
  close() {
    if (!this.dialog.open) return;
    this.dialog.close(); this.#trigger?.focus(); this.#trigger = null;
  }
  navigate(delta) { const index = this.items.findIndex(c => c.id === this.#selected), next = this.items[index + delta]; if (next) { this.#selected = next.id; this.#seen.add(next.id); this.render(); } }
  async load(id) {
    if (this.#urls.has(id)) return this.#urls.get(id);
    if (this.#loads.has(id)) return this.#loads.get(id);
    const sessionId = this.#session.id, epoch = this.#epoch;
    const promise = (async () => {
      try {
        const response = await fetch(this.sameOrigin(this.path(`/${id}/image`)), { headers: this.headers(), cache: 'no-store' });
        if (!response.ok || !['image/png', 'image/jpeg', 'image/webp'].includes(response.headers.get('content-type'))) throw new Error();
        const blob = await response.blob();
        if (epoch !== this.#epoch || sessionId !== this.#session.id || !this.#session.concepts?.some(c => c.id === id)) return null;
        const url = URL.createObjectURL(blob); this.#urls.set(id, url); return url;
      } catch { return null; }
    })().finally(() => { this.#loads.delete(id); });
    this.#loads.set(id, promise); return promise;
  }
  async request(artifactId) {
    if (this.#busy || !this.feature().available || this.#session.conceptStatus?.phase === 'pending') return;
    const sourceTurnId = this.#session.transcript.filter(t => t.role === 'user' && !t.erased && !t.withdrawn).at(-1)?.id;
    if (!sourceTurnId) return;
    const focused = this.root.activeElement; this.#busy = true; this.gates(); const sessionId = this.#session.id;
    try {
      const response = await postJson(this.path(artifactId ? `/${artifactId}/regenerate` : ''),
        { clientEventId: crypto.randomUUID(), intent: true, sourceTurnId }, { sessionToken: this.sessionToken });
      if (!response.ok) throw new Error(); const ack = await response.json(); if (sessionId === this.#session.id) this.receive(ack.event);
    } catch { this.root.querySelector('.concept-activity-text').textContent = this.copy.conceptFailed; }
    finally { this.#busy = false; this.gates(); this.refocus(focused); }
  }
  async feedback(vote, chips, reject = false) {
    const current = this.current(); if (this.#busy || !current || !this.feature().available || chips.length > 8) return;
    const focused = this.root.activeElement; this.#busy = true; this.gates(); const sessionId = this.#session.id;
    try {
      const response = await postJson(this.path(`/${current.id}/${reject ? 'reject' : 'feedback'}`),
        { clientEventId: crypto.randomUUID(), vote, chips }, { sessionToken: this.sessionToken });
      if (!response.ok) throw new Error(); const ack = await response.json();
      if (sessionId === this.#session.id) { this.receive(ack.event); if (reject) this.close(); }
    } catch { this.root.querySelector('.concept-viewer-message').textContent = this.copy.controlFailed; }
    finally { this.#busy = false; this.gates(); this.refocus(focused); }
  }
  async download() {
    const current = this.current(); if (!current) return;
    const sessionId = this.#session.id, epoch = this.#epoch; let url;
    try {
      // A real owner-authenticated GET on the image route, never a provider URL.
      const response = await fetch(this.sameOrigin(this.path(`/${current.id}/image?download=1`)), { headers: this.headers(), cache: 'no-store' });
      if (!response.ok) throw new Error(); const blob = await response.blob();
      if (epoch !== this.#epoch || sessionId !== this.#session.id) return;
      url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url;
      link.download = `concept-${current.id}.${current.mediaType.split('/')[1]}`; link.click();
    } catch { this.root.querySelector('.concept-viewer-message').textContent = this.copy.conceptImageFailed; }
    finally { if (url) URL.revokeObjectURL(url); }
  }
  destroy() { this.suspend(); this.dialog.remove(); }
}
