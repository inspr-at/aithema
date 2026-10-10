// The host surface inside <aithema-session> (AIT-104 B2): the host bar (conversation library,
// verification entry, credits, the host's account slot), the verification lock on the
// understanding pane, the handover band and the host's legal and footer slots. Each part
// appears only when the host enables it in configure({host}); all facts come from the server.
import { inputRevision, activeTurns } from '../../core/src/session.js';
import { postJson, sameOrigin } from './post-json.js';
import { node, setText, fill } from './dom.js';
import { Verification } from './verification.js';
import { LibraryDialog } from './library-dialog.js';

const LIBRARY_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>';
const MINUTE = 60_000;
export const defaultCreditFormat = (micro, locale) => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(micro / 1_000_000);

export class HostSurface {
  #root; #copy; #options; #base; #token; #session; #status; #adopt; #view; #alive = true; #connected = false;
  #verification = null; #library = null; #offer = null; #handover = null; #requesting = false; #limit = null;
  #credits = null; #creditsAt = 0; #creditsLoad = 0; #creditsTimer = null; #creditsTick = null; #ended = null;
  /**
   * options: {library, verification, handover, credits: true | {format(micro, locale)}, locale()}.
   * session() returns the live session; adopt(session, reason) opens another conversation.
   */
  constructor({ root, copy, options, baseUrl, sessionToken, session, status, adopt, onLock, focusAfterUnlock }) {
    this.#root = root; this.#copy = copy; this.#options = options ?? {}; this.#base = baseUrl; this.#token = sessionToken;
    this.#session = session; this.#status = status; this.#adopt = adopt; this.#view = root.host?.ownerDocument?.defaultView ?? globalThis.window;
    const o = this.#options, bar = root.querySelector('.host-bar'), s = copy.hostSurface;
    root.querySelector('.workspace').toggleAttribute('data-host', true);
    bar.hidden = false; bar.setAttribute('aria-label', s.bar);
    root.querySelector('.understanding').toggleAttribute('data-host', true);
    // The library: the bar's first action opens the dialog.
    const open = bar.querySelector('.library-open-dialog');
    open.hidden = !o.library;
    if (o.library) {
      open.innerHTML = LIBRARY_ICON; open.append(node('span', '', s.library.open));
      this.#library = new LibraryDialog({ dialog: root.querySelector('dialog.library'), copy, request: (path, body) => this.#call(`/api/library${path}`, body),
        current: () => this.#session().id, locale: () => o.locale?.() ?? this.#session().locale ?? 'en', adopt: (next, reason) => this.#adopt(next, reason),
        notice: () => root.querySelector('#ai-notice')?.textContent ?? '' });
      open.addEventListener('click', () => this.#library.show(open));
    }
    if (o.verification) {
      this.#verification = new Verification({ root, copy, request: (path, body) => this.#call(this.#sessionPath(path), body), status, onChange: onLock,
        focusAfterUnlock, entry: bar.querySelector('.host-verify'), lock: root.querySelector('.verify-lock'), dialog: root.querySelector('dialog.verify-dialog'),
        identity: this.#session().identity, pollMs: o.pollMs, notice: () => root.querySelector('#ai-notice')?.textContent ?? '' });
    }
    this.#mountHandover(); this.#mountFoot();
    this.#handover = this.#session().handover ?? null;
    this.#paintCredits(); this.#paintHandover();
  }
  get locked() { return this.#verification?.locked ?? false; }
  /** The understanding pane holds host controls: the verification form while locked, or the handover band. */
  get holdsControls() { return this.locked || Boolean(this.#options.handover); }
  get verification() { return this.#verification; }
  get library() { return this.#library; }
  /** Starts host reads once the element is in the page. */
  connect() {
    this.#connected = true;
    void this.#verification?.load(); this.#verification?.connect();
    if (this.#options.handover && this.#offer === null) void this.#loadHandover();
    if (this.#options.credits) { void this.#loadCredits(); this.#tickCredits(); }
  }
  disconnect() {
    this.#connected = false; this.#verification?.disconnect();
    clearInterval(this.#creditsTick); this.#creditsTick = null; clearTimeout(this.#creditsTimer); this.#creditsTimer = null;
  }
  destroy() { this.#alive = false; this.disconnect(); this.#verification?.destroy(); this.#library?.destroy(); }
  /** Durable host events (already applied to the session projection) and the turns that change balances. */
  receive(event) {
    this.#verification?.receive(event);
    if (event.type === 'handover.state') { this.#handover = event.data; this.#requesting = false; this.#limit = null; }
    if (event.type === 'handover.limit-reached') this.#limit = inputRevision(this.#session());
    if (event.type === 'library.state' || event.type === 'session.erased') this.#library?.changed();
    if (event.type === 'credits.limit-reached' || event.type === 'conversation.end-requested') {
      const reason = event.data?.reason;
      if (event.type === 'credits.limit-reached') this.#status(this.#copy.hostSurface.credits.ended[reason] ?? this.#copy.hostSurface.credits.ended.session);
      this.#ended = reason ?? this.#ended ?? 'session';
    }
    if (['credits.state', 'credits.limit-reached', 'conversation.end-requested', 'session.paused'].includes(event.type) ||
      event.type === 'turn.final' && event.data?.role === 'assistant' || event.type === 'concept.state' && event.data?.artifact) this.#refreshCredits();
    this.update();
  }
  /** A restored snapshot replaces the projection: identity and handover follow it. */
  resync() {
    const session = this.#session();
    if (session.identity !== undefined) this.#verification?.set(session.identity ?? null);
    if (session.handover !== undefined) this.#handover = session.handover;
    this.#refreshCredits(); this.update();
  }
  /** Repaints parts that follow the session (person turns, revisions, pause). */
  update() { this.#paintHandover(); this.#paintCredits(); }
  #sessionPath(path) { return `/api/sessions/${encodeURIComponent(this.#session().id)}/${path}`; }
  // Owner routes: same origin only; the owner cookie or the session token authenticates them.
  async #call(path, body) {
    const sessionId = this.#session().id, url = sameOrigin(this.#view, `${this.#base}${path}`);
    const response = body === undefined
      ? await fetch(url, { headers: this.#token ? { 'x-aithema-session-token': this.#token } : {}, cache: 'no-store' })
      : await postJson(url, body, { sessionToken: this.#token });
    let value = null; try { value = await response.json(); } catch { /* A body-less reply carries its status only. */ }
    if (!this.#alive || sessionId !== this.#session().id) throw new Error('Conversation changed');
    return { ok: response.ok, status: response.status, body: value };
  }
  // Handover (START offer.ts): the host's offer copy in a slot, one action, its state in words.
  #mountHandover() {
    const band = this.#root.querySelector('.handover'), h = this.#copy.hostSurface.handover;
    setText(band.querySelector('h3'), h.title);
    setText(band.querySelector('slot[name="handover-offer"]'), h.offer);
    const button = band.querySelector('.handover-request');
    // The button keeps the width of its longest label, so a state change never moves it.
    for (const label of [h.request, h.update, h.retry]) { const sizer = node('span', 'handover__sizer', label); sizer.setAttribute('aria-hidden', 'true'); button.append(sizer); }
    button.prepend(node('span', 'handover__label'));
    button.addEventListener('click', () => void this.#requestHandover());
  }
  async #loadHandover() {
    try {
      const response = await this.#call(this.#sessionPath('handover'));
      if (!response.ok) { this.#offer = false; this.#paintHandover(); return; }
      this.#offer = response.body?.offer ?? false;
      if (response.body?.handover) this.#handover = response.body.handover;
    } catch { if (this.#alive) this.#offer = false; }
    if (this.#alive) this.#paintHandover();
  }
  #handoverState() {
    const h = this.#copy.hostSurface.handover, session = this.#session(), view = this.#handover, revision = inputRevision(session);
    const hasInput = activeTurns(session).some(turn => turn.role === 'user') || (session.uploads ?? []).some(u => u.state === 'accepted');
    if (this.#requesting || view?.status === 'preparing') return { label: view?.status === 'failed' ? h.retry : h.request, text: h.preparing, disabled: true };
    if (this.#limit === revision) return { label: h.request, text: h.limit, disabled: true };
    if (view?.status === 'failed') return { label: h.retry, text: h.failed, disabled: false, retry: true };
    if (view?.status === 'sent' && view.revision === revision) return { label: h.request, text: h.sent, disabled: true };
    if (!hasInput || session.tombstone) return { label: h.request, text: h.needsInput, disabled: true };
    if (view?.status === 'sent') return { label: h.update, text: h.changed, disabled: false };
    return { label: h.request, text: '', disabled: false };
  }
  #paintHandover() {
    const band = this.#root.querySelector('.handover'), aside = this.#root.querySelector('.understanding');
    const shown = Boolean(this.#options.handover) && this.#offer !== false && (this.#offer === null || this.#offer?.available === true);
    band.hidden = !shown; aside.toggleAttribute('data-handover', shown);
    if (!shown) return;
    const state = this.#handoverState(), button = band.querySelector('.handover-request');
    setText(button.querySelector('.handover__label'), state.label);
    button.setAttribute('aria-disabled', String(state.disabled || this.#offer === null));
    button.dataset.retry = String(Boolean(state.retry));
    setText(band.querySelector('.handover__state'), state.text);
  }
  async #requestHandover() {
    const button = this.#root.querySelector('.handover-request');
    if (button.getAttribute('aria-disabled') === 'true') return;
    const retry = button.dataset.retry === 'true';
    this.#requesting = true; this.#paintHandover();
    let response = null;
    try { response = await this.#call(this.#sessionPath(retry ? 'handover/retry' : 'handover'), {}); }
    catch { if (!this.#alive) return; }
    this.#requesting = false;
    if (response?.ok && response.body?.handover) this.#handover = response.body.handover;
    else this.#handover = { ...this.#handover ?? {}, status: 'failed' };
    this.#paintHandover();
  }
  // Credits: the owner's balance and the conversation's time slot, read from the server.
  #refreshCredits() {
    if (!this.#options.credits || !this.#connected) return;
    clearTimeout(this.#creditsTimer);
    this.#creditsTimer = setTimeout(() => void this.#loadCredits(), 300);
  }
  async #loadCredits() {
    const load = ++this.#creditsLoad;
    try {
      const response = await this.#call(this.#sessionPath('credits'));
      if (!this.#alive || load !== this.#creditsLoad || !response.ok) return;
      this.#credits = response.body; this.#creditsAt = Date.now();
      const slot = this.#credits?.limitSlot;
      if (['ending', 'ended'].includes(slot?.status)) this.#ended = slot.endReason ?? this.#ended ?? 'session';
      this.#paintCredits();
    } catch { /* The last known line stays until the next read. */ }
  }
  #tickCredits() {
    clearInterval(this.#creditsTick);
    this.#creditsTick = setInterval(() => { if (this.#alive) this.#paintCredits(); }, 15_000);
  }
  #paintCredits() {
    const line = this.#root.querySelector('.host-credits');
    line.hidden = !this.#options.credits;
    if (!this.#options.credits) return;
    const c = this.#copy.hostSurface.credits, session = this.#session(), locale = session.locale ?? 'en';
    const format = typeof this.#options.credits?.format === 'function' ? this.#options.credits.format : defaultCreditFormat;
    const limit = line.querySelector('.host-credits__limit'), text = line.querySelector('.host-credits__text');
    if (this.#ended) {
      setText(text, c.ended[this.#ended] ?? c.ended.session); limit.hidden = false; line.dataset.ended = 'true';
      return;
    }
    limit.hidden = true; line.dataset.ended = 'false';
    const owner = this.#credits?.balance?.owner, slot = this.#credits?.limitSlot;
    if (!owner) { setText(text, ''); return; }
    const parts = [fill(c.balance, { available: format(owner.availableMicro, locale), limit: format(owner.limitMicro, locale) })];
    if (slot?.status === 'active' && Number.isFinite(slot.remainingMs)) {
      // The host's deadline keeps running during a pause (credits.js creditsView), so the countdown never
      // stops; a pause only keeps new paid work from starting, and the line says exactly that.
      const remaining = Math.max(0, slot.remainingMs - (Date.now() - this.#creditsAt));
      parts.push(fill(c.remaining, { minutes: Math.ceil(remaining / MINUTE) }));
      if (session.paused) parts.push(c.paused);
    }
    setText(text, parts.join(' · '));
  }
  // Legal and footer slots: the hairline row shows only when the host filled one of them.
  #mountFoot() {
    const foot = this.#root.querySelector('.host-foot');
    const sync = () => { foot.hidden = ![...foot.querySelectorAll('slot')].some(slot => slot.assignedNodes?.({ flatten: true }).length); };
    for (const slot of foot.querySelectorAll('slot')) slot.addEventListener('slotchange', sync);
    sync();
  }
}
