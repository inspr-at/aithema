import { postJson } from './post-json.js';
import { reasonText } from './settings-dialog.js';
import { HTML_MEDIA_TYPE, frameDocument, inspectHTML } from '../../core/src/ui-html.js';

// START generated-ui-progress: estimates reserve completion for durable success.
export function conceptProgress(status, now = Date.now()) {
  const elapsed = Math.max(0, now - status.startedAt), duration = Math.max(1000, status.estimateMs ?? 45000);
  return { percent: Math.min(99, Math.floor(elapsed / duration * 100)), seconds: Math.max(0, Math.ceil((duration - elapsed) / 1000)), overdue: elapsed >= duration };
}

/** Images render as images; clickable HTML drafts (AIT-113) render in the sandboxed preview. */
export const conceptKind = item => item?.mediaType === HTML_MEDIA_TYPE ? 'html' : 'image';
const sentence = text => /[.!?…]$/u.test(text) ? text : `${text}.`;
/**
 * The rail's plain-words generation state. `kind` is what the next render produces
 * (the host's visual kind); the ready sentence follows the latest item.
 */
export function conceptStateText({ copy, status = { phase: 'idle' }, feature, items, kind, requestError }) {
  const drafts = items.filter(c => conceptKind(c) === 'html').length;
  if (status.phase === 'pending') return kind === 'html' ? drafts ? copy.conceptDraftUpdating : copy.conceptDraftRendering : copy.conceptRendering;
  if (requestError) return requestError;
  if (status.phase === 'failed') return status.reason ? sentence(reasonText(copy, status.reason))
    : status.error === 'restart' ? copy.conceptRestarted : status.error === 'source-removed' ? copy.conceptSourceRemoved : copy.conceptFailed;
  if (status.phase === 'waiting') return copy.conceptWaiting;
  if (!feature.available && feature.reason) return sentence(feature.reason);
  if (!items.length) return copy.conceptIntro;
  return conceptKind(items.at(-1)) === 'html' ? copy.conceptDraftReady.replace('{number}', drafts) : copy.conceptReady;
}
const DRAFT_GLYPH = '<svg viewBox="0 0 48 32" aria-hidden="true"><rect x="1.5" y="1.5" width="45" height="29" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
  '<path d="M1.5 8h45M7 15h18M7 20h12M30 15h11v10H30z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';

