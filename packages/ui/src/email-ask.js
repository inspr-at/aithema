import { activeTurns } from '../../core/src/session.js';
import { fill, setText } from './dom.js';
import { formatCredits } from './display.js';
import { icon } from './icons.js';
import { guardConceptControls } from './concept-guards.js';

export const EMAIL_ASK_IDLE_MS = 1500;
export const lowCredit = credits => credits?.exhausted !== true && credits?.balance?.owner?.availableMicro > 0 &&
  Number.isSafeInteger(credits?.lowAtMicro) && credits.balance.owner.availableMicro <= credits.lowAtMicro;

/** The server owns frequency and records; this policy only chooses a safe moment. */
export function emailAskIntent({ count, replied, streaming, callActive, typing, eligible, low, lowReady = false, state = {}, desktop, dayReady }) {
  if (streaming || callActive || typing || !replied) return null;
  if (desktop && state.open && !state.saved && count >= state.openedAt + 2) return 'fold';
  if (!eligible) return null;
  if (low) return lowReady ? 'low' : null;
  if (state.open) return null;
  return count >= 5 && dayReady ? 'turn5' : null;
}

export class EmailAsk {
  constructor({ root, copy, verification, request, session, streaming, changed, lowCredits = true, now = () => Date.now() }) {
    Object.assign(this, { root, copy, verification, request, session, streaming, changed, lowCredits, now });
    this.alive = true; this.connected = true; this.state = {}; this.step = 'idle'; this.message = ''; this.lastInput = -Infinity;
    this.workspace = root.querySelector('.workspace'); this.composer = root.querySelector('#message');
    this.mq = root.ownerDocument.defaultView.matchMedia('(min-width: 60rem)');
    this.gate = root.ownerDocument.createElement('section'); this.gate.className = 'email-ask';
    this.gate.setAttribute('role', 'region'); this.gate.setAttribute('aria-labelledby', 'email-ask-title');
    this.gate.innerHTML = `<div class="email-ask__context"><span class="email-ask__kickers"><span class="email-ask__kick5"></span><span class="email-ask__kicklow"></span></span><span class="email-ask__balance"></span></div>
      <h2 id="email-ask-title"></h2><ul class="email-ask__benefits"><li>${icon('check')}<span class="email-ask__benefit"></span></li><li>${icon('check')}<span class="email-ask__all"></span></li></ul>
      <div class="email-ask__stack"><form id="email-ask-form" class="email-ask__form" novalidate><label class="m-label" for="email-ask-input"></label>
        <input class="m-in" id="email-ask-input" type="email" inputmode="email" autocomplete="email" maxlength="254" spellcheck="false" aria-describedby="email-ask-message email-ask-notice">
        <p class="m-msg" id="email-ask-message" role="status"></p><p class="m-notice" id="email-ask-notice"><span class="m-notice-text"></span> <a class="m-pp" target="_blank" rel="noopener"></a></p></form>
        <div class="email-ask__done" role="status"><p class="m-addr"></p><p class="m-tier"></p><p class="email-ask__hint"></p></div></div>
      <div class="email-ask__actions"><button class="email-ask__save m-save" type="submit" form="email-ask-form"></button><button class="email-ask__skip" type="button"></button></div>`;
    this.root.querySelector('.email-ask-pane').append(this.gate);
    this.input = this.q('#email-ask-input');
    this.q('form').addEventListener('submit', event => { event.preventDefault(); void this.save(); });
    this.input.addEventListener('input', () => { if (this.step !== 'saving') { this.invalid = false; this.message = ''; this.paint(); } });
    this.q('.email-ask__skip').addEventListener('click', () => void this.dismiss(true));
    this.gate.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); void this.dismiss(true); } });
    this.gate.addEventListener('mouseleave', () => this.update());
    this.gate.addEventListener('focusout', () => this.schedule());
    this.fold = root.querySelector('.email-ask-fold');
    this.fold.addEventListener('click', () => { this.manual = true; this.step = 'idle'; this.open = true; this.paint(); this.input.focus({ preventScroll: true }); });
    this.onInput = () => { this.lastInput = this.now(); this.schedule(); };
    this.onBlur = () => this.schedule();
    this.composer.addEventListener('input', this.onInput); this.composer.addEventListener('blur', this.onBlur);
    this.onLayout = () => { this.paint(); this.update(); }; this.mq.addEventListener('change', this.onLayout);
    this.resize = new root.ownerDocument.defaultView.ResizeObserver(() => {
      root.querySelector('.email-ask-dock').style.setProperty('--email-composer-height', root.querySelector('.composer-shell').offsetHeight + 'px');
    }); this.resize.observe(root.querySelector('.composer-shell'));
    this.paint();
  }
  q(selector) { return this.gate.querySelector(selector); }
  get email() { return this.verification.email; }
  get desktop() { return this.mq.matches && this.workspace.dataset.understanding !== 'absent' && !this.workspace.hasAttribute('data-folded'); }
  get callActive() { const rail = this.root.querySelector('.audio-rail'); return rail?.dataset.call === 'active' && !['paused', 'waiting', 'idle', 'ended'].includes(rail.dataset.state); }
  get typing() {
    const focus = this.root.activeElement;
    return focus === this.composer && (this.composer.value.trim() !== '' || !this.desktop) || this.now() - this.lastInput < EMAIL_ASK_IDLE_MS ||
      this.desktop && this.root.querySelector('.analysis-content').contains(focus) || Boolean(this.root.querySelector('dialog[open]'));
  }
  get eligible() { return this.credits?.exhausted !== true && !this.root.querySelector('.audio-rail')?.hasAttribute('data-used-up') && this.email.canCollect && !this.email.address && this.credits?.tiers?.next === 'emailGiven' && this.credits.tiers.delta > 0; }
  get reservedLowLine() {
    if (this.lowCredits && this.credits?.emailAskLowCredits !== false) return null;
    if (this.state.lowLine) return { ...this.state.lowLine, reserved: true };
    if (!lowCredit(this.credits)) return null;
    const turns = activeTurns(this.session()), last = turns.at(-1);
    if (last?.role !== 'assistant') return null;
    return { ...(this.state.lowLine ?? { at: last.id, kind: this.credits?.tiers?.next === 'emailConfirmed' ? 'confirm' : this.eligible ? 'give' : 'none',
      deltaMicro: this.credits?.tiers?.delta ?? 0, availableMicro: this.credits?.balance?.owner?.availableMicro }), reserved: true };
  }
  get lowLine() { return this.lowCredits && this.credits?.emailAskLowCredits !== false ? this.state.lowLine : null; }
  setCredits(credits) {
    this.credits = credits;
    this.awaitingCredits = false;
    const state = credits?.emailAsk;
    if (state && (state.revision ?? 0) >= (this.state.revision ?? 0)) this.state = state;
    this.after = this.now() + Math.max(0, (credits.emailAskAfter ?? 0) - (credits.nowMs ?? this.now()));
    this.setLowClaim(credits);
    this.update();
  }
  setLowClaim(response) {
    this.lowClaim = response.lowEmailAsk;
    this.lowAfter = this.now() + Math.max(0, (this.lowClaim?.after ?? 0) - (response.nowMs ?? this.now()));
  }
  setCopy(copy) { this.copy = copy; this.paint(); }
  schedule() { clearTimeout(this.timer); if (this.connected) this.timer = setTimeout(() => this.update(), EMAIL_ASK_IDLE_MS + 10); this.timer?.unref?.(); }
  update() {
    if (!this.alive || !this.connected) return;
    if (this.dismissPending) { this.paint(); if (!this.busy) void this.act('dismiss'); return; }
    const turns = activeTurns(this.session()), replied = turns.at(-1)?.role === 'assistant', count = turns.filter(turn => turn.role === 'user').length;
    const low = this.lowCredits && this.credits?.emailAskLowCredits !== false && lowCredit(this.credits), safe = replied && !this.streaming() && !this.callActive && !this.typing;
    if (this.callActive && this.open && !this.desktop) { void this.dismiss(false); return; }
    if ((this.state.why !== 'low' || this.lowCredits && this.credits?.emailAskLowCredits !== false) && this.state.open && !this.open && safe && (this.eligible || this.email.address)) {
      this.open = true; if (this.email.address) { this.step = 'done'; this.sent = this.email.identity?.status === 'verification-pending' && this.email.identity?.delivery !== 'failed'; }
    }
    if (low && !this.announcedLow) { this.announcedLow = true; setText(this.root.querySelector('.email-ask-announcement'), fill(this.copy.hostSurface.emailAsk.announceLow, { available: this.format(this.credits.balance.owner.availableMicro) })); }
    if (!low) this.announcedLow = false;
    this.paint();
    if (this.busy || !this.credits || this.awaitingCredits) return;
    if (this.lowClaim?.armed === false && this.credits.balance.owner.availableMicro > this.credits.lowAtMicro) { void this.act('rearm'); return; }
    if (safe && low && !this.state.lowLine) { void this.act('line'); return; }
    const intent = emailAskIntent({ count, replied, streaming: this.streaming(), callActive: this.callActive, typing: this.typing,
      eligible: this.eligible && (!lowCredit(this.credits) || low), low, lowReady: this.lowClaim?.armed === true && this.now() >= this.lowAfter,
      state: { ...this.state, open: this.open, saved: ['saving', 'done'].includes(this.step) }, desktop: this.desktop, dayReady: this.now() >= (this.after ?? Infinity) });
    if (intent === 'fold' && !this.gate.contains(this.root.activeElement) && !this.gate.matches(':hover')) void this.act('fold');
    else if (intent === 'low' || intent === 'turn5') void this.act('show', intent);
    else if (this.typing && replied && (low || count >= 5)) this.schedule();
  }
  async act(action, why) {
    if (this.busy || !this.alive) return;
    this.busy = true;
    let response;
    try { response = await this.request('email-ask', { action, ...(why ? { why } : {}) }); } catch { /* Retry at the next reply. */ }
    this.busy = false;
    if (!this.alive) return;
    if (response?.ok && response.body?.emailAsk) {
      this.state = response.body.emailAsk;
      if (action === 'dismiss' && response.body.accepted) this.dismissPending = false;
      if (this.dismissPending && action !== 'dismiss') { await this.act('dismiss'); return; }
      this.after = this.now() + Math.max(0, (response.body.emailAskAfter ?? 0) - (response.body.nowMs ?? this.now()));
      this.setLowClaim(response.body);
      if (action === 'show' && response.body.accepted) {
        this.step = 'idle'; this.message = ''; this.manual = false;
        setText(this.root.querySelector('.email-ask-announcement'), fill(this.copy.hostSurface.emailAsk.announceAsk, this.email.numbers));
      }
      if (action === 'fold' || action === 'dismiss') this.open = false;
      this.paint(); this.changed?.();
      if (response.body.accepted) this.update();
    }
  }
  async dismiss(focus) {
    const hadFocus = this.gate.contains(this.root.activeElement);
    this.dismissPending = true;
    this.open = false; this.manual = false; this.paint();
    if (focus && hadFocus) this.composer.focus({ preventScroll: true });
    await this.act('dismiss');
  }
  format(value) { return Number.isFinite(value) ? formatCredits(value, this.session().locale ?? 'en') : ''; }
  paint() {
    const a = this.copy.hostSurface.emailAsk, e = this.copy.hostSurface.email, v = this.copy.hostSurface.verify;
    const low = this.lowCredits && this.credits?.emailAskLowCredits !== false && lowCredit(this.credits), n = this.email.numbers, owner = this.credits?.balance?.owner;
    const confirmRaises = this.credits?.tiers?.canConfirm === true && this.credits.tiers.allowancesMicro?.emailConfirmed > this.credits.tiers.allowancesMicro?.emailGiven;
    const open = Boolean(this.open && this.email.canCollect && this.credits?.exhausted !== true), desktop = this.desktop;
    const slot = this.root.querySelector(desktop ? '.email-ask-pane' : '.email-ask-dock');
    if (this.gate.parentElement !== slot) {
      const focused = this.gate.contains(this.root.activeElement) ? this.root.activeElement : null;
      slot.append(this.gate); focused?.focus({ preventScroll: true });
    }
    this.workspace.dataset.emailAsk = open ? desktop ? 'pane' : 'dock' : 'closed';
    this.gate.dataset.step = this.step; this.gate.dataset.why = this.state.why ?? 'turn5';
    this.gate.inert = !open; this.gate.setAttribute('aria-hidden', String(!open));
    const assessment = this.root.querySelector('.analysis-content'); assessment.inert = open && desktop;
    this.root.querySelector('.transcript-shell').inert = open && !desktop;
    guardConceptControls(this.root);
    const form = this.root.querySelector('form.composer'), shell = this.root.querySelector('.composer-shell');
    form.inert = open && !desktop || shell.hasAttribute('data-used-up');
    this.root.querySelector('.qcard').inert = open && !desktop || shell.hasAttribute('data-used-up');
    for (const [selector, text] of [['.email-ask__kick5', a.kickerTurn5], ['.email-ask__kicklow', a.kickerLow], ['h2', a.title], ['.email-ask__all', a.benefitContinue], ['.email-ask__skip', a.skip], ['.email-ask__save', e.save], ['.m-label', v.label]]) setText(this.q(selector), text);
    setText(this.q('.email-ask__balance'), owner ? fill(low ? a.balanceLow : a.balance, { available: this.format(owner.availableMicro), limit: this.format(owner.limitMicro) }) : '');
    this.q('.email-ask__balance').classList.toggle('low', low);
    setText(this.q('.email-ask__benefit'), fill(confirmRaises ? a.benefitCreditsMail : a.benefitCredits, n));
    this.input.setAttribute('aria-invalid', String(Boolean(this.invalid)));
    this.q('.email-ask__save').setAttribute('aria-disabled', String(this.step === 'saving'));
    setText(this.q('#email-ask-message'), this.message);
    this.email.paintNotice(this.q('.m-notice'));
    const done = this.step === 'done'; this.q('form').inert = done; this.q('.email-ask__done').inert = !done;
    setText(this.q('.m-addr'), (this.email.delivery && this.sent ? e.sentTo + ' ' : '') + this.email.address);
    setText(this.q('.m-tier'), this.email.delivery && this.sent ? confirmRaises ? fill(e.pendingTier, n) : fill(e.tier, { tier: n.email }) : fill(a.saved, n));
    setText(this.q('.email-ask__hint'), this.email.delivery ? this.sent === false ? v.deliveryFailed : v.hint : a.savedHint);
    this.q('.email-ask__save').inert = done;
    const folded = this.state.folded && this.eligible && !open;
    this.fold.style.visibility = folded ? 'visible' : 'hidden'; this.fold.inert = !folded;
    setText(this.fold, fill(a.folded, { delta: this.format(this.credits?.tiers?.delta) }));
  }
  paintLine(row, line = this.state.lowLine) {
    if (!row.firstChild) row.innerHTML = `<span class="email-low-line__icon">${icon('info')}</span><span><span class="email-low-line__text"></span> <button class="email-low-line__action" type="button"></button></span>`;
    const a = this.copy.hostSurface.emailAsk;
    setText(row.querySelector('.email-low-line__text'), fill(a[line.kind === 'give' ? 'lineGive' : line.kind === 'confirm' ? 'lineConfirm' : 'lineNone'], { delta: this.format(line.deltaMicro), available: this.format(line.availableMicro) }));
    const button = row.querySelector('button'), next = this.credits?.tiers?.next;
    button.hidden = line.resolved === true || line.kind === 'none' || (line.kind === 'give' ? !this.eligible : next !== 'emailConfirmed');
    setText(button, line.kind === 'confirm' ? a.lineConfirmAction : a.lineGiveAction);
    button.onclick = () => { if (line.kind === 'confirm') this.changed?.({ settings: true }); else { this.manual = true; this.open = true; this.step = 'idle'; this.paint(); this.input.focus({ preventScroll: true }); } };
  }
  async save() {
    if (this.step === 'saving' || this.step === 'done' || !this.email.canCollect) return;
    const address = this.input.value.trim();
    if (address.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(address)) { this.invalid = true; this.message = this.copy.hostSurface.verify.invalid; this.paint(); this.input.focus({ preventScroll: true }); return; }
    this.step = 'saving'; this.message = this.copy.hostSurface.email.saving; this.paint();
    const response = await this.verification.saveAndConfirm(address);
    if (!this.alive) return;
    if (response?.ok) { this.step = 'done'; this.sent = response.sent; this.message = ''; this.paint(); if (this.open) this.q('.email-ask__skip').focus({ preventScroll: true }); }
    else { this.step = 'idle'; this.invalid = response?.status === 400; this.message = this.invalid ? this.copy.hostSurface.verify.invalid : this.copy.hostSurface.email.failed; this.paint(); }
  }
  connect() { this.connected = true; this.update(); }
  disconnect() { this.connected = false; clearTimeout(this.timer); }
  destroy() { this.alive = false; this.disconnect(); this.resize.disconnect(); this.mq.removeEventListener('change', this.onLayout); this.composer.removeEventListener('input', this.onInput); this.composer.removeEventListener('blur', this.onBlur); }
}
