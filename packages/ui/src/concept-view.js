import { consentTimeout } from './consent-timer.js';
import { isConsentReason } from '../../core/src/settings.js';
import { paintConsentLine, reasonAction, reasonSeparator } from './consent-line.js';
import { postJson, sameOrigin } from './post-json.js';
import { reasonText } from './settings-dialog.js';
import { HTML_MEDIA_TYPE, frameDocument, inspectHTML } from '../../core/src/ui-html.js';
import { draftsLine, creditCost } from './display.js';
import { conceptControlsBlocked, guardConceptControls } from './concept-guards.js';

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
export function conceptStateText({ copy, status = { phase: 'idle' }, feature, items, kind, cost, requestError }) {
  const drafts = items.filter(c => conceptKind(c) === 'html').length;
  if (status.phase === 'pending') return kind === 'html' ? drafts ? copy.conceptDraftUpdating : copy.conceptDraftRendering : copy.conceptRendering;
  if (requestError) return requestError;
  if (status.phase === 'failed') return status.reason ? sentence(reasonText(copy, status.reason, kind === 'html' ? 'html' : 'images'))
    : status.error === 'restart' ? copy.conceptRestarted : status.error === 'source-removed' ? copy.conceptSourceRemoved : copy.conceptFailed;
  if (status.phase === 'waiting') return copy.conceptWaiting;
  if (!items.length || !feature.available) {
    const line = draftsLine({ copy, cost, feature, kind: kind === 'html' ? 'html' : 'images' });
    if (!line.recovery && !feature.available && feature.reason && cost && line.state !== 'low' && !/not configured|not set up|not offered|not in preset|unavailable on device|visuals off|nicht eingerichtet|nicht angeboten|ausgeschaltet/iu.test(feature.rawReason ?? feature.reason)) return sentence(feature.reason);
    return line.action ? '' : line.text;
  }
  return conceptKind(items.at(-1)) === 'html' ? copy.conceptDraftReady.replace('{number}', drafts) : copy.conceptReady;
}
const DRAFT_GLYPH = '<svg viewBox="0 0 48 32" aria-hidden="true"><rect x="1.5" y="1.5" width="45" height="29" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
  '<path d="M1.5 8h45M7 15h18M7 20h12M30 15h11v10H30z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';

// AIT-274's retry glyph and status markup also serve the composer and access error.
export const WARNING_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.9v3.6M8 11.1v.05"/></svg>';
export function paintFailureLine(line, words, suffix = '') {
  if (line.querySelector('.question-status.warning') && line.textContent === words + suffix) return;
  const status = document.createElement('span'), why = document.createElement('span');
  status.className = 'question-status warning'; why.className = 'question-why';
  status.innerHTML = WARNING_ICON;
  const [, first, rest = ''] = /^(.*?[.!?])(?=\s|$)([\s\S]*)$/u.exec(words) ?? [null, words];
  why.textContent = first; status.append(why);
  line.replaceChildren(status, document.createTextNode(rest + suffix));
}

