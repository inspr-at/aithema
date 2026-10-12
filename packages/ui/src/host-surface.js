// The host surface inside <aithema-session> (AIT-104 B2): the host bar (conversation library,
// credits, the host's account slot), the verification entry in Settings, the verification lock on the
// understanding pane, the handover band and the host's legal and footer slots. Each part
// appears only when the host enables it in configure({host}); all facts come from the server.
import { inputRevision, activeTurns } from '../../core/src/session.js';
import { postJson, sameOrigin } from './post-json.js';
import { node, setText, fill } from './dom.js';
import { Verification } from './verification.js';
import { LibraryDialog } from './library-dialog.js';
import { ConversationsMenu } from './conversations-menu.js';
import { formatCredits, wholeCredits } from './display.js';

export const defaultCreditFormat = formatCredits;

export class HostSurface {
  #root; #copy; #options; #base; #token; #session; #status; #adopt; #view; #alive = true; #connected = false;
  #verification = null; #library = null; #offer = null; #handover = null; #requesting = false; #limit = null;
  #credits = null; #creditsLoad = 0; #creditsTimer = null; #creditsPoll = null; #ended = null;
  #menu = null; #openSettings; #onCredits; #creditEnding;
  /**
   * options: {library, verification, handover, credits: true | {format(micro, locale)}, locale()}.
   * session() returns the live session; adopt(session, reason) opens another conversation.
   */
  constructor({ root, copy, options, baseUrl, sessionToken, session, status, adopt, onLock, focusAfterUnlock, beforeVerifyDialog, verificationOpener, openSettings, onCredits, creditEnding }) {
    this.#root = root; this.#copy = copy; this.#options = options ?? {}; this.#base = baseUrl; this.#token = sessionToken;
    this.#openSettings = openSettings; this.#onCredits = onCredits; this.#creditEnding = creditEnding;
    this.#session = session; this.#status = status; this.#adopt = adopt; this.#view = root.host?.ownerDocument?.defaultView ?? globalThis.window;
    const o = this.#options, bar = root.querySelector('.host-bar'), s = copy.hostSurface;
    root.querySelector('.workspace').toggleAttribute('data-host', true);
    bar.hidden = false; bar.setAttribute('aria-label', s.bar);
    root.querySelector('.understanding').toggleAttribute('data-host', true);
    // Conversations: New first, recent conversations, then the full manager.
    bar.querySelector('.conversations-wrap').hidden = !o.library;
    if (o.library) {
      this.#library = new LibraryDialog({ dialog: root.querySelector('dialog.library'), copy, request: (path, body) => this.#call(`/api/library${path}`, body),
        current: () => this.#session().id, locale: () => this.#session().locale ?? 'en',
        newLocale: () => o.locale?.() ?? this.#session().locale ?? 'en', adopt: (next, reason) => this.#adopt(next, reason),
        notice: () => root.querySelector('#ai-notice')?.textContent ?? '' });
      this.#menu = new ConversationsMenu({ root, copy, request: (path, body) => this.#call(path, body), current: () => this.#session().id,
        locale: () => this.#session().locale ?? 'en', newLocale: () => o.locale?.() ?? this.#session().locale ?? 'en',
        adopt: (next, reason) => this.#adopt(next, reason), manage: opener => this.#library.show(opener), status });
    }
    if (o.verification) {
      this.#verification = new Verification({ root, copy, request: (path, body, verb) => this.#call(path.startsWith('/api/') ? path : this.#sessionPath(path), body, verb), status, onChange: info => { this.#paintCredits(); onLock?.(info); this.#onCredits?.(); },
        creditsChanged: () => this.#loadCredits(), demo: this.#session().demo === true, handover: Boolean(o.handover),
        ...(typeof o.verification === 'object' ? o.verification : {}), locale: () => this.#session().locale ?? 'en',
        focusAfterUnlock, beforeOpen: beforeVerifyDialog, focusReturn: verificationOpener,
        entry: root.querySelector('.host-verify'), lock: root.querySelector('.verify-lock'), dialog: root.querySelector('dialog.verify-dialog'),
        identity: this.#session().identity, pollMs: o.pollMs, notice: () => root.querySelector('#ai-notice')?.textContent ?? '' });
    }
    this.#mountHandover(); this.#mountFoot();
    root.querySelector('.credits-email').addEventListener('click', event => { event.preventDefault(); this.#openSettings?.(); });
    this.#handover = this.#session().handover ?? null;
    this.#paintCredits(); this.#paintHandover();
  }
  setCopy(copy) {
    this.#copy = copy;
    const s = copy.hostSurface, root = this.#root;
    root.querySelector('.host-bar').setAttribute('aria-label', s.bar);
    this.#menu?.setCopy(copy);
    this.#verification?.setCopy(copy); this.#library?.setCopy(copy);
    setText(root.querySelector('.handover h3'), s.handover.title);
    setText(root.querySelector('slot[name="handover-offer"]'), s.handover.offer);
    root.querySelectorAll('.handover__sizer').forEach((n, i) => setText(n, [s.handover.request, s.handover.update, s.handover.retry][i]));
    this.update();
  }
  get tiers() { return this.#credits?.tiers ?? null; }
  get usedUp() { return this.#ended === 'host-limit' || Boolean(this.#credits?.balance?.owner && this.#credits.balance.owner.availableMicro <= 0); }
  get nextTier() { return this.#verification?.enabled && this.#verification.canCollect ? this.tiers?.next ?? null : null; }
  get deltaCredits() { return this.tiers ? defaultCreditFormat(this.tiers.delta, this.#session().locale ?? 'en') : ''; }
  get locked() { return this.#verification?.locked ?? false; }
  /** The understanding pane holds host controls: the verification form while locked, or the handover band. */
  get holdsControls() { return this.locked || Boolean(this.#options.handover); }
  get verification() { return this.#verification; }
  get library() { return this.#library; }
  /** Starts host reads once the element is in the page. */
  connect() {
    this.#connected = true;
    this.#menu?.connect();
    void this.#verification?.load(); this.#verification?.connect();
    if (this.#options.handover && this.#offer === null) void this.#loadHandover();
    if (this.#options.credits) {
      void this.#loadCredits(); clearInterval(this.#creditsPoll);
      this.#creditsPoll = setInterval(() => { if (this.#alive && this.#connected && this.usedUp && this.#root.ownerDocument.visibilityState !== 'hidden') void this.#loadCredits(); }, 15_000);
      this.#creditsPoll.unref?.();
    }
  }
  disconnect() {
    this.#connected = false; this.#verification?.disconnect();
    this.#menu?.disconnect();
    clearTimeout(this.#creditsTimer); this.#creditsTimer = null; clearInterval(this.#creditsPoll); this.#creditsPoll = null;
  }
  destroy() { this.#alive = false; this.disconnect(); this.#verification?.destroy(); this.#library?.destroy(); this.#menu?.destroy(); }
  /** Durable host events (already applied to the session projection) and the turns that change balances. */
  receive(event) {
    this.#verification?.receive(event);
    if (event.type === 'handover.state') { this.#handover = event.data; this.#requesting = false; this.#limit = null; }
    if (event.type === 'handover.limit-reached') this.#limit = inputRevision(this.#session());
    if (event.type === 'library.state' || event.type === 'session.erased') this.#library?.changed();
    if (event.type === 'credits.limit-reached' || event.type === 'conversation.end-requested') {
      const reason = event.data?.reason;
      if (event.type === 'credits.limit-reached' && (reason !== 'host-limit' || !this.#onCredits)) this.#status(this.#copy.hostSurface.credits.ended[reason] ?? this.#copy.hostSurface.credits.ended.session);
      this.#ended = reason ?? this.#ended ?? 'session';
    }
    if (['identity.state', 'identity.unlocked', 'credits.state', 'credits.limit-reached', 'conversation.end-requested', 'session.paused'].includes(event.type) ||
      event.type === 'voice.state' && ['closing', 'ended'].includes(event.data?.state) ||
      event.type === 'turn.final' && event.data?.role === 'assistant' || event.type === 'concept.state' && event.data?.artifact) this.#refreshCredits();
    this.update(); this.#onCredits?.();
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
  async #call(path, body, verb = 'POST') {
    const sessionId = this.#session().id, url = sameOrigin(this.#view, `${this.#base}${path}`);
    const response = body === undefined
      ? await fetch(url, { headers: this.#token ? { 'x-aithema-session-token': this.#token } : {}, cache: 'no-store' })
      : await postJson(url, body, { sessionToken: this.#token, verb });
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
  // Credits are an owner-wide monetary allowance. Reads never start a time slot.
  #refreshCredits() {
    if (!this.#options.credits || !this.#connected) return;
    clearTimeout(this.#creditsTimer); this.#creditsTimer = setTimeout(() => void this.#loadCredits(), 300);
  }
  async #loadCredits() {
    const load = ++this.#creditsLoad;
    try {
      const response = await this.#call(this.#sessionPath('credits'));
      if (!this.#alive || load !== this.#creditsLoad || !response.ok) return;
      this.#credits = response.body;
      const slot = this.#credits?.limitSlot;
      if (slot === null || this.#credits?.balance?.owner?.availableMicro > 0 && slot?.endReason === 'host-limit') this.#ended = null;
      if (['ending', 'ended'].includes(slot?.status)) this.#ended = slot.endReason ?? this.#ended ?? 'session';
      this.#verification?.setCredits(this.#credits); this.#paintCredits(); this.#onCredits?.();
    } catch { /* The last acknowledged values stay until the next read. */ }
  }
  #paintCredits() {
    const line = this.#root.querySelector('.host-credits'); line.hidden = !this.#options.credits;
    if (!this.#options.credits) return;
    const c = this.#copy.hostSurface.credits, layout = this.#copy.layout, locale = this.#session().locale ?? 'en';
    const format = typeof this.#options.credits?.format === 'function' ? this.#options.credits.format : defaultCreditFormat;
    const owner = this.#credits?.balance?.owner, tiers = this.tiers, exhausted = this.usedUp, out = exhausted && !this.#creditEnding?.();
    const amount = line.querySelector('.host-credits__amount'), total = line.querySelector('.host-credits__total'), unit = line.querySelector('.host-credits__unit');
    const button = line.querySelector('.host-credits__button'), track = line.querySelector('.host-credits__track');
    const scope = line.querySelector('.host-credits__scope'), current = line.querySelector('.host-credits__current');
    line.dataset.ended = String(out); line.querySelector('.host-credits__text').setAttribute('aria-hidden', String(out));
    line.querySelector('.host-credits__used-up').setAttribute('aria-hidden', String(!out));
    setText(line.querySelector('.host-credits__used-up-full'), c.usedUp); setText(line.querySelector('.host-credits__used-up-short'), c.usedUpShort);
    setText(line.querySelector('.host-credits__equivalence'), c.unit);
    setText(amount, owner ? format(exhausted ? 0 : owner.availableMicro, locale) : '…');
    setText(total, owner ? fill(layout.creditsTotal, { limit: format(owner.limitMicro, locale) }) : ''); setText(unit, owner ? layout.creditsUnit : '');
    const balance = owner ? fill(exhausted ? c.balanceOut : c.balance, { available: format(owner.availableMicro, locale), limit: format(owner.limitMicro, locale) }) : `${c.title}: ${c.loading}`;
    setText(scope, balance); button.setAttribute('aria-label', balance);
    current.hidden = !tiers;
    if (tiers) setText(current.querySelector('span:last-child'), fill(c[tiers.current === 'emailConfirmed' ? 'withConfirmed' : tiers.current === 'emailGiven' ? 'withEmail' : 'anonymous'], { tier: format(tiers.allowancesMicro?.[tiers.current], locale) }));
    const next = this.nextTier, nextLine = line.querySelector('.host-credits__next'), link = line.querySelector('.credits-email');
    setText(nextLine, next ? fill(c[next === 'emailGiven' ? 'withEmail' : 'afterConfirm'], { tier: format(tiers.allowancesMicro?.[next], locale) }) : out ? c.noMore : '');
    nextLine.hidden = !next && !out; link.hidden = !next;
    setText(link, next === 'emailConfirmed' ? c.confirm : c.give);
    track.hidden = !owner;
    if (owner) {
      const value = wholeCredits(exhausted ? 0 : owner.availableMicro), maximum = wholeCredits(owner.limitMicro);
      track.querySelector('i').style.width = `${maximum > 0 ? Math.min(100, value / maximum * 100) : 0}%`;
      track.setAttribute('aria-valuenow', String(value)); track.setAttribute('aria-valuemax', String(maximum)); track.setAttribute('aria-label', c.title);
    }
    const limit = line.querySelector('.host-credits__limit'); limit.hidden = !out;
    // Retained slot for the demo's host-owned end notice; never a minute countdown.
    const deadline = line.querySelector('.host-credits__deadline'); deadline.hidden = true; setText(deadline, '');
  }
  // Legal and footer slots: the hairline row shows only when the host filled one of them.
  #mountFoot() {
    const foot = this.#root.querySelector('.host-foot');
    const sync = () => { foot.hidden = ![...foot.querySelectorAll('slot')].some(slot => slot.assignedNodes?.({ flatten: true }).length); };
    for (const slot of foot.querySelectorAll('slot')) slot.addEventListener('slotchange', sync);
    sync();
  }
}