/** Generic START viewer experience, private owner-authenticated bytes only. */
export class ConceptView {
  #session; #selected; #latest; #seen = new Set(); #urls = new Map(); #drafts = new Map(); #loads = new Map(); #epoch = 0;
  #busy = false; #trigger; #timer; #touchX; #requestError = null; #statusKey = ''; #pointer = false; #pointerStage = false;
  constructor({ root, copy, baseUrl, sessionToken, receive, feature }) {
    Object.assign(this, { root, copy, baseUrl, sessionToken, receive, feature });
    this.visibility = () => { if (root.ownerDocument.hidden) void this.endEligibility(); };
    this.pagehide = () => { void this.endEligibility(); };
    root.querySelector('.concept-rail').innerHTML = `<div class="concept-scene" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <div class="concept-activity"><span class="concept-activity-text" role="status"></span><progress class="concept-progress" max="100" value="0"></progress><small class="concept-countdown"></small></div>
      <button class="concept-request" type="button"></button>`;
    root.querySelector('.concept-preview-slot').innerHTML = `<button class="concept-preview" type="button"><img alt="" decoding="async"><span class="concept-preview-glyph" hidden>${DRAFT_GLYPH}</span><span class="concept-preview-label"></span></button>`;
    const dialog = document.createElement('dialog'); dialog.className = 'concept-viewer'; dialog.setAttribute('aria-labelledby', 'concept-title');
    dialog.innerHTML = `<header class="concept-viewer-head"><h2 id="concept-title"></h2><span class="concept-count" aria-live="polite"></span><button class="concept-close" type="button"></button></header>
      <div class="concept-stage"><img class="concept-image" decoding="async"><aithema-html-preview class="concept-html" fill hidden></aithema-html-preview><p class="concept-image-status" role="status"></p></div>
      <footer class="concept-viewer-controls"><div class="concept-navigation"><button class="concept-previous" type="button"></button><button class="concept-next" type="button"></button><button class="concept-download" type="button"></button><button class="concept-regenerate" type="button"></button></div>
        <p class="concept-disclosure"></p><div class="concept-feedback"><button class="concept-up" type="button"></button><button class="concept-down" type="button"></button><button class="concept-reject" type="button"></button></div>
        <div class="concept-guidance-options"></div><div class="concept-guidance-selected" aria-live="polite"></div><p class="concept-viewer-message" role="status"></p></footer>`;
    root.append(dialog); this.dialog = dialog;
    const labels = { '.concept-close': 'conceptClose', '.concept-previous': 'conceptPrevious', '.concept-next': 'conceptNext',
      '.concept-download': 'conceptDownload', '.concept-up': 'conceptUp', '.concept-down': 'conceptDown', '.concept-reject': 'conceptReject', '.concept-preview-label': 'conceptView' };
    for (const [selector, key] of Object.entries(labels)) root.querySelector(selector).textContent = copy[key];
    root.querySelector('.concept-image').alt = copy.conceptImageAlt;
    if (copy.conceptPreview) root.querySelector('.concept-html').copy = copy.conceptPreview;
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
      // The draft's width switch uses arrow keys itself (and prevents their default).
      if (!e.defaultPrevented && !['INPUT', 'TEXTAREA'].includes(e.target.tagName) && ['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); this.navigate(e.key === 'ArrowLeft' ? -1 : 1); }
      // Keep keyboard focus in the single immersive viewer, including hosts whose
      // dialog polyfill doesn't implement native focus containment.
      if (e.key === 'Tab') {
        const draft = root.querySelector('.concept-html');
        // From the draft's width switch, Tab continues into the draft itself.
        if (root.activeElement === draft && !e.shiftKey && draft.state === 'ready') return;
        const stops = [...dialog.querySelectorAll('button, aithema-html-preview')].filter(b => !b.disabled && !b.hidden);
        const index = stops.indexOf(root.activeElement); e.preventDefault(); stops[(index + (e.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus();
      }
    });
    const controls = root.querySelector('.concept-viewer-controls');
    controls.addEventListener('pointerenter', () => { this.#pointer = true; });
    controls.addEventListener('pointerleave', () => { this.#pointer = false; });
    const stage = root.querySelector('.concept-stage');
    // A pointer resting on the draft defers a revision too: replacing the frame would remove what it is on.
    stage.addEventListener('pointerenter', () => { this.#pointerStage = true; });
    stage.addEventListener('pointerleave', () => { this.#pointerStage = false; });
    stage.addEventListener('touchstart', e => { this.#touchX = e.touches[0]?.clientX; }, { passive: true });
    stage.addEventListener('touchend', e => { const delta = e.changedTouches[0]?.clientX - this.#touchX; if (Math.abs(delta) > 60) this.navigate(delta > 0 ? -1 : 1); }, { passive: true });
    this.connect();
  }
  get items() { return (this.#session?.concepts ?? []).filter(c => !c.archived && !c.erased); }
  current() { return this.items.find(c => c.id === this.#selected); }
  path(suffix = '') { return `${this.baseUrl}/api/sessions/${this.#session.id}/concepts${suffix}`; }
  // Every owner-authenticated concept request, GET or POST, passes here before it is sent.
  sameOrigin(path) {
    const location = this.root.ownerDocument.defaultView?.location;
    if (location?.origin && location.origin !== 'null' && new URL(path, location.href).origin !== location.origin) throw new Error('Concept routes require same origin');
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
    this.#epoch++; clearInterval(this.#timer); this.#timer = null; for (const url of this.#urls.values()) URL.revokeObjectURL(url); this.#urls.clear(); this.#drafts.clear(); this.close();
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
    for (const id of this.#drafts.keys()) if (!valid.has(id)) this.#drafts.delete(id);
    // Redact revoked content immediately.
    if (changedOwner || session.consentWithdrawn || session.tombstone || this.#selected && !valid.has(this.#selected)) {
      this.#epoch++; this.root.querySelector('.concept-image').removeAttribute('src'); this.root.querySelector('.concept-disclosure').textContent = '';
      this.root.querySelector('.concept-html').artifact = null;
      this.root.querySelector('.concept-guidance-selected').textContent = ''; this.close();
    }
    // A request error stands until the generation state moves on.
    const statusKey = JSON.stringify(session.conceptStatus ?? null);
    if (statusKey !== this.#statusKey) { this.#statusKey = statusKey; this.#requestError = null; }
    const latest = this.items.at(-1);
    if (!latest) this.root.querySelector('.concept-preview img').removeAttribute('src');
    this.follow(latest);
    this.render();
  }
  // Drafts are revised continuously: a viewer showing the latest draft moves on to the new
  // revision in its fixed stage, unless someone is at work in the viewer (focus in the draft,
  // its width switch or a viewer control, or the pointer on the controls); an older revision
  // stays put. Either way the count and Next update at once.
  follow(latest) {
    const before = this.#latest; this.#latest = latest?.id;
    if (!this.dialog.open || !before || !latest || latest.id === before || conceptKind(latest) !== 'html') return;
    if (this.#selected === before && !this.inUse()) { this.#selected = latest.id; this.#seen.add(latest.id); }
    else this.root.querySelector('.concept-viewer-message').textContent = this.copy.conceptDraftNewer;
  }
  inUse() {
    const draft = this.root.querySelector('.concept-html'), active = this.root.activeElement;
    return this.#pointer || this.#pointerStage || draft.draftFocused || active === draft || Boolean(active && this.root.querySelector('.concept-viewer-controls').contains(active));
  }
  visualKind() { return this.#session?.conceptVisualKind === 'html' ? 'html' : 'image'; }
  progress() {
    if (!this.#session) return;
    const status = this.#session.conceptStatus ?? { phase: 'idle' }, node = this.root.querySelector('.concept-progress');
    const text = this.root.querySelector('.concept-activity-text'), countdown = this.root.querySelector('.concept-countdown');
    const words = conceptStateText({ copy: this.copy, status, feature: this.feature(), items: this.items, kind: this.visualKind(), requestError: this.#requestError });
    if (text.textContent !== words) text.textContent = words;
    if (status.phase === 'pending') {
      const estimate = conceptProgress(status); node.value = estimate.percent;
      countdown.textContent = estimate.overdue ? this.copy.conceptOverdue : this.copy.conceptCountdown.replace('{seconds}', estimate.seconds);
    } else { node.value = status.phase === 'ready' ? 100 : 0; countdown.textContent = ''; }
    this.root.querySelector('.concept-rail').dataset.phase = status.phase;
  }
  // Every control keeps a fixed slot, so state renders at once, also under the pointer (AIT-116 D3).
  render() {
    this.progress();
    const latest = this.items.at(-1), tab = this.root.querySelector('.concept-tab'), latestDraft = conceptKind(latest) === 'html';
    const view = latestDraft ? this.copy.conceptDraftView : this.copy.conceptView;
    tab.dataset.unread = String(Boolean(latest && !this.#seen.has(latest.id))); tab.disabled = !latest;
    tab.title = latest ? view : this.feature().reason ?? this.copy.conceptIntro;
    // The thumbnail slot keeps its size: an image, or a glyph for a draft (a live frame stays in the viewer).
    const preview = this.root.querySelector('.concept-preview');
    preview.disabled = !latest; preview.style.visibility = latest ? '' : 'hidden';
    preview.querySelector('img').hidden = latestDraft; preview.querySelector('.concept-preview-glyph').hidden = !latestDraft;
    preview.querySelector('.concept-preview-label').textContent = view; preview.setAttribute('aria-label', view);
    if (latest && !latestDraft) void this.load(latest.id).then(url => { if (this.items.at(-1)?.id === latest.id && url) preview.querySelector('img').src = url; });
    this.gates();
    if (!this.dialog.open) return;
    let current = this.current();
    if (!current) { this.#selected = latest?.id; current = latest; }
    if (!current) { this.close(); return; }
    const index = this.items.findIndex(c => c.id === current.id), html = conceptKind(current) === 'html';
    this.dialog.dataset.kind = html ? 'html' : 'image';
    this.root.querySelector('#concept-title').textContent = html
      ? this.copy.conceptDraftTitle.replace('{number}', this.items.filter(c => conceptKind(c) === 'html').indexOf(current) + 1)
      : this.copy.conceptTitle.replace('{number}', index + 1);
    this.root.querySelector('.concept-count').textContent = this.copy.conceptCount.replace('{current}', index + 1).replace('{count}', this.items.length);
    this.root.querySelector('.concept-previous').disabled = index <= 0; this.root.querySelector('.concept-next').disabled = index >= this.items.length - 1;
    const fake = current.provenance?.generator?.provider === 'local-demo-fake';
    const manipulated = current.provenance?.origin === 'ai-manipulated';
    this.root.querySelector('.concept-disclosure').textContent = html ? fake ? this.copy.conceptDraftFake : manipulated ? this.copy.conceptDraftManipulated : this.copy.conceptDraftGenerated
      : fake ? this.copy.conceptFake : manipulated ? this.copy.conceptManipulated : this.copy.conceptGenerated;
    this.root.querySelector('.concept-download').textContent = html ? this.copy.conceptDraftDownload : this.copy.conceptDownload;
    for (const vote of ['up', 'down']) this.root.querySelector('.concept-' + vote).setAttribute('aria-pressed', String(current.feedback?.vote === vote));
    // Selected guidance keeps its buttons by value, so a focused one stays focused across live renders.
    const selected = this.root.querySelector('.concept-guidance-selected'), chips = current.feedback?.chips ?? [];
    const buttons = new Map([...selected.children].map(button => [button.dataset.value, button]));
    for (const [value, button] of buttons) if (!chips.includes(value)) { button.remove(); buttons.delete(value); }
    let next = selected.firstElementChild;
    for (const value of chips) {
      let button = buttons.get(value);
      if (!button) {
        button = document.createElement('button'); button.type = 'button'; button.dataset.value = value;
        button.textContent = this.copy.conceptRemoveGuidance.replace('{guidance}', value);
        button.addEventListener('click', () => { const shown = this.current()?.feedback;
          if (shown) void this.feedback(shown.vote, shown.chips.filter(c => c !== value)); });
      }
      if (button !== next) selected.insertBefore(button, next); else next = next.nextElementSibling;
    }
    const image = this.root.querySelector('.concept-image'), draft = this.root.querySelector('.concept-html'), imageStatus = this.root.querySelector('.concept-image-status');
    image.hidden = html; draft.hidden = !html;
    if (html) { this.renderDraft(current, draft, imageStatus); image.removeAttribute('src'); delete image.dataset.id; return; }
    if (draft.artifact) draft.artifact = null;
    delete draft.dataset.id;
    if (image.dataset.id !== current.id) { image.removeAttribute('src'); image.dataset.id = current.id; }
    imageStatus.textContent = this.copy.conceptLoading;
    void this.load(current.id).then(url => { if (this.current()?.id === current.id && this.dialog.open) {
      if (url) image.src = url; imageStatus.textContent = url ? '' : this.copy.conceptImageFailed;
    } });
  }
  // The preview keeps one frame per shown revision: live renders that don't change the
  // revision leave it (and whatever the person did inside it) alone.
  renderDraft(current, draft, status) {
    const show = bytes => { if (draft.artifact?.bytes !== bytes) draft.artifact = { bytes, mediaType: HTML_MEDIA_TYPE }; };
    const cached = this.#drafts.get(current.id);
    if (draft.dataset.id !== current.id) { draft.dataset.id = current.id; if (!cached) draft.artifact = null; }
    if (cached) { show(cached); status.textContent = ''; return; }
    status.textContent = this.copy.conceptDraftLoading;
    void this.load(current.id).then(bytes => { if (this.current()?.id === current.id && this.dialog.open) {
      if (bytes) show(bytes); status.textContent = bytes ? '' : this.copy.conceptDraftFailed;
    } });
  }
  gates() {
    const active = this.root.activeElement; // captured before any control below is disabled
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
    // A live update (e.g. SSE "pending" after the POST settled) can disable the focused
    // control; browsers then drop focus out of the modal and its arrow-key navigation.
    if (this.dialog.open && active?.disabled && this.dialog.contains(active)) this.root.querySelector('.concept-close').focus();
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
    // A closed viewer runs no draft; reopening shows the cached bytes at once.
    const draft = this.root.querySelector('.concept-html'); draft.artifact = null; delete draft.dataset.id;
    this.root.querySelector('.concept-viewer-message').textContent = ''; this.#pointer = false; this.#pointerStage = false;
    this.dialog.close(); this.#trigger?.focus(); this.#trigger = null;
  }
  navigate(delta) {
    const index = this.items.findIndex(c => c.id === this.#selected), next = this.items[index + delta];
    if (next) { this.#selected = next.id; this.#seen.add(next.id); this.root.querySelector('.concept-viewer-message').textContent = ''; this.render(); }
  }
  /** An image's object URL, or a draft's bytes: fetched as data from the owner route, never navigated to. */
  async load(id) {
    if (this.#urls.has(id)) return this.#urls.get(id);
    if (this.#drafts.has(id)) return this.#drafts.get(id);
    if (this.#loads.has(id)) return this.#loads.get(id);
    const sessionId = this.#session.id, epoch = this.#epoch, html = conceptKind(this.#session.concepts?.find(c => c.id === id)) === 'html';
    const promise = (async () => {
      try {
        const response = await fetch(this.sameOrigin(this.path(`/${id}/${html ? 'html' : 'image'}`)), { headers: this.headers(), cache: 'no-store' });
        const type = response.headers.get('content-type');
        if (!response.ok || !(html ? type === 'application/octet-stream' : ['image/png', 'image/jpeg', 'image/webp'].includes(type))) throw new Error();
        const data = html ? new Uint8Array(await response.arrayBuffer()) : await response.blob();
        if (epoch !== this.#epoch || sessionId !== this.#session.id || !this.#session.concepts?.some(c => c.id === id)) return null;
        if (html) { this.#drafts.set(id, data); return data; }
        const url = URL.createObjectURL(data); this.#urls.set(id, url); return url;
      } catch { return null; }
    })().finally(() => { this.#loads.delete(id); });
    this.#loads.set(id, promise); return promise;
  }
  async request(artifactId) {
    if (this.#busy || !this.feature().available || this.#session.conceptStatus?.phase === 'pending') return;
    const sourceTurnId = this.#session.transcript.filter(t => t.role === 'user' && !t.erased && !t.withdrawn).at(-1)?.id;
    if (!sourceTurnId) return;
    const focused = this.root.activeElement; this.#busy = true; this.#requestError = null; this.gates(); const sessionId = this.#session.id;
    try {
      const response = await postJson(this.sameOrigin(this.path(artifactId ? `/${artifactId}/regenerate` : '')),
        { clientEventId: crypto.randomUUID(), intent: true, sourceTurnId }, { sessionToken: this.sessionToken });
      if (!response.ok) throw Object.assign(new Error(), { reason: (await response.json().catch(() => null))?.reason });
      const ack = await response.json(); if (sessionId === this.#session.id) this.receive(ack.event);
    } catch (error) {
      // A refusal with a known reason (a limit, the spending cap) says so in plain words.
      if (sessionId === this.#session.id) { this.#requestError = typeof error.reason === 'string' ? sentence(reasonText(this.copy, error.reason)) : this.copy.conceptFailed; this.progress(); }
    }
    finally { this.#busy = false; this.gates(); this.refocus(focused); }
  }
  async feedback(vote, chips, reject = false) {
    const current = this.current(); if (this.#busy || !current || !this.feature().available || chips.length > 8) return;
    const focused = this.root.activeElement; this.#busy = true; this.gates(); const sessionId = this.#session.id;
    try {
      const response = await postJson(this.sameOrigin(this.path(`/${current.id}/${reject ? 'reject' : 'feedback'}`)),
        { clientEventId: crypto.randomUUID(), vote, chips }, { sessionToken: this.sessionToken });
      if (!response.ok) throw new Error(); const ack = await response.json();
      if (sessionId === this.#session.id) { this.receive(ack.event); if (reject) this.close(); }
    } catch { this.root.querySelector('.concept-viewer-message').textContent = this.copy.controlFailed; }
    finally { this.#busy = false; this.gates(); this.refocus(focused); }
  }
  async download() {
    const current = this.current(); if (!current) return;
    const sessionId = this.#session.id, epoch = this.#epoch; let url;
    if (conceptKind(current) === 'html') {
      // The same static file as the export: the draft with scripts turned off, never the raw bytes.
      try {
        const bytes = await this.load(current.id);
        if (!bytes || !inspectHTML(bytes).ok) throw new Error();
        if (epoch !== this.#epoch || sessionId !== this.#session.id) return;
        url = URL.createObjectURL(new Blob([frameDocument(new TextDecoder().decode(bytes), { standalone: true })], { type: HTML_MEDIA_TYPE }));
        const link = document.createElement('a'); link.href = url; link.download = `concept-${current.id}.html`; link.click();
      } catch { this.root.querySelector('.concept-viewer-message').textContent = this.copy.conceptDraftFailed; }
      finally { if (url) URL.revokeObjectURL(url); }
      return;
    }
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
