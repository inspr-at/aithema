import { ActorRole } from './actor-role.js';
import { reasonSeparator } from './consent-line.js';
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
import { EmailAsk, lowCredit } from './email-ask.js';

export const defaultCreditFormat = formatCredits;

export class HostSurface {
  #root; #copy; #options; #base; #token; #session; #status; #adopt; #view; #alive = true; #connected = false;
  #verification = null; #library = null; #offer = null; #handover = null; #requesting = false; #limit = null;
  #limitGeneration = 0;
  #credits = null; #creditsFailed = false; #creditsLoad = 0; #creditsReads = 0; #creditsTimer = null; #creditsPoll = null; #ended = null; #creditClosing = null;
  #menu = null; #openSettings; #onCredits; #creditEnding; #admissionDenied; #creditContext;
  #emailAsk = null; #actorRole = null; #initialCreditScope;
  /**
   * options: {library, verification, handover, credits: true | {format(micro, locale)}, locale()}.
   * session() returns the live session; adopt(session, reason) opens another conversation.
   */
  constructor({ root, copy, options, baseUrl, sessionToken, session, status, adopt, onLock, focusAfterUnlock, beforeVerifyDialog, verificationOpener, openSettings, onCredits, creditEnding, creditContext, admissionDenied, streaming, initialCreditScope }) {
    this.#root = root; this.#copy = copy; this.#options = options ?? {}; this.#base = baseUrl; this.#token = sessionToken;
    this.#initialCreditScope = initialCreditScope ?? options?.credits?.scope;
    this.#openSettings = openSettings; this.#onCredits = onCredits; this.#creditEnding = creditEnding;
    this.#admissionDenied = admissionDenied; this.#creditContext = creditContext;
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
    if (o.credits && this.#verification) this.#emailAsk = new EmailAsk({ root, copy, verification: this.#verification,
      request: (path, body) => this.#call(this.#sessionPath(path), body), session, streaming,
      changed: info => { if (info?.settings) this.#openSettings?.(); else this.#onCredits?.(); } });
    this.#mountHandover(); this.#mountFoot();
    if (o.actorRole?.labels) this.#actorRole = new ActorRole({ root, copy, options: o.actorRole, session,
      request: (path, body) => this.#call(this.#sessionPath(path), body), settings: opener => openSettings?.(opener, { processing: true }) });
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
    this.#emailAsk?.setCopy(copy); this.#actorRole?.setCopy(copy);
    setText(root.querySelector('.handover h3'), s.handover.title);
    setText(root.querySelector('slot[name="handover-offer"]'), s.handover.offer);
    root.querySelectorAll('.handover__sizer').forEach((n, i) => setText(n, [s.handover.request, s.handover.update, s.handover.retry][i]));
    this.update();
  }
  openRoleSettings(opener) { return this.#actorRole?.openSheet(opener) ?? false; }
  get creditScope() { return this.#credits ? this.#credits.scope ?? null : this.#initialCreditScope; }
  get tiers() { return this.#credits?.tiers ?? null; }
  get low() { return !this.usedUp && lowCredit(this.#credits); }
  get emailAsk() { return this.#emailAsk; }
  get endReason() {
    const state = this.#session().credits;
    return this.#ended ?? (['ending', 'ended'].includes(state?.status) ? state.endReason ?? 'session' : null);
  }
  get limitCopy() {
    const { credits, usedUp } = this.#copy.hostSurface;
    const next = this.nextTier;
    if (this.#credits?.scope === 'session' && this.#credits.dailyCapReached) return {
      title: credits.dailyCapShort, body: credits.dailyCap, footer: false, announce: credits.dailyCap,
    };
    const state = this.endReason === 'host-limit' && next
      ? { title: usedUp.title, body: fill(usedUp[next === 'emailGiven' ? 'hostGive' : 'hostConfirm'], { delta: this.deltaCredits }), footer: false }
      : credits.ended[this.endReason] ?? usedUp;
    // Restored host limits wait for the tier receipt before announcing their variant.
    return { ...state, announce: this.endReason === 'host-limit' && this.#options.credits && !this.#credits && !this.#creditsFailed ? '' : `${state.title} ${state.body}` };
  }
  get usedUp() { return Boolean(this.endReason) || this.#credits?.exhausted === true; }
  get fullHold() {
    const owner = this.#credits?.balance?.owner;
    return !this.usedUp && (this.#credits?.fullHold === true || owner?.availableMicro === 0 && owner.reservedMicro > 0);
  }
  get nextTier() {
    if (this.endReason && this.endReason !== 'host-limit' || !this.#verification?.enabled || !this.#verification.canCollect) return null;
    const tiers = this.tiers;
    if (this.#credits?.scope !== 'session') return tiers?.next ?? null;
    if (this.#credits.dailyCapReached || tiers?.current === 'emailConfirmed') return null;
    const allowances = tiers?.allowancesMicro;
    // Equal anonymous/email-given allowances go straight to confirmation.
    if (tiers?.current === 'anonymous' && allowances && allowances.anonymous === allowances.emailGiven) {
      return tiers.canConfirm && allowances.emailConfirmed > allowances.anonymous ? 'emailConfirmed' : null;
    }
    return tiers?.next && allowances?.[tiers.next] > allowances?.[tiers.current] ? tiers.next : null;
  }
  get deltaCredits() { return this.tiers ? defaultCreditFormat(this.#credits?.scope === 'session' && this.nextTier
    ? this.tiers.allowancesMicro[this.nextTier] - this.tiers.allowancesMicro[this.tiers.current] : this.tiers.delta, this.#session().locale ?? 'en') : ''; }
  get locked() { return this.#verification?.locked ?? false; }
  /** The understanding pane holds host controls: the verification form while locked, or the handover band. */
  get holdsControls() { return this.locked || Boolean(this.#options.handover); }
  get verification() { return this.#verification; }
  get library() { return this.#library; }
  /** Starts host reads once the element is in the page. */
  connect() {
    this.#connected = true;
    this.#emailAsk?.connect();
    this.#menu?.connect();
    void this.#actorRole?.load();
    void this.#verification?.load(); this.#verification?.connect();
    if (this.#options.handover && this.#offer === null) void this.#loadHandover();
    if (this.#options.credits) {
      void this.#loadCredits(); clearInterval(this.#creditsPoll);
      this.#creditsPoll = setInterval(() => {
        const rail = this.#root.querySelector('.audio-rail'), running = rail?.dataset.call === 'active' && !['paused', 'waiting', 'idle', 'ended'].includes(rail.dataset.state);
        if (this.#alive && this.#connected && !this.#creditsReads && (this.usedUp || this.#credits?.reconciling || rail?.hasAttribute('data-call-reconciling') || this.#admissionDenied?.() || running) && this.#root.ownerDocument.visibilityState !== 'hidden') void this.#loadCredits();
      }, 15_000);
      this.#creditsPoll.unref?.();
    }
  }
  disconnect() {
    this.#connected = false; this.#verification?.disconnect();
    this.#emailAsk?.disconnect();
    this.#menu?.disconnect();
    clearTimeout(this.#creditsTimer); this.#creditsTimer = null; clearInterval(this.#creditsPoll); this.#creditsPoll = null;
  }
  destroy() { this.#alive = false; this.disconnect(); this.#emailAsk?.destroy(); this.#verification?.destroy(); this.#library?.destroy(); this.#menu?.destroy(); this.#actorRole?.destroy(); }
  /** Durable host events (already applied to the session projection) and the turns that change balances. */
  receive(event) {
    if (event.type === 'turn.final' && event.data?.role === 'assistant' && this.#emailAsk) this.#emailAsk.awaitingCredits = true;
    this.#verification?.receive(event);
    this.#actorRole?.sync();
    if (event.type === 'handover.state') { this.#handover = event.data; this.#requesting = false; this.#limit = null; }
    if (event.type === 'handover.limit-reached') this.#limit = inputRevision(this.#session());
    if (event.type === 'library.state' || event.type === 'session.erased') this.#library?.changed();
    if (event.type === 'credits.limit-reached' || event.type === 'conversation.end-requested') {
      const reason = event.data?.reason;
      this.#limitGeneration++;
      this.#ended = reason ?? this.#ended ?? 'session';
      // The composer's limit block owns the reason and its polite announcement.
      // Never send ended copy through the action-status/toast channel.
    }
    if (event.type === 'credits.state' && event.data?.status === 'active') {
      this.#limitGeneration++;
      if (this.#ended === 'host-limit') this.#ended = null;
    }
    if (event.type === 'voice.state' && ['closing', 'ended'].includes(event.data?.state)) {
      const endedCall = this.#creditContext?.();
      if (endedCall && event.data.callId === endedCall.callId && event.data.providerSessionId === endedCall.providerSessionId) this.#creditClosing = endedCall;
    }
    if (['identity.state', 'identity.unlocked', 'credits.state', 'credits.limit-reached', 'conversation.end-requested', 'session.paused', 'understanding.updated', 'lane.failed'].includes(event.type) ||
      event.type === 'voice.state' && ['closing', 'ended'].includes(event.data?.state) ||
      event.type === 'turn.final' && event.data?.role === 'assistant' || event.type === 'concept.state' && event.data?.artifact) this.#refreshCredits();
    this.update(); this.#onCredits?.();
  }
  /** A restored snapshot replaces the projection: identity and handover follow it. */
  resync() {
    const session = this.#session();
    this.#actorRole?.set(session.roleChoice); this.#actorRole?.sync();
    if (session.identity !== undefined) this.#verification?.set(session.identity ?? null);
    if (session.handover !== undefined) this.#handover = session.handover;
    this.#refreshCredits(); this.update();
  }
  /** Repaints parts that follow the session (person turns, revisions, pause). */
  update() { this.#paintHandover(); this.#paintCredits(); this.#emailAsk?.update(); }
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
  // Credits project the allowance selected by the host for this conversation. Reads never start a time slot.
  #refreshCredits() {
    if (!this.#options.credits || !this.#connected) return;
    clearTimeout(this.#creditsTimer); this.#creditsTimer = setTimeout(() => void this.#loadCredits(), 300);
  }
  async #loadCredits() {
    const limitGeneration = this.#limitGeneration;
    const load = ++this.#creditsLoad, previous = this.#credits, previousTier = this.tiers?.current, endedCall = this.#creditContext?.();
    // Only receipts requested after this call's durable closing/ended can settle it.
    const settlingCall = endedCall === this.#creditClosing && !endedCall?.settled ? endedCall : undefined;
    this.#creditsReads++;
    this.#verification?.setCreditsState('loading');
    try {
      const response = await this.#call(this.#sessionPath('credits'));
      if (!this.#alive || load !== this.#creditsLoad) return;
      if (!response.ok) { this.#creditsFailed = true; this.#verification?.setCreditsState('failed'); this.#onCredits?.({ receiptFailed: true }); return; }
      this.#creditsFailed = false; this.#credits = response.body;
      const allowanceChanged = Boolean(previous && (previous.balance?.owner?.limitMicro !== this.#credits?.balance?.owner?.limitMicro ||
        JSON.stringify(previous.tiers) !== JSON.stringify(this.#credits?.tiers)));
      if (previousTier && previousTier !== this.tiers?.current) void this.#verification?.load();
      const slot = this.#credits?.limitSlot;
      // A positive visitor balance alone says nothing about the operator budget.
      // Recovery requires explicit exhaustion clearing, a raised allowance or
      // an authoritative host-limit slot reopening; settlement alone cannot recover.
      const allowanceRaised = this.#credits?.balance?.owner?.limitMicro > previous?.balance?.owner?.limitMicro;
      const recovered = this.#credits?.exhausted === false && this.#credits?.balance?.owner?.availableMicro > 0 &&
        (previous?.exhausted === true || allowanceRaised || previous?.limitSlot?.endReason === 'host-limit' &&
          ['ending', 'ended'].includes(previous.limitSlot.status) && slot?.status === 'active');
      // An earlier receipt cannot recover a limit announced after its request.
      const currentLimit = limitGeneration === this.#limitGeneration;
      if (currentLimit && this.#ended === 'host-limit' && recovered) this.#ended = null;
      if (currentLimit && ['ending', 'ended'].includes(slot?.status) && !(slot.endReason === 'host-limit' && recovered)) this.#ended = slot.endReason ?? this.#ended ?? 'session';
      this.#verification?.setCredits(this.#credits); this.#paintCredits(); await this.#onCredits?.({ allowanceChanged, settledCall: this.#credits.reconciling === false ? settlingCall : undefined });
      this.#emailAsk?.setCredits(this.#credits);
    } catch {
      // Keep acknowledged tiers; only an unresolved lead needs a failure status.
      if (this.#alive && load === this.#creditsLoad) {
        this.#creditsFailed = true; this.#verification?.setCreditsState('failed'); this.#onCredits?.({ receiptFailed: true });
      }
    }
    finally { this.#creditsReads--; }
  }
  #paintCredits() {
    const line = this.#root.querySelector('.host-credits'); line.hidden = !this.#options.credits;
    if (!this.#options.credits) return;
    const c = this.#copy.hostSurface.credits, layout = this.#copy.layout, locale = this.#session().locale ?? 'en';
    const format = typeof this.#options.credits?.format === 'function' ? this.#options.credits.format : defaultCreditFormat;
    const owner = this.#credits?.balance?.owner, tiers = this.tiers, exhausted = this.usedUp, out = exhausted;
    const scoped = this.#credits?.scope === 'session', capped = scoped && this.#credits.dailyCapReached;
    const sessionLayout = scoped || !this.#credits && this.#initialCreditScope === 'session';
    line.toggleAttribute('data-session-credits', sessionLayout); line.toggleAttribute('data-daily-cap', capped);
    setText(line.querySelector('.host-credits__measure-cap'), sessionLayout ? c.dailyCapShort : '');
    const tierText = text => scoped ? text.replace(/ Credits/gu, '\u00a0Credits') : text;
    const reservedLimit = owner ? Math.max(owner.limitMicro, ...Object.values(tiers?.allowancesMicro ?? {}).filter(Number.isSafeInteger)) : null;
    const warningLimit = this.#credits?.lowAtMaxMicro ?? this.#credits?.lowAtMicro;
    const warningAvailable = owner && Number.isSafeInteger(warningLimit) ? Math.min(owner.availableMicro, warningLimit) : 0;
    const low = this.low; line.dataset.low = String(low);
    const amount = line.querySelector('.host-credits__amount'), total = line.querySelector('.host-credits__total'), unit = line.querySelector('.host-credits__unit');
    const button = line.querySelector('.host-credits__button'), track = line.querySelector('.host-credits__track');
    const scope = line.querySelector('.host-credits__scope'), current = line.querySelector('.host-credits__current');
    for (const attribute of ['title', 'aria-description']) {
      if (this.#credits?.reconciling) button.setAttribute(attribute, c.reconciling);
      else button.removeAttribute(attribute);
    }
    // Tick AIT-357: reserve the six-glyph 10,000-credit envelope before the
    // first receipt. Larger host allowances still grow and use the normal refit.
    const initialMaximum = 100_000_000; // microUSD: 10,000 whole credits
    const measuredMaximum = format(Math.max(initialMaximum, reservedLimit ?? 0), locale);
    // Reserve both numbers before the receipt so the unit never moves.
    amount.setAttribute('data-credit-reserve', measuredMaximum);
    total.setAttribute('data-credit-reserve', fill(layout.creditsTotal, { limit: measuredMaximum }));
    line.querySelector('.host-credits__measure-amount').setAttribute('data-credit-reserve', measuredMaximum);
    line.dataset.ended = String(out); line.querySelector('.host-credits__text').setAttribute('aria-hidden', String(out));
    line.querySelector('.host-credits__used-up').setAttribute('aria-hidden', String(!out));
    line.querySelector('.host-credits__low').setAttribute('aria-hidden', String(!low));
    line.querySelector('.host-credits__low').hidden = !Number.isSafeInteger(warningLimit);
    line.querySelector('.host-credits__measure-low').hidden = !Number.isSafeInteger(warningLimit);
    setText(line.querySelector('.host-credits__low-full'), owner ? fill(c.low, { available: format(warningAvailable, locale) }) : '');
    setText(line.querySelector('.host-credits__low-short'), owner ? fill(c.lowShort, { available: format(warningAvailable, locale) }) : '');
    // Reserve the width using the highest server tier; digit changes never
    // narrow the cell, including EN where the used-up label is shorter.
    setText(line.querySelector('.host-credits__measure-amount'), owner ? format(reservedLimit, locale) : measuredMaximum);
    setText(line.querySelector('.host-credits__measure-total'), fill(layout.creditsTotal, { limit: measuredMaximum }));
    setText(line.querySelector('.host-credits__measure-unit'), tierText(layout.creditsUnit));
    setText(line.querySelector('.host-credits__measure-low-full'), owner && Number.isSafeInteger(warningLimit) ? fill(c.low, { available: format(warningLimit, locale) }) : '');
    setText(line.querySelector('.host-credits__measure-low-short'), owner && Number.isSafeInteger(warningLimit) ? fill(c.lowShort, { available: format(warningLimit, locale) }) : '');
    const timedOut = this.endReason === 'one-hour';
    setText(line.querySelector('.host-credits__used-up-full'), capped ? c.dailyCapShort : timedOut ? c.timeExpired : c.usedUp);
    setText(line.querySelector('.host-credits__used-up-short'), capped ? c.dailyCapShort : timedOut ? c.timeExpired : c.usedUpShort);
    setText(line.querySelector('.host-credits__equivalence'), c.unit);
    setText(amount.querySelector('.host-credits__value'), owner ? format(exhausted ? 0 : owner.availableMicro, locale) : '…');
    setText(total, owner ? fill(layout.creditsTotal, { limit: format(owner.limitMicro, locale) }) : ''); setText(unit, tierText(layout.creditsUnit));
    const balance = owner ? fill(scoped ? exhausted ? c.sessionBalanceOut : c.sessionBalance : exhausted ? c.balanceOut : c.balance, { available: format(owner.availableMicro, locale), limit: format(owner.limitMicro, locale) }) : c.loading;
    setText(scope, balance); button.setAttribute('aria-label', capped ? c.dailyCap : balance);
    if (low) button.setAttribute('aria-label', fill(c.low, { available: format(owner.availableMicro, locale) }) + reasonSeparator + balance);
    current.hidden = !tiers || tiers.current === 'anonymous';
    if (tiers) setText(current.querySelector('span:last-child'), tierText(fill(c[tiers.current === 'emailConfirmed' ? 'withConfirmed' : tiers.current === 'emailGiven' ? 'withEmail' : 'anonymous'], { tier: format(tiers.allowancesMicro?.[tiers.current], locale) })));
    const next = this.nextTier, nextLine = line.querySelector('.host-credits__next'), link = line.querySelector('.credits-email');
    setText(nextLine, next ? scoped && tiers.current === 'anonymous' && next === 'emailConfirmed' ? '' : tierText(fill(c[next === 'emailGiven' ? 'withEmail' : 'afterConfirm'], { tier: format(tiers.allowancesMicro?.[next], locale) })) : !capped && out && (scoped || this.limitCopy.footer !== false) ? c.noMore : '');
    nextLine.hidden = capped || !next && (!out || !scoped && this.limitCopy.footer === false); link.hidden = !next;
    setText(link, next === 'emailConfirmed' ? c.confirm : c.give);
    // Reserve the track without overriding narrow/legal-host display rules.
    track.hidden = false; track.style.visibility = owner ? '' : 'hidden';
    if (owner) {
      const value = wholeCredits(exhausted ? 0 : owner.availableMicro), maximum = wholeCredits(owner.limitMicro);
      track.querySelector('i').style.width = `${maximum > 0 ? Math.min(100, value / maximum * 100) : 0}%`;
      track.setAttribute('aria-valuenow', String(value)); track.setAttribute('aria-valuemax', String(maximum)); track.setAttribute('aria-label', c.title);
    }
    const daily = line.querySelector('.host-credits__daily-cap');
    daily.hidden = !capped; setText(daily, capped ? c.dailyCap : '');
    const limit = line.querySelector('.host-credits__limit'); limit.hidden = !out;
    limit.querySelector('slot').hidden = scoped && this.#session().demo === true;
    setText(limit.querySelector('.host-credits__demo'), scoped && this.#session().demo === true ? c.sessionCreditsLimit : '');
    // Retained slot for the demo's host-owned end notice; never a minute countdown.
    const deadline = line.querySelector('.host-credits__deadline'); deadline.hidden = true; setText(deadline, '');
  }
  // Host footer content stays in the info popup; legal links have their own standing bar slot.
  #mountFoot() {
    const foot = this.#root.querySelector('.host-foot');
    const sync = () => { foot.hidden = ![...foot.querySelectorAll('slot')].some(slot => slot.assignedNodes?.({ flatten: true }).length); };
    for (const slot of foot.querySelectorAll('slot')) slot.addEventListener('slotchange', sync);
    sync();
  }
}