/** Generic START viewer experience, owner-authenticated artifacts and scoped previews. */
export class ConceptView {
  #lifetime = 0;
  #session; #selected; #latest; #seen = new Set(); #seenLoaded = false; #urls = new Map(); #drafts = new Map(); #loads = new Map(); #epoch = 0;
  #previewRetryAt = 0; #previewDenied = new Map();
  #consentRefreshFailed = false; #consentDocument; #pendingScopes = new Set(); #visible = []; #withdrawnKind; #scopeEpoch = { html: 0, image: 0 };
  #canvasEpoch = 0; #canvasCopy; #stageFeature; #canvasWithdrawnKind;
  #unbound = false; #imageLayout = false; #backdropId; #backdropEpoch = 0; #withdrawnUntil = 0; #withdrawnTimer; #hover = false; #phone; #placeAccess;
  #busy = false; #trigger; #timer; #touchX; #requestError = null; #statusKey = ''; #pointer = false; #pointerStage = false;
  setCopy(copy) { this.copy = copy; this.#paintCopy(); this.render(); if (this.root.querySelector('.workspace')?.hasAttribute('data-folded')) void this.paintCanvas(); }
  #paintCopy() {
    const { root, copy } = this;
    const [image, draft] = root.querySelectorAll('.concept-preview-sizer');
    image.textContent = copy.conceptView; draft.textContent = copy.conceptDraftView ?? '';
    const labels = { '.concept-close': 'conceptClose', '.concept-previous': 'conceptPrevious', '.concept-next': 'conceptNext',
      '.concept-download': 'conceptDownload', '.concept-up': 'conceptUp', '.concept-down': 'conceptDown', '.concept-reject': 'conceptReject', '.concept-preview-label': 'conceptView' };
    for (const [selector, key] of Object.entries(labels)) root.querySelector(selector).textContent = copy[key];
    root.querySelector('.drafts-reason-reserve').replaceChildren(...[
      copy.display.draftsUnoffered, copy.display.draftsOff, copy.display.draftsUnavailable, copy.display.draftsLow,
      `${copy.display.draftsDisabled}${reasonSeparator}${copy.display.draftsEnable}`,
      ...['draftsPreset', 'draftsDevice', 'draftsQuote', 'draftsTimeout'].map(key =>
        `${copy.display[key]}${reasonSeparator}${copy.display[key === 'draftsPreset' || key === 'draftsDevice' ? 'draftsChoose' : 'draftsRetry']}`),
    ].map(words => { const line = document.createElement('span'); line.textContent = words; return line; }));
    root.querySelector('.concept-image').alt = copy.conceptImageAlt;
    if (copy.conceptPreview) root.querySelector('.concept-html').copy = copy.conceptPreview;
    root.querySelectorAll('.concept-guidance-options button').forEach((button, i) => { button.dataset.value = copy.conceptGuidance[i] ?? ''; button.textContent = button.dataset.value; });
  }
  constructor({ root, copy, baseUrl, sessionToken, receive, feature, consent, settings, retry, previewURL }) {
    Object.assign(this, { root, copy, baseUrl, sessionToken, receive, feature, consent, settings, retry, previewURL });
    this.visibility = () => { if (root.ownerDocument.hidden) void this.endEligibility(); };
    this.pagehide = () => { void this.endEligibility(); };
    root.querySelector('.concept-rail').innerHTML = `<div class="concept-scene" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <div class="concept-activity"><span class="concept-activity-text" role="status"></span><span class="drafts-reason-reserve" aria-hidden="true"></span><progress class="concept-progress" max="100" value="0"></progress><small class="concept-countdown"></small></div>
      <button class="concept-request" type="button"></button>`;
    // The label shares one cell with both possible labels, so the thumbnail keeps its width when an image or a draft arrives.
    root.querySelector('.concept-preview-slot').innerHTML = `<button class="concept-preview" type="button"><span class="concept-preview-thumbs"><img alt="" aria-hidden="true" decoding="async"><img alt="" aria-hidden="true" decoding="async"></span><span class="concept-preview-glyph" hidden>${DRAFT_GLYPH}</span><span class="concept-preview-text"><span class="concept-preview-label"></span><span class="concept-preview-sizer" aria-hidden="true"></span><span class="concept-preview-sizer" aria-hidden="true"></span></span></button>`;
    const [image, draft] = root.querySelectorAll('.concept-preview-sizer'); image.textContent = copy.conceptView; draft.textContent = copy.conceptDraftView ?? '';
    const dialog = document.createElement('dialog'); dialog.className = 'concept-viewer'; dialog.setAttribute('aria-labelledby', 'concept-title');
    dialog.innerHTML = `<header class="concept-viewer-head"><h2 id="concept-title"></h2><span class="concept-count" aria-live="polite"></span><button class="concept-close" type="button"></button></header>
      <div class="concept-stage"><img class="concept-image" decoding="async"><aithema-html-preview class="concept-html" fill hidden></aithema-html-preview><p class="concept-image-status" role="status"></p></div>
      <footer class="concept-viewer-controls"><div class="concept-navigation"><button class="concept-previous" type="button"></button><button class="concept-next" type="button"></button><button class="concept-download" type="button"></button><button class="concept-regenerate" type="button"></button></div>
        <p class="concept-disclosure"></p><div class="concept-feedback"><button class="concept-up" type="button"></button><button class="concept-down" type="button"></button><button class="concept-reject" type="button"></button></div>
        <div class="concept-guidance-options"></div><p class="concept-viewer-message" role="status"></p></footer>`;
    root.append(dialog); this.dialog = dialog;
    this.#paintCopy();
    // Move the same access and priced request nodes into the phone dock. There is
    // one keyboard target per action, and the composer status row stays untouched.
    const foldSlot = document.createElement('div'); foldSlot.className = 'concept-fold-slot';
    root.querySelector('.fold-view').insertBefore(foldSlot, root.querySelector('.drafts-canvas'));
    const phoneSlot = document.createElement('div'); phoneSlot.className = 'concept-phone-slot';
    root.querySelector('.composer-dock').prepend(phoneSlot);
    this.#phone = root.ownerDocument.defaultView.matchMedia('(max-width:600px)');
    this.#placeAccess = event => {
      const access = root.querySelector('.concept-access');
      const parent = root.querySelector('.workspace').hasAttribute('data-folded') ? foldSlot : this.#phone.matches && this.#imageLayout ? phoneSlot : root.querySelector('.concept-bar');
      if (access.parentNode !== parent) parent.prepend(access);
      guardConceptControls(root);
      if (event && this.#session) this.render();
    };
    this.#placeAccess();
    const thread = root.querySelector('.concept-thread');
    thread.addEventListener('pointermove', event => {
      const exposed = event.pointerType !== 'touch' && this.exposedAt(event.clientX, event.clientY, event.target);
      this.#hover = exposed; thread.toggleAttribute('data-hover', exposed); this.sharpen();
      if (exposed) this.placeHint(event.clientX, event.clientY);
      else root.querySelector('.concept-backdrop-hint').removeAttribute('data-show');
    });
    thread.addEventListener('pointerleave', () => this.clearHover());
    thread.addEventListener('click', event => {
      if (!event.defaultPrevented && this.exposedAt(event.clientX, event.clientY, event.target)) this.open(this.#backdropId);
    });
    thread.querySelector('.transcript-shell').addEventListener('scroll', () => this.clearHover(), { passive: true });
    root.querySelector('.concept-preview').addEventListener('focus', () => this.sharpen());
    root.querySelector('.concept-preview').addEventListener('blur', () => this.sharpen());
    root.querySelector('.concept-request').addEventListener('click', () => void this.request());
    root.querySelector('.concept-regenerate').addEventListener('click', () => void this.request(this.#selected));
    root.querySelector('.concept-tab').addEventListener('click', () => this.open());
    root.querySelector('.concept-preview').addEventListener('click', () => this.items.length ? this.open() : this.#withdrawnKind && this.consent?.(root.querySelector('.concept-preview'), this.#withdrawnKind));
    root.querySelector('.concept-close').addEventListener('click', () => this.close());
    root.querySelector('.concept-previous').addEventListener('click', () => this.navigate(-1));
    root.querySelector('.concept-next').addEventListener('click', () => this.navigate(1));
    root.querySelector('.concept-download').addEventListener('click', () => void this.download());
    for (const vote of ['up', 'down']) root.querySelector('.concept-' + vote).addEventListener('click', () => {
      const current = this.current(); void this.feedback(current?.feedback?.vote === vote ? 'clear' : vote, current?.feedback?.chips ?? []);
    });
    root.querySelector('.concept-reject').addEventListener('click', () => void this.feedback('down', this.current()?.feedback?.chips ?? [], true));
    // Guidance choices are toggles (GUI-27, not pills): pressing adds the guidance, pressing again removes it.
    for (const value of copy.conceptGuidance) root.querySelector('.concept-guidance-options').append(this.guidanceToggle(value));
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
        // A failed preview has two shadow controls: the selected width and Reload.
        // Include both in the trap so backwards entry reaches Reload too.
        const failedDraft = draft.state === 'failure';
        const stops = [...dialog.querySelectorAll('button, aithema-html-preview')].filter(b => !b.disabled && !b.hidden)
          .flatMap(b => b === draft && failedDraft ? [...draft.shadowRoot.querySelectorAll('button')].filter(b => !b.disabled && b.tabIndex >= 0) : [b]);
        const active = root.activeElement === draft && failedDraft ? draft.shadowRoot.activeElement : root.activeElement;
        const index = stops.indexOf(active); e.preventDefault(); stops[(index + (e.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus();
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
  // Availability also includes temporary admission gates. Only consent loss
  // removes delivered artifacts; pause, preset exclusion and budget do not.
  covered(kind) {
    const feature = kind === 'html' ? 'html' : 'images', session = this.#session;
    if (!session || this.#consentRefreshFailed || this.#pendingScopes.has(kind) || session.consentWithdrawn || session.tombstone) return false;
    const doc = this.#consentDocument;
    const verdict = session.featureMatrix?.[session.processingPreset ?? 'best']?.[feature];
    const matchingDocument = doc?.consentRevision === session.consentRevision;
    const ids = matchingDocument ? doc.features?.[feature] : undefined;
    // A consent refusal for the producer still applies when the document matches.
    // Purpose metadata distinguishes an unrelated current choice's refusal.
    for (const decision of [verdict, verdict?.unpaused]) {
      if (isConsentReason(decision?.reason) && (!matchingDocument || !decision.consentPurposes ||
        decision.consentPurposes.some(purpose => ids?.includes(purpose === 'mock-conversation' ? 'mock-processing' : purpose)))) return false;
    }
    if (matchingDocument) return Array.isArray(ids) && ids.length > 0 && ids.every(id => doc.selected.includes(id));
    return true;
  }
  unavailable(kind) {
    return this.#consentDocument?.consentRevision === this.#session?.consentRevision &&
      this.#consentDocument.unavailableFeatures?.includes(kind === 'html' ? 'html' : 'images');
  }
  get items() { return this.#session?.consentWithdrawn || this.#session?.tombstone ? [] : (this.#session?.concepts ?? []).filter(c => this.covered(conceptKind(c)) && !c.archived && !c.erased && !c.withdrawn && !c.turnIds?.some(id => this.#session.transcript.some(turn => turn.id === id && (turn.erased || turn.withdrawn)))); }
  current() { return this.items.find(c => c.id === this.#selected); }
  path(suffix = '') { return `${this.baseUrl}/api/sessions/${this.#session.id}/concepts${suffix}`; }
  // Every owner-authenticated concept request, GET or POST, passes here before it is sent.
  sameOrigin(path) { return sameOrigin(this.root.ownerDocument.defaultView, path, 'Concept routes require same origin'); }
  connect() {
    this.#phone.addEventListener('change', this.#placeAccess); this.#placeAccess();
    this.root.ownerDocument.addEventListener('visibilitychange', this.visibility);
    this.root.ownerDocument.defaultView?.addEventListener('pagehide', this.pagehide);
    if (!this.#timer) { this.#timer = setInterval(() => this.progress(), 1000); this.#timer.unref?.(); }
  }
  suspend() {
    this.#lifetime++; this.#busy = false; this.gates();
    this.#phone.removeEventListener('change', this.#placeAccess);
    this.root.ownerDocument.removeEventListener('visibilitychange', this.visibility);
    this.root.ownerDocument.defaultView?.removeEventListener('pagehide', this.pagehide);
    this.clearBackdrop(); this.clearThumbnail(); clearTimeout(this.#withdrawnTimer); this.#epoch++; this.#loads.clear(); clearInterval(this.#timer); this.#timer = null; for (const url of this.#urls.values()) URL.revokeObjectURL(url); this.#urls.clear(); this.#drafts.clear(); this.suspendCanvas(); this.close();
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
  reviseConsent(changed, granted = true, removed) {
    // Unknown names still take the session's bounded refresh path. Known names
    // can remove their surfaces immediately even in a mixed future event.
    if (!Array.isArray(changed)) return;
    const directed = Array.isArray(removed) && removed.every(name => changed.includes(name) &&
      ['text', 'analysis', 'voice', 'transcription', 'images', 'html-drafts', 'uploads'].includes(name));
    for (const scope of changed) {
      if (!['html-drafts', 'images'].includes(scope)) continue;
      const kind = scope === 'html-drafts' ? 'html' : 'image', feature = kind === 'html' ? 'html' : 'images';
      // The authoritative removal delta distinguishes additions even when the
      // client document trails a grant. A stale document alone proves neither.
      if (granted === true && directed && !removed.includes(scope)) continue;
      const doc = this.#consentDocument?.consentRevision === this.#session.consentRevision ? this.#consentDocument : undefined;
      if (!directed && Array.isArray(doc?.features?.[feature]) && !doc.features[feature].every(id => doc.selected.includes(id))) continue;
      if (this.covered(kind)) this.#pendingScopes.add(kind);
    }
    this.update(this.#session);
  }
  failClosedConsent() {
    this.#consentRefreshFailed = true;
    // A refusal may already have removed the last item. Its four-second
    // notice must not expire or move focus while verification is closed.
    clearTimeout(this.#withdrawnTimer); this.#withdrawnUntil = 0;
    this.update(this.#session);
  }
  update(session, consentDocument, consentVerified = false) {
    if (consentVerified) this.#pendingScopes.clear();
    if (consentVerified && this.#consentRefreshFailed) {
      this.#consentRefreshFailed = false;
      this.#withdrawnUntil = 0;
      clearTimeout(this.#withdrawnTimer);
    }
    const changedOwner = this.#session && this.#session.id !== session.id;
    const wasRevoked = this.#session?.consentWithdrawn || this.#session?.tombstone;
    const previous = this.#visible.at(-1), wasPending = this.#session?.conceptStatus?.phase === 'pending';
    const lostSource = wasPending && this.#session.transcript.some(turn => !turn.erased && !turn.withdrawn &&
      !session.transcript.some(next => next.id === turn.id && !next.erased && !next.withdrawn));
    if (changedOwner) { this.#pendingScopes.clear(); this.#consentRefreshFailed = false; this.#canvasWithdrawnKind = undefined; this.#consentDocument = undefined; this.#previewDenied.clear(); this.#withdrawnKind = undefined; this.#previewRetryAt = 0; this.#stageFeature = undefined; this.#imageLayout = false; }
    this.#session = session;
    if (consentDocument) this.#consentDocument = consentDocument;
    if (this.#canvasWithdrawnKind && this.covered(this.#canvasWithdrawnKind)) this.#canvasWithdrawnKind = undefined;
    const partial = !changedOwner && !session.consentWithdrawn && !session.tombstone && (this.#consentRefreshFailed ? this.#visible.at(-1) : this.#visible.find(item => !this.covered(conceptKind(item))));
    if (partial) {
      for (const kind of ['html', 'image']) if (this.#visible.some(item => conceptKind(item) === kind && !this.covered(kind))) this.#scopeEpoch[kind]++;
      for (const id of this.#loads.keys()) if (!this.items.some(item => item.id === id)) this.#loads.delete(id);
    }
    const selectedRemoved = this.dialog.open && this.#selected && !this.items.some(item => item.id === this.#selected);
    const valid = new Set(this.items.map(c => c.id));
    if (changedOwner || session.consentWithdrawn || session.tombstone) valid.clear();
    if (changedOwner || partial || previous && !valid.has(previous.id) || !wasRevoked && (session.consentWithdrawn || session.tombstone) || lostSource || wasPending && session.conceptStatus?.error === 'source-removed') {
      if (!partial) { this.#epoch++; this.#loads.clear(); }
      if (!partial || !valid.has(this.#backdropId)) this.clearBackdrop();
      clearTimeout(this.#withdrawnTimer);
      // Keep the access reservation's kind when an earlier feature refusal
      // already removed its latest item before the refresh deadline fired.
      this.#withdrawnKind = partial && !this.unavailable(conceptKind(partial)) ? this.#consentRefreshFailed ? this.#withdrawnKind ?? conceptKind(previous) : conceptKind(partial) : undefined;
      this.#withdrawnUntil = changedOwner || this.#consentRefreshFailed || partial && this.unavailable(conceptKind(partial)) ? 0 : Date.now() + 4000;
      if (this.#withdrawnUntil) {
        this.#withdrawnTimer = consentTimeout(() => {
          this.#withdrawnUntil = 0;
          const accessFocused = this.root.activeElement === this.root.querySelector('.concept-preview');
          this.render();
          if (accessFocused && !this.items.length) this.root.querySelector('.concept-activity-text .consent-action')?.focus();
        }, 4000);
        this.#withdrawnTimer.unref?.();
      }
    }
    // Outgoing cross-fade layers are artifact surfaces too. Remove revoked
    // bytes synchronously even when the current revision is still valid.
    for (const image of this.root.querySelectorAll('.concept-backdrop img, .concept-preview img')) {
      if (image.dataset.id && !valid.has(image.dataset.id)) {
        image.removeAttribute('src'); image.removeAttribute('data-on'); delete image.dataset.id;
      }
    }
    for (const [id, url] of this.#urls) if (!valid.has(id)) { URL.revokeObjectURL(url); this.#urls.delete(id); }
    for (const id of this.#drafts.keys()) if (!valid.has(id)) this.#drafts.delete(id);
    // Hidden surfaces are still artifact surfaces. Revoke them independently of
    // the fold state or the modal's selected revision.
    const canvas = this.root.querySelector('.canvas-html'), canvasImage = this.root.querySelector('.canvas-image');
    const canvasId = canvas?.dataset.id ?? canvasImage?.dataset.id;
    if (partial && canvasId && !valid.has(canvasId)) this.#canvasWithdrawnKind = conceptKind(this.#visible.find(item => item.id === canvasId));
    if (changedOwner || session.consentWithdrawn || session.tombstone ||
      (canvasId || canvas?.artifact || canvasImage?.hasAttribute('src')) && !valid.has(canvasId)) this.suspendCanvas();
    // Redact revoked content immediately.
    if (changedOwner || session.consentWithdrawn || session.tombstone || this.#selected && !valid.has(this.#selected)) {
      if (!partial) this.#epoch++;
      this.root.querySelector('.concept-image').removeAttribute('src'); this.root.querySelector('.concept-disclosure').textContent = '';
      this.root.querySelector('.concept-html').artifact = null;
      this.paintGuidance([]); this.close();
    }
    // A request error stands until the generation state moves on.
    const statusKey = JSON.stringify(session.conceptStatus ?? null);
    if (statusKey !== this.#statusKey) { this.#statusKey = statusKey; this.#requestError = null; }
    const latest = this.items.at(-1);
    if (!latest) this.clearThumbnail();
    this.#visible = this.items;
    this.follow(latest);
    this.render();
    if ((partial || this.#consentRefreshFailed) && selectedRemoved) this.root.querySelector('.concept-preview').focus({ preventScroll: true });
    if (this.root.querySelector('.workspace')?.hasAttribute('data-folded')) void this.paintCanvas();
  }
  // Drafts are revised continuously: a viewer showing the latest draft moves on to the new
  // revision in its fixed stage, unless someone is at work in the viewer (focus in the draft,
  // its width switch or a viewer control, or the pointer on the controls); an older revision
  // stays put. Either way the count and Next update at once.
  follow(latest) {
    const before = this.#latest; this.#latest = latest?.id;
    if (!this.dialog.open || !before || !latest || latest.id === before || latest.id === this.#selected || conceptKind(latest) !== 'html') return;
    if (this.#selected === before && !this.inUse()) { this.#selected = latest.id; this.#seen.add(latest.id); this.rememberViewed(); }
    else this.root.querySelector('.concept-viewer-message').textContent = this.copy.conceptDraftNewer;
  }
  inUse() {
    const draft = this.root.querySelector('.concept-html'), active = this.root.activeElement;
    return this.#pointer || this.#pointerStage || draft.draftFocused || active === draft || Boolean(active && this.root.querySelector('.concept-viewer-controls').contains(active));
  }
  visualKind() { return this.#session?.conceptVisualKind === 'html' ? 'html' : 'image'; }
  #visualsBound() {
    if (!this.#session || this.#session.visualsBound === false) return false;
    if (this.#session.visualsBound === true) return true;
    return !Object.values(this.#session.featureMatrix ?? {}).every(matrix => ['html', 'images'].every(kind => {
      const value = matrix[kind], verdict = value?.reason === 'session paused' ? value.unpaused ?? value : value;
      return !verdict || !verdict.available && ['not configured', this.copy.notConfigured, 'preset not configured', 'unavailable on device'].includes(verdict.reason);
    }));
  }
  accessFeature() {
    if (!this.items.length && ['html', 'image'].some(kind => this.unavailable(kind)))
      return { available: false, rawReason: 'publication unavailable', reason: this.copy.notConfigured };
    if (this.#withdrawnKind && !this.covered(this.#withdrawnKind)) {
      const kind = this.#withdrawnKind === 'html' ? 'html' : 'images';
      return { available: false, rawReason: 'current processing consent required', reason: reasonText(this.copy, 'current processing consent required', kind) };
    }
    return this.feature({ ignorePause: true });
  }
  progress() {
    if (!this.#session) return;
    const unbound = !this.#visualsBound();
    this.#unbound = unbound;
    // A host with no visuals retains its existing layout. Once this conversation
    // has bound images, keep its reservation through all states, including none.
    this.#imageLayout = this.visualKind() === 'image' && (this.#imageLayout || !unbound);
    this.root.querySelector('.concept-rail').hidden = unbound && !this.items.length;
    this.root.querySelector('.concept-bar').toggleAttribute('data-no-drafts', !this.#imageLayout && unbound && !this.items.length);
    this.root.querySelector('.workspace').dataset.conceptLayout = this.#imageLayout ? 'image' : this.visualKind() === 'html' ? 'html' : 'unbound';
    this.root.querySelector('.workspace').toggleAttribute('data-concept-unbound', unbound);
    this.#placeAccess?.();
    const consentOnly = this.#withdrawnKind && !this.covered(this.#withdrawnKind) && !this.items.length;
    const status = consentOnly ? { phase: 'idle' } : this.#session.conceptStatus ?? { phase: 'idle' }, node = this.root.querySelector('.concept-progress');
    const text = this.root.querySelector('.concept-activity-text'), countdown = this.root.querySelector('.concept-countdown');
    const initial = this.#stageFeature === undefined;
    const current = this.accessFeature();
    const consentChanged = isConsentReason(current.rawReason ?? current.reason) || isConsentReason(this.#stageFeature?.rawReason ?? this.#stageFeature?.reason);
    if (!this.#session.paused || initial || consentChanged) this.#stageFeature = current;
    const feature = this.#session.consentWithdrawn || this.#session.tombstone ? this.feature() : this.#stageFeature;
    const words = conceptStateText({ copy: this.copy, status, feature, items: this.items, kind: this.visualKind(), cost: this.#session.conceptCost, requestError: this.#requestError });
    // Tick L1: pausing gates actions, but keeps the stage's pre-pause words.
    // A reload has no previous words: initialize from the underlying feature verdict.
    // Consent withdrawal and erasure still clear dependent presentation normally.
    if (initial || !this.#session.paused || consentChanged || this.#session.consentWithdrawn || this.#session.tombstone) {
      const line = draftsLine({ copy: this.copy, cost: this.#session.conceptCost, feature });
      if (!['pending', 'failed', 'waiting'].includes(status.phase) && !this.#requestError && (!this.items.length || !feature.available)) this.#paintReason(text, feature, words, line);
      else paintConsentLine(text, { copy: this.copy, feature: (this.#withdrawnKind ?? this.visualKind()) === 'html' ? 'html' : 'images', verdict: feature, text: words, open: opener => this.consent?.(opener, this.#withdrawnKind ?? this.visualKind()) });
    }
    if (status.phase === 'pending') {
      const estimate = conceptProgress(status); node.value = estimate.percent;
      countdown.textContent = estimate.overdue ? this.copy.conceptOverdue : this.copy.conceptCountdown.replace('{seconds}', estimate.seconds);
    } else { node.value = status.phase === 'ready' ? 100 : 0; countdown.textContent = ''; }
    this.root.querySelector('.concept-rail').dataset.phase = status.phase;
    this.paintBackdropState(unbound);
  }
  #paintReason(text, feature, words, line) {
    const disabled = !feature.available && (feature.rawReason ?? feature.reason) === 'visuals off';
    if (disabled || line.recovery) {
      // The same native action as C1; only the destination differs.
      if (!text.querySelector('.drafts-settings-action')) {
        const label = document.createElement('span'), action = reasonAction('', opener => text.dataset.recovery === 'retry' ? void this.retry?.() : this.settings?.(opener));
        label.className = 'drafts-disabled-copy'; action.classList.add('drafts-settings-action');
        label.id = `drafts-${text === this.root.querySelector('.concept-activity-text') ? 'rail' : 'canvas'}-sentence`; action.setAttribute('aria-describedby', label.id);
        action.dataset.focusKey = 'drafts-settings'; text.replaceChildren(label, action);
      }
      delete text.dataset.consentFeature;
      text.dataset.recovery = line.recovery ?? 'settings';
      text.querySelector('.drafts-disabled-copy').textContent = `${disabled ? this.copy.display.draftsDisabled : line.message}${reasonSeparator}`;
      text.querySelector('.drafts-settings-action').textContent = disabled ? this.copy.display.draftsEnable : line.label;
    } else paintConsentLine(text, { copy: this.copy, feature: (this.#withdrawnKind ?? this.visualKind()) === 'html' ? 'html' : 'images', verdict: feature, text: words, open: opener => this.consent?.(opener, this.#withdrawnKind ?? this.visualKind()) });
    const consentLabel = text.querySelector('.consent-line-copy');
    if (consentLabel) {
      consentLabel.id = `consent-${text === this.root.querySelector('.concept-activity-text') ? 'rail' : 'canvas'}-sentence`;
      text.querySelector('.consent-action').setAttribute('aria-describedby', consentLabel.id);
    }
  }
  // Every control keeps a fixed slot, so state renders at once, also under the pointer (AIT-116 D3).
  render() {
    const owner = this.#session?.id, epoch = this.#epoch;
    this.progress();
    const latest = this.items.at(-1), tab = this.root.querySelector('.concept-tab'), latestDraft = latest ? conceptKind(latest) === 'html' : this.#withdrawnKind === 'html';
    if (latest) this.#readViewed();
    const view = latestDraft ? this.copy.conceptDraftView : this.copy.conceptView;
    tab.dataset.unread = String(Boolean(latest && !this.#seen.has(latest.id))); tab.disabled = !latest;
    tab.title = latest ? view : this.feature().reason ?? this.copy.conceptIntro;
    // The thumbnail slot keeps its size: an image, or a glyph for a draft (a live frame stays in the viewer).
    const preview = this.root.querySelector('.concept-preview');
    const gone = this.#consentRefreshFailed || this.#withdrawnKind && this.#withdrawnUntil > Date.now();
    preview.disabled = !latest && !gone; preview.style.visibility = latest || gone ? '' : 'hidden';
    preview.toggleAttribute('data-withdrawn', Boolean(gone && !latest));
    preview.querySelector('.concept-preview-thumbs').hidden = latestDraft;
    for (const image of preview.querySelectorAll('img')) image.hidden = latestDraft; preview.querySelector('.concept-preview-glyph').hidden = !latestDraft;
    const previewLabel = this.#phone.matches && this.#imageLayout ? this.copy.conceptPhoneReady : view;
    preview.querySelector('.concept-preview-label').textContent = previewLabel; preview.setAttribute('aria-label', gone && !latest ? this.root.querySelector('.concept-withdrawn').textContent : previewLabel);
    if (latest && !latestDraft && (this.visualKind() === 'html' || !this.backdropHidden())) void this.load(latest.id).then(url => {
      if (owner === this.#session?.id && epoch === this.#epoch && this.items.at(-1)?.id === latest.id && url && (this.visualKind() === 'html' || !this.backdropHidden())) this.paintThumbnail(latest.id, url);
    });
    else this.clearThumbnail();
    this.paintBackdrop();
    this.gates();
    if (!this.dialog.open) {
      if (this.#withdrawnKind || this.#consentRefreshFailed) {
        const count = this.items.length;
        this.root.querySelector('.concept-count').textContent = count ? this.copy.conceptCount.replace('{current}', count).replace('{count}', count) : '';
        this.root.querySelector('.concept-previous').disabled = count <= 1;
        this.root.querySelector('.concept-next').disabled = true;
      }
      return;
    }
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
    this.paintGuidance(current.feedback?.chips ?? []);
    const image = this.root.querySelector('.concept-image'), draft = this.root.querySelector('.concept-html'), imageStatus = this.root.querySelector('.concept-image-status');
    image.hidden = html; draft.hidden = !html;
    if (html) { this.renderDraft(current, draft, imageStatus); image.removeAttribute('src'); delete image.dataset.id; return; }
    if (draft.artifact) draft.artifact = null;
    delete draft.dataset.id;
    if (image.dataset.id !== current.id) { image.removeAttribute('src'); image.dataset.id = current.id; }
    imageStatus.textContent = this.copy.conceptLoading;
    void this.load(current.id).then(url => { if (owner === this.#session?.id && epoch === this.#epoch && this.current()?.id === current.id && this.dialog.open) {
      if (url) image.src = url; imageStatus.textContent = url ? '' : this.copy.conceptImageFailed;
    } });
  }
  // The preview keeps one frame per shown revision: live renders that don't change the
  // revision leave it (and whatever the person did inside it) alone.
  renderDraft(current, draft, status) {
    if (!this.covered('html') || !this.items.some(item => item.id === current.id)) { draft.artifact = null; delete draft.dataset.id; return; }
    status.textContent = '';
    if (draft.dataset.id === current.id && draft.artifact) return;
    draft.dataset.id = current.id;
    draft.artifact = this.previewSource(current.id);
  }
  previewSource(id) {
    const sessionId = this.#session.id, epoch = this.#epoch, scopeEpoch = this.#scopeEpoch.html;
    return { mediaType: HTML_MEDIA_TYPE, previewURL: this.previewURL, mint: async signal => {
      const active = () => !signal?.aborted && epoch === this.#epoch && scopeEpoch === this.#scopeEpoch.html && sessionId === this.#session.id && this.items.some(item => item.id === id);
      if (!active() || typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(id)) throw new Error('Preview scope expired');
      if (this.#previewDenied.get(id) === this.#session.consentRevision) throw new Error('Preview scope denied');
      if (Date.now() < this.#previewRetryAt) throw new Error('Preview retry later');
      const response = await postJson(this.sameOrigin(this.path(`/${id}/preview`)), {}, {
        sessionToken: this.sessionToken, cache: 'no-store', redirect: 'error', signal,
      });
      if (!active()) throw new Error('Preview scope expired');
      if (response.status === 403) this.#previewDenied.set(id, this.#session.consentRevision);
      if (response.status === 503) {
        const seconds = Number(response.headers.get('retry-after'));
        this.#previewRetryAt = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 60_000) : 60_000);
      }
      if (!response.ok) throw new Error('Preview unavailable');
      const source = await response.json();
      if (!active()) throw new Error('Preview scope expired');
      return source;
    } };
  }
  // Temporary admission restrictions gate requests, not the fold. Only a real
  // capability loss restores the transcript; cached drafts survive preset exclusion.
  canShowCanvas() {
    if (!this.#session || this.#session.consentWithdrawn || this.#session.tombstone) return false;
    const feature = this.feature({ ignorePause: true });
    if ([this.copy.notConfigured, 'not configured', 'not offered', 'visuals not offered', 'preset not configured', 'unavailable on device'].includes(feature.rawReason ?? feature.reason)) return false;
    if ((feature.rawReason ?? feature.reason) === 'plugin not in preset') return this.items.length > 0;
    return true;
  }
  // The folded canvas uses the same authenticated loader, revocation rules and sandbox as the viewer.
  suspendCanvas() {
    if (!this.root.querySelector('.workspace')?.hasAttribute('data-folded')) this.#canvasWithdrawnKind = undefined;
    this.#placeAccess?.();
    this.#canvasEpoch++;
    const draft = this.root.querySelector('.canvas-html'), image = this.root.querySelector('.canvas-image');
    if (draft) { draft.artifact = null; delete draft.dataset.id; }
    if (image) { image.removeAttribute('src'); delete image.dataset.id; }
    this.root.querySelector('.canvas-status').textContent = '';
  }
  async paintCanvas() {
    this.#placeAccess?.();
    const draft = this.root.querySelector('.canvas-html'), image = this.root.querySelector('.canvas-image');
    if (!draft || !this.root.querySelector('.workspace')?.hasAttribute('data-folded')) return;
    if (!this.canShowCanvas()) { this.suspendCanvas(); return; }
    const epoch = this.#canvasEpoch, sessionId = this.#session.id;
    const empty = this.root.querySelector('.canvas-empty'), status = this.root.querySelector('.canvas-status');
    const item = this.#session?.consentWithdrawn || this.#session?.tombstone || this.#canvasWithdrawnKind ? null : this.items.at(-1);
    if (this.#canvasCopy !== this.copy.conceptPreview) { draft.copy = this.copy.conceptPreview; this.#canvasCopy = this.copy.conceptPreview; }
    empty.hidden = Boolean(item); draft.hidden = !item || conceptKind(item) !== 'html'; image.hidden = !item || conceptKind(item) === 'html';
    if (!item) {
      this.suspendCanvas();
      const feature = this.accessFeature();
      const line = draftsLine({ copy: this.copy, cost: this.#session.conceptCost, feature });
      empty.querySelector('svg').toggleAttribute('hidden', !line.action);
      const text = empty.querySelector(':scope > span');
      if (line.action) text.textContent = this.copy.layout.canvasEmpty;
      else this.#paintReason(text, feature, line.text, line);
      return;
    }
    if (draft.dataset.id !== item.id) { draft.dataset.id = item.id; draft.artifact = null; image.removeAttribute('src'); }
    status.textContent = conceptKind(item) === 'html' ? this.copy.conceptDraftLoading : this.copy.conceptLoading;
    if (conceptKind(item) === 'html') {
      if (!draft.artifact) draft.artifact = this.previewSource(item.id);
      status.textContent = ''; return;
    }
    if (draft.artifact) draft.artifact = null;
    const bytes = await this.load(item.id);
    if (epoch !== this.#canvasEpoch || sessionId !== this.#session.id || !this.root.querySelector('.workspace')?.hasAttribute('data-folded') ||
      !this.canShowCanvas() || this.items.at(-1)?.id !== item.id) return;
    if (bytes) { image.src = bytes; image.dataset.id = item.id; } status.textContent = bytes ? '' : this.copy.conceptImageFailed;
  }
  #readViewed() {
    if (this.#seenLoaded || !this.#visualsBound()) return;
    // No storage is needed until a bound visual is shown. A failed read is final
    // for this viewer too, so private mode does not trigger retries on every paint.
    this.#seenLoaded = true;
    try {
      const seen = JSON.parse(this.root.ownerDocument.defaultView.localStorage.getItem('aithema-concept-viewed') ?? '[]');
      if (Array.isArray(seen)) for (const id of seen) {
        if (typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(id)) this.#seen.add(id);
      }
    } catch { /* Private mode must not prevent viewing. */ }
  }
  rememberViewed() {
    if (!this.#visualsBound()) return;
    try {
      this.root.ownerDocument.defaultView.localStorage.setItem('aithema-concept-viewed',
        JSON.stringify([...this.#seen].filter(id => /^[a-zA-Z0-9_-]{1,128}$/u.test(id)).slice(-200)));
    } catch { /* Storage is optional, including reads in private mode. */ }
  }
  backdropHidden() {
    return this.visualKind() !== 'image' || this.#unbound || (this.#withdrawnUntil > Date.now() && (!this.#withdrawnKind || !this.items.length)) ||
      ['pending', 'failed'].includes(this.#session?.conceptStatus?.phase) || Boolean(this.#requestError) || !this.items.at(-1);
  }
  paintBackdropState(unbound) {
    const access = this.root.querySelector('.concept-access'), phase = this.#session?.conceptStatus?.phase;
    const consentOnly = this.#withdrawnKind && !this.covered(this.#withdrawnKind) && !this.items.length;
    const state = this.#consentRefreshFailed ? 'gone' : unbound ? 'none' : this.#withdrawnUntil > Date.now() ? 'gone' : consentOnly ? 'consent' : phase === 'pending' && this.#session.transcript.some(turn => !turn.erased && !turn.withdrawn) ? 'gen' :
      phase === 'failed' && this.#session.conceptStatus.error === 'source-removed' ? 'empty' : phase === 'failed' || this.#requestError ? 'err' : this.items.length ? 'ready' : this.#withdrawnKind && !this.covered(this.#withdrawnKind) ? 'consent' : 'idle';
    access.dataset.state = state;
    if (this.visualKind() === 'image' && state === 'err' && !this.#requestError && !this.#session.conceptStatus?.reason)
      this.root.querySelector('.concept-activity-text').textContent = this.copy.conceptBackdropFailed;
    if (this.#imageLayout && state === 'err') {
      const text = this.root.querySelector('.concept-activity-text');
      const failureCopy = text.querySelector('.consent-line-copy') ?? text;
      paintFailureLine(failureCopy, failureCopy.textContent);
    }
    access.toggleAttribute('data-scope-withdrawn', Boolean(this.#consentRefreshFailed || this.#withdrawnKind && !this.covered(this.#withdrawnKind)));
    access.toggleAttribute('data-refresh-failed', this.#consentRefreshFailed);
    access.toggleAttribute('data-partial-withdrawal', Boolean(!this.#consentRefreshFailed && this.#withdrawnKind && state === 'gone'));
    const notice = this.root.querySelector('.concept-withdrawn');
    const key = this.#withdrawnKind === 'html' ? 'conceptDraftWithdrawn' : 'conceptImageWithdrawn';
    const words = state === 'gone' ? this.#withdrawnKind && !this.#consentRefreshFailed ? this.copy[key + (this.#phone.matches ? 'Narrow' : '')] : this.copy.conceptWithdrawn : '';
    notice.setAttribute('aria-live', 'polite');
    // Repeated feature refreshes do not retrigger the live announcement.
    if (notice.textContent !== words) notice.textContent = words;
    const bottom = this.root.querySelector('.concept-bottom');
    bottom.dataset.state = state;
    const estimate = state === 'gen' ? conceptProgress(this.#session.conceptStatus) : null;
    const label = estimate ? `${this.copy.conceptBackdropRendering} ${estimate.overdue ? this.copy.conceptOverdue : this.copy.conceptBackdropCountdown.replace('{seconds}', estimate.seconds)}` : '';
    // One status node: the same bottom label moves to the phone row.
    const labelNode = this.root.querySelector('.concept-bottom-label');
    labelNode.textContent = label;
    bottom.querySelector('progress').value = estimate?.percent ?? 0;
    (this.#phone.matches && this.#imageLayout ? access : this.root.querySelector('.concept-thread')).append(bottom);
    const preview = this.root.querySelector('.concept-preview');
    preview.querySelector('.concept-preview-label').textContent = this.#phone.matches && this.#imageLayout
      ? this.copy.conceptPhoneReady : conceptKind(this.items.at(-1)) === 'html' ? this.copy.conceptDraftView : this.copy.conceptView;
    if (this.backdropHidden()) { this.clearBackdrop(); if (this.visualKind() === 'image') this.clearThumbnail(); }
  }
  clearThumbnail() {
    for (const image of this.root.querySelectorAll('.concept-preview img')) {
      image.removeAttribute('src'); image.removeAttribute('data-on'); delete image.dataset.id;
    }
  }
  paintThumbnail(id, url) {
    const thumbs = this.root.querySelector('.concept-preview-thumbs'), images = [...thumbs.querySelectorAll('img')];
    const previous = images.find(image => image.hasAttribute('data-on'));
    if (previous?.dataset.id === id) return;
    const next = images.find(image => image !== previous); next.src = url; next.dataset.id = id;
    void next.offsetWidth;
    previous?.removeAttribute('data-on'); next.setAttribute('data-on', '');
    // The first img remains the current thumbnail for existing host/test queries.
    thumbs.prepend(next);
  }
  clearBackdrop() {
    this.#backdropEpoch++; this.#backdropId = undefined;
    for (const image of this.root.querySelectorAll('.concept-backdrop img')) {
      image.removeAttribute('src'); image.removeAttribute('data-on'); delete image.dataset.id;
    }
    this.clearHover();
  }
  paintBackdrop() {
    if (this.backdropHidden()) return;
    const item = this.items.at(-1), epoch = this.#backdropEpoch, sessionId = this.#session.id;
    if (this.#backdropId === item.id) return;
    void this.load(item.id).then(url => {
      if (!url || epoch !== this.#backdropEpoch || sessionId !== this.#session.id || this.backdropHidden() || this.items.at(-1)?.id !== item.id) return;
      const images = [...this.root.querySelectorAll('.concept-backdrop img')];
      if (this.#backdropId === item.id) return;
      const previous = images.find(image => image.hasAttribute('data-on'));
      const next = images.find(image => image !== previous);
      next.src = url; next.dataset.id = item.id;
      // Commit the starting opacity before enabling the new layer. Both layers
      // use only opacity; revocation bypasses transitions by removing the bytes.
      void next.offsetWidth;
      previous?.removeAttribute('data-on'); next.setAttribute('data-on', '');
      this.#backdropId = item.id; this.sharpen();
    });
  }
  clearHover() {
    this.#hover = false;
    this.root.querySelector('.concept-thread').removeAttribute('data-hover');
    this.root.querySelector('.concept-backdrop-hint').removeAttribute('data-show'); this.sharpen();
  }
  sharpen() {
    this.root.querySelector('.concept-thread').toggleAttribute('data-near', !this.backdropHidden() &&
      (this.#hover || this.root.activeElement === this.root.querySelector('.concept-preview')));
  }
  exposedAt(x, y, target = this.root.elementFromPoint?.(x, y)) {
    if (this.#phone.matches || !this.#backdropId || this.backdropHidden() || target?.closest('.turn,.upload,button,a,input,textarea,select,[role="button"],.concept-bottom')) return false;
    const box = this.root.querySelector('.concept-backdrop').getBoundingClientRect();
    return Boolean(target && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom);
  }
  placeHint(px, py) {
    const hint = this.root.querySelector('.concept-backdrop-hint'), stage = this.root.querySelector('.concept-thread').getBoundingClientRect();
    hint.textContent = this.copy.conceptView;
    const w = hint.offsetWidth, h = hint.offsetHeight;
    // Sample the whole hint and its clearance, including edges. A nearby bubble
    // suppresses the hint, even while the exposed background stays sharpened.
    const free = (x, y) => {
      for (let yy = y - 8; yy <= y + h + 8; yy += 4) for (let xx = x - 8; xx <= x + w + 8; xx += 4)
        if (!this.exposedAt(xx, yy)) return false;
      return true;
    };
    for (const [dx, dy] of [[14, 18], [14, -h - 12], [-w - 14, 18], [-w - 14, -h - 12]]) {
      const x = px + dx, y = py + dy;
      if (free(x, y)) {
        hint.style.left = `${Math.round(x - stage.left)}px`; hint.style.top = `${Math.round(y - stage.top)}px`;
        hint.setAttribute('data-show', ''); return;
      }
    }
    hint.removeAttribute('data-show');
  }
  guidanceToggle(value) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = value; button.dataset.value = value;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => { const value = button.dataset.value, current = this.current(), chips = current?.feedback?.chips ?? [];
      void this.feedback(current?.feedback?.vote ?? 'clear', chips.includes(value) ? chips.filter(c => c !== value) : [...chips, value]); });
    return button;
  }
  // Every toggle keeps its node, so a focused one stays focused across live renders. Guidance that
  // is not one of the fixed choices (e.g. saved in another language) shows as an extra pressed toggle
  // after them, removable the same way.
  paintGuidance(chips) {
    const options = this.root.querySelector('.concept-guidance-options'), fixed = new Set(this.copy.conceptGuidance);
    for (const button of [...options.children]) if (!fixed.has(button.dataset.value) && !chips.includes(button.dataset.value)) button.remove();
    const extra = chips.filter(value => !fixed.has(value) && ![...options.children].some(b => b.dataset.value === value));
    options.append(...extra.map(value => this.guidanceToggle(value)));
    for (const button of options.children) button.setAttribute('aria-pressed', String(chips.includes(button.dataset.value)));
    if (extra.length) this.gates();
  }
  gates() {
    const active = this.root.activeElement; // captured before any control below is disabled
    const feature = this.#withdrawnKind && !this.covered(this.visualKind()) ? this.accessFeature() : this.feature(), pending = this.#session?.conceptStatus?.phase === 'pending';
    const source = this.#session?.transcript.some(t => t.role === 'user' && !t.erased && !t.withdrawn);
    const line = draftsLine({ copy: this.copy, cost: this.#session?.conceptCost,
      feature: this.#session?.paused && !this.#session.consentWithdrawn && !this.#session.tombstone ? this.#stageFeature ?? feature : feature });
    const costCopy = line.action ? creditCost(this.#session.conceptCost.maxMicro, this.copy) : '';
    const request = this.root.querySelector('.concept-request');
    this.root.querySelector('.concept-activity').hidden = line.action && !['pending', 'failed', 'waiting'].includes(this.#session?.conceptStatus?.phase);
    request.textContent = this.#session?.conceptStatus?.phase === 'failed' && line.action ? [this.copy.conceptRetry, costCopy].filter(Boolean).join(reasonSeparator) : line.text;
    request.hidden = !line.action;
    request.disabled = this.#busy || pending || !feature.available || !line.action || !source; request.title = !feature.available ? feature.reason : !source ? this.copy.conceptNeedsInput : '';
    const regenerate = this.root.querySelector('.concept-regenerate'); regenerate.textContent = [this.copy.conceptRegenerate, costCopy].filter(Boolean).join(reasonSeparator);
    regenerate.hidden = !line.action; regenerate.disabled = request.disabled || !this.current(); regenerate.title = request.title;
    for (const node of this.root.querySelectorAll('.concept-feedback button, .concept-guidance-options button')) {
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
    if (conceptControlsBlocked(this.root)) return;
    if (!id || !this.items.some(c => c.id === id)) return;
    this.#readViewed();
    this.#trigger = this.root.activeElement; this.#selected = id; this.#seen.add(id); this.rememberViewed();
    if (!this.dialog.open) this.dialog.showModal(); this.render(); this.root.querySelector('.concept-close').focus();
    // Viewing mints only a scoped preview capability; it never requests generation or spending.
  }
  close() {
    if (!this.dialog.open) return;
    // Closing invalidates pending mints; reopening always mints a fresh source.
    const draft = this.root.querySelector('.concept-html'); draft.artifact = null; delete draft.dataset.id;
    this.root.querySelector('.concept-viewer-message').textContent = ''; this.#pointer = false; this.#pointerStage = false;
    this.dialog.close(); this.#trigger?.focus(); this.#trigger = null;
  }
  navigate(delta) {
    const index = this.items.findIndex(c => c.id === this.#selected), next = this.items[index + delta];
    if (next) { this.#selected = next.id; this.#seen.add(next.id); this.rememberViewed(); this.root.querySelector('.concept-viewer-message').textContent = ''; this.render(); }
  }
  /** Image object URLs and static-download bytes only. Executable previews use previewSource. */
  async load(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(id) || !this.items.some(item => item.id === id)) return null;
    if (this.#urls.has(id)) return this.#urls.get(id);
    if (this.#drafts.has(id)) return this.#drafts.get(id);
    if (this.#loads.has(id)) return this.#loads.get(id);
    const sessionId = this.#session.id, epoch = this.#epoch, html = conceptKind(this.#session.concepts?.find(c => c.id === id)) === 'html';
    const scopeEpoch = this.#scopeEpoch[html ? 'html' : 'image'];
    const promise = (async () => {
      try {
        const response = await fetch(this.sameOrigin(this.path(`/${id}/${html ? 'html' : 'image'}`)), { headers: this.headers(), cache: 'no-store' });
        const type = response.headers.get('content-type');
        if (!response.ok || !(html ? type === 'application/octet-stream' : ['image/png', 'image/jpeg', 'image/webp'].includes(type))) throw new Error();
        const data = html ? new Uint8Array(await response.arrayBuffer()) : await response.blob();
        if (epoch !== this.#epoch || scopeEpoch !== this.#scopeEpoch[html ? 'html' : 'image'] || sessionId !== this.#session.id || !this.items.some(c => c.id === id)) return null;
        if (html) { this.#drafts.set(id, data); return data; }
        const url = URL.createObjectURL(data); this.#urls.set(id, url); return url;
      } catch { return null; }
    })().finally(() => { if (this.#loads.get(id) === promise) this.#loads.delete(id); });
    this.#loads.set(id, promise); return promise;
  }
  async request(artifactId) {
    if (conceptControlsBlocked(this.root)) return;
    if (this.#busy || !this.feature().available || !draftsLine({ copy: this.copy, cost: this.#session.conceptCost, feature: this.feature() }).action || this.#session.conceptStatus?.phase === 'pending') return;
    const sourceTurnId = this.#session.transcript.filter(t => t.role === 'user' && !t.erased && !t.withdrawn).at(-1)?.id;
    if (!sourceTurnId) return;
    const focused = this.root.activeElement; this.#busy = true; this.#requestError = null; this.gates(); const sessionId = this.#session.id, lifetime = this.#lifetime;
    const active = () => lifetime === this.#lifetime && sessionId === this.#session.id;
    try {
      const response = await postJson(this.sameOrigin(this.path(artifactId ? `/${artifactId}/regenerate` : '')),
        { clientEventId: crypto.randomUUID(), intent: true, sourceTurnId }, { sessionToken: this.sessionToken });
      if (!response.ok) throw Object.assign(new Error(), { reason: (await response.json().catch(() => null))?.reason });
      const ack = await response.json(); if (active()) this.receive(ack.event);
    } catch (error) {
      // A refusal with a known reason (a limit, the spending cap) says so in plain words.
      if (active()) { this.#requestError = typeof error.reason === 'string' ? sentence(reasonText(this.copy, error.reason, this.visualKind() === 'html' ? 'html' : 'images')) : this.copy.conceptFailed; this.render(); }
    }
    finally { if (active()) { this.#busy = false; this.gates(); this.refocus(focused); } }
  }
  async feedback(vote, chips, reject = false) {
    const current = this.current(); if (this.#busy || !current || !this.feature().available || chips.length > 8) return;
    const focused = this.root.activeElement; this.#busy = true; this.gates(); const sessionId = this.#session.id, lifetime = this.#lifetime;
    const active = () => lifetime === this.#lifetime && sessionId === this.#session.id;
    try {
      const response = await postJson(this.sameOrigin(this.path(`/${current.id}/${reject ? 'reject' : 'feedback'}`)),
        { clientEventId: crypto.randomUUID(), vote, chips }, { sessionToken: this.sessionToken });
      if (!response.ok) throw new Error(); const ack = await response.json();
      if (active()) { this.receive(ack.event); if (reject) this.close(); }
    } catch { if (active()) this.root.querySelector('.concept-viewer-message').textContent = this.copy.controlFailed; }
    finally { if (active()) { this.#busy = false; this.gates(); this.refocus(focused); } }
  }
  async download() {
    const current = this.current(); if (!current) return;
    const sessionId = this.#session.id, epoch = this.#epoch; let url;
    if (conceptKind(current) === 'html') {
      // The same static file as the export: the draft with scripts turned off, never the raw bytes.
      try {
        const bytes = await this.load(current.id);
        if (!bytes || !inspectHTML(bytes).ok) throw new Error();
        if (epoch !== this.#epoch || sessionId !== this.#session.id || !this.items.some(c => c.id === current.id)) return;
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
      if (epoch !== this.#epoch || sessionId !== this.#session.id || !this.items.some(c => c.id === current.id)) return;
      url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url;
      link.download = `concept-${current.id}.${current.mediaType.split('/')[1]}`; link.click();
    } catch { this.root.querySelector('.concept-viewer-message').textContent = this.copy.conceptImageFailed; }
    finally { if (url) URL.revokeObjectURL(url); }
  }
  destroy() { this.suspend(); this.dialog.remove(); }
}
